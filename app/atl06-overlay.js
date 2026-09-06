import * as THREE from 'three';

const toggleEl = document.getElementById('atl06Toggle');
const focusEl = document.getElementById('atl06Focus');
const metaEl = document.getElementById('atl06Meta');
const inspectEl = document.getElementById('atl06Inspect');
const passControlEl = document.getElementById('atl06PassControl');
const passSelectEl = document.getElementById('atl06PassSelect');
const legendEl = document.getElementById('atl06Legend');
const exaggerationEl = document.getElementById('exaggeration');
const viewerEl = document.getElementById('viewer');
const params = new URLSearchParams(window.location.search);
const REGION = params.get('region') || 'ferrar-glacier';
const RESOLUTION = params.get('resolution') || '10m';
const REQUESTED_EPOCH = params.get('epoch');
const DEBUG = params.get('atl06debug') === '1';
const SERIES_URL = `../data/processed/${REGION}/nasa/atl06-series.json`;
const COMPARISON_URL = `../data/processed/${REGION}/nasa/atl06-rema-comparison.json`;
const TERRAIN_META_URL = `../data/processed/${REGION}/viewer/${RESOLUTION}/terrain-lod.json`;

const DISPLAY_LIFT_M = 1.5;
const MAX_LINE_GAP_M = 250;
const OUTER_POINT_PX = 7;
const INNER_POINT_PX = 3;

const BEAM_COLORS = {
  gt1l: 0x00e5ff,
  gt1r: 0x00ff9d,
  gt2l: 0xd64dff,
  gt2r: 0xff4db8,
  gt3l: 0xffe94d,
  gt3r: 0xff8a36,
};

let viewerApi = null;
let overlayGroup = null;
let debugGroup = null;
let passRecords = [];
let selectedPassIndex = 0;
let loaded = false;
let focusCount = 0;
let summaryHtml = '';

const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 120;
const pointer = new THREE.Vector2();

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : 'unknown date';
}

function parseTime(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function colorHex(value) {
  return `#${Number(value).toString(16).padStart(6, '0')}`;
}

function updateMeta(extra = '') {
  if (!metaEl) return;
  metaEl.innerHTML = [summaryHtml, extra].filter(Boolean).join('<br>');
}

summaryHtml = '<strong>ICESat-2 ATL06 science overlay</strong>';
updateMeta('<strong>Overlay module:</strong> executed · waiting for viewer bridge…');
window.openAntarcticaAtl06ModuleExecuted = true;

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

function selectedRecord() {
  return passRecords[selectedPassIndex] || null;
}

function syncOverlayState() {
  if (overlayGroup) {
    overlayGroup.visible = Boolean(toggleEl?.checked);
    overlayGroup.scale.y = Number(exaggerationEl?.value || 1);
  }
  if (debugGroup) debugGroup.visible = DEBUG && Boolean(toggleEl?.checked);
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

function addRunLine(group, run, beam, xOffset, zOffset, elevationMin) {
  const geometry = new THREE.BufferGeometry().setFromPoints(
    run.map((point) => trackPosition(point, xOffset, zOffset, elevationMin)),
  );
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
    color: BEAM_COLORS[beam] ?? 0x00e5ff,
    transparent: true,
    opacity: 0.82,
    depthTest: false,
    depthWrite: false,
    fog: false,
  }));
  line.name = `ATL06 ${beam} centerline`;
  line.renderOrder = 70;
  line.frustumCulled = false;
  group.add(line);
}

function addTrackPoints(group, points, beam, xOffset, zOffset, elevationMin, pointObjects) {
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
  group.add(outer);

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
  inner.userData.atl06Beam = beam;
  inner.userData.atl06Points = points;
  pointObjects.push(inner);
  group.add(inner);
}

function directionForRun(longestRun) {
  if (!longestRun || longestRun.length < 2) return new THREE.Vector2(1, 0);
  const a = longestRun[0];
  const b = longestRun[longestRun.length - 1];
  const dx = Number(b.x_m) - Number(a.x_m);
  const dz = Number(b.z_m) - Number(a.z_m);
  const len = Math.hypot(dx, dz);
  return len > 1 ? new THREE.Vector2(dx / len, dz / len) : new THREE.Vector2(1, 0);
}

