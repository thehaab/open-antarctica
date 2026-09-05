# REMA acquisition — Ferrar Glacier

This document records the first terrain-source selection for Open Antarctica v0.0.1.

## Source footprint

The Ferrar Glacier prototype footprint is stored in `regions/ferrar-glacier.json` in Antarctic Polar Stereographic (`EPSG:3031`):

```text
xmin   369585.9375
ymin -1276268.2255506516
xmax   430625.0
ymax -1258494.7880506516
```

The footprint is approximately 61 km east-west by 17.8 km north-south.

## REMA tile selection

PGC's REMA grid is named by row/column position. The first tile index advances north-south and the second advances east-west. The 100 km parent grid begins at x=-4,000,000 m, y=-4,000,000 m in EPSG:3031.

The Ferrar footprint crosses the east-west parent-tile boundary at `x = 400000 m` and remains between `y = -1300000 m` and `y = -1200000 m`.

Therefore the exact source set is:

### 10 m prototype

- `28_44_10m_v2.0.tar.gz`
- `28_45_10m_v2.0.tar.gz`

These are full 100 km x 100 km 10 m parent tiles. PGC lists them at approximately 729 MB and 741 MB respectively.

### 2 m v0.0.1 terrain

Each parent is subdivided into four 50 km x 50 km subtiles. PGC's subtile convention is:

```text
2_1 | 2_2
----+----
1_1 | 1_2
```

The Ferrar footprint is in the lower half of both parents, spanning the right half of `28_44` and the left half of `28_45`. Therefore only these two 2 m subtiles intersect the footprint:

- `28_44_1_2_2m_v2.0.tar.gz` — lower-right subtile of `28_44`
- `28_45_1_1_2m_v2.0.tar.gz` — lower-left subtile of `28_45`

## Correction note

The first acquisition attempt incorrectly reversed the REMA row/column tile identifiers and downloaded `44_28` and `45_28`. The crop preflight exposed the mistake because the requested Ferrar window fell completely outside those rasters. The source identifiers above are the corrected values.

## Download

On Windows, use the PowerShell downloader:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fetch_rema.ps1 -Region ferrar-glacier -Resolution 10m
```

The Python downloader remains available where Python is installed:

```bash
python scripts/fetch_rema.py --region ferrar-glacier --resolution 10m
```

Later, acquire the 2 m terrain by changing the resolution to `2m`.

Downloads are stored under:

```text
data/raw/rema/<resolution>/archives/
```

and the primary `*_dem.tif` files are extracted under:

```text
data/raw/rema/<resolution>/dem/
```

Interrupted downloads can be resumed when the PGC server supports HTTP Range requests.

## Next processing step

After acquisition, the configured DEMs are mosaicked and cropped to the exact region BBOX:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_rema_crop.ps1 -Region ferrar-glacier -Resolution 10m
```

Expected sequence:

```text
PGC archives
    -> extract *_dem.tif
    -> validate source extents
    -> mosaic configured source DEMs
    -> crop exact EPSG:3031 BBOX
    -> validate dimensions / NoData / valid pixels
    -> generate viewer terrain representation
```

## Data policy

Do not commit downloaded archives, GeoTIFFs, derived terrain tiles, or caches to Git. The repository stores only source identifiers, URLs, processing code, and provenance.
