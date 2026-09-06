import * as THREE from 'three';

const toggleEl = document.getElementById('atl11Toggle');
const confidenceControlEl = document.getElementById('atl11ConfidenceControl');
const confidenceToggleEl = document.getElementById('atl11ConfidenceToggle');
const trackControlEl = document.getElementById('atl11TrackControl');
const trackSelectEl = document.getElementById('atl11TrackSelect');
const focusEl = document.getElementById('atl11Focus');
const legendEl = document.getElementById('atl11Legend');
const metaEl = document.getElementById('atl11Meta');
const inspectEl = document.getElementById('atl11Inspect');
const exaggerationEl = document.getElementById('exaggeration');
const viewerEl = document.getElementById('viewer');
const params = new URLSearchParams(window.location.search);
const REGION = params.get('region') || 'ferrar-glacier';
const RESOLUTION = params.get('resolution') || '10m';
const DATA_URL = `../data/processed/${REGION}/nasa/atl11-timeseries.json`;
const TERRAIN_META_URL = `../data/processed/${REGION}/viewer/${RESOLUTION}/terrain-lod.json`;

const DISPLAY_LIFT_M = 5;
const POINT_SIZE_PX = 6;
const DEFAULT_TREND_SATURATION_M_PER_YR = 0.5;

// Visualization QC only. These are intentionally transparent, conservative
// thresholds for suppressing weak linear fits; they do not replace ATL11's
// native quality fields or constitute a new NASA science product.
const CONFIDENCE = {
  minCycles: 8,
  minSpanYears: 3.0,
  maxSlopeSigmaMPerYr: 0.05,
  maxResidualRmseM: 1.0,
};

let viewerApi = null;
let layerGroup = null;
let trackRecords = [];
let loaded = false;
let trendSaturationMPerYr = DEFAULT_TREND_SATURATION_M_PER_YR;
let highConfidenceTotal = 0;
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 160;
const pointer = new THREE.Vector2();

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : 'unknown';
}

function requestRender() {
  viewerApi?.requestRender?.();
}

function chooseTrendSaturation(summary) {
  const trend = summary?.trend_m_per_yr || {};
  const p05 = Number(trend.p05);
  const p95 = Number(trend.p95);
  const robust = Math.max(Math.abs(p05), Math.abs(p95));
  if (!Number.isFinite(robust) || robust <= 0) return DEFAULT_TREND_SATURATION_M_PER_YR;
  return THREE.MathUtils.clamp(Math.ceil(robust / 0.05) * 0.05, 0.10, 1.00);
}

