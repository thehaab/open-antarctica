import * as THREE from 'three';

const toggleEl = document.getElementById('atl06Toggle');
const terrainToggleEl = document.getElementById('terrainSurfaceToggle');
const focusEl = document.getElementById('atl06Focus');
const metaEl = document.getElementById('atl06Meta');
const exaggerationEl = document.getElementById('exaggeration');
const params = new URLSearchParams(window.location.search);
const REGION = params.get('region') || 'ferrar-glacier';
const RESOLUTION = params.get('resolution') || '10m';
const DEBUG = params.get('atl06debug') === '1';
const COMPARISON_URL = `../data/processed/${REGION}/nasa/atl06-rema-comparison.json`;
const TERRAIN_META_URL = `../data/processed/${REGION}/viewer/${RESOLUTION}/terrain-lod.json`;

const DISPLAY_LIFT_M = 1.5;
const MAX_LINE_GAP_M = 250;
const OUTER_POINT_PX = 10;
const INNER_POINT_PX = 5;

const BEAM_COLORS = {
  gt1l: 0x00e5ff,
  gt1r: 0x00ff9d,
  gt2l: 0xd64dff,
  gt2r: 0xff4db8,
  gt3l: 0xffe94d,
  gt3r: 0xff8a36,
};

let viewerApi = null;
let terrainGroup = null;
let overlayGroup = null;
let overlayBounds = null;
let loaded = false;
let dominantTrackDirection = new THREE.Vector2(1, 0);
let focusCount = 0;
let summaryHtml = '';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : 'unknown date';
}

function requestRender() {
  if (!viewerApi) return;
  viewerApi.scene?.updateMatrixWorld?.(true);
  viewerApi.requestRender?.();
}

function deltaColor(delta) {
  const value = Number(delta);
  const t = Math.min(Math.abs(value) / 1.2, 1.0);
  const neutral = new THREE.Color(0xf8fbff);
  const endpoint = value < 0 ? new THREE.Color(0x00bfff) : new THREE.Color(0xff6500);
  return neutral.lerp(endpoint, t);
}

function syncOverlayState() {
  if (overlayGroup) {
    overlayGroup.visible = Boolean(toggleEl?.checked);
    overlayGroup.scale.y = Number(exaggerationEl?.value || 1);
  }
  if (terrainGroup && terrainToggleEl) terrainGroup.visible = Boolean(terrainToggleEl.checked);
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

function trackPosition(point, xOffset, zOffset, elevationMin) {
  return new THREE.Vector3(
    Number(point.x_m) + xOffset,
    Number(point.h_li_m) - elevationMin + DISPLAY_LIFT_M,
    Number(point.z_m) + zOffset,
  );
}

function addRunLine(run, beam, xOffset, zOffset, elevationMin) {
  const geometry = new THREE.BufferGeometry().setFromPoints(
    run.map((point) => trackPosition(point, xOffset, zOffset, elevationMin)),
  );
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
    color: BEAM_COLORS[beam] ?? 0x00e5ff,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
    fog: false,
  }));
  line.name = `ATL06 ${beam} centerline`;
  line.renderOrder = 70;
  line.frustumCulled = false;
  overlayGroup.add(line);
}

function addTrackPoints(points, beam, xOffset, zOffset, elevationMin) {
  const positions = new Float32Array(points.length * 3);
  const deltaColors = new Float32Array(points.length * 3);
  let p = 0;
  let c = 0;
  for (const point of points) {
    const v = trackPosition(point, xOffset, zOffset, elevationMin);
    positions[p++] = v.x;
    positions[p++] = v.y;
    positions[p++] = v.z;
    const color = deltaColor(point.delta_h_m);
    deltaColors[c++] = color.r;
    deltaColors[c++] = color.g;
    deltaColors[c++] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(deltaColors, 3));
  geometry.computeBoundingSphere();

  const outer = new THREE.Points(geometry, new THREE.PointsMaterial({
    size: OUTER_POINT_PX,
    sizeAttenuation: false,
    color: BEAM_COLORS[beam] ?? 0x00e5ff,
    depthTest: false,
    depthWrite: false,
    fog: false,
  }));
  outer.name = `ATL06 ${beam} beam points`;
  outer.renderOrder = 71;
  outer.frustumCulled = false;
  overlayGroup.add(outer);

  const inner = new THREE.Points(geometry, new THREE.PointsMaterial({
    size: INNER_POINT_PX,
    sizeAttenuation: false,
    vertexColors: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
  }));
  inner.name = `ATL06 ${beam} measured points`;
  inner.renderOrder = 72;
  inner.frustumCulled = false;
  overlayGroup.add(inner);
}

