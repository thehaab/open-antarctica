#!/usr/bin/env python3
"""Discover REMA mosaic tiles intersecting an Open Antarctica region.

Queries the Polar Geospatial Center's authoritative REMA v2 tile index feature
service using the region's EPSG:3031 bounding box. This deliberately avoids
hand-derived REMA tile IDs.

The ArcGIS index is authoritative for tile geometry/IDs, but its historical
``fileurl`` field may contain an obsolete ``/mosaic/2.0/`` path. For downloads
we therefore derive the canonical current PGC HTTP URL from the authoritative
release, supertile, and DEM ID using PGC's documented ``/mosaic/vX.Y/`` layout.

Uses only the Python standard library.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SERVICE = (
    "https://services.arcgis.com/8df8p0NlLFEShl0r/ArcGIS/rest/services/"
    "PGC_REMA_v2_Tile_Index/FeatureServer/0/query"
)
PGC_HTTP_ROOT = "https://data.pgc.umn.edu/elev/dem/setsm/REMA/mosaic"
USER_AGENT = "OpenAntarctica/0.0.1 (+https://github.com/thehaab/open-antarctica)"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def load_region(region_id: str) -> dict:
    path = repo_root() / "regions" / f"{region_id}.json"
    if not path.exists():
        raise SystemExit(f"Region definition not found: {path}")
    cfg = json.loads(path.read_text(encoding="utf-8"))
    if cfg.get("crs") != "EPSG:3031":
        raise SystemExit(
            f"REMA discovery currently requires EPSG:3031; region uses {cfg.get('crs')!r}"
        )
    return cfg


def query_index(bbox: list[float]) -> dict:
    xmin, ymin, xmax, ymax = bbox
    geometry = {
        "xmin": xmin,
        "ymin": ymin,
        "xmax": xmax,
        "ymax": ymax,
        "spatialReference": {"wkid": 3031},
    }
    params = {
        "where": "1=1",
        "geometry": json.dumps(geometry, separators=(",", ":")),
        "geometryType": "esriGeometryEnvelope",
        "inSR": "3031",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": (
            "objectid,dem_id,tile,supertile,gsd,epsg,release_ver,"
            "data_percent,fileurl,s3url"
        ),
        "returnGeometry": "false",
        "f": "json",
    }
    url = f"{SERVICE}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            payload = json.load(response)
    except urllib.error.URLError as exc:
        raise SystemExit(f"REMA tile-index request failed: {exc}") from exc

    if "error" in payload:
        raise SystemExit(
            "REMA tile-index service returned an error:\n"
            + json.dumps(payload["error"], indent=2)
        )
    return payload


def canonical_pgc_url(attrs: dict) -> str | None:
    """Build the current PGC HTTP archive URL from authoritative index fields."""
    dem_id = attrs.get("dem_id")
    supertile = attrs.get("supertile")
    release = attrs.get("release_ver")
    gsd = attrs.get("gsd")
    if not dem_id or not supertile or release is None or gsd is None:
        return None

    release_text = str(release)
    if not release_text.startswith("v"):
        release_text = "v" + release_text

    try:
        gsd_text = f"{int(float(gsd))}m"
    except (TypeError, ValueError):
        return None

    return (
        f"{PGC_HTTP_ROOT}/{release_text}/{gsd_text}/{supertile}/"
        f"{dem_id}.tar.gz"
    )


def clean_feature(feature: dict) -> dict:
    attrs = dict(feature.get("attributes") or {})
    attrs = {k: v for k, v in attrs.items() if v is not None}
    canonical = canonical_pgc_url(attrs)
    if canonical:
        attrs["canonical_fileurl"] = canonical
    return attrs


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Discover authoritative REMA v2 tiles intersecting a configured region."
    )
    parser.add_argument("--region", default="ferrar-glacier")
    parser.add_argument(
        "--json",
        action="store_true",
        help="print machine-readable JSON instead of the human summary",
    )
    args = parser.parse_args()

    cfg = load_region(args.region)
    bbox = [float(v) for v in cfg["bbox"]]
    payload = query_index(bbox)
    features = [clean_feature(f) for f in payload.get("features", [])]

    # Stable output makes diffs and debugging easier.
    features.sort(
        key=lambda f: (
            str(f.get("supertile", "")),
            str(f.get("tile", "")),
            str(f.get("dem_id", "")),
        )
    )

    if args.json:
        print(
            json.dumps(
                {
                    "region": args.region,
                    "name": cfg.get("name"),
                    "crs": cfg.get("crs"),
                    "bbox": bbox,
                    "service": SERVICE,
                    "features": features,
                },
                indent=2,
            )
        )
        return 0

    print("Open Antarctica - authoritative REMA tile discovery")
    print(f"Region: {cfg.get('name', args.region)}")
    print(f"CRS:    {cfg.get('crs')}")
    print(
        "BBOX:   "
        f"{bbox[0]:.4f}, {bbox[1]:.4f}, {bbox[2]:.4f}, {bbox[3]:.4f}"
    )
    print(f"Matches: {len(features)}")
    print()

    if not features:
        print("No REMA v2 index polygons intersect this region.")
        return 1

    for i, attrs in enumerate(features, 1):
        print(f"[{i}] dem_id={attrs.get('dem_id')}")
        print(f"    tile={attrs.get('tile')}  supertile={attrs.get('supertile')}")
        print(
            f"    gsd={attrs.get('gsd')}  epsg={attrs.get('epsg')}  "
            f"release={attrs.get('release_ver')}  valid={attrs.get('data_percent')}"
        )
        if attrs.get("canonical_fileurl"):
            print(f"    pgc_http={attrs['canonical_fileurl']}")
        raw_url = attrs.get("fileurl")
        if raw_url and raw_url != attrs.get("canonical_fileurl"):
            print(f"    index_fileurl={raw_url}  [index field may be stale]")
        if attrs.get("s3url"):
            print(f"    s3url={attrs['s3url']}")
        print()

    supertiles = sorted({str(f["supertile"]) for f in features if f.get("supertile")})
    tiles = sorted({str(f["tile"]) for f in features if f.get("tile")})
    if supertiles:
        print("Unique supertiles: " + ", ".join(supertiles))
    if tiles:
        print("Unique tiles:      " + ", ".join(tiles))

    print()
    print("Source: PGC REMA v2 Tile Index feature service (EPSG:3031).")
    print("Download URLs: canonical PGC HTTP mosaic layout derived from index fields.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