function trendColor(value) {
  const trend = Number(value);
  const t = Math.min(Math.abs(trend) / trendSaturationMPerYr, 1.0);
  const neutral = new THREE.Color(0xf7fbff);
  const endpoint = trend < 0 ? new THREE.Color(0x00aaff) : new THREE.Color(0xff7200);
  return neutral.lerp(endpoint, t);
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isHighConfidence(point) {
  const cycles = Number(point.cycle_count || 0);
  const span = Number(point.span_years || 0);
  const sigma = finiteOrNull(point.trend_sigma_m_per_yr);
  const rmse = finiteOrNull(point.trend_residual_rmse_m);
  return cycles >= CONFIDENCE.minCycles
    && span >= CONFIDENCE.minSpanYears
    && (sigma === null || sigma <= CONFIDENCE.maxSlopeSigmaMPerYr)
    && (rmse === null || rmse <= CONFIDENCE.maxResidualRmseM);
}

function highConfidenceOnly() {
  return Boolean(confidenceToggleEl?.checked);
}

function trackLabel(track, highCount = null) {
  const rgt = track.rgt == null ? 'RGT ?' : `RGT ${String(track.rgt).padStart(4, '0')}`;
  const total = Number(track.point_count || track.points?.length || 0);
  const suffix = highCount == null ? `${total.toLocaleString()} pts` : `${highCount.toLocaleString()}/${total.toLocaleString()} high-conf`;
  return `${rgt} · ${track.pair} · ${suffix}`;
}

function selectedKey() {
  return trackSelectEl?.value || 'all';
}

function selectedRecords() {
  const key = selectedKey();
  return key === 'all' ? trackRecords : trackRecords.filter((record) => record.key === key);
}

function activeVisual(record) {
  return highConfidenceOnly() ? record.high : record.all;
}

function syncState() {
  const enabled = Boolean(toggleEl?.checked);
  const selected = selectedKey();
  const highOnly = highConfidenceOnly();
  for (const record of trackRecords) {
    const selectedRecord = selected === 'all' || selected === record.key;
    record.group.visible = enabled && selectedRecord;
    record.group.scale.y = Number(exaggerationEl?.value || 1);
    record.all.group.visible = !highOnly;
    record.high.group.visible = highOnly;
  }
  if (confidenceControlEl) confidenceControlEl.hidden = !enabled;
  if (trackControlEl) trackControlEl.hidden = !enabled;
  if (legendEl) legendEl.hidden = !enabled;
  if (focusEl) focusEl.disabled = !enabled || !trackRecords.length;
  if (inspectEl && !enabled) inspectEl.hidden = true;
  requestRender();
}

function pointPosition(point, elevationMin) {
  return new THREE.Vector3(
    Number(point.x_m),
    Number(point.latest_h_m) - elevationMin + DISPLAY_LIFT_M,
    Number(point.z_m),
  );
}

function emptyVisual(name) {
  const group = new THREE.Group();
  group.name = name;
  return { group, dots: null, bounds: new THREE.Box3(), points: [] };
}

function buildPointVisual(points, track, elevationMin, name, lineOpacity = 0.72) {
  if (!points.length) return emptyVisual(name);

  const group = new THREE.Group();
  group.name = name;
  const positions = new Float32Array(points.length * 3);
  const colors = new Float32Array(points.length * 3);
  const bounds = new THREE.Box3();

  let p = 0;
  let c = 0;
  for (const point of points) {
    const position = pointPosition(point, elevationMin);
    positions[p++] = position.x;
    positions[p++] = position.y;
    positions[p++] = position.z;
    bounds.expandByPoint(position);
    const color = trendColor(point.trend_m_per_yr);
    colors[c++] = color.r;
    colors[c++] = color.g;
    colors[c++] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();

  // The line is a navigation aid along the fixed reference-point corridor. In
  // high-confidence mode it may bridge omitted weak-fit points, so the dots are
  // the authoritative per-reference-point marks.
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: lineOpacity,
    depthTest: false,
    depthWrite: false,
    fog: false,
  }));
  line.renderOrder = 80;
  line.frustumCulled = false;
  group.add(line);

  const dots = new THREE.Points(geometry, new THREE.PointsMaterial({
    size: POINT_SIZE_PX,
    sizeAttenuation: false,
    vertexColors: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
  }));
  dots.renderOrder = 81;
  dots.frustumCulled = false;
  dots.userData.atl11Points = points;
  dots.userData.atl11Track = track;
  group.add(dots);

  return { group, dots, bounds, points };
}

function buildTrackVisual(track, elevationMin) {
  const group = new THREE.Group();
  group.name = `ATL11 ${track.rgt ?? '?'} ${track.pair}`;
  const points = Array.isArray(track.points) ? track.points : [];
  const highPoints = points.filter(isHighConfidence);
  const all = buildPointVisual(points, track, elevationMin, 'all ATL11 points');
  const high = buildPointVisual(highPoints, track, elevationMin, 'high-confidence ATL11 points', 0.82);
  group.add(all.group, high.group);
  high.group.visible = true;
  all.group.visible = false;
  return { group, all, high, highCount: highPoints.length };
}

function combinedBounds(records) {
  const bounds = new THREE.Box3();
  for (const record of records) {
    const visual = activeVisual(record);
    if (visual && !visual.bounds.isEmpty()) bounds.union(visual.bounds);
  }
  return bounds;
}

function focusSelected() {
  if (!viewerApi?.camera || !viewerApi?.controls) return;
  const records = selectedRecords();
  if (!records.length) return;
  const bounds = combinedBounds(records);
  if (bounds.isEmpty()) return;

  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 2500);
  const fov = THREE.MathUtils.degToRad(viewerApi.camera.fov);
  const distance = Math.min(Math.max(radius / Math.sin(fov * 0.5) * 1.05, 5000), 160000);
  const viewDir = new THREE.Vector3(0.58, 0.58, 0.58).normalize();
  viewerApi.controls.target.copy(center);
  viewerApi.camera.position.copy(center).addScaledVector(viewDir, distance);
  viewerApi.camera.lookAt(center);
  viewerApi.controls.update();
  requestRender();
}

function confidenceReason(point) {
  const reasons = [];
  const sigma = finiteOrNull(point.trend_sigma_m_per_yr);
  const rmse = finiteOrNull(point.trend_residual_rmse_m);
  if (Number(point.cycle_count || 0) < CONFIDENCE.minCycles) reasons.push(`<${CONFIDENCE.minCycles} cycles`);
  if (Number(point.span_years || 0) < CONFIDENCE.minSpanYears) reasons.push(`<${CONFIDENCE.minSpanYears.toFixed(0)} yr span`);
  if (sigma !== null && sigma > CONFIDENCE.maxSlopeSigmaMPerYr) reasons.push(`slope σ > ${CONFIDENCE.maxSlopeSigmaMPerYr.toFixed(2)} m/yr`);
  if (rmse !== null && rmse > CONFIDENCE.maxResidualRmseM) reasons.push(`fit RMSE > ${CONFIDENCE.maxResidualRmseM.toFixed(1)} m`);
  return reasons;
}

