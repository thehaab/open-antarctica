import * as THREE from 'three';

const toggleEl = document.getElementById('atl06CoverageToggle');
const legendEl = document.getElementById('atl06CoverageLegend');
const metaEl = document.getElementById('atl06CoverageMeta');
const exaggerationEl = document.getElementById('exaggeration');
const params = new URLSearchParams(window.location.search);
const REGION = params.get('region') || 'ferrar-glacier';
const RESOLUTION = params.get('resolution') || '10m';
const COVERAGE_URL = `../data/processed/${REGION}/nasa/atl06-coverage.json`;
const TERRAIN_META_URL = `../data/processed/${REGION}/viewer/${RESOLUTION}/terrain-lod.json`;

const DISPLAY_LIFT_M = 8;
const COVERAGE_COLOR = 0x65dcff;
const COVERAGE_OPACITY = 0.16;

let viewerApi = null;
let coverageGroup = null;
let loaded = false;

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

function syncState() {
  if (coverageGroup) {
    coverageGroup.visible = Boolean(toggleEl?.checked);
    coverageGroup.scale.y = Number(exaggerationEl?.value || 1);
  }
  if (legendEl) legendEl.hidden = !toggleEl?.checked;
  requestRender();
}

function buildLineSegments(data, elevationMin) {
  const vertices = [];
  let segmentCount = 0;
  for (const track of data.tracks || []) {
    const points = Array.isArray(track.points) ? track.points : [];
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      vertices.push(
        Number(a.x_m), Number(a.rema_h_m) - elevationMin + DISPLAY_LIFT_M, Number(a.z_m),
        Number(b.x_m), Number(b.rema_h_m) - elevationMin + DISPLAY_LIFT_M, Number(b.z_m),
      );
      segmentCount += 1;
    }
  }

  if (!vertices.length) throw new Error('coverage index contains no drawable proxy lines');
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeBoundingSphere();

  const material = new THREE.LineBasicMaterial({
    color: COVERAGE_COLOR,
    transparent: true,
    opacity: COVERAGE_OPACITY,
    depthTest: false,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
  });

  const lines = new THREE.LineSegments(geometry, material);
  lines.name = 'ICESat-2 ATL06 mission CMR coverage proxies';
  lines.renderOrder = 55;
  lines.frustumCulled = false;
  return { lines, segmentCount };
}

async function buildCoverage() {
  if (loaded || !viewerApi) return;
  loaded = true;
  if (metaEl) metaEl.innerHTML = '<strong>ICESat-2 mission coverage</strong><br>Reading local CMR coverage index…';

  try {
    const [coverageResponse, terrainResponse] = await Promise.all([
      fetch(COVERAGE_URL, { cache: 'no-store' }),
      fetch(TERRAIN_META_URL, { cache: 'no-store' }),
    ]);
    if (!coverageResponse.ok) throw new Error(`coverage index HTTP ${coverageResponse.status}`);
    if (!terrainResponse.ok) throw new Error(`terrain metadata HTTP ${terrainResponse.status}`);

    const data = await coverageResponse.json();
    const terrainMeta = await terrainResponse.json();
    const elevationMin = Number(terrainMeta.elevation?.min);
    if (!Number.isFinite(elevationMin)) throw new Error('terrain elevation minimum unavailable');

    coverageGroup = new THREE.Group();
    coverageGroup.name = 'ICESat-2 ATL06 mission coverage layer';
    const { lines, segmentCount } = buildLineSegments(data, elevationMin);
    coverageGroup.add(lines);
    viewerApi.scene.add(coverageGroup);

    const summary = data.summary || {};
    const granules = Number(summary.cmr_granule_count || 0);
    const proxies = Number(summary.rendered_proxy_count || 0);
    const rgts = Number(summary.unique_rgt_count || 0);
    const sourceCounts = summary.geometry_source_counts || {};

    if (metaEl) {
      metaEl.innerHTML = [
        '<strong>ICESat-2 mission coverage</strong>',
        `${granules.toLocaleString()} CMR granules intersect crop · ${proxies.toLocaleString()} rendered footprint proxies`,
        `${rgts.toLocaleString()} unique reference ground tracks parsed · ${segmentCount.toLocaleString()} display segments`,
        `Coverage: ${esc(dateOnly(summary.coverage_start))} → ${esc(dateOnly(summary.coverage_end))}`,
        `Spatial metadata: line ${Number(sourceCounts.cmr_line || 0)} · polygon-axis ${Number(sourceCounts.cmr_polygon_axis || 0)} · box-axis ${Number(sourceCounts.cmr_box_axis || 0)}`,
        '<em>Coverage overview only: these are CMR granule-footprint centerline proxies, not the exact six ATL06 laser beams. Brighter overlap means repeated granule coverage.</em>',
      ].join('<br>');
    }

    if (toggleEl) toggleEl.disabled = false;
    syncState();
  } catch (error) {
    console.warn('ATL06 mission coverage unavailable:', error);
    if (toggleEl) {
      toggleEl.checked = false;
      toggleEl.disabled = true;
    }
    if (legendEl) legendEl.hidden = true;
    if (metaEl) {
      metaEl.innerHTML = [
        '<strong>ICESat-2 mission coverage</strong>',
        `<em>${esc(error.message)}.</em>`,
        'Run scripts/build_atl06_coverage.py to build the local coverage overview.',
      ].join('<br>');
    }
  }
}

function attach(api) {
  if (!api || viewerApi) return;
  viewerApi = api;
  buildCoverage();
}

if (toggleEl) {
  toggleEl.disabled = true;
  toggleEl.addEventListener('change', syncState);
}
if (exaggerationEl) exaggerationEl.addEventListener('input', syncState);

if (window.openAntarcticaViewer) {
  attach(window.openAntarcticaViewer);
} else {
  window.addEventListener('open-antarctica-viewer-ready', (event) => {
    attach(event.detail || window.openAntarcticaViewer);
  }, { once: true });
}
