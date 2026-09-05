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