function renderInspect(point, track) {
  if (!inspectEl) return;
  const observations = Array.isArray(point.observations) ? point.observations : [];
  const first = observations[0];
  const last = observations[observations.length - 1];
  const rgt = track.rgt == null ? '?' : String(track.rgt).padStart(4, '0');
  const confident = isHighConfidence(point);
  const reasons = confidenceReason(point);
  inspectEl.hidden = false;
  inspectEl.innerHTML = [
    '<strong>ATL11 repeat reference point</strong>',
    `RGT ${esc(rgt)} · ${esc(track.pair)} · ref_pt ${esc(point.ref_pt)}`,
    `<strong>Visualization confidence: ${confident ? 'high' : 'review'}</strong>${reasons.length ? ` · ${esc(reasons.join(', '))}` : ''}`,
    `${Number(point.cycle_count)} good cycles · ${Number(point.span_years).toFixed(2)} yr span`,
    `First: ${esc(dateOnly(first?.time))} · ${Number(point.first_h_m).toFixed(3)} m`,
    `Latest: ${esc(dateOnly(last?.time))} · ${Number(point.latest_h_m).toFixed(3)} m`,
    `Δh: ${Number(point.delta_h_m).toFixed(3)} m`,
    `<strong>dh/dt: ${Number(point.trend_m_per_yr).toFixed(4)} m/yr</strong>`,
    point.trend_sigma_m_per_yr == null ? '' : `slope σ: ${Number(point.trend_sigma_m_per_yr).toFixed(4)} m/yr`,
    `fit residual RMSE: ${Number(point.trend_residual_rmse_m).toFixed(3)} m`,
    `${Number(point.latitude).toFixed(6)}°, ${Number(point.longitude).toFixed(6)}°`,
  ].filter(Boolean).join('<br>');
}

function inspectPointer(event) {
  if (!toggleEl?.checked || !viewerApi?.camera || !viewerEl) return;
  const rect = viewerEl.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, viewerApi.camera);
  const objects = selectedRecords()
    .map((record) => activeVisual(record)?.dots)
    .filter((object) => object && object.visible !== false);
  const hits = raycaster.intersectObjects(objects, false);
  if (!hits.length) return;
  const hit = hits[0];
  const point = hit.object.userData.atl11Points?.[hit.index];
  const track = hit.object.userData.atl11Track;
  if (point && track) renderInspect(point, track);
}

function populateTrackSelect() {
  if (!trackSelectEl) return;
  trackSelectEl.replaceChildren();
  const all = document.createElement('option');
  all.value = 'all';
  const total = trackRecords.reduce((sum, record) => sum + record.all.points.length, 0);
  all.textContent = `All repeat tracks · ${highConfidenceTotal.toLocaleString()}/${total.toLocaleString()} high-conf`;
  trackSelectEl.appendChild(all);
  for (const record of trackRecords) {
    const option = document.createElement('option');
    option.value = record.key;
    option.textContent = trackLabel(record.track, record.highCount);
    trackSelectEl.appendChild(option);
  }
}