function buildPassVisual(pass, xOffset, zOffset, elevationMin) {
  const group = new THREE.Group();
  group.name = `ATL06 pass ${dateOnly(pass.time)}`;
  const bounds = new THREE.Box3();
  const pointObjects = [];
  let pointCount = 0;
  let beamCount = 0;
  let runCount = 0;
  let longestRun = null;

  for (const track of pass.tracks || []) {
    const points = Array.isArray(track.points) ? track.points : [];
    if (!points.length) continue;
    const beam = track.beam || 'beam';
    beamCount += 1;
    pointCount += points.length;

    for (const point of points) bounds.expandByPoint(trackPosition(point, xOffset, zOffset, elevationMin));
    const runs = buildRuns(points);
    runCount += runs.length;
    for (const run of runs) {
      if (!longestRun || run.length > longestRun.length) longestRun = run;
      addRunLine(group, run, beam, xOffset, zOffset, elevationMin);
    }
    addTrackPoints(group, points, beam, xOffset, zOffset, elevationMin, pointObjects);
  }

  return {
    group,
    bounds,
    pointObjects,
    pointCount,
    beamCount,
    runCount,
    direction: directionForRun(longestRun),
  };
}

function disposeObject(object) {
  object.traverse?.((child) => {
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) child.material.forEach((m) => m?.dispose?.());
    else child.material?.dispose?.();
  });
}

function clearDebug() {
  if (!debugGroup) return;
  while (debugGroup.children.length) {
    const child = debugGroup.children.pop();
    disposeObject(child);
  }
}

function rebuildDebug() {
  clearDebug();
  const record = selectedRecord();
  if (!DEBUG || !record?.visual || record.visual.bounds.isEmpty()) return;

  const helper = new THREE.Box3Helper(record.visual.bounds, 0xff00ff);
  helper.name = 'ATL06 debug bounds';
  helper.renderOrder = 100;
  helper.material.depthTest = false;
  helper.material.depthWrite = false;
  helper.material.fog = false;
  debugGroup.add(helper);

  const center = record.visual.bounds.getCenter(new THREE.Vector3());
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(180, 20, 10),
    new THREE.MeshBasicMaterial({ color: 0xff00ff, depthTest: false, depthWrite: false, fog: false }),
  );
  marker.position.copy(center);
  marker.name = 'ATL06 debug center';
  marker.renderOrder = 101;
  debugGroup.add(marker);
}

function summaryStats(record) {
  const summary = record?.summary || {};
  return summary.robust_points || summary.all_points || summary;
}

function refreshSelectedMeta(extra = '') {
  const record = selectedRecord();
  if (!record) return;
  const stats = summaryStats(record);
  const visual = record.visual;
  const size = visual.bounds.getSize(new THREE.Vector3());
  const sourceLabel = passRecords.length > 1
    ? `${passRecords.length} dated passes loaded`
    : 'single validated pass';

  summaryHtml = [
    '<strong>ICESat-2 ATL06 science overlay</strong>',
    `Pass: ${esc(dateOnly(record.time))} · ${visual.beamCount} beams · ${visual.pointCount.toLocaleString()} segments · ${visual.runCount} runs`,
    `ATL06 − REMA median: ${Number(stats.median_m).toFixed(3)} m`,
    `RMSE: ${Number(stats.rmse_m).toFixed(3)} m · p05…p95: ${Number(stats.p05_m).toFixed(3)}…${Number(stats.p95_m).toFixed(3)} m`,
    `Track bounds: ${(size.x / 1000).toFixed(1)} × ${(size.z / 1000).toFixed(1)} km · ${sourceLabel}`,
    'Beam color identifies the six ICESat-2 beams. Dot centers encode Δh: cyan = below REMA · white ≈ agreement · orange = above REMA.',
    `<em>Measured ATL06 height; ${DISPLAY_LIFT_M.toFixed(1)} m display lift only. REMA is not corrected.</em>`,
    DEBUG ? '<strong>Debug:</strong> magenta bounds belong to ATL06 and now hide with the ATL06 layer.' : '',
  ].filter(Boolean).join('<br>');
  updateMeta(extra || '<strong>Overlay status:</strong> ready · click a measurement dot to inspect it');
}

function focusOverlay() {
  const record = selectedRecord();
  if (!record?.visual || !viewerApi?.camera || !viewerApi?.controls) {
    updateMeta('<strong>Focus:</strong> viewer controls are not available.');
    return;
  }

  const bounds = record.visual.bounds;
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 3000);
  const fov = THREE.MathUtils.degToRad(viewerApi.camera.fov);
  const distance = Math.min(Math.max(radius / Math.sin(fov * 0.5) * 1.12, 6000), 150000);
  const direction = record.visual.direction;
  const perp = new THREE.Vector3(-direction.y, 0, direction.x).normalize();
  const viewDir = new THREE.Vector3(perp.x, 0.58, perp.z).normalize();

  viewerApi.controls.target.copy(center);
  viewerApi.camera.position.copy(center).addScaledVector(viewDir, distance);
  viewerApi.camera.lookAt(center);
  viewerApi.camera.updateProjectionMatrix();
  viewerApi.controls.update();
  focusCount += 1;
  requestRender();
  refreshSelectedMeta(
    `<strong>Focus:</strong> ${dateOnly(record.time)} · ${(distance / 1000).toFixed(1)} km view (${focusCount})`,
  );
}

