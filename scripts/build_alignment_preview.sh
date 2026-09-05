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

for cmd in jq gdalinfo gdalwarp gdaldem gdal_translate; do
  command -v "$cmd" >/dev/null || { echo "$cmd is required" >&2; exit 2; }
done

[[ -f "$CFG" ]] || { echo "Missing region config: $CFG" >&2; exit 2; }

NAME="$(jq -r '.name' "$CFG")"
VERSION="$(jq -r '.sources.rema.version' "$CFG")"
DEM="$ROOT/data/processed/$REGION/terrain/$RESOLUTION/${REGION}_${RESOLUTION}_dem.tif"
LIMA="$ROOT/data/processed/$REGION/imagery/lima/${REGION}_lima_15m.tif"
OUT_DIR="$ROOT/data/processed/$REGION/preview"
mkdir -p "$OUT_DIR"

ALIGNED_TIF="$OUT_DIR/${REGION}_lima_on_${RESOLUTION}_grid.tif"
ALIGNED_PNG="$OUT_DIR/${REGION}_lima_on_${RESOLUTION}_grid.png"
HILLSHADE_PNG="$OUT_DIR/${REGION}_${RESOLUTION}_hillshade.png"
HTML="$OUT_DIR/${REGION}_${RESOLUTION}_alignment.html"

[[ -f "$DEM" ]] || { echo "Missing DEM: $DEM" >&2; exit 2; }
[[ -f "$LIMA" ]] || { echo "Missing LIMA imagery: $LIMA" >&2; exit 2; }

info="$(gdalinfo -json "$DEM")"
WIDTH="$(jq -r '.size[0]' <<<"$info")"
HEIGHT="$(jq -r '.size[1]' <<<"$info")"
X0="$(jq -r '.geoTransform[0]' <<<"$info")"
PX="$(jq -r '.geoTransform[1]' <<<"$info")"
Y0="$(jq -r '.geoTransform[3]' <<<"$info")"
PY="$(jq -r '.geoTransform[5]' <<<"$info")"
RX="$(jq -r '.geoTransform[2]' <<<"$info")"
RY="$(jq -r '.geoTransform[4]' <<<"$info")"

if [[ "$RX" != "0.0" && "$RX" != "0" ]] || [[ "$RY" != "0.0" && "$RY" != "0" ]]; then
  echo "Rotated DEM geotransforms are not supported by this preview script." >&2
  exit 3
fi

X1="$(awk -v a="$X0" -v n="$WIDTH" -v p="$PX" 'BEGIN{printf "%.12f",a+n*p}')"
Y1="$(awk -v a="$Y0" -v n="$HEIGHT" -v p="$PY" 'BEGIN{printf "%.12f",a+n*p}')"
XMIN="$(awk -v a="$X0" -v b="$X1" 'BEGIN{print (a<b?a:b)}')"
XMAX="$(awk -v a="$X0" -v b="$X1" 'BEGIN{print (a>b?a:b)}')"
YMIN="$(awk -v a="$Y0" -v b="$Y1" 'BEGIN{print (a<b?a:b)}')"
YMAX="$(awk -v a="$Y0" -v b="$Y1" 'BEGIN{print (a>b?a:b)}')"

echo "Open Antarctica - REMA/LIMA alignment preview"
echo "Region:      $NAME"
echo "DEM grid:    ${WIDTH} x ${HEIGHT}"
printf 'DEM extent:  x=%.3f..%.3f, y=%.3f..%.3f\n' "$XMIN" "$XMAX" "$YMIN" "$YMAX"
echo

echo "Resampling LIMA onto the exact DEM grid ..."
gdalwarp -overwrite \
  -t_srs EPSG:3031 \
  -te "$XMIN" "$YMIN" "$XMAX" "$YMAX" \
  -ts "$WIDTH" "$HEIGHT" \
  -r cubic \
  -co TILED=YES -co COMPRESS=DEFLATE \
  "$LIMA" "$ALIGNED_TIF"

echo "Writing aligned imagery PNG ..."
gdal_translate -of PNG "$ALIGNED_TIF" "$ALIGNED_PNG"

echo "Generating matching REMA hillshade ..."
gdaldem hillshade "$DEM" "$HILLSHADE_PNG" \
  -of PNG -multidirectional -compute_edges

cat > "$HTML" <<EOF
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Open Antarctica — ${NAME} alignment</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #101216; color: #eceff4; font: 14px/1.4 system-ui, sans-serif; }
  header { padding: 14px 18px; display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
  h1 { font-size: 17px; margin: 0; font-weight: 650; }
  .controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  input[type=range] { width: 220px; }
  .stage { position: relative; width: 100vw; overflow: auto; background: #000; }
  .frame { position: relative; width: min(100vw, ${WIDTH}px); margin: 0 auto; line-height: 0; }
  .frame img { width: 100%; height: auto; display: block; }
  #shade { position: absolute; inset: 0; opacity: .34; mix-blend-mode: multiply; pointer-events: none; }
  .meta { opacity: .7; }
</style>
</head>
<body>
<header>
  <h1>Open Antarctica — ${NAME}</h1>
  <div class="controls">
    <label>REMA hillshade <input id="opacity" type="range" min="0" max="100" value="34"></label>
    <output id="value">34%</output>
    <label><input id="multiply" type="checkbox" checked> multiply blend</label>
  </div>
  <span class="meta">LIMA 15 m imagery aligned to REMA ${RESOLUTION} grid (${WIDTH} × ${HEIGHT})</span>
</header>
<div class="stage">
  <div class="frame">
    <img src="$(basename "$ALIGNED_PNG")" alt="Aligned LIMA imagery">
    <img id="shade" src="$(basename "$HILLSHADE_PNG")" alt="REMA hillshade">
  </div>
</div>
<script>
const slider = document.getElementById('opacity');
const shade = document.getElementById('shade');
const value = document.getElementById('value');
const multiply = document.getElementById('multiply');
function update() {
  shade.style.opacity = Number(slider.value) / 100;
  shade.style.mixBlendMode = multiply.checked ? 'multiply' : 'normal';
  value.textContent = slider.value + '%';
}
slider.addEventListener('input', update);
multiply.addEventListener('change', update);
update();
</script>
</body>
</html>
EOF

echo
echo "Alignment preview complete: $HTML"
if command -v wslpath >/dev/null 2>&1; then
  echo "Open with: explorer.exe \"$(wslpath -w "$HTML")\""
fi
