#!/usr/bin/env node
// Corridor reference pipeline: OSM road geometry (via OSRM) + real elevation (Open-Meteo, Copernicus DEM)
// -> GeoJSON, CSV, summary.json and two SVG previews you can use as an underlay while building in the ETS2 editor.
//
// Usage:
//   node corridor.mjs                 real run (needs internet)
//   node corridor.mjs --mock          offline run with synthetic data (checks the pipeline)
//   node corridor.mjs --selftest      verifies the math against known answers
// Options: --config waypoints.json  --step 50  --smooth 5  --curve 150  --out out  --refresh

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const R = 6371008.8; // mean Earth radius, metres
const toRad = (d) => (d * Math.PI) / 180;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- geometry ----------

export function haversine(a, b) {
  // a, b = [lon, lat]
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Azimuthal equidistant projection around an origin: metres east/north, accurate to <0.1% over ~250 km.
export function makeProjector(lat0, lon0) {
  const p0 = toRad(lat0);
  const l0 = toRad(lon0);
  return (lon, lat) => {
    const p = toRad(lat);
    const dl = toRad(lon) - l0;
    const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(dl);
    const c = Math.acos(Math.min(1, Math.max(-1, cosc)));
    const k = c < 1e-12 ? 1 : c / Math.sin(c);
    return [R * k * Math.cos(p) * Math.sin(dl), R * k * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(dl))];
  };
}

export function resample(coords, step) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  const total = cum[cum.length - 1];
  const n = Math.max(1, Math.round(total / step));
  const ds = total / n; // evenly spaced, as close to `step` as possible
  const points = [];
  let j = 0;
  for (let k = 0; k <= n; k++) {
    const d = k * ds;
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const seg = cum[j + 1] - cum[j];
    const t = seg > 0 ? Math.min(1, Math.max(0, (d - cum[j]) / seg)) : 0;
    points.push([coords[j][0] + (coords[j + 1][0] - coords[j][0]) * t, coords[j][1] + (coords[j + 1][1] - coords[j][1]) * t]);
  }
  return { points, spacing: ds, total };
}

export function circumradius(A, B, C) {
  const ab = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const bc = Math.hypot(C[0] - B[0], C[1] - B[1]);
  const ca = Math.hypot(A[0] - C[0], A[1] - C[1]);
  const cross = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]));
  if (cross < 1e-9) return Infinity;
  return (ab * bc * ca) / (2 * cross);
}

export function smooth(values, window) {
  if (window <= 1) return values.slice();
  const h = Math.floor(window / 2);
  return values.map((_, i) => {
    let sum = 0, cnt = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(values.length - 1, i + h); k++) { sum += values[k]; cnt++; }
    return sum / cnt;
  });
}

export function computeGrades(s, z) {
  return z.map((_, i) => {
    const a = Math.max(0, i - 1);
    const b = Math.min(z.length - 1, i + 1);
    return s[b] - s[a] > 0 ? ((z[b] - z[a]) / (s[b] - s[a])) * 100 : 0;
  });
}

export function findTightCurves(s, radii, threshold) {
  const out = [];
  let cur = null;
  radii.forEach((r, i) => {
    if (r < threshold) {
      if (!cur) cur = { startKm: s[i] / 1000, endKm: s[i] / 1000, minRadiusM: r };
      cur.endKm = s[i] / 1000;
      cur.minRadiusM = Math.min(cur.minRadiusM, r);
    } else if (cur) { out.push(cur); cur = null; }
  });
  if (cur) out.push(cur);
  return out.map((c) => ({ ...c, startKm: +c.startKm.toFixed(2), endKm: +c.endKm.toFixed(2), minRadiusM: Math.round(c.minRadiusM) }));
}

// ---------- network ----------

async function fetchJson(url, tries = 4) {
  let lastErr;
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'corridor-pipeline/1.0' } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) { lastErr = e; await sleep(1000 * 2 ** t); }
  }
  throw new Error(`Request failed after ${tries} tries (${lastErr.message}): ${url.slice(0, 110)}...`);
}