function chooseDefaultPass() {
  if (!passRecords.length || !REQUESTED_EPOCH) return passRecords.length - 1;
  const epoch = parseTime(REQUESTED_EPOCH);
  if (epoch === null) return passRecords.length - 1;
  let bestIndex = 0;
  let bestDistance = Infinity;
  passRecords.forEach((record, index) => {
    const value = parseTime(record.time);
    if (value === null) return;
    const distance = Math.abs(value - epoch);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function setSelectedPass(index, focus = false) {
  if (!passRecords.length) return;
  selectedPassIndex = Math.min(Math.max(Number(index) || 0, 0), passRecords.length - 1);
  passRecords.forEach((record, i) => { record.visual.group.visible = i === selectedPassIndex; });
  if (passSelectEl) passSelectEl.value = String(selectedPassIndex);
  rebuildDebug();
  if (inspectEl) {
    inspectEl.hidden = true;
    inspectEl.innerHTML = '';
  }
  refreshSelectedMeta();
  syncOverlayState();
  if (focus) focusOverlay();
}

function populatePassControl() {
  if (!passControlEl || !passSelectEl) return;
  passSelectEl.innerHTML = '';
  passRecords.forEach((record, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${dateOnly(record.time)} · ${record.visual.pointCount.toLocaleString()} segments`;
    passSelectEl.appendChild(option);
  });
  passControlEl.hidden = passRecords.length <= 1;
}

function renderLegend() {
  if (!legendEl) return;
  const items = Object.entries(BEAM_COLORS).map(([beam, color]) =>
    `<span class="legend-item"><span class="legend-swatch" style="background:${colorHex(color)}"></span>${beam}</span>`,
  );
  legendEl.innerHTML = [
    `<div class="legend-row">${items.join('')}</div>`,
    '<div style="margin-top:5px">dot center Δh: <span style="color:#00bfff">below</span> · white ≈ REMA · <span style="color:#ff6500">above</span></div>',
  ].join('');
  legendEl.hidden = false;
}

function normalizePasses(series, comparison) {
  if (series?.passes?.length) {
    return series.passes.map((pass) => ({
      time: pass.time,
      granule_id: pass.granule_id,
      files: pass.files || [],
      summary: pass.summary || {},
      tracks: pass.tracks || [],
    }));
  }

  if (comparison?.tracks?.length) {
    return [{
      time: comparison.source?.atl06?.indexed_nearest_time || comparison.source?.indexed_nearest_time,
      granule_id: comparison.source?.atl06?.indexed_granule_id,
      files: comparison.source?.atl06?.files || [],
      summary: comparison.summary || {},
      tracks: comparison.tracks || [],
    }];
  }
  return [];
}

function inspectMeasurement(event) {
  if (!toggleEl?.checked || !viewerApi?.camera || !passRecords.length || !viewerEl) return;
  if (event.target instanceof Element && event.target.closest('.panel')) return;
  const record = selectedRecord();
  if (!record?.visual?.pointObjects?.length) return;

  const rect = viewerEl.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  viewerApi.scene.updateMatrixWorld(true);
  raycaster.setFromCamera(pointer, viewerApi.camera);
  const hits = raycaster.intersectObjects(record.visual.pointObjects, false);
  if (!hits.length) return;

  const hit = hits[0];
  const data = hit.object.userData.atl06Points?.[hit.index];
  const beam = hit.object.userData.atl06Beam || 'beam';
  if (!data || !inspectEl) return;

  inspectEl.hidden = false;
  inspectEl.innerHTML = [
    '<strong>ATL06 measurement</strong>',
    `${esc(dateOnly(record.time))} · ${esc(beam)}`,
    `ATL06 h_li: ${Number(data.h_li_m).toFixed(3)} m`,
    Number.isFinite(Number(data.rema_h_m)) ? `REMA: ${Number(data.rema_h_m).toFixed(3)} m` : 'REMA: unavailable',
    Number.isFinite(Number(data.delta_h_m)) ? `Δh: ${Number(data.delta_h_m).toFixed(3)} m` : 'Δh: unavailable',
    Number.isFinite(Number(data.latitude)) && Number.isFinite(Number(data.longitude))
      ? `${Number(data.latitude).toFixed(6)}°, ${Number(data.longitude).toFixed(6)}°`
      : '',
  ].filter(Boolean).join('<br>');
}

async function buildOverlay() {
  if (loaded || !viewerApi) return;
  loaded = true;
  updateMeta('<strong>Overlay module:</strong> attached · reading local science data…');

  try {
    const [terrainResponse, seriesResponse, comparisonResponse] = await Promise.all([
      fetch(TERRAIN_META_URL, { cache: 'no-store' }),
      fetch(SERIES_URL, { cache: 'no-store' }),
      fetch(COMPARISON_URL, { cache: 'no-store' }),
    ]);
    if (!terrainResponse.ok) throw new Error(`Terrain metadata HTTP ${terrainResponse.status} for ${RESOLUTION}`);

    const terrainMeta = await terrainResponse.json();
    const series = seriesResponse.ok ? await seriesResponse.json() : null;
    const comparison = comparisonResponse.ok ? await comparisonResponse.json() : null;
    const sourceRegion = series?.region || comparison?.region;
    const origin = sourceRegion?.local_origin;
    const extent = terrainMeta.extent;
    const elevationMin = Number(terrainMeta.elevation?.min);
    if (!origin || !extent || !Number.isFinite(elevationMin)) throw new Error('ATL06 overlay metadata is incomplete');

    const rawPasses = normalizePasses(series, comparison);
    if (!rawPasses.length) {
      throw new Error('No ATL06 science data found. Build atl06-series.json or atl06-rema-comparison.json locally');
    }

    const terrainCenterX = (Number(extent.xmin) + Number(extent.xmax)) * 0.5;
    const terrainCenterY = (Number(extent.ymin) + Number(extent.ymax)) * 0.5;
    const xOffset = Number(origin.x) - terrainCenterX;
    const zOffset = terrainCenterY - Number(origin.y);

    overlayGroup = new THREE.Group();
    overlayGroup.name = 'ICESat-2 ATL06 dated science overlay';
    debugGroup = new THREE.Group();
    debugGroup.name = 'ATL06 debug helpers';
    overlayGroup.add(debugGroup);

    passRecords = [];
    for (const pass of rawPasses) {
      const visual = buildPassVisual(pass, xOffset, zOffset, elevationMin);
      if (!visual.pointCount || visual.bounds.isEmpty()) {
        disposeObject(visual.group);
        continue;
      }
      visual.group.visible = false;
      overlayGroup.add(visual.group);
      passRecords.push({ ...pass, visual });
    }
    if (!passRecords.length) throw new Error('ATL06 science files contain no drawable in-region measurements');

    viewerApi.scene.add(overlayGroup);
    populatePassControl();
    renderLegend();
    selectedPassIndex = chooseDefaultPass();
    setSelectedPass(selectedPassIndex, false);
    if (focusEl) focusEl.disabled = false;
    if (DEBUG) focusOverlay();
  } catch (error) {
    console.error('ATL06 overlay failed:', error);
    if (toggleEl) {
      toggleEl.checked = false;
      toggleEl.disabled = true;
    }
    if (focusEl) focusEl.disabled = true;
    if (passControlEl) passControlEl.hidden = true;
    if (legendEl) legendEl.hidden = true;
    summaryHtml = '<strong>ICESat-2 ATL06 science overlay</strong>';
    updateMeta(`<strong>Overlay error:</strong> ${esc(error.message)}`);
  }
}

function attach(api) {
  if (!api || viewerApi) return;
  viewerApi = api;
  updateMeta('<strong>Overlay module:</strong> viewer bridge received…');
  buildOverlay();
}

if (focusEl) {
  focusEl.disabled = true;
  focusEl.addEventListener('click', focusOverlay);
}
if (toggleEl) toggleEl.addEventListener('change', syncOverlayState);
if (passSelectEl) passSelectEl.addEventListener('change', () => setSelectedPass(Number(passSelectEl.value), false));
if (exaggerationEl) exaggerationEl.addEventListener('input', syncOverlayState);
if (viewerEl) viewerEl.addEventListener('click', inspectMeasurement);

if (window.openAntarcticaViewer) {
  attach(window.openAntarcticaViewer);
} else {
  window.addEventListener('open-antarctica-viewer-ready', (event) => {
    attach(event.detail || window.openAntarcticaViewer);
  }, { once: true });
}