function deriveDominantDirection(longestRun) {
  if (!longestRun || longestRun.length < 2) return;
  const a = longestRun[0];
  const b = longestRun[longestRun.length - 1];
  const dx = Number(b.x_m) - Number(a.x_m);
  const dz = Number(b.z_m) - Number(a.z_m);
  const len = Math.hypot(dx, dz);
  if (len > 1) dominantTrackDirection.set(dx / len, dz / len);
}

function updateMeta(extra = '') {
  if (!metaEl) return;
  metaEl.innerHTML = [summaryHtml, extra].filter(Boolean).join('<br>');
}

function focusOverlay() {
  if (!overlayBounds || !viewerApi?.camera || !viewerApi?.controls) {
    updateMeta('<strong>Focus:</strong> viewer controls are not available.');
    return;
  }

  const center = overlayBounds.getCenter(new THREE.Vector3());
  const size = overlayBounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 3000);
  const fov = THREE.MathUtils.degToRad(viewerApi.camera.fov);
  const distance = Math.min(Math.max(radius / Math.sin(fov * 0.5) * 1.12, 6000), 150000);
  const perp = new THREE.Vector3(-dominantTrackDirection.y, 0, dominantTrackDirection.x).normalize();
  const viewDir = new THREE.Vector3(perp.x, 0.58, perp.z).normalize();

  viewerApi.controls.target.copy(center);
  viewerApi.camera.position.copy(center).addScaledVector(viewDir, distance);
  viewerApi.camera.lookAt(center);
  viewerApi.camera.updateProjectionMatrix();
  viewerApi.controls.update();
  focusCount += 1;
  requestRender();

  updateMeta(
    `<strong>Focus:</strong> moved camera to ATL06 bounds (${focusCount}) · center ` +
    `${center.x.toFixed(0)}, ${center.y.toFixed(0)}, ${center.z.toFixed(0)} · distance ${(distance / 1000).toFixed(1)} km`,
  );
}

function addDebugBounds() {
  if (!DEBUG || !overlayBounds || !viewerApi) return;
  const helper = new THREE.Box3Helper(overlayBounds, 0xff00ff);
  helper.name = 'ATL06 debug bounds';
  helper.renderOrder = 100;
  helper.material.depthTest = false;
  helper.material.depthWrite = false;
  helper.material.fog = false;
  viewerApi.scene.add(helper);

  const center = overlayBounds.getCenter(new THREE.Vector3());
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(180, 20, 10),
    new THREE.MeshBasicMaterial({ color: 0xff00ff, depthTest: false, depthWrite: false, fog: false }),
  );
  marker.position.copy(center);
  marker.name = 'ATL06 debug center';
  marker.renderOrder = 101;
  viewerApi.scene.add(marker);
}

