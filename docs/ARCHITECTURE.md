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
```

## Likely viewer

CesiumJS is the leading candidate because it is open source, WebGL-based, and designed for streamed terrain and imagery.

The prototype should avoid making Cesium ion a hard dependency. Temporary use for experiments is acceptable, but the target architecture is reproducible and self-hostable.

## Progressive resolution

Prototype development should begin with REMA 10 m terrain for fast iteration, then switch the same footprint to 2 m terrain after alignment and camera behavior are validated.

Future continent-scale rendering should use level-of-detail streaming rather than loading full-resolution terrain everywhere.

## Projection

Source data is naturally handled in Antarctic Polar Stereographic (`EPSG:3031`).

Projection/reprojection decisions must be explicit and reproducible in the pipeline. Avoid assuming Web Mercator for polar source data.
