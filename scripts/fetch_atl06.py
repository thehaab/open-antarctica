#!/usr/bin/env python3
"""Download and extract a dated ICESat-2 ATL06 pass for an Open Antarctica region.

Prerequisite: run discover_nasa.py first so a local nasa-observations.json index exists.
This script uses the nearest dated ATL06 observation from that index, searches NASA
Earthdata for files around that pass, downloads matching HDF5 granules, extracts
land-ice height segments intersecting the region, and writes a browser-friendly
JSON track file.

Science note: ATL06 h_li is an ellipsoidal land-ice height. This script does not
silently force it onto REMA; vertical-reference comparison remains an explicit
validation step before any surface correction is attempted.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import pathlib
import sys

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
            "Missing NASA ingest dependencies. Create/activate a venv and run:\n"
            "  python3 -m pip install -r scripts/requirements-nasa.txt\n"
            f"Import error: {exc}"
        )
    return earthaccess, h5py, np, Transformer


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Download/extract the nearest ATL06 pass for a region")
    p.add_argument("--region", required=True, help="Region id, e.g. ferrar-glacier")
    p.add_argument(
        "--window-hours",
        type=float,
        default=12.0,
        help="Earthdata search half-window around the indexed nearest pass (default: 12 h)",
    )
    p.add_argument(
        "--include-flagged",
        action="store_true",
        help="Include ATL06 segments with ATL06_quality_summary != 0",
    )
    p.add_argument(
        "--max-results",
        type=int,
        default=20,
        help="Maximum Earthdata granules returned for the narrow pass search",
    )
    return p.parse_args()


def parse_utc(value: str) -> dt.datetime:
    result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        result = result.replace(tzinfo=dt.timezone.utc)
    return result.astimezone(dt.timezone.utc)


def iso_utc(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def load_json(path: pathlib.Path) -> dict:
    if not path.exists():
        raise SystemExit(f"Required file not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def finite_float(value) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def main() -> int:
    args = parse_args()
    earthaccess, h5py, np, Transformer = need_modules()

    region_path = REGIONS_DIR / f"{args.region}.json"
    region = load_json(region_path)
    if region.get("crs") != "EPSG:3031":
        raise SystemExit("fetch_atl06.py currently expects EPSG:3031 region coordinates")

    index_path = REPO_ROOT / "data" / "processed" / args.region / "nasa" / "nasa-observations.json"
    index = load_json(index_path)
    atl06 = index.get("products", {}).get("ATL06") or {}
    nearest = atl06.get("nearest_granules") or []
    if not nearest:
        raise SystemExit(
            "NASA index contains no nearest ATL06 observation. Re-run scripts/discover_nasa.py first."
        )

    indexed = nearest[0]
    indexed_time_raw = indexed.get("time_start") or indexed.get("time_end")
    if not indexed_time_raw:
        raise SystemExit("Nearest ATL06 index entry has no time_start/time_end")
    indexed_time = parse_utc(indexed_time_raw)

    half_window = dt.timedelta(hours=max(args.window_hours, 0.25))
    search_start = indexed_time - half_window
    search_end = indexed_time + half_window
    wgs84_bbox = index.get("region", {}).get("wgs84_bbox")
    if not wgs84_bbox or len(wgs84_bbox) != 4:
        raise SystemExit("NASA index is missing region.wgs84_bbox")

    print(f"Indexed nearest ATL06 pass: {indexed_time_raw}")
    print(f"Earthdata search: {iso_utc(search_start)} -> {iso_utc(search_end)}")
    print("Authenticating with NASA Earthdata ...")
    earthaccess.login()

    results = earthaccess.search_data(
        short_name="ATL06",
        version="007",
        bounding_box=tuple(float(v) for v in wgs84_bbox),
        temporal=(iso_utc(search_start), iso_utc(search_end)),
        count=max(args.max_results, 1),
    )
    if not results:
        raise SystemExit("Earthdata returned no ATL06 files for the indexed pass window")

    raw_dir = REPO_ROOT / "data" / "raw" / "icesat2" / "atl06" / "v007"
    raw_dir.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {len(results)} candidate granule(s) ...")
    downloaded = earthaccess.download(results, str(raw_dir))
    files = [pathlib.Path(str(p)) for p in downloaded if pathlib.Path(str(p)).suffix.lower() in {".h5", ".hdf5"}]
    if not files:
        files = sorted(raw_dir.glob("*.h5")) + sorted(raw_dir.glob("*.hdf5"))
    if not files:
        raise SystemExit(f"No HDF5 granules found under {raw_dir}")

    xmin, ymin, xmax, ymax = [float(v) for v in region["bbox"]]
    x_center = (xmin + xmax) * 0.5
    y_center = (ymin + ymax) * 0.5
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:3031", always_xy=True)

    tracks: list[dict] = []
    total_points = 0
    total_flagged_dropped = 0
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
                if not args.include_flagged:
                    total_flagged_dropped += int(np.count_nonzero(mask & (quality != 0)))
                    mask &= quality == 0

                idxs = np.nonzero(mask)[0]
                if idxs.size == 0:
                    continue

                points = []
                for i in idxs.tolist():
                    h = float(height[i])
                    if not finite_float(h):
                        continue
                    points.append(
                        {
                            "x_m": round(float(xs[i] - x_center), 3),
                            "z_m": round(float(y_center - ys[i]), 3),
                            "latitude": round(float(lat[i]), 8),
                            "longitude": round(float(lon[i]), 8),
                            "h_li_m": round(h, 3),
                            "delta_time_s": round(float(delta_time[i]), 6),
                            "quality": int(quality[i]),
                        }
                    )

                if points:
                    tracks.append({"file": path.name, "beam": beam, "points": points})
                    file_points += len(points)
                    total_points += len(points)

        if file_points:
            used_files.append(path.name)
            print(f"  {path.name}: {file_points} in-region ATL06 segments")

    if total_points == 0:
        raise SystemExit(
            "Downloaded ATL06 granules contained no usable segments inside the configured EPSG:3031 footprint."
        )

    out_dir = REPO_ROOT / "data" / "processed" / args.region / "nasa"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "atl06-track.json"
    output = {
        "schema": "open-antarctica-atl06-track-v1",
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
            "indexed_nearest_time": indexed_time_raw,
            "indexed_granule_id": indexed.get("granule_id"),
            "files": used_files,
            "height_reference": "WGS84 ellipsoid / ITRF2014 as delivered by ATL06",
            "segment_nominal_length_m": 40,
            "quality_filter": "ATL06_quality_summary == 0" if not args.include_flagged else "all finite segments",
        },
        "summary": {
            "track_count": len(tracks),
            "point_count": total_points,
            "flagged_segments_dropped": total_flagged_dropped,
        },
        "tracks": tracks,
        "notes": [
            "These are actual ATL06 science measurements, not CMR metadata.",
            "delta_time_s is preserved from ATL06 and is not converted to UTC in this v1 extractor.",
            "Do not use these heights to deform REMA until vertical-reference compatibility is explicitly validated.",
        ],
    }
    out_path.write_text(json.dumps(output, separators=(",", ":")) + "\n", encoding="utf-8")

    print()
    print(f"ATL06 science track: {out_path}")
    print(f"Tracks: {len(tracks)}")
    print(f"Segments: {total_points}")
    if not args.include_flagged:
        print(f"Flagged segments excluded: {total_flagged_dropped}")
    print("Next: render this track above REMA after vertical-reference validation.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
