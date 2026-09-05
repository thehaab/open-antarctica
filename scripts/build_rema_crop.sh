#!/usr/bin/env bash
set -euo pipefail

REGION="ferrar-glacier"
RESOLUTION="10m"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --resolution) RESOLUTION="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="$ROOT/regions/$REGION.json"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
command -v gdalinfo >/dev/null || { echo "gdalinfo is required" >&2; exit 2; }
command -v gdalbuildvrt >/dev/null || { echo "gdalbuildvrt is required" >&2; exit 2; }
command -v gdal_translate >/dev/null || { echo "gdal_translate is required" >&2; exit 2; }

NAME="$(jq -r '.name' "$CFG")"
VERSION="$(jq -r '.sources.rema.version' "$CFG")"
read -r XMIN YMIN XMAX YMAX < <(jq -r '.bbox | @tsv' "$CFG")
DEM_DIR="$ROOT/data/raw/rema/v${VERSION}/${RESOLUTION}/dem"
OUT_DIR="$ROOT/data/processed/$REGION/terrain/$RESOLUTION"
mkdir -p "$OUT_DIR"
VRT="$OUT_DIR/${REGION}_${RESOLUTION}_mosaic.vrt"
CROP="$OUT_DIR/${REGION}_${RESOLUTION}_dem.tif"
rm -f "$CROP"

mapfile -t ARCHIVES < <(jq -r ".sources.rema.tiles[\"$RESOLUTION\"][] | .archive" "$CFG")
if [[ ${#ARCHIVES[@]} -eq 0 ]]; then
  echo "No REMA $RESOLUTION tiles configured for $REGION" >&2
  exit 2
fi

DEMS=()
for archive in "${ARCHIVES[@]}"; do
  dem="${archive%.tar.gz}_dem.tif"
  path="$DEM_DIR/$dem"
  if [[ ! -f "$path" ]]; then
    echo "Missing configured DEM: $path" >&2
    echo "Run: python3 scripts/fetch_rema.py --region $REGION --resolution $RESOLUTION" >&2
    exit 2
  fi
  DEMS+=("$path")
done

echo "Open Antarctica - REMA crop build"
echo "Region:      $NAME"
echo "Resolution:  $RESOLUTION"
echo "Input DEMs:  ${#DEMS[@]}"
echo "Output:      $CROP"
echo

UNION_XMIN=""
UNION_XMAX=""
UNION_YMIN=""
UNION_YMAX=""
for dem in "${DEMS[@]}"; do
  echo "Validating $(basename "$dem") ..."
  info="$(gdalinfo -json "$dem")"
  width="$(jq -r '.size[0]' <<<"$info")"
  height="$(jq -r '.size[1]' <<<"$info")"
  x0="$(jq -r '.geoTransform[0]' <<<"$info")"
  px="$(jq -r '.geoTransform[1]' <<<"$info")"
  y0="$(jq -r '.geoTransform[3]' <<<"$info")"
  py="$(jq -r '.geoTransform[5]' <<<"$info")"
  x1="$(awk -v a="$x0" -v n="$width" -v p="$px" 'BEGIN{printf "%.12f",a+n*p}')"
  y1="$(awk -v a="$y0" -v n="$height" -v p="$py" 'BEGIN{printf "%.12f",a+n*p}')"
  exmin="$(awk -v a="$x0" -v b="$x1" 'BEGIN{print (a<b?a:b)}')"
  exmax="$(awk -v a="$x0" -v b="$x1" 'BEGIN{print (a>b?a:b)}')"
  eymin="$(awk -v a="$y0" -v b="$y1" 'BEGIN{print (a<b?a:b)}')"
  eymax="$(awk -v a="$y0" -v b="$y1" 'BEGIN{print (a>b?a:b)}')"
  printf '  extent x=%.0f..%.0f, y=%.0f..%.0f; pixel=%s x %s m\n' "$exmin" "$exmax" "$eymin" "$eymax" "$px" "$py"
  if [[ -z "$UNION_XMIN" ]]; then
    UNION_XMIN="$exmin"; UNION_XMAX="$exmax"; UNION_YMIN="$eymin"; UNION_YMAX="$eymax"
  else
    UNION_XMIN="$(awk -v a="$UNION_XMIN" -v b="$exmin" 'BEGIN{print (a<b?a:b)}')"
    UNION_XMAX="$(awk -v a="$UNION_XMAX" -v b="$exmax" 'BEGIN{print (a>b?a:b)}')"
    UNION_YMIN="$(awk -v a="$UNION_YMIN" -v b="$eymin" 'BEGIN{print (a<b?a:b)}')"
    UNION_YMAX="$(awk -v a="$UNION_YMAX" -v b="$eymax" 'BEGIN{print (a>b?a:b)}')"
  fi
done

printf 'Configured crop x=%.0f..%.0f, y=%.0f..%.0f\n' "$XMIN" "$XMAX" "$YMIN" "$YMAX"
printf 'Source union     x=%.0f..%.0f, y=%.0f..%.0f\n' "$UNION_XMIN" "$UNION_XMAX" "$UNION_YMIN" "$UNION_YMAX"

contained="$(awk -v xmin="$XMIN" -v xmax="$XMAX" -v ymin="$YMIN" -v ymax="$YMAX" -v uxmin="$UNION_XMIN" -v uxmax="$UNION_XMAX" -v uymin="$UNION_YMIN" -v uymax="$UNION_YMAX" 'BEGIN{print (xmin>=uxmin && xmax<=uxmax && ymin>=uymin && ymax<=uymax)?1:0}')"
if [[ "$contained" != "1" ]]; then
  echo "Configured region is not contained by configured REMA source tiles; refusing crop." >&2
  exit 3
fi

echo "Building VRT mosaic ..."
gdalbuildvrt -overwrite "$VRT" "${DEMS[@]}"

echo "Cropping to configured EPSG:3031 footprint ..."
gdal_translate -projwin "$XMIN" "$YMAX" "$XMAX" "$YMIN" -projwin_srs EPSG:3031 \
  -co TILED=YES -co COMPRESS=DEFLATE -co PREDICTOR=3 -co BIGTIFF=IF_SAFER \
  "$VRT" "$CROP"

stats="$(gdalinfo -stats "$CROP")"
valid="$(grep -oE 'STATISTICS_VALID_PERCENT=[0-9.]+' <<<"$stats" | head -n1 | cut -d= -f2 || true)"
if [[ -n "$valid" ]]; then
  echo "Valid elevation pixels: ${valid}%"
  awk -v v="$valid" 'BEGIN{exit !(v>0)}' || { echo "Output has 0% valid pixels" >&2; exit 4; }
fi

echo
gdalinfo "$CROP" | grep -E '^(Size is|Origin =|Pixel Size =|  NoData Value=)' || true
echo "REMA crop complete: $CROP"