async function buildOverlay() {
  if (loaded || !viewerApi) return;
  loaded = true;
  updateMeta('<strong>ICESat-2 ATL06 science overlay</strong><br>Overlay module loaded; reading local comparison data…');

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
    if (!origin || !extent || !Number.isFinite(elevationMin)) throw new Error('ATL06 overlay metadata is incomplete');

    terrainGroup = viewerApi.terrainGroup || null;
    if (!terrainGroup) throw new Error('Terrain bridge is not available');

    const terrainCenterX = (Number(extent.xmin) + Number(extent.xmax)) * 0.5;
    const terrainCenterY = (Number(extent.ymin) + Number(extent.ymax)) * 0.5;
    const xOffset = Number(origin.x) - terrainCenterX;
    const zOffset = terrainCenterY - Number(origin.y);

    overlayGroup = new THREE.Group();
    overlayGroup.name = 'ICESat-2 ATL06 dated science overlay';
    overlayBounds = new THREE.Box3();

    let pointCount = 0;
    let beamCount = 0;
    let runCount = 0;
    let longestRun = null;

    for (const track of comparison.tracks || []) {
      const points = Array.isArray(track.points) ? track.points : [];
      if (!points.length) continue;
      const beam = track.beam || 'beam';
      beamCount += 1;
      pointCount += points.length;

      for (const point of points) overlayBounds.expandByPoint(trackPosition(point, xOffset, zOffset, elevationMin));
      const runs = buildRuns(points);
      runCount += runs.length;
      for (const run of runs) {
        if (!longestRun || run.length > longestRun.length) longestRun = run;
        addRunLine(run, beam, xOffset, zOffset, elevationMin);
      }
      addTrackPoints(points, beam, xOffset, zOffset, elevationMin);
    }

    if (!pointCount || overlayBounds.isEmpty()) throw new Error('ATL06 overlay contains no drawable points');
    deriveDominantDirection(longestRun);
    viewerApi.scene.add(overlayGroup);
    addDebugBounds();
    syncOverlayState();

    const sourceTime = comparison.source?.atl06?.indexed_nearest_time;
    const summary = comparison.summary?.robust_points || comparison.summary?.all_points || {};
    const size = overlayBounds.getSize(new THREE.Vector3());
    summaryHtml = [
      '<strong>ICESat-2 ATL06 science overlay</strong>',
      `Pass: ${esc(dateOnly(sourceTime))} · ${beamCount} beams · ${pointCount.toLocaleString()} segments · ${runCount} runs`,
      `ATL06 − REMA median: ${Number(summary.median_m).toFixed(3)} m`,
      `RMSE: ${Number(summary.rmse_m).toFixed(3)} m · p05…p95: ${Number(summary.p05_m).toFixed(3)}…${Number(summary.p95_m).toFixed(3)} m`,
      `Track bounds: ${(size.x / 1000).toFixed(1)} × ${(size.z / 1000).toFixed(1)} km`,
      `Render: core Three.js · ${OUTER_POINT_PX}px beam dots + ${INNER_POINT_PX}px measured-delta centers`,
      'Beam colors: cyan/green · magenta/pink · yellow/orange. Inner point color: cyan = below REMA · white ≈ agreement · orange = above REMA.',
      `<em>Measured ATL06 height; ${DISPLAY_LIFT_M.toFixed(1)} m display lift only. REMA is not corrected.</em>`,
      DEBUG ? '<strong>Debug:</strong> magenta box + sphere = computed ATL06 bounds/center.' : '',
    ].filter(Boolean).join('<br>');
    updateMeta('<strong>Overlay status:</strong> ready');
    if (focusEl) focusEl.disabled = false;
  } catch (error) {
    console.error('ATL06 overlay failed:', error);
    if (toggleEl) {
      toggleEl.checked = false;
      toggleEl.disabled = true;
    }
    if (focusEl) focusEl.disabled = true;
    summaryHtml = '<strong>ICESat-2 ATL06 science overlay</strong>';
    updateMeta(`<strong>Overlay error:</strong> ${esc(error.message)}`);
  }
}

function attach(api) {
  if (!api || viewerApi) return;
  viewerApi = api;
  buildOverlay();
}

if (focusEl) {
  focusEl.disabled = true;
  focusEl.addEventListener('click', focusOverlay);
}
if (toggleEl) toggleEl.addEventListener('change', syncOverlayState);
if (terrainToggleEl) terrainToggleEl.addEventListener('change', syncOverlayState);
if (exaggerationEl) exaggerationEl.addEventListener('input', syncOverlayState);

if (window.openAntarcticaViewer) {
  attach(window.openAntarcticaViewer);
} else {
  window.addEventListener('open-antarctica-viewer-ready', (event) => {
    attach(event.detail || window.openAntarcticaViewer);
  }, { once: true });
}
