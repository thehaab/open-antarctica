#!/usr/bin/env bash
set -euo pipefail

REGION="ferrar-glacier"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="$ROOT/regions/$REGION.json"

command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }
command -v gdal_translate >/dev/null || { echo "gdal_translate is required" >&2; exit 2; }
command -v gdalinfo >/dev/null || { echo "gdalinfo is required" >&2; exit 2; }

[[ -f "$CFG" ]] || { echo "Region definition not found: $CFG" >&2; exit 2; }

NAME="$(jq -r '.name' "$CFG")"
CRS="$(jq -r '.crs' "$CFG")"
read -r XMIN YMIN XMAX YMAX < <(jq -r '.bbox | @tsv' "$CFG")
WMS_URL="$(jq -r '.sources.lima.wms_url' "$CFG")"
WMS_VERSION="$(jq -r '.sources.lima.wms_version' "$CFG")"
RES_M="$(jq -r '.sources.lima.nominal_resolution_m' "$CFG")"
LAYERS="$(jq -r '.sources.lima.layers | join(",")' "$CFG")"

if [[ -z "$WMS_URL" || "$WMS_URL" == "null" ]]; then
  echo "No LIMA source configured for $REGION" >&2
  exit 2
fi

# Request at approximately native LIMA resolution while respecting the
# ArcGIS service's 4096 px maximum image dimension.
WIDTH="$(awk -v a="$XMIN" -v b="$XMAX" -v r="$RES_M" 'BEGIN{printf "%d", ((b-a)/r)+0.5}')"
HEIGHT="$(awk -v a="$YMIN" -v b="$YMAX" -v r="$RES_M" 'BEGIN{printf "%d", ((b-a)/r)+0.5}')"

if (( WIDTH > 4096 || HEIGHT > 4096 )); then
  echo "Requested LIMA image would be ${WIDTH}x${HEIGHT}, exceeding the service 4096 px limit." >&2
  echo "This region requires tiled acquisition; refusing a silently downsampled request." >&2
  exit 3
fi

OUT_DIR="$ROOT/data/processed/$REGION/imagery/lima"
mkdir -p "$OUT_DIR"
RAW="$OUT_DIR/${REGION}_lima_15m.png"
GEOTIFF="$OUT_DIR/${REGION}_lima_15m.tif"

BBOX="$XMIN,$YMIN,$XMAX,$YMAX"

echo "Open Antarctica - LIMA imagery acquisition"
echo "Region:      $NAME"
echo "CRS:         $CRS"
echo "BBOX:        $BBOX"
echo "Resolution:  ~${RES_M} m"
echo "Image size:  ${WIDTH} x ${HEIGHT}"
echo "Layers:      $LAYERS"
echo "Output:      $GEOTIFF"
echo

echo "Requesting natural-color LIMA from USGS WMS ..."
TMP="${RAW}.part"
rm -f "$TMP"

curl --fail --location --silent --show-error \
  --get "$WMS_URL" \
  --data-urlencode "SERVICE=WMS" \
  --data-urlencode "VERSION=$WMS_VERSION" \
  --data-urlencode "REQUEST=GetMap" \
  --data-urlencode "LAYERS=$LAYERS" \
  --data-urlencode "STYLES=" \
  --data-urlencode "SRS=$CRS" \
  --data-urlencode "BBOX=$BBOX" \
  --data-urlencode "WIDTH=$WIDTH" \
  --data-urlencode "HEIGHT=$HEIGHT" \
  --data-urlencode "FORMAT=image/png" \
  --data-urlencode "TRANSPARENT=FALSE" \
  --output "$TMP"

# Confirm the response is actually a raster rather than an XML/HTML service error.
if ! gdalinfo "$TMP" >/dev/null 2>&1; then
  echo "USGS response is not a readable raster. First bytes:" >&2
  head -c 300 "$TMP" >&2 || true
  echo >&2
  exit 4
fi
mv "$TMP" "$RAW"

echo "Georeferencing exact EPSG:3031 footprint ..."
rm -f "$GEOTIFF"
gdal_translate \
  -a_srs "$CRS" \
  -a_ullr "$XMIN" "$YMAX" "$XMAX" "$YMIN" \
  -co TILED=YES \
  -co COMPRESS=DEFLATE \
  -co PHOTOMETRIC=RGB \
  "$RAW" "$GEOTIFF"

echo
printf 'Raster: '
gdalinfo "$GEOTIFF" | grep '^Size is' | head -n1
printf 'Origin: '
gdalinfo "$GEOTIFF" | grep '^Origin =' | head -n1
printf 'Pixel:  '
gdalinfo "$GEOTIFF" | grep '^Pixel Size =' | head -n1

echo
echo "LIMA acquisition complete: $GEOTIFF"
echo "Quicklook: explorer.exe \"$(wslpath -w "$RAW")\""
