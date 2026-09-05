#!/usr/bin/env bash
set -euo pipefail

REGION="ferrar-glacier"
RESOLUTION="10m"
GRID_WIDTH=768
TEXTURE_WIDTH=2048

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --resolution) RESOLUTION="$2"; shift 2 ;;
    --grid-width) GRID_WIDTH="$2"; shift 2 ;;
    --texture-width) TEXTURE_WIDTH="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="$ROOT/regions/$REGION.json"

for cmd in jq gdalinfo gdal_translate; do
  command -v "$cmd" >/dev/null || { echo "$cmd is required" >&2; exit 2; }
done

[[ -f "$CFG" ]] || { echo "Missing region config: $CFG" >&2; exit 2; }

NAME="$(jq -r '.name' "$CFG")"
DEM="$ROOT/data/processed/$REGION/terrain/$RESOLUTION/${REGION}_${RESOLUTION}_dem.tif"
ALIGNED="$ROOT/data/processed/$REGION/preview/${REGION}_lima_on_${RESOLUTION}_grid.tif"

if [[ ! -f "$DEM" ]]; then
  echo "Missing terrain DEM: $DEM" >&2
  exit 2
fi

if [[ ! -f "$ALIGNED" ]]; then
  echo "Aligned LIMA raster not found; building alignment assets first ..."
  bash "$ROOT/scripts/build_alignment_preview.sh" --region "$REGION" --resolution "$RESOLUTION"
fi

OUT="$ROOT/data/processed/$REGION/viewer/$RESOLUTION"
mkdir -p "$OUT"
HEIGHT_BIN="$OUT/height.bin"
TEXTURE_JPG="$OUT/texture.jpg"
META="$OUT/terrain.json"

rm -f "$HEIGHT_BIN" "$OUT/height.hdr" "$TEXTURE_JPG" "$META"

echo "Open Antarctica - local 3D viewer asset build"
echo "Region:        $NAME"
echo "Resolution:    $RESOLUTION"
echo "Terrain grid:  ${GRID_WIDTH}px wide"
echo "Texture:       ${TEXTURE_WIDTH}px wide"
echo

echo "Downsampling DEM to browser height grid ..."
gdal_translate \
  -of ENVI \
  -ot Float32 \
  -r bilinear \
  -outsize "$GRID_WIDTH" 0 \
  "$DEM" "$HEIGHT_BIN"

HINFO="$(gdalinfo -json "$HEIGHT_BIN")"
WIDTH="$(jq -r '.size[0]' <<<"$HINFO")"
HEIGHT="$(jq -r '.size[1]' <<<"$HINFO")"
X0="$(jq -r '.geoTransform[0]' <<<"$HINFO")"
PX="$(jq -r '.geoTransform[1]' <<<"$HINFO")"
Y0="$(jq -r '.geoTransform[3]' <<<"$HINFO")"
PY="$(jq -r '.geoTransform[5]' <<<"$HINFO")"
X1="$(awk -v a="$X0" -v n="$WIDTH" -v p="$PX" 'BEGIN{printf "%.12f",a+n*p}')"
Y1="$(awk -v a="$Y0" -v n="$HEIGHT" -v p="$PY" 'BEGIN{printf "%.12f",a+n*p}')"
XMIN="$(awk -v a="$X0" -v b="$X1" 'BEGIN{print (a<b?a:b)}')"
XMAX="$(awk -v a="$X0" -v b="$X1" 'BEGIN{print (a>b?a:b)}')"
YMIN="$(awk -v a="$Y0" -v b="$Y1" 'BEGIN{print (a<b?a:b)}')"
YMAX="$(awk -v a="$Y0" -v b="$Y1" 'BEGIN{print (a>b?a:b)}')"

# ENVI is a raw little-endian float32 raster on the WSL/x86 development target.
BYTE_ORDER="$(grep -E '^byte order' "$OUT/height.hdr" | awk -F= '{gsub(/[[:space:]]/,"",$2); print $2}' || true)"
if [[ -n "$BYTE_ORDER" && "$BYTE_ORDER" != "0" ]]; then
  echo "Unexpected ENVI byte order $BYTE_ORDER; viewer currently expects little-endian float32." >&2
  exit 3
fi

echo "Writing browser texture ..."
gdal_translate \
  -of JPEG \
  -r cubic \
  -outsize "$TEXTURE_WIDTH" 0 \
  -co QUALITY=92 \
  "$ALIGNED" "$TEXTURE_JPG"

jq -n \
  --arg region "$REGION" \
  --arg name "$NAME" \
  --arg resolution "$RESOLUTION" \
  --arg crs "EPSG:3031" \
  --arg heightmap "height.bin" \
  --arg texture "texture.jpg" \
  --argjson width "$WIDTH" \
  --argjson height "$HEIGHT" \
  --argjson xmin "$XMIN" \
  --argjson xmax "$XMAX" \
  --argjson ymin "$YMIN" \
  --argjson ymax "$YMAX" \
  --argjson pixelX "$PX" \
  --argjson pixelY "$PY" \
  '{
    region: $region,
    name: $name,
    resolution: $resolution,
    crs: $crs,
    width: $width,
    height: $height,
    extent: {xmin:$xmin, xmax:$xmax, ymin:$ymin, ymax:$ymax},
    pixelSize: {x:$pixelX, y:$pixelY},
    heightmap: $heightmap,
    heightEncoding: "float32-little-endian",
    texture: $texture,
    sources: {
      terrain: "REMA v2",
      imagery: "USGS LIMA 15 m natural color"
    }
  }' > "$META"

echo
echo "Viewer assets complete: $OUT"
echo "Grid:    ${WIDTH} x ${HEIGHT}"
echo "Texture: $TEXTURE_JPG"
echo "Metadata: $META"
echo
echo "Serve the repository root with:"
echo "  python3 -m http.server 8000"
echo "Then open:"
echo "  http://localhost:8000/app/"