async function buildLayer() {
  if (loaded || !viewerApi) return;
  loaded = true;
  if (metaEl) metaEl.innerHTML = '<strong>ICESat-2 ATL11 repeat-track change</strong><br>Reading local ATL11 time series…';

  try {
    const [dataResponse, terrainResponse] = await Promise.all([
      fetch(DATA_URL, { cache: 'no-store' }),
      fetch(TERRAIN_META_URL, { cache: 'no-store' }),
    ]);
    if (!dataResponse.ok) throw new Error(`ATL11 time series HTTP ${dataResponse.status}`);
    if (!terrainResponse.ok) throw new Error(`terrain metadata HTTP ${terrainResponse.status}`);
    const data = await dataResponse.json();
    const terrainMeta = await terrainResponse.json();
    const elevationMin = Number(terrainMeta.elevation?.min);
    if (!Number.isFinite(elevationMin)) throw new Error('terrain elevation minimum unavailable');

    const summary = data.summary || {};
    const trend = summary.trend_m_per_yr || {};
    trendSaturationMPerYr = chooseTrendSaturation(summary);

    layerGroup = new THREE.Group();
    layerGroup.name = 'ICESat-2 ATL11 repeat-track change layer';
    trackRecords = [];
    highConfidenceTotal = 0;
    for (const [index, track] of (data.tracks || []).entries()) {
      if (!Array.isArray(track.points) || !track.points.length) continue;
      const visual = buildTrackVisual(track, elevationMin);
      const key = `${track.rgt ?? 'unknown'}:${track.pair}:${index}`;
      layerGroup.add(visual.group);
      highConfidenceTotal += visual.highCount;
      trackRecords.push({ key, track, points: track.points, ...visual });
    }
    if (!trackRecords.length) throw new Error('ATL11 file contains no drawable repeat-track points');
    viewerApi.scene.add(layerGroup);

    populateTrackSelect();
    if (trackControlEl) trackControlEl.hidden = false;
    if (legendEl) {
      legendEl.hidden = false;
      legendEl.innerHTML = [
        '<strong>ATL11 dh/dt</strong>',
        '<div class="legend-row">' +
          '<span class="legend-item"><span class="legend-swatch" style="background:#00aaff"></span>lowering</span>' +
          '<span class="legend-item"><span class="legend-swatch" style="background:#f7fbff"></span>stable</span>' +
          '<span class="legend-item"><span class="legend-swatch" style="background:#ff7200"></span>rising</span>' +
        '</div>',
        `robust color scale ±${trendSaturationMPerYr.toFixed(2)} m/yr (p05/p95 based)`,
        `high-confidence view: ≥${CONFIDENCE.minCycles} cycles · ≥${CONFIDENCE.minSpanYears.toFixed(0)} yr · slope σ ≤${CONFIDENCE.maxSlopeSigmaMPerYr.toFixed(2)} m/yr · fit RMSE ≤${CONFIDENCE.maxResidualRmseM.toFixed(1)} m`,
        '<em>Confidence filter is Open Antarctica visualization QC, not an ATL11/NASA quality classification.</em>',
      ].join('<br>');
    }

    const totalPoints = Number(summary.retained_ref_points || 0);
    if (metaEl) {
      metaEl.innerHTML = [
        '<strong>ICESat-2 ATL11 repeat-track change</strong>',
        `${Number(summary.unique_rgt_count || 0)} RGTs · ${Number(summary.track_pair_count || 0)} beam-pair tracks`,
        `${totalPoints.toLocaleString()} repeat reference points · ${Number(summary.observation_count || 0).toLocaleString()} cycle observations`,
        `${highConfidenceTotal.toLocaleString()} reference points pass the recommended visualization confidence filter`,
        `Coverage: ${esc(dateOnly(summary.coverage_start))} → ${esc(dateOnly(summary.coverage_end))}`,
        `Median dh/dt: ${Number(trend.median).toFixed(4)} m/yr · p05…p95 ${Number(trend.p05).toFixed(4)}…${Number(trend.p95).toFixed(4)} m/yr`,
        `Display color scale: ±${trendSaturationMPerYr.toFixed(2)} m/yr`,
        '<em>These are ATL11 fixed reference-point time series. Color is same-place linear height trend, not ATL06-vs-REMA difference.</em>',
      ].join('<br>');
    }

    if (toggleEl) toggleEl.disabled = false;
    if (confidenceToggleEl) confidenceToggleEl.disabled = false;
    if (focusEl) focusEl.disabled = false;
    syncState();
  } catch (error) {
    console.warn('ATL11 repeat-track layer unavailable:', error);
    if (toggleEl) {
      toggleEl.checked = false;
      toggleEl.disabled = true;
    }
    if (confidenceControlEl) confidenceControlEl.hidden = true;
    if (trackControlEl) trackControlEl.hidden = true;
    if (legendEl) legendEl.hidden = true;
    if (focusEl) focusEl.disabled = true;
    if (metaEl) {
      metaEl.innerHTML = [
        '<strong>ICESat-2 ATL11 repeat-track change</strong>',
        `<em>${esc(error.message)}.</em>`,
        'Run scripts/fetch_atl11_timeseries.py to build the local repeat-track science layer.',
      ].join('<br>');
    }
  }
}

function attach(api) {
  if (!api || viewerApi) return;
  viewerApi = api;
  buildLayer();
}

if (toggleEl) {
  toggleEl.disabled = true;
  toggleEl.addEventListener('change', syncState);
}
if (confidenceToggleEl) {
  confidenceToggleEl.disabled = true;
  confidenceToggleEl.addEventListener('change', () => {
    if (inspectEl) inspectEl.hidden = true;
    syncState();
  });
}
if (trackSelectEl) trackSelectEl.addEventListener('change', () => {
  if (inspectEl) inspectEl.hidden = true;
  syncState();
});
if (focusEl) {
  focusEl.disabled = true;
  focusEl.addEventListener('click', focusSelected);
}
if (exaggerationEl) exaggerationEl.addEventListener('input', syncState);
if (viewerEl) viewerEl.addEventListener('click', inspectPointer);

if (window.openAntarcticaViewer) attach(window.openAntarcticaViewer);
else window.addEventListener('open-antarctica-viewer-ready', (event) => attach(event.detail || window.openAntarcticaViewer), { once: true });