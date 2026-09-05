#!/usr/bin/env python3
"""Download the REMA DEM archives required by a configured Open Antarctica region.

Uses only the Python standard library. Downloads are resumable when the server
honors HTTP Range requests. By default, only the primary *_dem.tif is extracted
from each archive.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path

CHUNK_SIZE = 4 * 1024 * 1024
USER_AGENT = "OpenAntarctica/0.0.1 (+https://github.com/thehaab/open-antarctica)"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def load_region(region_id: str) -> dict:
    path = repo_root() / "regions" / f"{region_id}.json"
    if not path.exists():
        raise SystemExit(f"Region definition not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def human_bytes(value: int | None) -> str:
    if value is None:
        return "?"
    units = ["B", "KiB", "MiB", "GiB", "TiB"]
    n = float(value)
    for unit in units:
        if n < 1024 or unit == units[-1]:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{value} B"


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".part")

    if destination.exists():
        print(f"[skip] {destination.name} already exists")
        return

    start = partial.stat().st_size if partial.exists() else 0
    headers = {"User-Agent": USER_AGENT}
    if start:
        headers["Range"] = f"bytes={start}-"
        print(f"[resume] {destination.name} at {human_bytes(start)}")
    else:
        print(f"[download] {destination.name}")

    request = urllib.request.Request(url, headers=headers)

    try:
        response = urllib.request.urlopen(request)
    except urllib.error.HTTPError as exc:
        if start and exc.code == 416:
            partial.replace(destination)
            print(f"[done] {destination.name}")
            return
        raise

    status = getattr(response, "status", None)
    if start and status != 206:
        response.close()
        print("[info] Server did not honor Range request; restarting download")
        partial.unlink(missing_ok=True)
        return download(url, destination)

    content_length = response.headers.get("Content-Length")
    total = (start + int(content_length)) if content_length else None
    mode = "ab" if start else "wb"
    downloaded = start
    last_report = 0.0

    with response, partial.open(mode) as output:
        while True:
            chunk = response.read(CHUNK_SIZE)
            if not chunk:
                break
            output.write(chunk)
            downloaded += len(chunk)
            now = time.monotonic()
            if now - last_report >= 2.0:
                if total:
                    pct = downloaded / total * 100
                    print(
                        f"  {human_bytes(downloaded)} / {human_bytes(total)} "
                        f"({pct:5.1f}%)",
                        end="\r",
                        flush=True,
                    )
                else:
                    print(f"  {human_bytes(downloaded)}", end="\r", flush=True)
                last_report = now

    print(" " * 72, end="\r")
    partial.replace(destination)
    print(f"[done] {destination.name} ({human_bytes(destination.stat().st_size)})")


def extract_dem(archive: Path, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)

    with tarfile.open(archive, mode="r:gz") as tf:
        members = [
            member
            for member in tf.getmembers()
            if member.isfile() and member.name.lower().endswith("_dem.tif")
        ]
        if len(members) != 1:
            names = ", ".join(member.name for member in members) or "none"
            raise RuntimeError(
                f"Expected exactly one *_dem.tif in {archive.name}; found: {names}"
            )

        member = members[0]
        target = output_dir / Path(member.name).name
        if target.exists():
            print(f"[skip] {target.name} already extracted")
            return target

        source = tf.extractfile(member)
        if source is None:
            raise RuntimeError(f"Unable to read {member.name} from {archive.name}")

        print(f"[extract] {member.name} -> {target}")
        with source, target.open("wb") as output:
            shutil.copyfileobj(source, output, length=CHUNK_SIZE)

    print(f"[done] {target.name} ({human_bytes(target.stat().st_size)})")
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--region",
        default="ferrar-glacier",
        help="Region id from regions/<id>.json (default: ferrar-glacier)",
    )
    parser.add_argument(
        "--resolution",
        choices=("10m", "2m"),
        default="10m",
        help="REMA mosaic resolution to acquire (default: 10m)",
    )
    parser.add_argument(
        "--no-extract",
        action="store_true",
        help="Download archives only; do not extract *_dem.tif files",
    )
    args = parser.parse_args()

    region = load_region(args.region)
    rema = region.get("sources", {}).get("rema", {})
    tiles = rema.get("tiles", {}).get(args.resolution)
    if not tiles:
        raise SystemExit(
            f"No REMA {args.resolution} tiles configured for region {args.region!r}"
        )

    version = rema.get("version", "unknown")
    root = repo_root() / "data" / "raw" / "rema" / f"v{version}" / args.resolution
    archive_dir = root / "archives"
    dem_dir = root / "dem"

    print(f"Region: {region['name']} ({region['id']})")
    print(f"REMA: v{version}, {args.resolution}, {region['crs']}")
    print(f"Tiles: {', '.join(tile['id'] for tile in tiles)}")
    print("PGC downloads are subject to the Polar Geospatial Center acknowledgement policy.")
    print()

    for tile in tiles:
        archive = archive_dir / tile["archive"]
        download(tile["url"], archive)
        if not args.no_extract:
            extract_dem(archive, dem_dir)

    print()
    print(f"REMA acquisition complete: {root}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nInterrupted. Partial downloads are kept for resume.", file=sys.stderr)
        raise SystemExit(130)
