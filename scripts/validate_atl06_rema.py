#!/usr/bin/env python3
"""Compare extracted ATL06 land-ice heights against the rendered REMA terrain.

This script is deliberately a validation step, not a surface-correction step.
Both source products are ellipsoidal heights referenced to WGS84, but they are
not temporally identical: the REMA mosaic is a multi-date composite while ATL06
is a dated ICESat-2 observation. Differences therefore contain real surface
change as well as measurement / registration / sampling effects.

The comparison samples the exact finest-level height tiles used by the browser,
so it validates ATL06 against what Open Antarctica actually renders without
adding another raster-library dependency.
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib
import statistics
import struct

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Compare ATL06 heights with rendered REMA terrain")
    p.add_argument("--region", required=True, help="Region id, e.g. ferrar-glacier")
    p.add_argument("--resolution", default="2m", help="Viewer terrain resolution (default: 2m)")
    p.add_argument(
        "--outlier-limit-m",
        type=float,
        default=100.0,
        help="Absolute ATL06-REMA delta treated as an extreme outlier for robust stats (default: 100 m)",
    )
    return p.parse_args()


def load_json(path: pathlib.Path) -> dict:
    if not path.exists():
        raise SystemExit(f"Required file not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * q
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return ordered[lo]
    f = pos - lo
    return ordered[lo] * (1.0 - f) + ordered[hi] * f


def stats(values: list[float]) -> dict:
    if not values:
        return {"count": 0}
    med = statistics.median(values)
    abs_dev = [abs(v - med) for v in values]
    return {
        "count": len(values),
        "mean_m": round(statistics.fmean(values), 3),
        "median_m": round(med, 3),
        "mad_m": round(statistics.median(abs_dev), 3),
        "rmse_m": round(math.sqrt(statistics.fmean(v * v for v in values)), 3),
        "p05_m": round(percentile(values, 0.05), 3),
        "p25_m": round(percentile(values, 0.25), 3),
        "p75_m": round(percentile(values, 0.75), 3),
        "p95_m": round(percentile(values, 0.95), 3),
        "min_m": round(min(values), 3),
        "max_m": round(max(values), 3),
    }


class TileSampler:
    def __init__(self, viewer_dir: pathlib.Path, meta: dict):
        self.viewer_dir = viewer_dir
        self.meta = meta
        self.extent = meta["extent"]
        self.lod = meta["lod"]
        self.level = int(self.lod["maxLevel"])
        self.samples = int(self.lod["samples"])
        scale = 2 ** self.level
        self.nx = int(self.lod["rootTilesX"]) * scale
        self.ny = int(self.lod["rootTilesY"]) * scale
        self.span_x = float(self.extent["xmax"]) - float(self.extent["xmin"])
        self.span_y = float(self.extent["ymax"]) - float(self.extent["ymin"])
        self.tile_w = self.span_x / self.nx
        self.tile_h = self.span_y / self.ny
        self.cache: dict[tuple[int, int], tuple[float, ...]] = {}

    def _tile_path(self, tx: int, ty: int) -> pathlib.Path:
        pattern = self.lod["heightPattern"]
        rel = pattern.replace("{level}", str(self.level)).replace("{x}", str(tx)).replace("{y}", str(ty))
        return self.viewer_dir / rel

    def _load_tile(self, tx: int, ty: int) -> tuple[float, ...]:
        key = (tx, ty)
        if key in self.cache:
            return self.cache[key]
        path = self._tile_path(tx, ty)
        if not path.exists():
            raise SystemExit(f"Missing finest-level viewer tile: {path}")
        raw = path.read_bytes()
        expected = self.samples * self.samples * 4
        if len(raw) != expected:
            raise SystemExit(f"Unexpected tile size for {path}: {len(raw)} bytes, expected {expected}")
        values = struct.unpack(f"<{self.samples * self.samples}f", raw)
        self.cache[key] = values
        return values

    def sample(self, x: float, y: float) -> float | None:
        xmin = float(self.extent["xmin"])
        xmax = float(self.extent["xmax"])
        ymin = float(self.extent["ymin"])
        ymax = float(self.extent["ymax"])
        if x < xmin or x > xmax or y < ymin or y > ymax:
            return None

        fx_global = (x - xmin) / self.span_x * self.nx
        fy_global = (ymax - y) / self.span_y * self.ny
        tx = min(max(int(math.floor(fx_global)), 0), self.nx - 1)
        ty = min(max(int(math.floor(fy_global)), 0), self.ny - 1)
        u = min(max(fx_global - tx, 0.0), 1.0)
        v = min(max(fy_global - ty, 0.0), 1.0)

        gx = u * (self.samples - 1)
        gy = v * (self.samples - 1)
        x0 = int(math.floor(gx))
        y0 = int(math.floor(gy))
        x1 = min(x0 + 1, self.samples - 1)
        y1 = min(y0 + 1, self.samples - 1)
        dx = gx - x0
        dy = gy - y0

        tile = self._load_tile(tx, ty)
        def at(col: int, row: int) -> float:
            return float(tile[row * self.samples + col])

        h00 = at(x0, y0)
        h10 = at(x1, y0)
        h01 = at(x0, y1)
        h11 = at(x1, y1)
        if any((not math.isfinite(h) or h <= -9000) for h in (h00, h10, h01, h11)):
            return None
        top = h00 * (1.0 - dx) + h10 * dx
        bottom = h01 * (1.0 - dx) + h11 * dx
        return top * (1.0 - dy) + bottom * dy


def main() -> int:
    args = parse_args()
    nasa_dir = REPO_ROOT / "data" / "processed" / args.region / "nasa"
    track_path = nasa_dir / "atl06-track.json"
    viewer_dir = REPO_ROOT / "data" / "processed" / args.region / "viewer" / args.resolution
    meta_path = viewer_dir / "terrain-lod.json"

    track = load_json(track_path)
    meta = load_json(meta_path)
    if meta.get("crs") != "EPSG:3031":
        raise SystemExit(f"Expected EPSG:3031 viewer terrain, got {meta.get('crs')}")

    origin = track["region"]["local_origin"]
    x_center = float(origin["x"])
    y_center = float(origin["y"])
    sampler = TileSampler(viewer_dir, meta)

    comparisons: list[dict] = []
    all_deltas: list[float] = []
    robust_deltas: list[float] = []
    by_beam: dict[str, list[float]] = {}
    unsampled = 0

    for source_track in track.get("tracks", []):
        beam = source_track.get("beam", "unknown")
        out_points = []
        beam_deltas = by_beam.setdefault(beam, [])
        for point in source_track.get("points", []):
            x_local = float(point["x_m"])
            z_local = float(point["z_m"])
            x_proj = x_center + x_local
            y_proj = y_center - z_local
            rema_h = sampler.sample(x_proj, y_proj)
            if rema_h is None:
                unsampled += 1
                continue
            atl_h = float(point["h_li_m"])
            delta = atl_h - rema_h
            all_deltas.append(delta)
            beam_deltas.append(delta)
            if abs(delta) <= args.outlier_limit_m:
                robust_deltas.append(delta)
            out_points.append({
                "x_m": round(x_local, 3),
                "z_m": round(z_local, 3),
                "h_li_m": round(atl_h, 3),
                "rema_h_m": round(rema_h, 3),
                "delta_h_m": round(delta, 3),
                "quality": int(point.get("quality", 0)),
            })
        if out_points:
            comparisons.append({
                "file": source_track.get("file"),
                "beam": beam,
                "points": out_points,
            })

    if not all_deltas:
        raise SystemExit("No ATL06 points could be sampled against the rendered REMA terrain")

    output = {
        "schema": "open-antarctica-atl06-rema-comparison-v1",
        "region": track.get("region"),
        "source": {
            "atl06": track.get("source"),
            "rema": {
                "product": meta.get("sources", {}).get("terrain", "PGC REMA"),
                "resolution": meta.get("resolution"),
                "height_reference": "WGS84 ellipsoid",
                "comparison_lod": sampler.level,
                "comparison_sampling": "bilinear sampling of browser finest-level height tiles",
            },
        },
        "summary": {
            "sampled_points": len(all_deltas),
            "unsampled_points": unsampled,
            "extreme_outlier_limit_m": args.outlier_limit_m,
            "extreme_outlier_count": len(all_deltas) - len(robust_deltas),
            "all_points": stats(all_deltas),
            "robust_points": stats(robust_deltas),
            "by_beam": {beam: stats(values) for beam, values in sorted(by_beam.items())},
        },
        "tracks": comparisons,
        "notes": [
            "ATL06 h_li and raw PGC REMA elevations are both ellipsoidal heights referenced to WGS84.",
            "This validates the vertical-reference convention but does not make the datasets contemporaneous.",
            "REMA mosaic pixels are a multi-date median composite; ATL06 points here are from a dated 2026 pass.",
            "delta_h_m = ATL06 h_li - REMA rendered height.",
            "No deformation or correction has been applied to REMA.",
        ],
    }
    out_path = nasa_dir / "atl06-rema-comparison.json"
    out_path.write_text(json.dumps(output, separators=(",", ":")) + "\n", encoding="utf-8")

    print("Open Antarctica - ATL06 / REMA validation")
    print(f"ATL06 track: {track_path}")
    print(f"REMA viewer: {meta_path}")
    print(f"Comparison:  {out_path}")
    print()
    print(f"Sampled points: {len(all_deltas)}")
    print(f"Unsampled:      {unsampled}")
    print(f"Extreme |dh| > {args.outlier_limit_m:g} m: {len(all_deltas) - len(robust_deltas)}")
    print()
    s = stats(robust_deltas)
    print("Robust ATL06 - REMA delta (extreme outliers excluded):")
    print(f"  median: {s.get('median_m')} m")
    print(f"  MAD:    {s.get('mad_m')} m")
    print(f"  mean:   {s.get('mean_m')} m")
    print(f"  RMSE:   {s.get('rmse_m')} m")
    print(f"  p05..p95: {s.get('p05_m')} .. {s.get('p95_m')} m")
    print()
    for beam, values in sorted(by_beam.items()):
        bs = stats([v for v in values if abs(v) <= args.outlier_limit_m])
        print(f"  {beam}: n={bs.get('count', 0)} median={bs.get('median_m')} m MAD={bs.get('mad_m')} m")
    print()
    print("No REMA correction was applied. Next: inspect these deltas, then render the dated ATL06 track as an overlay.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
