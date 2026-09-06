# Scripts

Acquisition and build helpers live here.

Scripts should be safe to rerun and should derive their spatial footprint from files under `regions/` rather than hard-coded one-off coordinates where practical.

## REMA

Before downloading REMA data for a new or changed region, query the authoritative PGC REMA v2 tile index instead of deriving tile IDs by hand:

```bash
python3 scripts/discover_rema.py --region ferrar-glacier
```

For machine-readable output:

```bash
python3 scripts/discover_rema.py --region ferrar-glacier --json
```

Only after the intersecting tiles have been confirmed should the region source configuration and acquisition scripts be used.

## Time-aware NASA observations

Discover NASA observations that intersect a region and a specific time window. An explicit epoch is preferred so the viewer does not accidentally treat the search-window midpoint as the scientific reference time:

```bash
python3 scripts/discover_nasa.py \
  --region ferrar-glacier \
  --start 2026-06-01 \
  --end 2026-09-06 \
  --epoch 2026-09-01
```

The first supported products are ICESat-2 ATL06 and ATL11. The script queries NASA CMR and writes:

```text
data/processed/ferrar-glacier/nasa/nasa-observations.json
```

That file is a local discovery/provenance index. ATL06 is treated as dated along-track land-ice observations. ATL11 is treated as a repeat-track time-series product; its individual cycle dates must be read from the science HDF5 rather than inferred from collection metadata.

The discovery index does **not** mean the science granules have been downloaded or rendered.

### Download and extract the nearest ATL06 science pass

Create a Python environment with the NASA ingest dependencies:

```bash
python3 -m venv .venv-nasa
source .venv-nasa/bin/activate
python3 -m pip install -r scripts/requirements-nasa.txt
```

Then download and extract the nearest dated ATL06 pass recorded in the local discovery index:

```bash
python3 scripts/fetch_atl06.py \
  --region ferrar-glacier
```

`fetch_atl06.py` authenticates through NASA Earthdata using `earthaccess`, downloads candidate ATL06 v007 HDF5 granules around the indexed pass, filters measurements to the configured Ferrar EPSG:3031 footprint, and writes:

```text
data/processed/ferrar-glacier/nasa/atl06-track.json
```

By default only segments with `ATL06_quality_summary == 0` are retained. The output preserves ATL06 `h_li`, latitude, longitude, `delta_time`, beam identity, and local EPSG:3031 x/z coordinates. It deliberately does not deform REMA.

### Validate ATL06 against the rendered REMA surface

Raw PGC REMA and ATL06 `h_li` both use WGS84-ellipsoid heights, but the datasets are not contemporaneous. Before visualizing ATL06 as a surface comparison, sample the exact finest-level REMA height tiles used by the browser:

```bash
python3 scripts/validate_atl06_rema.py \
  --region ferrar-glacier \
  --resolution 2m
```

The validator writes:

```text
data/processed/ferrar-glacier/nasa/atl06-rema-comparison.json
```

It reports ATL06 minus REMA elevation deltas overall and by beam, including robust median/MAD statistics. It does not modify or vertically shift REMA. Differences can contain true elevation change because the REMA mosaic is a multi-date composite while the ATL06 pass is explicitly dated.

After building the index, the local viewer reports the selected epoch. Add an epoch to the viewer URL with, for example:

```text
http://localhost:8000/app/?resolution=2m&epoch=2026-09-01
```

Actual ATL06 track rendering follows this validation step.
