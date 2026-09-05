# Open Antarctica

An open-source 3D explorer for Antarctica using public elevation, satellite imagery, and geospatial data.

## Why

Most people will never physically visit Antarctica, yet the continent is one of the most extraordinary landscapes on Earth. Open Antarctica aims to make high-quality exploration accessible to anyone while keeping source data, provenance, licensing, and processing transparent.

## First milestone: v0.0.1 — Ferrar Glacier

The first prototype region is a ~61 km × 17.8 km footprint around Ferrar Glacier / southern McMurdo Dry Valleys in Victoria Land.

Initial goals:

- Render REMA terrain in 3D
- Drape USGS LIMA imagery over the terrain
- Support orbit, tilt, zoom, and free-flight exploration
- Add adjustable vertical exaggeration
- Add adjustable simulated sunlight / hillshade
- Show dataset attribution and provenance
- Keep the entire prototype reproducible with open tools
- Avoid checking large geospatial datasets into Git

## Initial region

CRS: `EPSG:3031`

BBOX:

```text
369585.9375,
-1276268.2255506516,
430625.0,
-1258494.7880506516
```

Approximate center:

```text
77.8123° S, 162.4794° E
```

See [`regions/ferrar-glacier.json`](regions/ferrar-glacier.json).

## Project structure

```text
app/          Browser viewer
pipeline/     DEM and imagery processing
regions/      Reproducible region definitions
scripts/      Acquisition/build helpers
docs/         Architecture, data sources, attribution
data/         Local-only datasets (ignored by Git)
```

## Data policy

Large source and derived rasters do **not** belong in Git. The repository should contain:

1. region definitions,
2. acquisition scripts,
3. processing recipes,
4. metadata/provenance,
5. viewer code.

Local data belongs under `data/`, which is ignored except for its README.

## License

Project code is intended to be licensed under the Apache License 2.0.

Source datasets retain their own licenses and attribution requirements. See [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md) and [`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md).
