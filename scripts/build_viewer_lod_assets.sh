#!/usr/bin/env bash
set -euo pipefail

REGION="ferrar-glacier"
RESOLUTION="10m"
LEVELS=3
ROOT_TILES_X=4
ROOT_TILES_Y=1
TILE_SAMPLES=257
TEXTURE_SIZE=512
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --resolution) RESOLUTION="$2"; shift 2 ;;
    --levels) LEVELS="$2"; shift 2 ;;
    --tile-samples) TILE_SAMPLES="$2"; shift 2 ;;
    --texture-size) TEXTURE_SIZE="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="$ROOT/regions/$REGION.json"

for cmd in jq gdalinfo gdal_translate awk; do
  command -v "$cmd" >/dev/null || { echo "$cmd is required" >&2; exit 2; }
done

[[ -f "$CFG" ]] || { echo "Missing region config: $CFG" >&2; exit 2; }
[[ "$LEVELS" =~ ^[1-5]$ ]] || { echo "--levels must be 1..5" >&2; exit 2; }
[[ "$TILE_SAMPLES" =~ ^[0-9]+$ ]] || { echo "--tile-samples must be an integer" >&2; exit 2; }
[[ "$TEXTURE_SIZE" =~ ^[0-9]+$ ]] || { echo "--texture-size must be an integer" >&2; exit 2; }

NAME="$(jq -r '.name' "$CFG")"
DEM="$ROOT/data/processed/$REGION/terrain/$RESOLUTION/${REGION}_${RESOLUTION}_dem.tif"
ALIGNED="$ROOT/data/processed/$REGION/preview/${REGION}_lima_on_${RESOLUTION}_grid.tif"

[[ -f "$DEM" ]] || { echo "Missing terrain DEM: $DEM" >&2; exit 2; }
if [[ ! -f "$ALIGNED" ]]; then
  echo "Aligned LIMA raster not found; building alignment assets first ..."
  bash "$ROOT/scripts/build_alignment_preview.sh" --region "$REGION" --resolution "$RESOLUTION"
fi

OUT="$ROOT/data/processed/$REGION/viewer/$RESOLUTION"
TILES="$OUT/tiles"
WORK="$OUT/_lod_work"
META="$OUT/terrain-lod.json"
mkdir -p "$TILES" "$WORK"

# v1 sampled every tile independently. Even though neighboring tiles described the
# same geographic edge, their outer raster pixels represented different pixel-center
# locations, which could leave visible cracks. v2 first builds one shared height grid
# per LOD and then cuts overlapping 257x257 windows from it. Adjacent tiles therefore
# contain byte-identical shared edge rows/columns.
if [[ -f "$META" ]]; then
  EXISTING_FORMAT="$(jq -r '.format // ""' "$META" 2>/dev/null || true)"
  if [[ "$EXISTING_FORMAT" != "open-antarctica-lod-v2" ]]; then
    echo "Legacy LOD assets detected; forcing seam-safe v2 rebuild."
    FORCE=1
  fi
fi

INFO="$(gdalinfo -json "$DEM")"
SOURCE_WIDTH="$(jq -r '.size[0]' <<<"$INFO")"
SOURCE_HEIGHT="$(jq -r '.size[1]' <<<"$INFO")"
X0="$(jq -r '.geoTransform[0]' <<<"$INFO")"
PX="$(jq -r '.geoTransform[1]' <<<"$INFO")"
Y0="$(jq -r '.geoTransform[3]' <<<"$INFO")"
PY="$(jq -r '.geoTransform[5]' <<<"$INFO")"
X1="$(awk -v a="$X0" -v n="$SOURCE_WIDTH" -v p="$PX" 'BEGIN{printf "%.12f",a+n*p}')"
Y1="$(awk -v a="$Y0" -v n="$SOURCE_HEIGHT" -v p="$PY" 'BEGIN{printf "%.12f",a+n*p}')"
XMIN="$(awk -v a="$X0" -v b="$X1" 'BEGIN{printf "%.12f",(a<b?a:b)}')"
XMAX="$(awk -v a="$X0" -v b="$X1" 'BEGIN{printf "%.12f",(a>b?a:b)}')"
YMIN="$(awk -v a="$Y0" -v b="$Y1" 'BEGIN{printf "%.12f",(a<b?a:b)}')"
YMAX="$(awk -v a="$Y0" -v b="$Y1" 'BEGIN{printf "%.12f",(a>b?a:b)}')"
SPAN_X="$(awk -v a="$XMIN" -v b="$XMAX" 'BEGIN{printf "%.12f",b-a}')"
SPAN_Y="$(awk -v a="$YMIN" -v b="$YMAX" 'BEGIN{printf "%.12f",b-a}')"

