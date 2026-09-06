#!/usr/bin/env python3
"""Discover time-aware NASA observations over an Open Antarctica region.

This script queries NASA's Common Metadata Repository (CMR) for ICESat-2
products intersecting a configured region and writes a compact local metadata
index. It does not download science granules.

The output is intentionally stored under data/processed/ (gitignored) so the
browser can expose temporal provenance without committing large or ephemeral
science metadata to the repository.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
REGIONS_DIR = REPO_ROOT / "regions"
DEFAULT_PRODUCTS = ("ATL06", "ATL11")
PRODUCT_VERSIONS = {
    "ATL06": "007",
    "ATL11": "007",
}
CMR_GRANULES = "https://cmr.earthdata.nasa.gov/search/granules.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Discover time-aware NASA observations intersecting an Open Antarctica region."
    )
    parser.add_argument("--region", required=True, help="Region id, e.g. ferrar-glacier")
    parser.add_argument("--start", required=True, help="UTC start date/time (YYYY-MM-DD or ISO-8601)")
    parser.add_argument("--end", required=True, help="UTC end date/time (YYYY-MM-DD or ISO-8601)")
    parser.add_argument(
        "--products",
        nargs="+",
        default=list(DEFAULT_PRODUCTS),
        choices=sorted(PRODUCT_VERSIONS),
        help="NASA products to query (default: ATL06 ATL11)",
    )
    parser.add_argument("--page-size", type=int, default=2000, help="CMR page size per product")
    parser.add_argument("--json", action="store_true", help="Print full JSON result to stdout")
    return parser.parse_args()


def normalize_time(value: str, end_of_day: bool = False) -> str:
    value = value.strip()
    if len(value) == 10:
        value += "T23:59:59Z" if end_of_day else "T00:00:00Z"
    elif value.endswith("Z"):
        pass
    elif "+" not in value[10:] and value.count("-") <= 2:
        value += "Z"
    return value


def load_region(region_id: str) -> dict:
    path = REGIONS_DIR / f"{region_id}.json"
    if not path.exists():
        raise SystemExit(f"Region configuration not found: {path}")
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def transform_bbox_3031_to_wgs84(bbox: list[float]) -> list[float]:
    if shutil.which("gdaltransform") is None:
        raise SystemExit(
            "gdaltransform is required. Install GDAL or run from the Open Antarctica WSL environment."
        )

    xmin, ymin, xmax, ymax = bbox
    corners = [
        (xmin, ymin),
        (xmin, ymax),
        (xmax, ymin),
        (xmax, ymax),
    ]
    payload = "".join(f"{x} {y}\n" for x, y in corners)
    proc = subprocess.run(
        ["gdaltransform", "-s_srs", "EPSG:3031", "-t_srs", "EPSG:4326"],
        input=payload,
        text=True,
        capture_output=True,
        check=True,
    )

    lonlat: list[tuple[float, float]] = []
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        lonlat.append((float(parts[0]), float(parts[1])))
    if len(lonlat) != 4:
        raise SystemExit(f"Unexpected gdaltransform output: {proc.stdout!r}")

    lons = [p[0] for p in lonlat]
    lats = [p[1] for p in lonlat]
    if max(lons) - min(lons) > 180:
        raise SystemExit(
            "Region crosses the antimeridian; discover_nasa.py needs polygon handling for this footprint."
        )
    return [min(lons), min(lats), max(lons), max(lats)]


def cmr_search(short_name: str, version: str, bbox: list[float], start: str, end: str, page_size: int) -> list[dict]:
    params = {
        "short_name": short_name,
        "version": version,
        "bounding_box": ",".join(f"{v:.8f}" for v in bbox),
        "temporal": f"{start},{end}",
        "page_size": str(page_size),
        "sort_key[]": "start_date",
    }
    url = CMR_GRANULES + "?" + urllib.parse.urlencode(params, doseq=True)
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "OpenAntarctica/0.0.1 (+https://github.com/thehaab/open-antarctica)",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.load(response)
    return payload.get("feed", {}).get("entry", [])


def compact_entry(product: str, version: str, entry: dict) -> dict:
    links = []
    for link in entry.get("links", []):
        href = link.get("href")
        if not href:
            continue
        rel = link.get("rel", "")
        title = link.get("title", "")
        if "data#" in rel or "download" in title.lower() or href.endswith((".h5", ".hdf5")):
            links.append(href)

    return {
        "product": product,
        "version": version,
        "granule_id": entry.get("producer_granule_id") or entry.get("title") or entry.get("id"),
        "concept_id": entry.get("id"),
        "time_start": entry.get("time_start"),
        "time_end": entry.get("time_end"),
        "updated": entry.get("updated"),
        "data_links": links[:4],
    }


def main() -> int:
    args = parse_args()
    region = load_region(args.region)
    if region.get("crs") != "EPSG:3031":
        raise SystemExit("discover_nasa.py currently expects region coordinates in EPSG:3031")

    start = normalize_time(args.start)
    end = normalize_time(args.end, end_of_day=True)
    wgs84_bbox = transform_bbox_3031_to_wgs84(region["bbox"])

    results: dict[str, list[dict]] = {}
    for product in args.products:
        version = PRODUCT_VERSIONS[product]
        print(f"[CMR] {product} v{version} ...", file=sys.stderr)
        entries = cmr_search(product, version, wgs84_bbox, start, end, args.page_size)
        results[product] = [compact_entry(product, version, entry) for entry in entries]
        print(f"[CMR] {product}: {len(entries)} granules", file=sys.stderr)

    generated = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    output = {
        "schema": "open-antarctica-nasa-temporal-index-v1",
        "generated_at": generated,
        "region": {
            "id": region["id"],
            "name": region["name"],
            "source_crs": region["crs"],
            "source_bbox": region["bbox"],
            "wgs84_bbox": wgs84_bbox,
        },
        "query": {
            "start": start,
            "end": end,
            "products": args.products,
        },
        "products": {
            product: {
                "version": PRODUCT_VERSIONS[product],
                "granule_count": len(results[product]),
                "granules": results[product],
            }
            for product in args.products
        },
        "notes": [
            "This is a discovery/provenance index, not downloaded science data.",
            "ATL06 is along-track land-ice height; ATL11 is a repeat-track/crossover height time series.",
            "Actual science granule access may require NASA Earthdata Login.",
        ],
    }

    out_dir = REPO_ROOT / "data" / "processed" / args.region / "nasa"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "nasa-observations.json"
    out_path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")

    if args.json:
        print(json.dumps(output, indent=2))
    else:
        print(f"NASA temporal index: {out_path}")
        print(f"WGS84 bbox: {', '.join(f'{v:.6f}' for v in wgs84_bbox)}")
        for product in args.products:
            print(f"{product} v{PRODUCT_VERSIONS[product]}: {len(results[product])} granules")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