async function getRoute(wps) {
  const coords = wps.map((w) => `${w.lon},${w.lat}`).join(';');
  const j = await fetchJson(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`);
  if (j.code !== 'Ok') throw new Error(`OSRM error: ${j.code} ${j.message || ''}`);
  const r = j.routes[0];
  return { coords: r.geometry.coordinates, distance: r.distance, snapped: j.waypoints.map((w) => w.location) };
}

async function getElevations(points, cacheFile) {
  const sig = { n: points.length, first: points[0].map((v) => v.toFixed(5)).join(','), last: points.at(-1).map((v) => v.toFixed(5)).join(',') };
  if (existsSync(cacheFile)) {
    const c = JSON.parse(await readFile(cacheFile, 'utf8'));
    if (c.sig.n === sig.n && c.sig.first === sig.first && c.sig.last === sig.last) { console.log('Using cached elevations'); return c.elev; }
  }
  const elev = [];
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const lat = chunk.map((p) => p[1].toFixed(5)).join(',');
    const lon = chunk.map((p) => p[0].toFixed(5)).join(',');
    const j = await fetchJson(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
    if (!Array.isArray(j.elevation) || j.elevation.length !== chunk.length) throw new Error('Unexpected elevation response');
    elev.push(...j.elevation);
    process.stdout.write(`\rElevation ${Math.min(i + 100, points.length)}/${points.length}`);
    await sleep(250);
  }
  process.stdout.write('\n');
  await writeFile(cacheFile, JSON.stringify({ sig, elev }));
  return elev;
}

// ---------- mock data (offline testing only) ----------

function mockRoute(wps) {
  const coords = [];
  for (let i = 0; i < wps.length - 1; i++) {
    for (let k = 0; k < 60; k++) {
      const t = k / 60;
      const wig = 0.012 * Math.sin(t * Math.PI * 6 + i);
      coords.push([wps[i].lon + (wps[i + 1].lon - wps[i].lon) * t + wig, wps[i].lat + (wps[i + 1].lat - wps[i].lat) * t + wig * 0.5]);
    }
  }
  coords.push([wps.at(-1).lon, wps.at(-1).lat]);
  return { coords, snapped: wps.map((w) => [w.lon, w.lat]) };
}
const mockElevation = (s) => s.map((d) => 1000 + 600 * Math.sin(d / 40000) + 150 * Math.sin(d / 7000));

// ---------- svg previews ----------

function svgProfile(s, z, tight) {
  const W = 1200, H = 320, m = { l: 60, r: 20, t: 20, b: 40 };
  const zmin = Math.min(...z), zmax = Math.max(...z), L = s.at(-1) / 1000;
  const sx = (km) => m.l + (km / L) * (W - m.l - m.r);
  const sy = (e) => H - m.b - ((e - zmin) / (zmax - zmin || 1)) * (H - m.t - m.b);
  const line = z.map((e, i) => `${sx(s[i] / 1000).toFixed(1)},${sy(e).toFixed(1)}`).join(' ');
  const bands = tight.map((c) => `<rect x="${sx(c.startKm).toFixed(1)}" y="${m.t}" width="${Math.max(2, sx(c.endKm) - sx(c.startKm)).toFixed(1)}" height="${H - m.t - m.b}" fill="#e5484d" opacity="0.25"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="sans-serif" font-size="12"><rect width="${W}" height="${H}" fill="#fff"/>${bands}<polyline points="${line}" fill="none" stroke="#1f6feb" stroke-width="2"/><text x="${m.l}" y="14">Elevation (m): min ${Math.round(zmin)}, max ${Math.round(zmax)}. Red bands = tight curves.</text><text x="${W / 2}" y="${H - 8}" text-anchor="middle">km along route (0 - ${L.toFixed(1)})</text></svg>`;
}

function svgPlan(xy, wps) {
  const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const W = 1000, pad = 40, scale = (W - 2 * pad) / (maxx - minx || 1), H = Math.round((maxy - miny) * scale + 2 * pad);
  const px = (p) => `${(pad + (p[0] - minx) * scale).toFixed(1)},${(H - pad - (p[1] - miny) * scale).toFixed(1)}`;
  const marks = wps.map((w) => { const [x, y] = px(w.xy).split(','); return `<circle cx="${x}" cy="${y}" r="5" fill="#e5484d"/><text x="${+x + 8}" y="${+y - 6}" font-size="13" font-family="sans-serif">${w.name.replace(/&/g, '&amp;')}</text>`; }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff"/><polyline points="${xy.map(px).join(' ')}" fill="none" stroke="#1f6feb" stroke-width="2"/>${marks}</svg>`;
}

// ---------- self-test ----------

function selftest() {
  let fail = 0;
  const check = (name, got, want, tol) => {
    const ok = Math.abs(got - want) <= tol;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${got.toFixed(4)}, want ${want} (+/-${tol})`);
  };
  check('haversine 1 deg latitude (m)', haversine([0, 0], [0, 1]), 111195, 100);
  // circle of radius 300 m sampled every 50 m of arc
  const r = 300, dth = 50 / r;
  const pts = Array.from({ length: 10 }, (_, i) => [r * Math.cos(i * dth), r * Math.sin(i * dth)]);
  check('circumradius on r=300 circle (m)', circumradius(pts[3], pts[4], pts[5]), 300, 1);
  check('circumradius on straight line is Infinity (1=yes)', Number(circumradius([0, 0], [50, 0], [100, 0]) === Infinity), 1, 0);
  const s = Array.from({ length: 20 }, (_, i) => i * 50);
  check('grade on 5% slope (%)', computeGrades(s, s.map((d) => d * 0.05))[10], 5, 1e-9);
  const line = [[44.0, 40.0], [44.0, 40.5], [44.3, 41.0]];
  const rs = resample(line, 50);
  const direct = haversine(line[0], line[1]) + haversine(line[1], line[2]);
  check('resample preserves total length (m)', rs.total, direct, 1e-6);
  check('resample spacing close to step (m)', rs.spacing, 50, 0.5);
  const proj = makeProjector(40.1776, 44.5126);
  const a = proj(43.4867, 41.4056);
  check('projection distance vs haversine over ~250 km (m)', Math.hypot(a[0], a[1]), haversine([44.5126, 40.1776], [43.4867, 41.4056]), 250);
  const sm = smooth([0, 10, 0, 10, 0], 3);
  check('smooth middle value', sm[2], 20 / 3, 1e-9);
  console.log(fail ? `\n${fail} check(s) FAILED` : '\nAll checks passed');
  process.exit(fail ? 1 : 0);
}

// ---------- main ----------

function parseArgs(argv) {
  const o = { config: 'waypoints.json', step: 50, out: 'out', smooth: 5, curve: 150, mock: false, selftest: false, refresh: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') o.mock = true;
    else if (a === '--selftest') o.selftest = true;
    else if (a === '--refresh') o.refresh = true;
    else if (['--config', '--out'].includes(a)) o[a.slice(2)] = argv[++i];
    else if (['--step', '--smooth', '--curve'].includes(a)) o[a.slice(2)] = Number(argv[++i]);
    else { console.error(`Unknown option ${a}`); process.exit(1); }
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv);
  if (o.selftest) return selftest();

  const cfg = JSON.parse(await readFile(o.config, 'utf8'));
  const cacheDir = path.join(o.out, 'cache');
  await mkdir(cacheDir, { recursive: true });

  // 1. route geometry
  let raw;
  const routeCache = path.join(cacheDir, 'route.json');
  const wpKey = JSON.stringify(cfg.waypoints);
  if (o.mock) raw = mockRoute(cfg.waypoints);
  else if (!o.refresh && existsSync(routeCache) && JSON.parse(await readFile(routeCache, 'utf8')).key === wpKey) {
    raw = JSON.parse(await readFile(routeCache, 'utf8')).raw;
    console.log('Using cached route');
  } else {
    console.log('Requesting route from OSRM...');
    raw = await getRoute(cfg.waypoints);
    await writeFile(routeCache, JSON.stringify({ key: wpKey, raw }));
  }

  const snapReport = cfg.waypoints.map((w, i) => {
    const moved = haversine([w.lon, w.lat], raw.snapped[i]);
    return { name: w.name, snappedLon: raw.snapped[i][0], snappedLat: raw.snapped[i][1], movedM: Math.round(moved) };
  });
  snapReport.forEach((r) => console.log(`  waypoint "${r.name}" snapped ${r.movedM} m${r.movedM > 300 ? '  <-- CHECK THIS COORDINATE' : ''}`));

  // 2. resample, project
  const { points, spacing, total } = resample(raw.coords, o.step);
  const proj = makeProjector(points[0][1], points[0][0]);
  const xy = points.map((p) => proj(p[0], p[1]));
  const s = points.map((_, i) => i * spacing);

  // 3. elevation
  const elevRaw = o.mock ? mockElevation(s) : await getElevations(points, path.join(cacheDir, `elevation-${o.step}.json`));
  const z = smooth(elevRaw, o.smooth);
  const grade = computeGrades(s, z);

  // 4. curvature
  const radius = points.map((_, i) => (i === 0 || i === points.length - 1 ? Infinity : circumradius(xy[i - 1], xy[i], xy[i + 1])));
  const tight = findTightCurves(s, radius, o.curve);

  // 5. outputs
  let ascent = 0, descent = 0;
  for (let i = 1; i < z.length; i++) { const d = z[i] - z[i - 1]; if (d > 0) ascent += d; else descent -= d; }
  const summary = {
    name: cfg.name, mock: o.mock, lengthKm: +(total / 1000).toFixed(2), samples: points.length, sampleSpacingM: +spacing.toFixed(1),
    elevationM: { min: Math.round(Math.min(...z)), max: Math.round(Math.max(...z)) },
    totalAscentM: Math.round(ascent), totalDescentM: Math.round(descent),
    maxUphillGradePct: +Math.max(...grade).toFixed(1), maxDownhillGradePct: +Math.min(...grade).toFixed(1),
    tightCurveThresholdM: o.curve, tightCurveCount: tight.length,
    tightestCurves: [...tight].sort((a, b) => a.minRadiusM - b.minRadiusM).slice(0, 20),
    waypoints: snapReport,
    notes: ['Elevation comes from a ~90 m DEM: it follows the terrain, not bridges or tunnels.', 'Local x/y are metres east/north of the first point; check axis orientation against the ETS2 editor before importing anything.'],
  };

  const csv = ['idx,km,lat,lon,elev_m,grade_pct,radius_m,x_east_m,y_north_m'];
  points.forEach((p, i) => csv.push([i, (s[i] / 1000).toFixed(3), p[1].toFixed(6), p[0].toFixed(6), z[i].toFixed(1), grade[i].toFixed(2), radius[i] > 5000 ? '' : radius[i].toFixed(0), xy[i][0].toFixed(1), xy[i][1].toFixed(1)].join(',')));
  const geojson = { type: 'Feature', properties: { name: cfg.name, lengthKm: summary.lengthKm }, geometry: { type: 'LineString', coordinates: points.map((p, i) => [+p[0].toFixed(6), +p[1].toFixed(6), +z[i].toFixed(1)]) } };
  const wpXY = snapReport.map((w) => ({ name: w.name, xy: proj(w.snappedLon, w.snappedLat) }));

  await writeFile(path.join(o.out, 'route.geojson'), JSON.stringify(geojson));
  await writeFile(path.join(o.out, 'profile.csv'), csv.join('\n') + '\n');
  await writeFile(path.join(o.out, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(path.join(o.out, 'profile.svg'), svgProfile(s, z, tight));
  await writeFile(path.join(o.out, 'plan.svg'), svgPlan(xy, wpXY));

  console.log(`\nDone${o.mock ? ' (MOCK DATA - not real)' : ''}: ${summary.lengthKm} km, ${summary.samples} samples, ${tight.length} tight curves (< ${o.curve} m radius).`);
  console.log(`Files in ${o.out}/: route.geojson, profile.csv, summary.json, profile.svg, plan.svg`);
}

main().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
