#!/usr/bin/env python3
"""Build a mission-era ATL06 coverage overview for an Open Antarctica region.

This is intentionally a *coverage/provenance* product, not a replacement for
science-segment extraction. It queries all ATL06 v007 CMR granules intersecting
the configured region and converts their CMR spatial metadata into lightweight
track-centerline proxies draped onto the same REMA terrain used by the viewer.

Spatial fidelity rules:
- If CMR supplies line geometry, use it directly.
- If CMR supplies polygon geometry, derive the polygon's principal-axis
  centerline as a compact granule-footprint proxy.
- If only a bounding box exists, derive its principal-axis centerline.

These proxy lines show where mission-era ATL06 granules intersect the crop and
where repeat coverage clusters. They are NOT the six exact ICESat-2 beam paths;
exact beam geometry still comes from downloaded ATL06 HDF5 science data.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import pathlib
import re

from discover_nasa import PRODUCT_MISSION_START, cmr_search, entry_time, format_utc
from validate_atl06_rema import TileSampler

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
REGIONS_DIR = REPO_ROOT / "regions"
RGT_RE = re.compile(r"_(\d{4})(\d{2})(\d{2})_")


def need_transformer():
    try:
        from pyproj import Transformer  # type: ignore
    except ImportError as exc:
        raise SystemExit(
            "Missing pyproj. Activate .venv-nasa and run:\n"
            "  python3 -m pip install -r scripts/requirements-nasa.txt\n"
            f"Import error: {exc}"
        )
    return Transformer


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build mission-era ATL06 CMR coverage overview")
    p.add_argument("--region", required=True, help="Region id, e.g. ferrar-glacier")
    p.add_argument("--resolution", default="2m", help="REMA viewer resolution used for draping")
    p.add_argument("--page-size", type=int, default=2000, help="CMR page size (default: 2000)")
    p.add_argument(
        "--spacing-m",
        type=float,
        default=500.0,
        help="Approximate spacing of draped proxy-line samples (default: 500 m)",
    )
    return p.parse_args()


def load_json(path: pathlib.Path) -> dict:
    if not path.exists():
        raise SystemExit(f"Required file not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def parse_latlon_string(value: str) -> list[tuple[float, float]]:
    """CMR JSON feed spatial strings are latitude/longitude pairs."""
    parts = [float(v) for v in str(value).replace(",", " ").split()]
    if len(parts) < 4 or len(parts) % 2:
        return []
    return [(parts[i], parts[i + 1]) for i in range(0, len(parts), 2)]


def flatten_spatial_values(value) -> list[str]:
    out: list[str] = []
    if isinstance(value, str):
        out.append(value)
    elif isinstance(value, list):
        for item in value:
            out.extend(flatten_spatial_values(item))
    return out


def principal_axis_segment(points: list[tuple[float, float]]) -> tuple[tuple[float, float], tuple[float, float]] | None:
    """Return a compact principal-axis segment through projected x/y points."""
    if len(points) < 2:
        return None
    cx = sum(p[0] for p in points) / len(points)
    cy = sum(p[1] for p in points) / len(points)
    sxx = sum((p[0] - cx) ** 2 for p in points)
    syy = sum((p[1] - cy) ** 2 for p in points)
    sxy = sum((p[0] - cx) * (p[1] - cy) for p in points)
    angle = 0.5 * math.atan2(2.0 * sxy, sxx - syy)
    ux = math.cos(angle)
    uy = math.sin(angle)
    projections = [(p[0] - cx) * ux + (p[1] - cy) * uy for p in points]
    lo = min(projections)
    hi = max(projections)
    if hi - lo < 1.0:
        return None
    return ((cx + lo * ux, cy + lo * uy), (cx + hi * ux, cy + hi * uy))


def clip_segment_to_bbox(
    a: tuple[float, float],
    b: tuple[float, float],
    bbox: list[float],
) -> tuple[tuple[float, float], tuple[float, float]] | None:
    """Liang-Barsky clip in EPSG:3031 x/y coordinates."""
    xmin, ymin, xmax, ymax = bbox
    x0, y0 = a
    x1, y1 = b
    dx = x1 - x0
    dy = y1 - y0
    p = (-dx, dx, -dy, dy)
    q = (x0 - xmin, xmax - x0, y0 - ymin, ymax - y0)
    u0, u1 = 0.0, 1.0
    for pi, qi in zip(p, q):
        if abs(pi) < 1e-12:
            if qi < 0:
                return None
            continue
        r = qi / pi
        if pi < 0:
            u0 = max(u0, r)
        else:
            u1 = min(u1, r)
        if u0 > u1:
            return None
    return ((x0 + u0 * dx, y0 + u0 * dy), (x0 + u1 * dx, y0 + u1 * dy))


def densify_segment(
    a: tuple[float, float],
    b: tuple[float, float],
    spacing: float,
) -> list[tuple[float, float]]:
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    distance = math.hypot(dx, dy)
    steps = max(int(math.ceil(distance / max(spacing, 50.0))), 1)
    return [
        (a[0] + dx * i / steps, a[1] + dy * i / steps)
        for i in range(steps + 1)
    ]


def extract_rgt(granule_id: str | None) -> str | None:
    if not granule_id:
        return None
    match = RGT_RE.search(granule_id)
    return match.group(1) if match else None


def entry_geometry(entry: dict, transformer) -> tuple[str, list[tuple[float, float]]] | None:
    # Prefer actual CMR line geometry when present.
    for value in flatten_spatial_values(entry.get("lines")):
        latlon = parse_latlon_string(value)
        if len(latlon) >= 2:
            lon = [p[1] for p in latlon]
            lat = [p[0] for p in latlon]
            xs, ys = transformer.transform(lon, lat)
            points = [(float(x), float(y)) for x, y in zip(xs, ys)]
            if len(points) >= 2:
                return "cmr_line", points

    # CMR JSON feed polygons are nested arrays of latitude/longitude strings.
    polygon_points: list[tuple[float, float]] = []
    for value in flatten_spatial_values(entry.get("polygons")):
        latlon = parse_latlon_string(value)
        if len(latlon) >= 3:
            lon = [p[1] for p in latlon]
            lat = [p[0] for p in latlon]
            xs, ys = transformer.transform(lon, lat)
            polygon_points.extend((float(x), float(y)) for x, y in zip(xs, ys))
    if polygon_points:
        segment = principal_axis_segment(polygon_points)
        if segment:
            return "cmr_polygon_axis", [segment[0], segment[1]]

    # Boxes in CMR JSON feed are south west north east.
    for value in flatten_spatial_values(entry.get("boxes")):
        parts = [float(v) for v in str(value).replace(",", " ").split()]
        if len(parts) != 4:
            continue
        south, west, north, east = parts
        corners_lon = [west, west, east, east]
        corners_lat = [south, north, north, south]
        xs, ys = transformer.transform(corners_lon, corners_lat)
        corners = [(float(x), float(y)) for x, y in zip(xs, ys)]
        segment = principal_axis_segment(corners)
        if segment:
            return "cmr_box_axis", [segment[0], segment[1]]
    return None


def main() -> int:
    args = parse_args()
    Transformer = need_transformer()
    region = load_json(REGIONS_DIR / f"{args.region}.json")
    if region.get("crs") != "EPSG:3031":
        raise SystemExit("build_atl06_coverage.py currently expects EPSG:3031 region coordinates")

    viewer_dir = REPO_ROOT / "data" / "processed" / args.region / "viewer" / args.resolution
    terrain_meta = load_json(viewer_dir / "terrain-lod.json")
    sampler = TileSampler(viewer_dir, terrain_meta)

    nasa_index_path = REPO_ROOT / "data" / "processed" / args.region / "nasa" / "nasa-observations.json"
    nasa_index = load_json(nasa_index_path)
    wgs84_bbox = nasa_index.get("region", {}).get("wgs84_bbox")
    if not wgs84_bbox or len(wgs84_bbox) != 4:
        raise SystemExit("NASA index is missing region.wgs84_bbox; run discover_nasa.py first")

    now = dt.datetime.now(dt.timezone.utc)
    start = format_utc(PRODUCT_MISSION_START["ATL06"])
    end = format_utc(now)
    print(f"[CMR] ATL06 v007 mission coverage {start} -> {end} ...")
    entries = cmr_search("ATL06", "007", [float(v) for v in wgs84_bbox], start, end, args.page_size)
    print(f"CMR granules intersecting crop: {len(entries)}")

    transformer = Transformer.from_crs("EPSG:4326", "EPSG:3031", always_xy=True)
    bbox = [float(v) for v in region["bbox"]]
    xmin, ymin, xmax, ymax = bbox
    x_center = (xmin + xmax) * 0.5
    y_center = (ymin + ymax) * 0.5

    tracks: list[dict] = []
    source_counts: dict[str, int] = {}
    unique_rgts: set[str] = set()
    times: list[dt.datetime] = []
    skipped_no_geometry = 0
    skipped_no_intersection = 0
    unsampled_points = 0

    for entry in entries:
        geometry = entry_geometry(entry, transformer)
        if not geometry:
            skipped_no_geometry += 1
            continue
        source, points = geometry

        # Reduce any multi-point CMR line to its end-to-end footprint inside this
        # small prototype crop. Exact six-beam geometry remains a science-data job.
        if len(points) > 2:
            segment = principal_axis_segment(points)
            if not segment:
                skipped_no_geometry += 1
                continue
            a, b = segment
        else:
            a, b = points[0], points[-1]

        clipped = clip_segment_to_bbox(a, b, bbox)
        if not clipped:
            skipped_no_intersection += 1
            continue

        dense = densify_segment(clipped[0], clipped[1], args.spacing_m)
        draped = []
        for x, y in dense:
            h = sampler.sample(x, y)
            if h is None:
                unsampled_points += 1
                continue
            draped.append({
                "x_m": round(x - x_center, 2),
                "z_m": round(y_center - y, 2),
                "rema_h_m": round(float(h), 2),
            })
        if len(draped) < 2:
            continue

        granule_id = entry.get("producer_granule_id") or entry.get("title") or entry.get("id")
        rgt = extract_rgt(granule_id)
        if rgt:
            unique_rgts.add(rgt)
        when = entry_time(entry)
        if when:
            times.append(when)

        source_counts[source] = source_counts.get(source, 0) + 1
        tracks.append({
            "granule_id": granule_id,
            "time": entry.get("time_start") or entry.get("time_end"),
            "rgt": rgt,
            "geometry_source": source,
            "points": draped,
        })

    out_dir = REPO_ROOT / "data" / "processed" / args.region / "nasa"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "atl06-coverage.json"
    output = {
        "schema": "open-antarctica-atl06-coverage-v1",
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
            "metadata": "NASA CMR granule spatial metadata",
            "terrain_drape": f"REMA viewer {args.resolution} finest-level tiles",
            "mission_start": start,
            "mission_end": end,
        },
        "summary": {
            "cmr_granule_count": len(entries),
            "rendered_proxy_count": len(tracks),
            "unique_rgt_count": len(unique_rgts),
            "geometry_source_counts": source_counts,
            "skipped_no_geometry": skipped_no_geometry,
            "skipped_no_crop_intersection_after_proxy": skipped_no_intersection,
            "unsampled_rema_points": unsampled_points,
            "coverage_start": format_utc(min(times)) if times else None,
            "coverage_end": format_utc(max(times)) if times else None,
            "sample_spacing_m": float(args.spacing_m),
        },
        "tracks": tracks,
        "notes": [
            "This layer visualizes mission-era CMR granule footprint centerlines, not the exact six ICESat-2 beam paths.",
            "Repeated/overlapping proxy lines indicate repeated granule coverage of the same part of the Ferrar crop.",
            "Exact beam geometry and science elevations must come from downloaded ATL06 HDF5 data.",
            "Proxy lines are draped onto REMA only for visualization; no REMA correction is applied.",
        ],
    }
    out_path.write_text(json.dumps(output, separators=(",", ":")) + "\n", encoding="utf-8")

    print(f"ATL06 mission coverage: {out_path}")
    print(f"Rendered footprint proxies: {len(tracks)}")
    print(f"Unique RGTs parsed: {len(unique_rgts)}")
    print(f"Geometry sources: {source_counts}")
    print(f"Skipped: no geometry={skipped_no_geometry}, no crop intersection={skipped_no_intersection}")
    print("Viewer note: this is CMR footprint coverage, not exact beam-level science geometry.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
