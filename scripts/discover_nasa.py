#!/usr/bin/env python3
"""Discover time-aware NASA observations over an Open Antarctica region.

This script queries NASA's Common Metadata Repository (CMR) for ICESat-2
products intersecting a configured region and writes a compact local metadata
index. It does not download science granules.

ATL06 is treated as a dated observation product: the first query is the exact
user-requested time window, and if that window is empty a mission-era fallback
finds observations nearest the reference epoch.

ATL11 is different: each spatial granule is a repeat-track height time series,
not a single acquisition. We therefore index spatially relevant ATL11 series
over the mission era and do not pretend the granule metadata start date is the
observation date nearest the selected epoch. Actual ATL11 cycle epochs must be
read from the science HDF5 file.

The output is stored under data/processed/ (gitignored) so the browser can
expose temporal provenance without committing large or ephemeral science data.
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
PRODUCT_TEMPORAL_MODEL = {
    "ATL06": "dated_observation",
    "ATL11": "repeat_track_time_series",
}
PRODUCT_MISSION_START = {
    "ATL06": dt.datetime(2018, 10, 14, tzinfo=dt.timezone.utc),
    "ATL11": dt.datetime(2019, 3, 29, tzinfo=dt.timezone.utc),
}
PRODUCT_COLLECTION_TEMPORAL = {
    "ATL11": {
        "start": "2019-03-29T00:00:00Z",
        "end": "present",
        "nominal_resolution": "91 days",
    },
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
        "--epoch",
        help="Optional reference epoch used to rank dated observations. Defaults to the search-window midpoint.",
    )
    parser.add_argument(
        "--products",
        nargs="+",
        default=list(DEFAULT_PRODUCTS),
        choices=sorted(PRODUCT_VERSIONS),
        help="NASA products to query (default: ATL06 ATL11)",
    )
    parser.add_argument("--page-size", type=int, default=2000, help="CMR page size per product")
    parser.add_argument(
        "--nearest-limit",
        type=int,
        default=8,
        help="Number of fallback ATL06 granules or ATL11 series descriptors to retain locally",
    )
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


def parse_utc(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def format_utc(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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


def entry_time(entry: dict) -> dt.datetime | None:
    value = entry.get("time_start") or entry.get("time_end")
    if not value:
        return None
    try:
        return parse_utc(value)
    except ValueError:
        return None


def temporal_distance_seconds(entry: dict, reference: dt.datetime) -> float:
    value = entry_time(entry)
    if value is None:
        return float("inf")
    return abs((value - reference).total_seconds())


def discover_atl06(
    version: str,
    bbox: list[float],
    start: str,
    end: str,
    start_dt: dt.datetime,
    end_dt: dt.datetime,
    reference_dt: dt.datetime,
    page_size: int,
    nearest_limit: int,
    now: dt.datetime,
) -> dict:
    print(f"[CMR] ATL06 v{version} exact window ...", file=sys.stderr)
    exact_entries = cmr_search("ATL06", version, bbox, start, end, page_size)
    exact_compact = [compact_entry("ATL06", version, entry) for entry in exact_entries]
    print(f"[CMR] ATL06: {len(exact_entries)} exact-window granules", file=sys.stderr)

    nearest_compact: list[dict] = []
    fallback_window = None
    if not exact_entries:
        fallback_start_dt = PRODUCT_MISSION_START["ATL06"]
        fallback_end_dt = max(min(now, end_dt), start_dt)
        if fallback_end_dt < fallback_start_dt:
            fallback_end_dt = now
        fallback_start = format_utc(fallback_start_dt)
        fallback_end = format_utc(fallback_end_dt)
        fallback_window = {"start": fallback_start, "end": fallback_end}
        print(
            f"[CMR] ATL06: no exact match; searching mission-era observations "
            f"{fallback_start} -> {fallback_end} ...",
            file=sys.stderr,
        )
        fallback_entries = cmr_search(
            "ATL06", version, bbox, fallback_start, fallback_end, page_size
        )
        fallback_compact = [compact_entry("ATL06", version, entry) for entry in fallback_entries]
        fallback_compact.sort(key=lambda entry: temporal_distance_seconds(entry, reference_dt))
        nearest_compact = fallback_compact[: max(nearest_limit, 0)]
        print(
            f"[CMR] ATL06: {len(fallback_entries)} mission-era matches; "
            f"retaining {len(nearest_compact)} nearest",
            file=sys.stderr,
        )

    nearest_days = None
    nearest_relation = None
    if nearest_compact:
        nearest_time = entry_time(nearest_compact[0])
        if nearest_time is not None:
            signed_days = (nearest_time - reference_dt).total_seconds() / 86400.0
            nearest_days = round(abs(signed_days), 3)
            nearest_relation = "after" if signed_days > 0 else "before" if signed_days < 0 else "at"

    return {
        "version": version,
        "temporal_model": PRODUCT_TEMPORAL_MODEL["ATL06"],
        "granule_count": len(exact_compact),
        "exact_granule_count": len(exact_compact),
        "granules": exact_compact,
        "nearest_granules": nearest_compact,
        "nearest_distance_days": nearest_days,
        "nearest_relation": nearest_relation,
        "fallback_window": fallback_window,
    }


def discover_atl11(
    version: str,
    bbox: list[float],
    page_size: int,
    retain_limit: int,
    now: dt.datetime,
) -> dict:
    mission_start = PRODUCT_MISSION_START["ATL11"]
    mission_end = now
    start = format_utc(mission_start)
    end = format_utc(mission_end)
    print(
        f"[CMR] ATL11 v{version} spatial time-series index {start} -> {end} ...",
        file=sys.stderr,
    )
    entries = cmr_search("ATL11", version, bbox, start, end, page_size)
    compact = [compact_entry("ATL11", version, entry) for entry in entries]
    retained = compact[: max(retain_limit, 0)]
    print(
        f"[CMR] ATL11: {len(entries)} spatial time-series granules; retaining {len(retained)} descriptors",
        file=sys.stderr,
    )
    return {
        "version": version,
        "temporal_model": PRODUCT_TEMPORAL_MODEL["ATL11"],
        "series_granule_count": len(compact),
        "series_granules": retained,
        "collection_temporal_coverage": PRODUCT_COLLECTION_TEMPORAL["ATL11"],
        "notes": [
            "ATL11 granules are repeat-track height time series, not single-date observations.",
            "Do not interpret CMR granule time_start as the observation nearest a selected epoch.",
            "Actual cycle epochs and heights must be read from the ATL11 HDF5 science data.",
        ],
    }


def main() -> int:
    args = parse_args()
    region = load_region(args.region)
    if region.get("crs") != "EPSG:3031":
        raise SystemExit("discover_nasa.py currently expects region coordinates in EPSG:3031")

    start = normalize_time(args.start)
    end = normalize_time(args.end, end_of_day=True)
    start_dt = parse_utc(start)
    end_dt = parse_utc(end)
    if end_dt < start_dt:
        raise SystemExit("--end must not be earlier than --start")

    if args.epoch:
        reference_dt = parse_utc(normalize_time(args.epoch))
        reference_source = "explicit_epoch"
    else:
        reference_dt = start_dt + (end_dt - start_dt) / 2
        reference_source = "search_window_midpoint"

    wgs84_bbox = transform_bbox_3031_to_wgs84(region["bbox"])
    now = dt.datetime.now(dt.timezone.utc)

    results: dict[str, dict] = {}
    for product in args.products:
        version = PRODUCT_VERSIONS[product]
        if product == "ATL06":
            results[product] = discover_atl06(
                version,
                wgs84_bbox,
                start,
                end,
                start_dt,
                end_dt,
                reference_dt,
                args.page_size,
                args.nearest_limit,
                now,
            )
        elif product == "ATL11":
            results[product] = discover_atl11(
                version,
                wgs84_bbox,
                args.page_size,
                args.nearest_limit,
                now,
            )

    generated = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    output = {
        "schema": "open-antarctica-nasa-temporal-index-v3",
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
            "reference_time": format_utc(reference_dt),
            "reference_source": reference_source,
            "products": args.products,
        },
        "products": results,
        "notes": [
            "This is a discovery/provenance index, not downloaded science data.",
            "ATL06 is a dated along-track land-ice height observation product.",
            "ATL11 is a spatially organized repeat-track height time series; its internal cycle dates must be read from HDF5.",
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
        print(f"Reference time: {format_utc(reference_dt)} ({reference_source})")
        for product in args.products:
            info = results[product]
            if info.get("temporal_model") == "repeat_track_time_series":
                coverage = info["collection_temporal_coverage"]
                print(
                    f"{product} v{info['version']}: {info['series_granule_count']} spatial time-series granules; "
                    f"collection coverage {coverage['start'][:10]} -> {coverage['end']} ({coverage['nominal_resolution']})"
                )
                continue

            line = f"{product} v{info['version']}: {info['exact_granule_count']} exact-window granules"
            if info["nearest_granules"]:
                nearest = info["nearest_granules"][0]
                relation = info.get("nearest_relation") or "from"
                line += (
                    f"; nearest {nearest.get('time_start') or nearest.get('time_end')} "
                    f"({info['nearest_distance_days']} days {relation} reference)"
                )
            print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
