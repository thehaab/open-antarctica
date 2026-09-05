# Roadmap

## Visual fidelity benchmark

Open Antarctica should aim to match or exceed the practical close-range visual usefulness of Google Maps / Google Earth in Antarctica, while being substantially better about terrain fidelity, provenance, scientific layers, and source transparency.

For the Ferrar Glacier prototype, the benchmark is:

- true-scale terrain at `1.0x` vertical exaggeration
- terrain geometry at 2 m or better where open elevation data permit
- imagery at 0.5 m or better where legally redistributable imagery is available
- enough close-range fidelity to resolve moraine bands, crevasses, small rock outcrops, and individual large boulders when source data support it
- never synthesize geographic detail merely to appear sharper; displayed detail must be traceable to source data
- show source, acquisition date/range, nominal resolution, and licensing/provenance in the viewer

The existing 15 m LIMA layer is a continent-scale open baseline, not the final close-range imagery target. The renderer should support higher-resolution open imagery and optional user-supplied/licensed imagery without making the open project dependent on proprietary redistribution rights.

## v0.0.1 — Ferrar Glacier proof of concept

Goal: determine whether open Antarctic terrain + imagery can produce a dramatically better exploration experience than conventional globe viewers for one carefully chosen region.

### Phase 1 — source data

- Identify the exact REMA tiles intersecting `regions/ferrar-glacier.json`
- Acquire REMA 10 m terrain for rapid iteration
- Acquire matching full-resolution LIMA imagery
- Validate CRS, bounds, nodata, and vertical datum metadata

### Phase 2 — local scene

- Crop terrain and imagery to the same footprint
- Render the scene in the browser
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
- Identify the highest-resolution legally redistributable imagery intersecting Ferrar Glacier
- Compare the result at matched viewpoints against the Google close-range benchmark
- Document a clean, reproducible local build

## Explicitly out of scope for v0.0.1

- AI reconstruction
- near-daily imagery fusion
- redistribution of commercial imagery without appropriate rights
- whole-continent ingest
- accounts or backend database
- production CDN/infrastructure
