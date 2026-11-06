# Yerevan to Akhalkalaki corridor pipeline

Builds a reference dataset for the ETS2 map: real road geometry, real elevation, curve radii and grades, sampled every 50 m.
It does not build the map. You use its output as a reference while placing roads in the editor.

## Run it (evening, at your computer)

Needs Node 18+ and an internet connection. No packages to install.

```
node corridor.mjs --selftest     # checks the math (should print "All checks passed")
node corridor.mjs                # real run, takes a few minutes
```

Results go to `out/`:

| File | What it is |
|---|---|
| `summary.json` | length, min/max elevation, total ascent/descent, steepest grades, tightest curves, waypoint snap report |
| `profile.csv` | one row per 50 m: km, lat, lon, elevation, grade %, curve radius, local x/y in metres |
| `route.geojson` | the route as a 3D line (lon, lat, elevation) |
| `profile.svg` | elevation profile, tight curves shaded red |
| `plan.svg` | top-down view with waypoints |

## Check these first

1. **Waypoints.** The script prints how far each waypoint moved when snapped to a road. Anything over 300 m is flagged. My coordinates are approximate, so fix them in `waypoints.json`.
2. **Border crossing.** Confirm the route actually crosses at Bavra/Ninotsminda by looking at `plan.svg`.
3. **Total length.** Compare `lengthKm` with what you know (roughly 3 hours of driving).

## Known limits

- Elevation comes from a ~90 m terrain model. It follows the ground, not bridges or tunnels.
- OSRM's public demo server is for light use. One run is fine; don't loop it.
- Both data sources are open data (OpenStreetMap, Copernicus DEM via Open-Meteo).
- Local x/y are metres east/north of the first point. Check axis orientation in the editor before relying on them.
- Tested offline only (self-test + synthetic data). The live API calls have not been run yet.

## Options

`--step 50` sample spacing in metres, `--smooth 5` elevation smoothing window, `--curve 150` radius in metres below which a curve counts as tight, `--refresh` ignore cached route, `--config file.json` other waypoint file, `--mock` synthetic data for testing.

## Next steps

1. Run it, send me `summary.json` and tell me if anything looks wrong.
2. Decide what to trace first: the Yerevan to Gyumri stretch is the best candidate for a first drivable segment.
3. Work out how to get the reference into the editor as an underlay (to be figured out with the editor open).
