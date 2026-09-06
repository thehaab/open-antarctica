import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

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

// ATL06 remains at measured h_li. This small lift is display-only and prevents
// coincident-depth artifacts when the terrain surface is enabled.
const DISPLAY_LIFT_M = 1.5;
const MAX_LINE_GAP_M = 250;
const BEAM_LINE_WIDTH_PX = 5;
const BEAM_HALO_WIDTH_PX = 11;
const POINT_SIZE_PX = 5;
const POINT_HALO_SIZE_PX = 10;

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
let loaded = false;
let overlayBounds = null;
let dominantTrackDirection = new THREE.Vector2(1, 0);
const lineMaterials = new Set();

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

function updateLineResolution() {
  const width = Math.max(viewerApi?.renderer?.domElement?.clientWidth || window.innerWidth, 1);
  const height = Math.max(viewerApi?.renderer?.domElement?.clientHeight || window.innerHeight, 1);
  for (const material of lineMaterials) material.resolution.set(width, height);
}

function deltaColor(delta) {
  const value = Number(delta);
  // Saturate by ~1.2 m because this validated pass agrees extremely closely with
  // REMA; a ±2 m palette made almost every point visually white.
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
  return [
    Number(point.x_m) + xOffset,
    Number(point.h_li_m) - elevationMin + DISPLAY_LIFT_M,
    Number(point.z_m) + zOffset,
  ];
}

function makeLineMaterial(color, linewidth, opacity, renderOrder) {
  const material = new LineMaterial({
    color,
    linewidth,
    worldUnits: false,
    transparent: opacity < 1,
    opacity,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  material.userData.renderOrder = renderOrder;
  lineMaterials.add(material);
  return material;
}

function addRunLine(run, beam, xOffset, zOffset, elevationMin) {
  const flat = [];
  for (const point of run) flat.push(...trackPosition(point, xOffset, zOffset, elevationMin));

  const geometry = new LineGeometry();
  geometry.setPositions(flat);

  const halo = new Line2(geometry, makeLineMaterial(0x02060a, BEAM_HALO_WIDTH_PX, 0.96, 70));
  halo.name = `ATL06 ${beam} line halo`;
  halo.renderOrder = 70;
  halo.frustumCulled = false;
  overlayGroup.add(halo);

  const color = BEAM_COLORS[beam] ?? 0x00e5ff;
  const line = new Line2(geometry, makeLineMaterial(color, BEAM_LINE_WIDTH_PX, 1, 71));
  line.name = `ATL06 ${beam} centerline`;
  line.renderOrder = 71;
  line.frustumCulled = false;
  overlayGroup.add(line);
}

function addTrackPoints(points, beam, xOffset, zOffset, elevationMin) {
  const positions = new Float32Array(points.length * 3);
  const colors = new Float32Array(points.length * 3);
  let p = 0;
  let c = 0;

  for (const point of points) {
    const [x, y, z] = trackPosition(point, xOffset, zOffset, elevationMin);
    positions[p++] = x;
    positions[p++] = y;
    positions[p++] = z;
    const color = deltaColor(point.delta_h_m);
    colors[c++] = color.r;
    colors[c++] = color.g;
    colors[c++] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();

  const halo = new THREE.Points(geometry, new THREE.PointsMaterial({
    size: POINT_HALO_SIZE_PX,
    sizeAttenuation: false,
    color: 0x02060a,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
    fog: false,
  }));
  halo.name = `ATL06 ${beam} point halo`;
  halo.renderOrder = 72;
  halo.frustumCulled = false;
  overlayGroup.add(halo);

  const dots = new THREE.Points(geometry, new THREE.PointsMaterial({
    size: POINT_SIZE_PX,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: false,
    depthTest: false,
    depthWrite: false,
    fog: false,
  }));
  dots.name = `ATL06 ${beam} measured points`;
  dots.renderOrder = 73;
  dots.frustumCulled = false;
  overlayGroup.add(dots);
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

function focusOverlay() {
  if (!overlayBounds || !viewerApi?.camera || !viewerApi?.controls) return;

  const center = overlayBounds.getCenter(new THREE.Vector3());
  const size = overlayBounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.z, 4000);
  const vertical = Math.max(size.y, 1200);

  // Look mostly across the tracks rather than down their length. The old generic
  // camera could make six narrow tracks collapse into an end-on terrain-like shape.
  const perpX = -dominantTrackDirection.y;
  const perpZ = dominantTrackDirection.x;
  viewerApi.controls.target.copy(center);
  viewerApi.camera.position.set(
    center.x + perpX * span * 0.72 + dominantTrackDirection.x * span * 0.10,
    center.y + Math.max(span * 0.48, vertical * 2.6),
    center.z + perpZ * span * 0.72 + dominantTrackDirection.y * span * 0.10,
  );
  viewerApi.controls.update();
  requestRender();
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
    new THREE.SphereGeometry(120, 16, 8),
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

      for (const point of points) {
        const [x, y, z] = trackPosition(point, xOffset, zOffset, elevationMin);
        overlayBounds.expandByPoint(new THREE.Vector3(x, y, z));
      }

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
    updateLineResolution();
    syncOverlayState();
    if (focusEl) focusEl.disabled = false;

    const sourceTime = comparison.source?.atl06?.indexed_nearest_time;
    const summary = comparison.summary?.robust_points || comparison.summary?.all_points || {};
    const size = overlayBounds.getSize(new THREE.Vector3());
    metaEl.innerHTML = [
      '<strong>ICESat-2 ATL06 science overlay</strong>',
      `Pass: ${esc(dateOnly(sourceTime))} · ${beamCount} beams · ${pointCount.toLocaleString()} segments · ${runCount} runs`,
      `ATL06 − REMA median: ${Number(summary.median_m).toFixed(3)} m`,
      `RMSE: ${Number(summary.rmse_m).toFixed(3)} m · p05…p95: ${Number(summary.p05_m).toFixed(3)}…${Number(summary.p95_m).toFixed(3)} m`,
      `Track bounds: ${(size.x / 1000).toFixed(1)} × ${(size.z / 1000).toFixed(1)} km · terrain bridge: exact`,
      'Beam centerlines: cyan/green · magenta/pink · yellow/orange. Measured point color: cyan = below REMA · white ≈ agreement · orange = above REMA.',
      `<strong>Display:</strong> ${BEAM_LINE_WIDTH_PX}px screen-space beam lines with ${BEAM_HALO_WIDTH_PX}px dark halos. No artificial world-space swath width is drawn.`,
      `<em>Measured ATL06 height; ${DISPLAY_LIFT_M.toFixed(1)} m display lift only. REMA is not corrected.</em>`,
      DEBUG ? '<strong>Debug:</strong> magenta box + sphere = computed ATL06 bounds/center.' : '',
    ].filter(Boolean).join('<br>');
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
if (terrainToggleEl) terrainToggleEl.addEventListener('change', syncOverlayState);
if (focusEl) {
  focusEl.disabled = true;
  focusEl.addEventListener('click', focusOverlay);
}
if (exaggerationEl) exaggerationEl.addEventListener('input', syncOverlayState);
window.addEventListener('resize', () => {
  updateLineResolution();
  requestRender();
});

if (window.openAntarcticaViewer) {
  attach(window.openAntarcticaViewer);
} else {
  window.addEventListener('open-antarctica-viewer-ready', (event) => {
    attach(event.detail || window.openAntarcticaViewer);
  }, { once: true });
}
