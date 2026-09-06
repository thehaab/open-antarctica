import * as THREE from 'three';

const toggleEl = document.getElementById('atl06Toggle');
const focusEl = document.getElementById('atl06Focus');
const metaEl = document.getElementById('atl06Meta');
const exaggerationEl = document.getElementById('exaggeration');
const params = new URLSearchParams(window.location.search);
const REGION = params.get('region') || 'ferrar-glacier';
const RESOLUTION = params.get('resolution') || '10m';
const COMPARISON_URL = `../data/processed/${REGION}/nasa/atl06-rema-comparison.json`;
const TERRAIN_META_URL = `../data/processed/${REGION}/viewer/${RESOLUTION}/terrain-lod.json`;
const DISPLAY_LIFT_M = 1.5;
const MAX_LINE_GAP_M = 250;

let viewerApi = null;
let overlayGroup = null;
let loaded = false;
let overlayBounds = null;

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
  const neutral = new THREE.Color(0xffffff);
  const endpoint = value < 0 ? new THREE.Color(0x00b7ff) : new THREE.Color(0xff7a18);
  return neutral.lerp(endpoint, t);
}

function syncOverlayState() {
  if (!overlayGroup) return;
  overlayGroup.visible = Boolean(toggleEl?.checked);
  overlayGroup.scale.y = Number(exaggerationEl?.value || 1);
  requestRender();
}

function buildRuns(points) {
  const runs = [];
  let current = [];
  let previous = null;
  for (const point of points) {
    if (previous) {
      const dx = Number(point.x_m) - Number(previous.x_m);
      const dz = Number(point.z_m) - Number(previous.z_m);
      if (Math.hypot(dx, dz) > MAX_LINE_GAP_M) {
        if (current.length >= 2) runs.push(current);
        current = [];
      }
    }
    current.push(point);
    previous = point;
  }
  if (current.length >= 2) runs.push(current);
  return runs;
}

function addRunLine(run, xOffset, zOffset, elevationMin) {
  const positions = new Float32Array(run.length * 3);
  const colors = new Float32Array(run.length * 3);
  let p = 0;
  let c = 0;
  for (const point of run) {
    positions[p++] = Number(point.x_m) + xOffset;
    positions[p++] = Number(point.h_li_m) - elevationMin + DISPLAY_LIFT_M;
    positions[p++] = Number(point.z_m) + zOffset;
    const color = colorForDelta(point.delta_h_m);
    colors[c++] = color.r;
    colors[c++] = color.g;
    colors[c++] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.98,
    depthTest: false,
    depthWrite: false,
  });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 51;
  line.frustumCulled = false;
  overlayGroup.add(line);
}

function addTrackPoints(points, beam, xOffset, zOffset, elevationMin) {
  const positions = new Float32Array(points.length * 3);
  const colors = new Float32Array(points.length * 3);
  let p = 0;
  let c = 0;

  for (const point of points) {
    positions[p++] = Number(point.x_m) + xOffset;
    positions[p++] = Number(point.h_li_m) - elevationMin + DISPLAY_LIFT_M;
    positions[p++] = Number(point.z_m) + zOffset;
    const color = colorForDelta(point.delta_h_m);
    colors[c++] = color.r;
    colors[c++] = color.g;
    colors[c++] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();

  // Dark halo makes the measurement visible over both white ice and dark rock.
  const halo = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: 8,
      sizeAttenuation: false,
      color: 0x071018,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    }),
  );
  halo.name = `ATL06 ${beam} halo`;
  halo.renderOrder = 50;
  halo.frustumCulled = false;
  overlayGroup.add(halo);

  const pointsObject = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: 4.5,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
    }),
  );
  pointsObject.name = `ATL06 ${beam}`;
  pointsObject.renderOrder = 52;
  pointsObject.frustumCulled = false;
  overlayGroup.add(pointsObject);
}

function focusOverlay() {
  if (!overlayBounds || !viewerApi?.camera) return;
  const controls = viewerApi.controls;
  if (!controls) {
    metaEl.insertAdjacentHTML('beforeend', '<br><em>Focus control is waiting for the terrain viewer bridge.</em>');
    return;
  }

  const center = overlayBounds.getCenter(new THREE.Vector3());
  const size = overlayBounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.z, 4000);
  const vertical = Math.max(size.y, 1200);

  controls.target.copy(center);
  viewerApi.camera.position.set(
    center.x + span * 0.38,
    center.y + Math.max(span * 0.42, vertical * 2.5),
    center.z + span * 0.82,
  );
  controls.update();
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

    if (!comparisonResponse.ok) throw new Error('ATL06/REMA comparison not built locally');
    if (!terrainResponse.ok) throw new Error(`Terrain metadata unavailable for ${RESOLUTION}`);

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
    overlayGroup.renderOrder = 50;
    overlayBounds = new THREE.Box3();

    let pointCount = 0;
    let beamCount = 0;
    for (const track of comparison.tracks || []) {
      const points = Array.isArray(track.points) ? track.points : [];
      if (!points.length) continue;
      beamCount += 1;
      pointCount += points.length;

      for (const point of points) {
        overlayBounds.expandByPoint(new THREE.Vector3(
          Number(point.x_m) + xOffset,
          Number(point.h_li_m) - elevationMin + DISPLAY_LIFT_M,
          Number(point.z_m) + zOffset,
        ));
      }

      addTrackPoints(points, track.beam || 'beam', xOffset, zOffset, elevationMin);
      for (const run of buildRuns(points)) addRunLine(run, xOffset, zOffset, elevationMin);
    }

    viewerApi.scene.add(overlayGroup);
    syncOverlayState();
    if (focusEl) focusEl.disabled = false;

    const sourceTime = comparison.source?.atl06?.indexed_nearest_time;
    const summary = comparison.summary?.robust_points || comparison.summary?.all_points || {};
    metaEl.innerHTML = [
      '<strong>ICESat-2 ATL06 science overlay</strong>',
      `Pass: ${esc(dateOnly(sourceTime))} · ${beamCount} beams · ${pointCount.toLocaleString()} segments`,
      `ATL06 − REMA median: ${Number(summary.median_m).toFixed(3)} m`,
      `RMSE: ${Number(summary.rmse_m).toFixed(3)} m · p05…p95: ${Number(summary.p05_m).toFixed(3)}…${Number(summary.p95_m).toFixed(3)} m`,
      'Color: cyan = below REMA · white ≈ agreement · orange = above REMA',
      '<strong>Display mode: x-ray track</strong> — points/lines are intentionally drawn through terrain so the dated measurement path cannot disappear behind the surface.',
      `<em>Measured ATL06 height; ${DISPLAY_LIFT_M.toFixed(1)} m display lift only. REMA is not corrected.</em>`,
    ].join('<br>');
  } catch (error) {
    if (toggleEl) {
      toggleEl.checked = false;
      toggleEl.disabled = true;
    }
    if (focusEl) focusEl.disabled = true;
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
if (focusEl) {
  focusEl.disabled = true;
  focusEl.addEventListener('click', focusOverlay);
}
if (exaggerationEl) exaggerationEl.addEventListener('input', syncOverlayState);

if (window.openAntarcticaViewer) {
  attach(window.openAntarcticaViewer);
} else {
  window.addEventListener('open-antarctica-viewer-ready', (event) => {
    attach(event.detail || window.openAntarcticaViewer);
  }, { once: true });
}
