# Architecture

## v0.0.1 principles

The first release is intentionally small:

- one region,
- local processing,
- browser-based 3D rendering,
- no backend database,
- no user accounts,
- no AI reconstruction,
- no commercial imagery dependency.

## Conceptual pipeline

```text
REMA DEM ---------------------> crop / prepare terrain ----+
                                                           |
                                                           v
                                                     3D viewer
                                                           ^
                                                           |
LIMA imagery -----------------> crop / tile imagery --------+

NASA temporal observations --> discovery / provenance -----+
                            \-> future time-aware layers ----+
```

## Time is a first-class coordinate

Open Antarctica must not silently treat observations from different years as one coherent surface. Antarctica is dynamic, especially across glaciers, crevasse fields, grounding zones, ice margins, and calving fronts.

The data model therefore treats time alongside horizontal position and elevation:

```text
x, y, z, t
```

Every dynamic observation should retain:

- acquisition start/end time,
- source/product/version,
- nominal spatial resolution or sampling character,
- processing/maturity level where relevant,
- provenance and access/licensing information.

A viewer epoch may be selected by the user. Source layers from other epochs are displayed as temporally mismatched unless a scientifically defensible transformation is available. The project must never warp or synthesize geographic change merely to make layers look aligned.

REMA is currently treated as a high-resolution geometric reference rather than a claim about the surface at a single date. LIMA is a historical optical reference mosaic rather than a single-date image. NASA ICESat-2 and NISAR products are candidates for the time-aware observational backbone.

## NASA temporal index

`scripts/discover_nasa.py` queries NASA CMR for time-stamped observations intersecting a configured region. The first supported products are:

- ICESat-2 ATL06: along-track land-ice surface height,
- ICESat-2 ATL11: repeat-track/crossover ice-sheet height time series.

The generated local `nasa-observations.json` is a discovery/provenance index only. It does not imply that the referenced science granules have been downloaded or rendered.

## Likely viewer

CesiumJS is the leading candidate because it is open source, WebGL-based, and designed for streamed terrain and imagery.

The prototype should avoid making Cesium ion a hard dependency. Temporary use for experiments is acceptable, but the target architecture is reproducible and self-hostable.

## Progressive resolution

Prototype development should begin with REMA 10 m terrain for fast iteration, then switch the same footprint to 2 m terrain after alignment and camera behavior are validated.

Future continent-scale rendering should use level-of-detail streaming rather than loading full-resolution terrain everywhere.

## Projection

Source data is naturally handled in Antarctic Polar Stereographic (`EPSG:3031`).

Projection/reprojection decisions must be explicit and reproducible in the pipeline. Avoid assuming Web Mercator for polar source data.
