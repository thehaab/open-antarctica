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

PGC's REMA grid uses 100 km x 100 km parent tiles. At 2 m resolution, each parent tile is divided into four 50 km x 50 km subtiles.

The Ferrar footprint crosses the parent-tile boundary at `x = 400000 m` and remains between `y = -1300000 m` and `y = -1250000 m`.

Therefore the exact source set is:

### 10 m prototype

- `44_28_10m_v2.0.tar.gz`
- `45_28_10m_v2.0.tar.gz`

These are full 100 km x 100 km 10 m parent tiles. The current PGC directory listings are approximately 743 MB and 740 MB respectively.

### 2 m v0.0.1 terrain

- `44_28_1_2_2m_v2.0.tar.gz` — lower-right subtile of `44_28`
- `45_28_1_1_2m_v2.0.tar.gz` — lower-left subtile of `45_28`

The current PGC directory listings are approximately 1.4 GB and 1.5 GB respectively.

Only those two 2 m subtiles intersect the prototype footprint.

## Download

The repository includes a standard-library Python downloader that reads URLs directly from the region definition.

Start with the 10 m prototype:

```bash
python scripts/fetch_rema.py --region ferrar-glacier --resolution 10m
```

Later, acquire the 2 m source terrain with:

```bash
python scripts/fetch_rema.py --region ferrar-glacier --resolution 2m
```

Downloads are written under:

```text
data/raw/rema/v2.0/<resolution>/archives/
```

and the script extracts only the primary `*_dem.tif` from each archive into:

```text
data/raw/rema/v2.0/<resolution>/dem/
```

Interrupted downloads leave a `.part` file and will attempt to resume on the next run when the PGC server supports HTTP Range requests.

## Next processing step

After acquisition, the two DEMs should be mosaicked and cropped to the exact region BBOX. That processing step will be implemented separately so acquisition remains a simple, auditable stage.

Expected sequence:

```text
PGC archives
    -> extract *_dem.tif
    -> mosaic source DEMs
    -> crop exact EPSG:3031 BBOX
    -> validate dimensions / NoData / elevation metadata
    -> generate viewer terrain representation
```

## Data policy

Do not commit downloaded archives, GeoTIFFs, derived terrain tiles, or caches to Git. The repository stores only source identifiers, URLs, processing code, and provenance.
