#!/usr/bin/env python3
"""Download and extract ICESat-2 ATL11 repeat-track height time series.

Builds a browser-friendly repeat-track change product for an Open Antarctica
region. ATL11 is the time-series authority here: each file represents one RGT
and region, with pt1/pt2/pt3 beam-pair groups containing repeated corrected
heights at fixed reference points across mission cycles.

The script:
- searches ATL11 v007 granules intersecting the configured EPSG:3031 region,
- downloads the matching HDF5 files through Earthdata,
- extracts quality_summary == 0 cycle heights inside the crop,
- computes per-reference-point linear dh/dt and endpoint change,
- spatially thins points for an interactive browser layer, and
- writes data/processed/<region>/nasa/atl11-timeseries.json.

No REMA deformation or temporal fusion is performed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import pathlib
import re

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
REGIONS_DIR = REPO_ROOT / "regions"
ATL11_FILENAME_RE = re.compile(r"ATL11_(\d{4})(\d{2})_([0-9]{4})_")
ATLAS_EPOCH = dt.datetime(2018, 1, 1, tzinfo=dt.timezone.utc)
SECONDS_PER_YEAR = 365.25 * 86400.0
PAIR_GROUPS = ("pt1", "pt2", "pt3")


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
    p = argparse.ArgumentParser(description="Build ATL11 repeat-track time series for a region")
    p.add_argument("--region", required=True, help="Region id, e.g. ferrar-glacier")
    p.add_argument("--version", default="007", help="ATL11 version (default: 007)")
    p.add_argument("--max-results", type=int, default=40, help="Maximum ATL11 granules to download")
    p.add_argument("--stride", type=int, default=4, help="Keep every Nth in-region reference point (default: 4)")
    p.add_argument("--min-cycles", type=int, default=3, help="Minimum good cycles required per reference point")
    p.add_argument("--min-span-years", type=float, default=1.0, help="Minimum observation span for dh/dt")
    p.add_argument("--include-flagged", action="store_true", help="Include quality_summary != 0 cycles")
    return p.parse_args()


def load_json(path: pathlib.Path) -> dict:
    if not path.exists():
        raise SystemExit(f"Required file not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def finite(value) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def delta_time_to_iso(seconds: float) -> str:
    # ATL11 delta_time is elapsed seconds relative to the ATLAS SDP epoch.
    # Day-scale dating is sufficient for this viewer; do not infer sub-minute
    # UTC precision from this convenience conversion.
    return (ATLAS_EPOCH + dt.timedelta(seconds=float(seconds))).isoformat().replace("+00:00", "Z")


def parse_filename(path: pathlib.Path) -> tuple[int | None, int | None, str | None]:
    match = ATL11_FILENAME_RE.search(path.name)
    if not match:
        return None, None, None
    return int(match.group(1)), int(match.group(2)), match.group(3)


def regression(np, times_s, heights) -> tuple[float, float | None, float]:
    """Return slope m/yr, slope standard error (if estimable), residual RMSE."""
    x = np.asarray(times_s, dtype=float) / SECONDS_PER_YEAR
    y = np.asarray(heights, dtype=float)
    x0 = x - float(np.mean(x))
    denom = float(np.sum(x0 * x0))
    if denom <= 0:
        return float("nan"), None, float("nan")
    slope = float(np.sum(x0 * (y - float(np.mean(y)))) / denom)
    intercept = float(np.mean(y) - slope * np.mean(x))
    residual = y - (intercept + slope * x)
    rmse = float(np.sqrt(np.mean(residual * residual)))
    slope_se = None
    if len(y) > 2:
        variance = float(np.sum(residual * residual) / (len(y) - 2))
        slope_se = math.sqrt(max(variance / denom, 0.0))
    return slope, slope_se, rmse


def percentile(np, values, q: float) -> float | None:
    if not values:
        return None
    return float(np.percentile(np.asarray(values, dtype=float), q * 100.0))


def main() -> int:
    args = parse_args()
    earthaccess, h5py, np, Transformer = need_modules()

    region = load_json(REGIONS_DIR / f"{args.region}.json")
    if region.get("crs") != "EPSG:3031":
        raise SystemExit("fetch_atl11_timeseries.py currently expects EPSG:3031 region coordinates")

    xmin, ymin, xmax, ymax = [float(v) for v in region["bbox"]]
    x_center = (xmin + xmax) * 0.5
    y_center = (ymin + ymax) * 0.5

    to_wgs84 = Transformer.from_crs("EPSG:3031", "EPSG:4326", always_xy=True)
    corners = [to_wgs84.transform(x, y) for x, y in ((xmin, ymin), (xmin, ymax), (xmax, ymin), (xmax, ymax))]
    lons = [p[0] for p in corners]
    lats = [p[1] for p in corners]
    wgs84_bbox = (min(lons), min(lats), max(lons), max(lats))

    print(f"Searching ATL11 v{args.version} repeat-track granules ...")
    print("Authenticating with NASA Earthdata ...")
    earthaccess.login()
    results = earthaccess.search_data(
        short_name="ATL11",
        version=args.version,
        bounding_box=wgs84_bbox,
        count=max(int(args.max_results), 1),
    )
    if not results:
        raise SystemExit("Earthdata returned no ATL11 granules for the configured footprint")

    raw_dir = REPO_ROOT / "data" / "raw" / "icesat2" / "atl11" / f"v{args.version}"
    raw_dir.mkdir(parents=True, exist_ok=True)
    print(f"Earthdata matches: {len(results)} · downloading to {raw_dir}")
    downloaded = earthaccess.download(results, str(raw_dir))
    files = []
    seen = set()
    for value in downloaded:
        path = pathlib.Path(str(value))
        if path.suffix.lower() not in {".h5", ".hdf5"}:
            continue
        if path.name in seen:
            continue
        seen.add(path.name)
        files.append(path)
    if not files:
        files = sorted(raw_dir.glob("ATL11_*.h5")) + sorted(raw_dir.glob("ATL11_*.hdf5"))
    if not files:
        raise SystemExit(f"No ATL11 HDF5 files found under {raw_dir}")

    to_3031 = Transformer.from_crs("EPSG:4326", "EPSG:3031", always_xy=True)
    stride = max(int(args.stride), 1)
    min_cycles = max(int(args.min_cycles), 2)

    tracks: list[dict] = []
    all_trends: list[float] = []
    all_changes: list[float] = []
    all_spans: list[float] = []
    total_candidate_refs = 0
    total_retained_refs = 0
    total_observations = 0
    unique_rgts: set[int] = set()
    used_files: list[str] = []

    for file_index, path in enumerate(sorted(files), start=1):
        rgt, region_number, cycle_range = parse_filename(path)
        file_retained = 0
        try:
            h5 = h5py.File(path, "r")
        except OSError as exc:
            print(f"[{file_index}/{len(files)}] skip {path.name}: {exc}")
            continue

        with h5:
            for pair in PAIR_GROUPS:
                if pair not in h5:
                    continue
                group = h5[pair]
                required = ("latitude", "longitude", "ref_pt", "cycle_number", "delta_time", "h_corr", "h_corr_sigma", "quality_summary")
                if any(name not in group for name in required):
                    continue

                lat = np.asarray(group["latitude"][:], dtype=float)
                lon = np.asarray(group["longitude"][:], dtype=float)
                ref_pt = np.asarray(group["ref_pt"][:])
                cycles = np.asarray(group["cycle_number"][:])
                delta_time = np.asarray(group["delta_time"][:], dtype=float)
                h_corr = np.asarray(group["h_corr"][:], dtype=float)
                h_sigma = np.asarray(group["h_corr_sigma"][:], dtype=float)
                quality = np.asarray(group["quality_summary"][:])

                if h_corr.ndim != 2 or delta_time.shape != h_corr.shape or quality.shape != h_corr.shape:
                    continue
                if h_corr.shape[0] != lat.shape[0] or h_corr.shape[1] != cycles.shape[0]:
                    continue

                xs, ys = to_3031.transform(lon, lat)
                inside = (
                    np.isfinite(xs) & np.isfinite(ys) &
                    (xs >= xmin) & (xs <= xmax) & (ys >= ymin) & (ys <= ymax)
                )
                indices = np.nonzero(inside)[0]
                total_candidate_refs += int(indices.size)
                if indices.size == 0:
                    continue

                # Thin in along-track order for browser performance while retaining
                # the first and last reference point of each intersecting run.
                keep = indices[::stride]
                if indices[-1] not in keep:
                    keep = np.append(keep, indices[-1])

                points = []
                pair_trends = []
                for i in keep.tolist():
                    valid = np.isfinite(h_corr[i]) & np.isfinite(delta_time[i])
                    valid &= np.abs(h_corr[i]) < 10000.0
                    valid &= delta_time[i] > 0
                    if not args.include_flagged:
                        valid &= quality[i] == 0
                    js = np.nonzero(valid)[0]
                    if js.size < min_cycles:
                        continue

                    times = [float(delta_time[i, j]) for j in js.tolist()]
                    heights = [float(h_corr[i, j]) for j in js.tolist()]
                    sigmas = [float(h_sigma[i, j]) if finite(h_sigma[i, j]) and abs(float(h_sigma[i, j])) < 1000 else None for j in js.tolist()]
                    span_years = (max(times) - min(times)) / SECONDS_PER_YEAR
                    if span_years < float(args.min_span_years):
                        continue

                    slope, slope_se, residual_rmse = regression(np, times, heights)
                    if not math.isfinite(slope):
                        continue

                    order = sorted(range(len(times)), key=lambda k: times[k])
                    first_k = order[0]
                    last_k = order[-1]
                    delta_h = heights[last_k] - heights[first_k]
                    latest_h = heights[last_k]
                    observations = []
                    for k in order:
                        j = int(js[k])
                        observations.append({
                            "cycle": int(cycles[j]),
                            "time": delta_time_to_iso(times[k]),
                            "delta_time_s": round(times[k], 3),
                            "h_corr_m": round(heights[k], 3),
                            "sigma_m": round(sigmas[k], 3) if sigmas[k] is not None else None,
                        })

                    point = {
                        "ref_pt": int(ref_pt[i]),
                        "x_m": round(float(xs[i] - x_center), 3),
                        "z_m": round(float(y_center - ys[i]), 3),
                        "latitude": round(float(lat[i]), 8),
                        "longitude": round(float(lon[i]), 8),
                        "cycle_count": len(observations),
                        "first_time": observations[0]["time"],
                        "last_time": observations[-1]["time"],
                        "span_years": round(span_years, 3),
                        "first_h_m": round(heights[first_k], 3),
                        "latest_h_m": round(latest_h, 3),
                        "delta_h_m": round(delta_h, 3),
                        "trend_m_per_yr": round(slope, 4),
                        "trend_sigma_m_per_yr": round(slope_se, 4) if slope_se is not None and math.isfinite(slope_se) else None,
                        "trend_residual_rmse_m": round(residual_rmse, 3),
                        "observations": observations,
                    }
                    points.append(point)
                    pair_trends.append(slope)
                    all_trends.append(slope)
                    all_changes.append(delta_h)
                    all_spans.append(span_years)
                    total_observations += len(observations)

                if not points:
                    continue

                if rgt is None:
                    try:
                        attr = group.attrs.get("ReferenceGroundTrack")
                        rgt = int(np.asarray(attr).reshape(-1)[0]) if attr is not None else None
                    except Exception:
                        rgt = None
                if rgt is not None:
                    unique_rgts.add(int(rgt))

                tracks.append({
                    "file": path.name,
                    "rgt": int(rgt) if rgt is not None else None,
                    "region_number": int(region_number) if region_number is not None else None,
                    "cycle_range": cycle_range,
                    "pair": pair,
                    "point_count": len(points),
                    "median_trend_m_per_yr": round(float(np.median(pair_trends)), 4),
                    "points": points,
                })
                file_retained += len(points)
                total_retained_refs += len(points)

        if file_retained:
            used_files.append(path.name)
            print(f"[{file_index}/{len(files)}] {path.name}: {file_retained} repeat reference points")

    if not tracks:
        raise SystemExit("No usable ATL11 repeat-track reference points were extracted inside the crop")

    all_times = [
        obs["time"]
        for track in tracks
        for point in track["points"]
        for obs in point["observations"]
    ]
    summary = {
        "downloaded_file_count": len(files),
        "used_file_count": len(used_files),
        "track_pair_count": len(tracks),
        "unique_rgt_count": len(unique_rgts),
        "candidate_in_region_ref_points": total_candidate_refs,
        "retained_ref_points": total_retained_refs,
        "observation_count": total_observations,
        "spatial_stride": stride,
        "minimum_good_cycles": min_cycles,
        "minimum_span_years": float(args.min_span_years),
        "coverage_start": min(all_times) if all_times else None,
        "coverage_end": max(all_times) if all_times else None,
        "trend_m_per_yr": {
            "median": round(float(np.median(all_trends)), 4),
            "p05": round(percentile(np, all_trends, 0.05), 4),
            "p95": round(percentile(np, all_trends, 0.95), 4),
        },
        "endpoint_delta_h_m": {
            "median": round(float(np.median(all_changes)), 3),
            "p05": round(percentile(np, all_changes, 0.05), 3),
            "p95": round(percentile(np, all_changes, 0.95), 3),
        },
        "median_span_years": round(float(np.median(all_spans)), 3),
    }

    output = {
        "schema": "open-antarctica-atl11-timeseries-v1",
        "region": {
            "id": region["id"],
            "name": region["name"],
            "crs": region["crs"],
            "bbox": region["bbox"],
            "local_origin": {"x": x_center, "y": y_center},
        },
        "source": {
            "product": "ATL11",
            "version": args.version,
            "provider": "NASA / NSIDC",
            "height_reference": "ATL11 slope-corrected land-ice height as delivered",
            "quality_filter": "quality_summary == 0" if not args.include_flagged else "all finite cycles",
            "time_conversion": "display dates derived from ATL11 delta_time relative to 2018-01-01 ATLAS SDP epoch; day-scale use only",
            "files": used_files,
        },
        "summary": summary,
        "tracks": sorted(tracks, key=lambda t: (t["rgt"] if t["rgt"] is not None else 9999, t["pair"])),
        "notes": [
            "ATL11 is the repeat-track time-series authority used here; these are fixed reference-point histories, not CMR footprint proxies.",
            "trend_m_per_yr is an ordinary least-squares slope through retained quality-filtered ATL11 cycle heights.",
            "delta_h_m is last retained cycle height minus first retained cycle height at the same ATL11 reference point.",
            "Spatial thinning is for browser interaction only and does not change individual retained time-series values.",
            "No REMA correction or deformation is applied.",
        ],
    }

    out_dir = REPO_ROOT / "data" / "processed" / args.region / "nasa"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "atl11-timeseries.json"
    out_path.write_text(json.dumps(output, separators=(",", ":")) + "\n", encoding="utf-8")

    print()
    print(f"ATL11 repeat-track time series: {out_path}")
    print(f"Files: {summary['used_file_count']}/{summary['downloaded_file_count']} used")
    print(f"RGTs: {summary['unique_rgt_count']} · track pairs: {summary['track_pair_count']}")
    print(f"Reference points: {summary['retained_ref_points']:,} retained from {summary['candidate_in_region_ref_points']:,} in-region candidates (stride {stride})")
    print(f"Cycle observations: {summary['observation_count']:,}")
    print(f"Coverage: {summary['coverage_start']} -> {summary['coverage_end']}")
    print(
        "dh/dt median: "
        f"{summary['trend_m_per_yr']['median']} m/yr "
        f"(p05..p95 {summary['trend_m_per_yr']['p05']} .. {summary['trend_m_per_yr']['p95']})"
    )
    print("Next: refresh the viewer and enable the ATL11 repeat-track change layer.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
