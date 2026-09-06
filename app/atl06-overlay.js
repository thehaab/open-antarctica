import * as THREE from 'three';

const toggleEl = document.getElementById('atl06Toggle');
const metaEl = document.getElementById('atl06Meta');
const exaggerationEl = document.getElementById('exaggeration');
const params = new URLSearchParams(window.location.search);
const REGION = params.get('region') || 'ferrar-glacier';
const RESOLUTION = params.get('resolution') || '10m';
const COMPARISON_URL = `../data/processed/${REGION}/nasa/atl06-rema-comparison.json`;
const TERRAIN_META_URL = `../data/processed/${REGION}/viewer/${RESOLUTION}/terrain-lod.json`;
const DISPLAY_LIFT_M = 1.5;

let viewerApi = null;
let overlayGroup = null;
let loaded = false;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : 'unknown date';
}

function requestRender() {
  viewerApi?.requestRender?.();
}

function colorForDelta(delta) {
  const value = Number(delta);
  const t = Math.min(Math.abs(value) / 2.0, 1.0);
  const neutral = new THREE.Color(0xf4f7fb);
  const endpoint = value < 0 ? new THREE.Color(0x35a7ff) : new THREE.Color(0xffa24a);
  return neutral.lerp(endpoint, t);
}

function syncOverlayState() {
  if (!overlayGroup) return;
  overlayGroup.visible = Boolean(toggleEl?.checked);
  overlayGroup.scale.y = Number(exaggerationEl?.value || 1);
  requestRender();
}

async function buildOverlay() {
  if (loaded || !viewerApi) return;
  loaded = true;

  try {
    const [comparisonResponse, terrainResponse] = await Promise.all([
      fetch(COMPARISON_URL, { cache: 'no-store' }),
      fetch(TERRAIN_META_URL, { cache: 'no-store' }),
    ]);

    if (!comparisonResponse.ok) {
      throw new Error('ATL06/REMA comparison not built locally');
    }
    if (!terrainResponse.ok) {
      throw new Error(`Terrain metadata unavailable for ${RESOLUTION}`);
    }

    const comparison = await comparisonResponse.json();
    const terrainMeta = await terrainResponse.json();
    const origin = comparison.region?.local_origin;
    const extent = terrainMeta.extent;
    const elevationMin = Number(terrainMeta.elevation?.min);
    if (!origin || !extent || !Number.isFinite(elevationMin)) {
      throw new Error('ATL06 overlay metadata is incomplete');
    }

    const terrainCenterX = (Number(extent.xmin) + Number(extent.xmax)) * 0.5;
    const terrainCenterY = (Number(extent.ymin) + Number(extent.ymax)) * 0.5;
    const xOffset = Number(origin.x) - terrainCenterX;
    const zOffset = terrainCenterY - Number(origin.y);

    overlayGroup = new THREE.Group();
    overlayGroup.name = 'ICESat-2 ATL06 dated science overlay';
    overlayGroup.renderOrder = 20;

    let pointCount = 0;
    for (const track of comparison.tracks || []) {
      const points = Array.isArray(track.points) ? track.points : [];
      if (!points.length) continue;

      const positions = new Float32Array(points.length * 3);
      const colors = new Float32Array(points.length * 3);
      let p = 0;
      let c = 0;

      for (const point of points) {
        const x = Number(point.x_m) + xOffset;
        const y = Number(point.h_li_m) - elevationMin + DISPLAY_LIFT_M;
        const z = Number(point.z_m) + zOffset;
        positions[p++] = x;
        positions[p++] = y;
        positions[p++] = z;

        const color = colorForDelta(point.delta_h_m);
        colors[c++] = color.r;
        colors[c++] = color.g;
        colors[c++] = color.b;
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.computeBoundingSphere();

      const material = new THREE.PointsMaterial({
        size: 3.0,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthTest: true,
        depthWrite: false,
      });

      const pointsObject = new THREE.Points(geometry, material);
      pointsObject.name = `ATL06 ${track.beam || 'beam'}`;
      pointsObject.renderOrder = 20;
      overlayGroup.add(pointsObject);
      pointCount += points.length;
    }

    viewerApi.scene.add(overlayGroup);
    syncOverlayState();

    const sourceTime = comparison.source?.atl06?.indexed_nearest_time;
    const summary = comparison.summary?.robust_points || comparison.summary?.all_points || {};
    const beamCount = (comparison.tracks || []).length;
    metaEl.innerHTML = [
      '<strong>ICESat-2 ATL06 science overlay</strong>',
      `Pass: ${esc(dateOnly(sourceTime))} · ${beamCount} beams · ${pointCount.toLocaleString()} segments`,
      `ATL06 − REMA median: ${Number(summary.median_m).toFixed(3)} m`,
      `RMSE: ${Number(summary.rmse_m).toFixed(3)} m · p05…p95: ${Number(summary.p05_m).toFixed(3)}…${Number(summary.p95_m).toFixed(3)} m`,
      'Point color: blue = below REMA · white ≈ agreement · orange = above REMA',
      `<em>Measured ATL06 height; ${DISPLAY_LIFT_M.toFixed(1)} m display lift only to avoid z-fighting. REMA is not corrected.</em>`,
    ].join('<br>');
  } catch (error) {
    if (toggleEl) {
      toggleEl.checked = false;
      toggleEl.disabled = true;
    }
    metaEl.innerHTML = [
      '<strong>ICESat-2 ATL06 science overlay</strong>',
      `<em>${esc(error.message)}.</em>`,
      'Run the ATL06 ingest and validation scripts before enabling this layer.',
    ].join('<br>');
  }
}

function attach(api) {
  if (!api || viewerApi) return;
  viewerApi = api;
  buildOverlay();
}

if (toggleEl) toggleEl.addEventListener('change', syncOverlayState);
if (exaggerationEl) exaggerationEl.addEventListener('input', syncOverlayState);

if (window.openAntarcticaViewer) {
  attach(window.openAntarcticaViewer);
} else {
  window.addEventListener('open-antarctica-viewer-ready', (event) => {
    attach(event.detail || window.openAntarcticaViewer);
  }, { once: true });
}
