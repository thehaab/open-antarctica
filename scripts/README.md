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

Discover NASA observations that intersect a region and a specific time window:

```bash
python3 scripts/discover_nasa.py \
  --region ferrar-glacier \
  --start 2026-06-01 \
  --end 2026-09-06
```

The first supported products are ICESat-2 ATL06 and ATL11. The script queries NASA CMR and writes:

```text
data/processed/ferrar-glacier/nasa/nasa-observations.json
```

That file is a local discovery/provenance index. It records matching granule IDs and acquisition times but does **not** mean the science granules have been downloaded or rendered.

After building the index, the local viewer will report the selected epoch and the number of matching NASA granules. Add an epoch to the viewer URL with, for example:

```text
http://localhost:8000/app/?resolution=2m&epoch=2026-09-01
```

Actual ICESat-2 science-data ingest and visualization are separate pipeline steps.
