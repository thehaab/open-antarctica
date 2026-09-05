# Roadmap

## v0.0.1 — Ferrar Glacier proof of concept

Goal: determine whether open Antarctic terrain + imagery can produce a dramatically better exploration experience than conventional globe viewers for one carefully chosen region.

### Phase 1 — source data

- Identify the exact REMA tiles intersecting `regions/ferrar-glacier.json`
- Acquire REMA 10 m terrain for rapid iteration
- Acquire matching full-resolution LIMA imagery
- Validate CRS, bounds, nodata, and vertical datum metadata

### Phase 2 — local scene

- Crop terrain and imagery to the same footprint
- Render the scene in CesiumJS
- Verify imagery/terrain alignment
- Add orbit, tilt, zoom, and free-flight navigation

### Phase 3 — visual controls

- Vertical exaggeration
- Simulated sunlight / hillshade
- Imagery opacity
- Terrain-only mode
- Provenance and attribution display

### Phase 4 — full-detail prototype

- Replace REMA 10 m with REMA 2 m
- Measure browser/GPU performance
- Document a clean, reproducible local build

## Explicitly out of scope for v0.0.1

- AI reconstruction
- near-daily imagery fusion
- commercial imagery
- whole-continent ingest
- accounts or backend database
- production CDN/infrastructure
