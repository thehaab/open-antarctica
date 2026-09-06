#!/usr/bin/env python3
"""Build a browser-ready, multi-date ICESat-2 ATL06 series for an Open Antarctica region.

This is the temporal follow-on to fetch_atl06.py + validate_atl06_rema.py. It:

1. queries the mission-era CMR record for ATL06 observations intersecting the region,
2. chooses a small set of dates distributed across the available mission history,
3. downloads the corresponding ATL06 v007 HDF5 granules through Earthdata,
4. extracts good in-region land-ice segments, and
5. samples the exact finest-level REMA viewer tiles under every segment.

The result is data/processed/<region>/nasa/atl06-series.json. REMA is never
modified; delta_h_m is always ATL06 h_li minus the rendered REMA elevation.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import pathlib

from discover_nasa import PRODUCT_MISSION_START, cmr_search, compact_entry, entry_time, format_utc
from validate_atl06_rema import TileSampler, stats

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
REGIONS_DIR = REPO_ROOT / "regions"
BEAMS = ("gt1l", "gt1r", "gt2l", "gt2r", "gt3l", "gt3r")


def need_modules():
    try:
        import earthaccess  # type: ignore
        import h5py  # type: ignore
        import numpy as np  # type: ignore
        from pyproj import Transformer  # type: ignore
    except ImportError as exc:
        raise SystemExit(
            "Missing NASA ingest dependencies. Activate .venv-nasa and run:\n"
            "  python3 -m pip install -r scripts/requirements-nasa.txt\n"
            f"Import error: {exc}"
        )
    return earthaccess, h5py, np, Transformer


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build a time-distributed ATL06 series over a region")
    p.add_argument("--region", required=True, help="Region id, e.g. ferrar-glacier")
    p.add_argument("--resolution", default="2m", help="Viewer REMA resolution used for comparison")
    p.add_argument("--passes", type=int, default=8, help="Number of dated passes to sample across the mission (default: 8)")
    p.add_argument(
        "--window-hours",
        type=float,
        default=2.0,
        help="Earthdata half-window around each sampled CMR observation (default: 2 h)",
    )
    p.add_argument("--max-results", type=int, default=20, help="Maximum Earthdata granules per sampled pass")
    p.add_argument("--page-size", type=int, default=2000, help="CMR mission-era search page size")
    p.add_argument("--include-flagged", action="store_true", help="Keep ATL06_quality_summary != 0 segments")
    p.add_argument(
        "--outlier-limit-m",
        type=float,
        default=100.0,
        help="Absolute ATL06-REMA delta excluded from robust pass statistics (default: 100 m)",
    )
    return p.parse_args()


def load_json(path: pathlib.Path) -> dict:
    if not path.exists():
        raise SystemExit(f"Required file not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def parse_utc(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def evenly_spaced_dates(entries: list[dict], count: int) -> list[dict]:
    """Pick CMR anchors distributed across unique UTC dates."""
    dated = []
    seen_days: set[str] = set()
    for entry in sorted(entries, key=lambda item: entry_time(item) or dt.datetime.max.replace(tzinfo=dt.timezone.utc)):
        when = entry_time(entry)
        if when is None:
            continue
        day = when.date().isoformat()
        if day in seen_days:
            continue
        seen_days.add(day)
        dated.append(entry)

    count = max(int(count), 1)
    if len(dated) <= count:
        return dated
    if count == 1:
        return [dated[-1]]

    indices = [round(i * (len(dated) - 1) / (count - 1)) for i in range(count)]
    return [dated[i] for i in indices]


def finite_float(value) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def extract_pass(
    files: list[pathlib.Path],
    h5py,
    np,
    transformer,
    sampler: TileSampler,
    bbox: list[float],
    x_center: float,
    y_center: float,
    include_flagged: bool,
    outlier_limit_m: float,
) -> tuple[list[dict], dict, list[str]]:
    xmin, ymin, xmax, ymax = bbox
    tracks: list[dict] = []
    all_deltas: list[float] = []
    robust_deltas: list[float] = []
    by_beam: dict[str, list[float]] = {}
    flagged_dropped = 0
    unsampled = 0
    used_files: list[str] = []

    for path in files:
        file_points = 0
        try:
            h5 = h5py.File(path, "r")
        except OSError:
            continue
        with h5:
            for beam in BEAMS:
                group_path = f"{beam}/land_ice_segments"
                if group_path not in h5:
                    continue
                group = h5[group_path]
                required = ("latitude", "longitude", "h_li", "delta_time", "atl06_quality_summary")
                if any(name not in group for name in required):
                    continue

                lat = np.asarray(group["latitude"][:])
                lon = np.asarray(group["longitude"][:])
                height = np.asarray(group["h_li"][:])
                delta_time = np.asarray(group["delta_time"][:])
                quality = np.asarray(group["atl06_quality_summary"][:])
                xs, ys = transformer.transform(lon, lat)

                mask = (
                    np.isfinite(lat)
                    & np.isfinite(lon)
                    & np.isfinite(height)
                    & np.isfinite(delta_time)
                    & np.isfinite(xs)
                    & np.isfinite(ys)
                    & (xs >= xmin)
                    & (xs <= xmax)
                    & (ys >= ymin)
                    & (ys <= ymax)
                )
                if not include_flagged:
                    flagged_dropped += int(np.count_nonzero(mask & (quality != 0)))
                    mask &= quality == 0

                idxs = np.nonzero(mask)[0]
                if idxs.size == 0:
                    continue

                points = []
                beam_deltas = by_beam.setdefault(beam, [])
                for i in idxs.tolist():
                    atl_h = float(height[i])
                    x_proj = float(xs[i])
                    y_proj = float(ys[i])
                    if not finite_float(atl_h):
                        continue
                    rema_h = sampler.sample(x_proj, y_proj)
                    if rema_h is None:
                        unsampled += 1
                        continue
                    delta = atl_h - rema_h
                    all_deltas.append(delta)
                    beam_deltas.append(delta)
                    if abs(delta) <= outlier_limit_m:
                        robust_deltas.append(delta)
                    points.append({
                        "x_m": round(x_proj - x_center, 3),
                        "z_m": round(y_center - y_proj, 3),
                        "latitude": round(float(lat[i]), 8),
                        "longitude": round(float(lon[i]), 8),
                        "h_li_m": round(atl_h, 3),
                        "rema_h_m": round(rema_h, 3),
                        "delta_h_m": round(delta, 3),
                        "delta_time_s": round(float(delta_time[i]), 6),
                        "quality": int(quality[i]),
                    })

                if points:
                    tracks.append({"file": path.name, "beam": beam, "points": points})
                    file_points += len(points)

        if file_points:
            used_files.append(path.name)

    summary = {
        "sampled_points": len(all_deltas),
        "unsampled_points": unsampled,
        "flagged_segments_dropped": flagged_dropped,
        "extreme_outlier_limit_m": outlier_limit_m,
        "extreme_outlier_count": len(all_deltas) - len(robust_deltas),
        "all_points": stats(all_deltas),
        "robust_points": stats(robust_deltas),
        "by_beam": {
            beam: stats([v for v in values if abs(v) <= outlier_limit_m])
            for beam, values in sorted(by_beam.items())
        },
    }
    return tracks, summary, used_files


def main() -> int:
    args = parse_args()
    earthaccess, h5py, np, Transformer = need_modules()

    region = load_json(REGIONS_DIR / f"{args.region}.json")
    if region.get("crs") != "EPSG:3031":
        raise SystemExit("fetch_atl06_series.py currently expects EPSG:3031 region coordinates")

    nasa_dir = REPO_ROOT / "data" / "processed" / args.region / "nasa"
    index = load_json(nasa_dir / "nasa-observations.json")
    wgs84_bbox = index.get("region", {}).get("wgs84_bbox")
    if not wgs84_bbox or len(wgs84_bbox) != 4:
        raise SystemExit("NASA index is missing region.wgs84_bbox; rerun scripts/discover_nasa.py")

    viewer_dir = REPO_ROOT / "data" / "processed" / args.region / "viewer" / args.resolution
    terrain_meta = load_json(viewer_dir / "terrain-lod.json")
    sampler = TileSampler(viewer_dir, terrain_meta)

    xmin, ymin, xmax, ymax = [float(v) for v in region["bbox"]]
    x_center = (xmin + xmax) * 0.5
    y_center = (ymin + ymax) * 0.5
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:3031", always_xy=True)

    mission_start = PRODUCT_MISSION_START["ATL06"]
    query_end_raw = index.get("query", {}).get("end")
    now = dt.datetime.now(dt.timezone.utc)
    mission_end = min(parse_utc(query_end_raw), now) if query_end_raw else now
    print(
        f"[CMR] ATL06 v007 mission sampling {format_utc(mission_start)} -> {format_utc(mission_end)} ..."
    )
    cmr_entries = cmr_search(
        "ATL06",
        "007",
        [float(v) for v in wgs84_bbox],
        format_utc(mission_start),
        format_utc(mission_end),
        max(args.page_size, 1),
    )
    compact = [compact_entry("ATL06", "007", entry) for entry in cmr_entries]
    anchors = evenly_spaced_dates(compact, max(args.passes, 1))
    if not anchors:
        raise SystemExit("CMR returned no dated ATL06 observations for this footprint")

    print(f"CMR matches: {len(cmr_entries)} · selected temporal anchors: {len(anchors)}")
    print("Authenticating with NASA Earthdata ...")
    earthaccess.login()

    raw_dir = REPO_ROOT / "data" / "raw" / "icesat2" / "atl06" / "v007"
    raw_dir.mkdir(parents=True, exist_ok=True)
    half_window = dt.timedelta(hours=max(args.window_hours, 0.25))
    passes: list[dict] = []

    for number, anchor in enumerate(anchors, start=1):
        anchor_time = entry_time(anchor)
        if anchor_time is None:
            continue
        search_start = anchor_time - half_window
        search_end = anchor_time + half_window
        print(
            f"[{number}/{len(anchors)}] {anchor_time.date()} · Earthdata "
            f"{format_utc(search_start)} -> {format_utc(search_end)}"
        )
        results = earthaccess.search_data(
            short_name="ATL06",
            version="007",
            bounding_box=tuple(float(v) for v in wgs84_bbox),
            temporal=(format_utc(search_start), format_utc(search_end)),
            count=max(args.max_results, 1),
        )
        if not results:
            print("  no Earthdata granules; skipping")
            continue

        downloaded = earthaccess.download(results, str(raw_dir))
        files = [
            pathlib.Path(str(path))
            for path in downloaded
            if pathlib.Path(str(path)).suffix.lower() in {".h5", ".hdf5"}
        ]
        if not files:
            print("  no HDF5 files returned; skipping")
            continue

        tracks, summary, used_files = extract_pass(
            files,
            h5py,
            np,
            transformer,
            sampler,
            [xmin, ymin, xmax, ymax],
            x_center,
            y_center,
            args.include_flagged,
            args.outlier_limit_m,
        )
        if not tracks or not summary["sampled_points"]:
            print("  no usable in-region segments; skipping")
            continue

        robust = summary.get("robust_points", {})
        print(
            f"  {summary['sampled_points']} segments · median Δh {robust.get('median_m')} m · "
            f"RMSE {robust.get('rmse_m')} m"
        )
        passes.append({
            "time": anchor.get("time_start") or anchor.get("time_end"),
            "granule_id": anchor.get("granule_id"),
            "concept_id": anchor.get("concept_id"),
            "files": used_files,
            "summary": summary,
            "tracks": tracks,
        })

    if not passes:
        raise SystemExit("No usable ATL06 temporal passes were extracted")

    passes.sort(key=lambda item: item.get("time") or "")
    output = {
        "schema": "open-antarctica-atl06-series-v1",
        "region": {
            "id": region["id"],
            "name": region["name"],
            "crs": region["crs"],
            "bbox": region["bbox"],
            "local_origin": {"x": x_center, "y": y_center},
        },
        "source": {
            "product": "ATL06",
            "version": "007",
            "height_reference": "WGS84 ellipsoid / ITRF2014 as delivered by ATL06",
            "selection": "time-distributed sample of unique CMR observation dates",
            "mission_search_start": format_utc(mission_start),
            "mission_search_end": format_utc(mission_end),
            "quality_filter": "ATL06_quality_summary == 0" if not args.include_flagged else "all finite segments",
            "rema_comparison": f"browser finest-level {args.resolution} height tiles",
        },
        "summary": {
            "pass_count": len(passes),
            "requested_pass_count": max(args.passes, 1),
            "cmr_match_count": len(cmr_entries),
            "first_pass": passes[0].get("time"),
            "last_pass": passes[-1].get("time"),
        },
        "passes": passes,
        "notes": [
            "Each pass contains actual ATL06 science measurements and a REMA comparison sampled from the rendered finest-level terrain tiles.",
            "delta_h_m = ATL06 h_li - REMA rendered height.",
            "REMA is a multi-date mosaic; ATL06 pass dates are explicit and REMA is not deformed or epoch-corrected.",
            "These sampled dates are a temporal exploration set, not yet a formal repeat-ground-track dh/dt product. ATL11 is the planned repeat-track time-series authority.",
        ],
    }
    out_path = nasa_dir / "atl06-series.json"
    out_path.write_text(json.dumps(output, separators=(",", ":")) + "\n", encoding="utf-8")

    print()
    print(f"ATL06 temporal series: {out_path}")
    print(f"Passes: {len(passes)}")
    print(f"Coverage: {passes[0].get('time')} -> {passes[-1].get('time')}")
    print("Next: refresh the viewer; its ATL06 pass selector will use this series automatically.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