STATS="$(gdalinfo -stats "$DEM")"
MIN_HEIGHT="$(grep -m1 -oE 'STATISTICS_MINIMUM=-?[0-9.]+' <<<"$STATS" | cut -d= -f2)"
MAX_HEIGHT="$(grep -m1 -oE 'STATISTICS_MAXIMUM=-?[0-9.]+' <<<"$STATS" | cut -d= -f2)"
[[ -n "$MIN_HEIGHT" && -n "$MAX_HEIGHT" ]] || { echo "Unable to determine DEM elevation range" >&2; exit 3; }

MAX_LEVEL=$((LEVELS - 1))
TOTAL=0
for ((level=0; level<LEVELS; level++)); do
  scale=$((1 << level))
  nx=$((ROOT_TILES_X * scale))
  ny=$((ROOT_TILES_Y * scale))
  TOTAL=$((TOTAL + nx * ny))
done

echo "Open Antarctica - tiled LOD viewer asset build"
echo "Region:         $NAME"
echo "Resolution:     $RESOLUTION"
echo "Source grid:    ${SOURCE_WIDTH} x ${SOURCE_HEIGHT}"
echo "LOD levels:     0..${MAX_LEVEL}"
echo "Root grid:      ${ROOT_TILES_X} x ${ROOT_TILES_Y}"
echo "Tile samples:   ${TILE_SAMPLES} x ${TILE_SAMPLES}"
echo "Tile texture:   ${TEXTURE_SIZE} x ${TEXTURE_SIZE}"
echo "Seam strategy:  shared level grid + overlapping edge samples"
echo "Total tiles:    $TOTAL"
echo

DONE=0
for ((level=0; level<LEVELS; level++)); do
  scale=$((1 << level))
  nx=$((ROOT_TILES_X * scale))
  ny=$((ROOT_TILES_Y * scale))
  grid_width=$((nx * (TILE_SAMPLES - 1) + 1))
  grid_height=$((ny * (TILE_SAMPLES - 1) + 1))
  shared_height="$WORK/l${level}_height.bin"
  shared_hdr="$WORK/l${level}_height.hdr"

  echo "Level $level: ${nx} x ${ny} tiles; shared grid ${grid_width} x ${grid_height}"

  if [[ "$FORCE" == "1" || ! -f "$shared_height" ]]; then
    rm -f "$shared_height" "$shared_hdr" "$shared_height.aux.xml"
    gdal_translate -q \
      -of ENVI -ot Float32 -r bilinear \
      -outsize "$grid_width" "$grid_height" \
      "$DEM" "$shared_height"

    BYTE_ORDER="$(grep -E '^byte order' "$shared_hdr" | awk -F= '{gsub(/[[:space:]]/,"",$2); print $2}' || true)"
    if [[ -n "$BYTE_ORDER" && "$BYTE_ORDER" != "0" ]]; then
      echo "Unexpected ENVI byte order $BYTE_ORDER for $shared_height" >&2
      exit 3
    fi
  fi

  for ((ty=0; ty<ny; ty++)); do
    for ((tx=0; tx<nx; tx++)); do
      dir="$TILES/l${level}/${tx}_${ty}"
      mkdir -p "$dir"
      height="$dir/height.bin"
      hdr="$dir/height.hdr"
      texture="$dir/texture.jpg"

      txmin="$(awk -v a="$XMIN" -v s="$SPAN_X" -v x="$tx" -v n="$nx" 'BEGIN{printf "%.12f",a+s*x/n}')"
      txmax="$(awk -v a="$XMIN" -v s="$SPAN_X" -v x="$tx" -v n="$nx" 'BEGIN{printf "%.12f",a+s*(x+1)/n}')"
      tymax="$(awk -v a="$YMAX" -v s="$SPAN_Y" -v y="$ty" -v n="$ny" 'BEGIN{printf "%.12f",a-s*y/n}')"
      tymin="$(awk -v a="$YMAX" -v s="$SPAN_Y" -v y="$ty" -v n="$ny" 'BEGIN{printf "%.12f",a-s*(y+1)/n}')"

      if [[ "$FORCE" == "1" || ! -f "$height" ]]; then
        src_x=$((tx * (TILE_SAMPLES - 1)))
        src_y=$((ty * (TILE_SAMPLES - 1)))
        rm -f "$height" "$hdr" "$height.aux.xml"
        gdal_translate -q \
          -of ENVI -ot Float32 \
          -srcwin "$src_x" "$src_y" "$TILE_SAMPLES" "$TILE_SAMPLES" \
          "$shared_height" "$height"

        BYTE_ORDER="$(grep -E '^byte order' "$hdr" | awk -F= '{gsub(/[[:space:]]/,"",$2); print $2}' || true)"
        if [[ -n "$BYTE_ORDER" && "$BYTE_ORDER" != "0" ]]; then
          echo "Unexpected ENVI byte order $BYTE_ORDER for $height" >&2
          exit 3
        fi
        rm -f "$hdr" "$height.aux.xml"
      fi

      if [[ "$FORCE" == "1" || ! -f "$texture" ]]; then
        rm -f "$texture" "$texture.aux.xml"
        gdal_translate -q \
          -of JPEG -r cubic \
          -projwin "$txmin" "$tymax" "$txmax" "$tymin" \
          -projwin_srs EPSG:3031 \
          -outsize "$TEXTURE_SIZE" "$TEXTURE_SIZE" \
          -co QUALITY=90 \
          "$ALIGNED" "$texture"
        rm -f "$texture.aux.xml"
      fi

      DONE=$((DONE + 1))
      if (( DONE % 8 == 0 || DONE == TOTAL )); then
        printf '  %d / %d tiles\r' "$DONE" "$TOTAL"
      fi
    done
  done
  echo
 done

jq -n \
  --arg region "$REGION" \
  --arg name "$NAME" \
  --arg resolution "$RESOLUTION" \
  --arg crs "EPSG:3031" \
  --argjson sourceWidth "$SOURCE_WIDTH" \
  --argjson sourceHeight "$SOURCE_HEIGHT" \
  --argjson xmin "$XMIN" \
  --argjson xmax "$XMAX" \
  --argjson ymin "$YMIN" \
  --argjson ymax "$YMAX" \
  --argjson pixelX "$PX" \
  --argjson pixelY "$PY" \
  --argjson minHeight "$MIN_HEIGHT" \
  --argjson maxHeight "$MAX_HEIGHT" \
  --argjson rootTilesX "$ROOT_TILES_X" \
  --argjson rootTilesY "$ROOT_TILES_Y" \
  --argjson maxLevel "$MAX_LEVEL" \
  --argjson samples "$TILE_SAMPLES" \
  --argjson textureSize "$TEXTURE_SIZE" \
  '{
    format: "open-antarctica-lod-v2",
    region: $region,
    name: $name,
    resolution: $resolution,
    crs: $crs,
    sourceGrid: {width:$sourceWidth, height:$sourceHeight},
    extent: {xmin:$xmin, xmax:$xmax, ymin:$ymin, ymax:$ymax},
    nativePixelSize: {x:$pixelX, y:$pixelY},
    elevation: {min:$minHeight, max:$maxHeight},
    lod: {
      rootTilesX:$rootTilesX,
      rootTilesY:$rootTilesY,
      maxLevel:$maxLevel,
      samples:$samples,
      textureSize:$textureSize,
      heightPattern:"tiles/l{level}/{x}_{y}/height.bin",
      texturePattern:"tiles/l{level}/{x}_{y}/texture.jpg",
      seamStrategy:"shared-level-grid"
    },
    sources: {
      terrain:"PGC REMA v2",
      imagery:"USGS LIMA 15 m natural color"
    }
  }' > "$META"

echo
echo "LOD viewer assets complete: $OUT"
echo "Metadata: $META"
echo "Serve the repository root with: python3 -m http.server 8000"
echo "Open: http://localhost:8000/app/"
