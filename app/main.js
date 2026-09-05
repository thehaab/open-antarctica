import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const viewer = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const metaEl = document.getElementById('meta');
const exaggerationEl = document.getElementById('exaggeration');
const exaggerationValueEl = document.getElementById('exaggerationValue');
const textureToggleEl = document.getElementById('textureToggle');
const wireframeToggleEl = document.getElementById('wireframeToggle');
const resetViewEl = document.getElementById('resetView');

const params = new URLSearchParams(window.location.search);
const REGION = params.get('region') || 'ferrar-glacier';
const RESOLUTION = params.get('resolution') || '10m';
const LOD_META_URL = `../data/processed/${REGION}/viewer/${RESOLUTION}/terrain-lod.json`;
const LEGACY_META_URL = `../data/processed/${REGION}/viewer/${RESOLUTION}/terrain.json`;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewer.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0d12);
scene.fog = new THREE.FogExp2(0x0a0d12, 0.000012);

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 10, 500000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;
controls.minDistance = 250;
controls.maxDistance = 180000;

scene.add(new THREE.HemisphereLight(0xd9e8ff, 0x18202b, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(-1, 2, 1.2);
scene.add(sun);

const terrainGroup = new THREE.Group();
scene.add(terrainGroup);

const textureLoader = new THREE.TextureLoader();
const tileCache = new Map();
const boundsCache = new Map();
const loadQueue = [];
const lodFrustum = new THREE.Frustum();
const projectionView = new THREE.Matrix4();
const sphereScratch = new THREE.Sphere();

const MAX_CONCURRENT_LOADS = 6;
const MAX_READY_TILES = RESOLUTION === '2m' ? 96 : 96;
const MAX_TARGET_VISIBLE = RESOLUTION === '2m' ? 60 : 72;
const TARGET_PIXEL_SPACING = RESOLUTION === '2m' ? 1.25 : 1.5;
const LOD_UPDATE_INTERVAL_MS = 90;

let activeLoads = 0;
let lodMeta = null;
let lodBase = '';
let defaultCamera = null;
let sharedUV = null;
let sharedIndex = null;
let legacyTerrain = null;
let legacyTexture = null;
let lastStatus = '';
let currentRenderLevel = 0;
let currentWantedKeys = new Set();
let lodDirty = true;
let lastLodUpdate = 0;

function setStatus(text, error = false) {
  if (text === lastStatus && !error) return;
  lastStatus = text;
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

function isRootKey(key) {
  return key.startsWith('0/');
}

function resetView() {
  if (!defaultCamera) return;
  camera.position.copy(defaultCamera.position);
  controls.target.copy(defaultCamera.target);
  controls.update();
  lodDirty = true;
}

function setDefaultCamera(spanX, spanZ, relief) {
  const target = new THREE.Vector3(0, Math.max(relief * 0.35, 400), 0);
  const position = new THREE.Vector3(
    spanX * 0.16,
    Math.max(spanX * 0.26, 12000),
    spanZ * 1.7,
  );
  defaultCamera = { position, target };
  resetView();
}

function applyMaterialControls(mesh, texture) {
  mesh.material.map = textureToggleEl.checked ? texture : null;
  mesh.material.color.set(textureToggleEl.checked ? 0xffffff : 0xcfd6df);
  mesh.material.wireframe = wireframeToggleEl.checked;
  mesh.material.needsUpdate = true;
  mesh.scale.y = Number(exaggerationEl.value);
}

function forEachTerrain(callback) {
  if (legacyTerrain) callback(legacyTerrain, legacyTexture);
  for (const state of tileCache.values()) {
    if (state.ready) callback(state.mesh, state.texture);
  }
}

function buildSharedTopology(samples) {
  const count = samples * samples;
  const uv = new Float32Array(count * 2);
  let t = 0;
  for (let row = 0; row < samples; row++) {
    const v = row / (samples - 1);
    for (let col = 0; col < samples; col++) {
      const u = col / (samples - 1);
      uv[t++] = u;
      uv[t++] = 1 - v;
    }
  }

  const cells = (samples - 1) * (samples - 1);
  const indices = new Uint32Array(cells * 6);
  let k = 0;
  for (let row = 0; row < samples - 1; row++) {
    for (let col = 0; col < samples - 1; col++) {
      const a = row * samples + col;
      const b = a + 1;
      const c = a + samples;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }

  sharedUV = new THREE.BufferAttribute(uv, 2);
  sharedIndex = new THREE.BufferAttribute(indices, 1);
}

function tileKey(level, x, y) {
  return `${level}/${x}/${y}`;
}

function parseTileKey(key) {
  const [level, x, y] = key.split('/').map(Number);
  return { level, x, y };
}

function tileBounds(level, x, y) {
  const key = tileKey(level, x, y);
  const cached = boundsCache.get(key);
  if (cached) return cached;

  const scale = 2 ** level;
  const nx = lodMeta.lod.rootTilesX * scale;
  const ny = lodMeta.lod.rootTilesY * scale;
  const global = lodMeta.extent;
  const spanX = global.xmax - global.xmin;
  const spanY = global.ymax - global.ymin;
  const width = spanX / nx;
  const depth = spanY / ny;
  const xmin = global.xmin + x * width;
  const xmax = xmin + width;
  const ymax = global.ymax - y * depth;
  const ymin = ymax - depth;
  const centerX = ((xmin + xmax) * 0.5) - ((global.xmin + global.xmax) * 0.5);
  const centerZ = ((global.ymin + global.ymax) * 0.5) - ((ymin + ymax) * 0.5);
  const value = { xmin, xmax, ymin, ymax, width, depth, centerX, centerZ };
  boundsCache.set(key, value);
  return value;
}

function tileUrl(pattern, level, x, y) {
  return lodBase + pattern
    .replace('{level}', level)
    .replace('{x}', x)
    .replace('{y}', y);
}

function enqueueLoad(key, task, priority = 0, onCancel = null) {
  return new Promise((resolve, reject) => {
    loadQueue.push({ key, task, priority, resolve, reject, onCancel });
    loadQueue.sort((a, b) => b.priority - a.priority);
    pumpLoadQueue();
  });
}

function cancelStaleQueuedLoads() {
  for (let i = loadQueue.length - 1; i >= 0; i--) {
    const entry = loadQueue[i];
    if (isRootKey(entry.key) || currentWantedKeys.has(entry.key)) continue;
    loadQueue.splice(i, 1);
    entry.onCancel?.();
    entry.resolve(null);
  }
}

function pumpLoadQueue() {
  while (activeLoads < MAX_CONCURRENT_LOADS && loadQueue.length > 0) {
    const entry = loadQueue.shift();
    if (!isRootKey(entry.key) && !currentWantedKeys.has(entry.key)) {
      entry.onCancel?.();
      entry.resolve(null);
      continue;
    }

    activeLoads += 1;
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        activeLoads -= 1;
        lodDirty = true;
        pumpLoadQueue();
      });
  }
}

function ensureTile(level, x, y, priority = 0) {
  const key = tileKey(level, x, y);
  const existing = tileCache.get(key);
  if (existing) {
    existing.lastUsed = performance.now();
    return existing.promise;
  }

  const state = {
    key,
    level,
    x,
    y,
    ready: false,
    loading: true,
    mesh: null,
    texture: null,
    promise: null,
    lastUsed: performance.now(),
  };
  tileCache.set(key, state);

  const cancel = () => {
    state.loading = false;
    if (tileCache.get(key) === state) tileCache.delete(key);
  };

  state.promise = enqueueLoad(key, async () => {
    const heightUrl = tileUrl(lodMeta.lod.heightPattern, level, x, y);
    const textureUrl = tileUrl(lodMeta.lod.texturePattern, level, x, y);
    const [heightResponse, loadedTexture] = await Promise.all([
      fetch(heightUrl),
      textureLoader.loadAsync(textureUrl),
    ]);

    if (!heightResponse.ok) throw new Error(`Unable to load terrain tile ${key}`);

    if (!isRootKey(key) && !currentWantedKeys.has(key)) {
      loadedTexture.dispose();
      cancel();
      return null;
    }

    const heights = new Float32Array(await heightResponse.arrayBuffer());
    const samples = lodMeta.lod.samples;
    const expected = samples * samples;
    if (heights.length !== expected) {
      loadedTexture.dispose();
      throw new Error(`Terrain tile ${key} has ${heights.length} samples; expected ${expected}`);
    }

    const bounds = tileBounds(level, x, y);
    const positions = new Float32Array(expected * 3);
    const minHeight = lodMeta.elevation.min;
    let p = 0;

    for (let row = 0; row < samples; row++) {
      const v = row / (samples - 1);
      const z = (v - 0.5) * bounds.depth;
      for (let col = 0; col < samples; col++) {
        const u = col / (samples - 1);
        const raw = heights[row * samples + col];
        const yValue = !Number.isFinite(raw) || raw <= -9000 ? 0 : raw - minHeight;
        positions[p++] = (u - 0.5) * bounds.width;
        positions[p++] = yValue;
        positions[p++] = z;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', sharedUV);
    geometry.setIndex(sharedIndex);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    loadedTexture.colorSpace = THREE.SRGBColorSpace;
    loadedTexture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);

    const material = new THREE.MeshStandardMaterial({
      map: loadedTexture,
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide,
      polygonOffset: level === 0,
      polygonOffsetFactor: level === 0 ? 1 : 0,
      polygonOffsetUnits: level === 0 ? 1 : 0,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(bounds.centerX, 0, bounds.centerZ);
    mesh.visible = false;
    mesh.userData.tileKey = key;
    terrainGroup.add(mesh);

    state.mesh = mesh;
    state.texture = loadedTexture;
    state.ready = true;
    state.loading = false;
    state.lastUsed = performance.now();
    applyMaterialControls(mesh, loadedTexture);
    lodDirty = true;
    return state;
  }, priority, cancel).catch((error) => {
    if (tileCache.get(key) === state) tileCache.delete(key);
    throw error;
  });

  return state.promise;
}

function updateFrustum() {
  camera.updateMatrixWorld();
  projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  lodFrustum.setFromProjectionMatrix(projectionView);
}

function tileIsVisible(level, x, y) {
  const bounds = tileBounds(level, x, y);
  const exaggeration = Number(exaggerationEl.value);
  const relief = (lodMeta.elevation.max - lodMeta.elevation.min) * exaggeration;
  sphereScratch.center.set(bounds.centerX, relief * 0.5, bounds.centerZ);
  sphereScratch.radius = Math.hypot(bounds.width * 0.5, bounds.depth * 0.5, relief * 0.5);
  return lodFrustum.intersectsSphere(sphereScratch);
}

function visibleTileKeys(level) {
  const scale = 2 ** level;
  const nx = lodMeta.lod.rootTilesX * scale;
  const ny = lodMeta.lod.rootTilesY * scale;
  const keys = [];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      if (tileIsVisible(level, x, y)) keys.push(tileKey(level, x, y));
    }
  }
  return keys;
}

function chooseTargetLevel() {
  const viewportHeight = Math.max(renderer.domElement.clientHeight, 1);
  const focalPixels = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5));
  const distance = Math.max(camera.position.distanceTo(controls.target), 250);

  let desired = lodMeta.lod.maxLevel;
  for (let level = 0; level <= lodMeta.lod.maxLevel; level++) {
    const bounds = tileBounds(level, 0, 0);
    const spacing = Math.max(bounds.width, bounds.depth) / (lodMeta.lod.samples - 1);
    const projectedPixels = spacing * focalPixels / distance;
    if (projectedPixels <= TARGET_PIXEL_SPACING) {
      desired = level;
      break;
    }
  }

  while (desired > 0) {
    const keys = visibleTileKeys(desired);
    if (keys.length <= MAX_TARGET_VISIBLE) return { level: desired, keys };
    desired -= 1;
  }
  return { level: 0, keys: visibleTileKeys(0) };
}

function allReady(keys) {
  return keys.every((key) => tileCache.get(key)?.ready);
}

function requestKeys(keys, priority) {
  for (const key of keys) {
    const { level, x, y } = parseTileKey(key);
    ensureTile(level, x, y, priority).catch((error) => {
      console.error(error);
      setStatus(error.message, true);
    });
  }
}

function rootKeys() {
  const keys = [];
  for (let y = 0; y < lodMeta.lod.rootTilesY; y++) {
    for (let x = 0; x < lodMeta.lod.rootTilesX; x++) keys.push(tileKey(0, x, y));
  }
  return keys;
}

function disposeTile(state) {
  if (!state?.ready || !state.mesh || state.level === 0) return;
  terrainGroup.remove(state.mesh);
  state.mesh.geometry.dispose();
  state.texture?.dispose();
  state.mesh.material.dispose();
  if (tileCache.get(state.key) === state) tileCache.delete(state.key);
}

function evictTiles() {
  const ready = [...tileCache.values()].filter((state) => state.ready);
  if (ready.length <= MAX_READY_TILES) return;

  const candidates = ready
    .filter((state) => state.level !== 0 && !currentWantedKeys.has(state.key) && !state.mesh.visible)
    .sort((a, b) => a.lastUsed - b.lastUsed);

  let readyCount = ready.length;
  for (const state of candidates) {
    if (readyCount <= MAX_READY_TILES) break;
    disposeTile(state);
    readyCount -= 1;
  }
}

function updateVisibility(renderKeys) {
  const renderSet = new Set(renderKeys);
  for (const state of tileCache.values()) {
    if (!state.ready || !state.mesh) continue;

    if (state.level === 0) {
      state.mesh.visible = true;
      continue;
    }

    state.mesh.visible = state.level === currentRenderLevel && renderSet.has(state.key);
  }
}

function updateStatus(targetLevel, renderKeys, nextKeys) {
  const readyCount = [...tileCache.values()].filter((state) => state.ready).length;
  const renderReady = renderKeys.filter((key) => tileCache.get(key)?.ready).length;
  const shownCount = [...tileCache.values()].filter((state) => state.ready && state.mesh?.visible).length;
  setStatus(
    `REMA ${RESOLUTION} + LIMA · target LOD ${targetLevel}/${lodMeta.lod.maxLevel}` +
    ` · shown ${currentRenderLevel}` +
    ` · surface ${renderReady}/${renderKeys.length}` +
    ` · ${shownCount} drawn · ${readyCount} cached` +
    (activeLoads ? ` · ${activeLoads} active` : '') +
    (loadQueue.length ? ` · ${loadQueue.length} queued` : '') +
    (nextKeys.length ? ` · warming LOD ${Math.min(currentRenderLevel + 1, lodMeta.lod.maxLevel)}` : ''),
  );
}

function updateLOD() {
  if (!lodMeta) return;
  updateFrustum();

  const target = chooseTargetLevel();
  const targetLevel = target.level;

  if (currentRenderLevel > targetLevel) currentRenderLevel = targetLevel;

  let renderKeys = visibleTileKeys(currentRenderLevel);
  let nextLevel = currentRenderLevel < targetLevel ? currentRenderLevel + 1 : null;
  let nextKeys = nextLevel === null ? [] : visibleTileKeys(nextLevel);

  const roots = rootKeys();
  currentWantedKeys = new Set([...roots, ...renderKeys, ...nextKeys]);
  cancelStaleQueuedLoads();

  requestKeys(renderKeys, 300);
  if (nextKeys.length) requestKeys(nextKeys, 200);

  let advanced = false;
  if (nextLevel !== null && nextKeys.length > 0 && allReady(nextKeys)) {
    currentRenderLevel = nextLevel;
    renderKeys = nextKeys;
    advanced = true;
  }

  updateVisibility(renderKeys);
  evictTiles();
  updateStatus(targetLevel, renderKeys, nextKeys);

  // If a whole level just became ready, immediately schedule the next refinement
  // pass instead of waiting for another camera movement to wake the LOD manager.
  lodDirty = advanced && currentRenderLevel < targetLevel;
}

async function loadLODTerrain(metaResponse) {
  lodMeta = await metaResponse.json();
  lodBase = LOD_META_URL.slice(0, LOD_META_URL.lastIndexOf('/') + 1);
  buildSharedTopology(lodMeta.lod.samples);

  const roots = rootKeys();
  currentWantedKeys = new Set(roots);
  await Promise.all(roots.map((key) => {
    const { level, x, y } = parseTileKey(key);
    return ensureTile(level, x, y, 1000);
  }));

  const spanX = lodMeta.extent.xmax - lodMeta.extent.xmin;
  const spanZ = lodMeta.extent.ymax - lodMeta.extent.ymin;
  const relief = lodMeta.elevation.max - lodMeta.elevation.min;
  setDefaultCamera(spanX, spanZ, relief);

  const finestX = lodMeta.lod.rootTilesX * (2 ** lodMeta.lod.maxLevel);
  const finestY = lodMeta.lod.rootTilesY * (2 ** lodMeta.lod.maxLevel);
  const effectiveX = spanX / finestX / (lodMeta.lod.samples - 1);
  const effectiveY = spanZ / finestY / (lodMeta.lod.samples - 1);

  metaEl.innerHTML = [
    `<strong>${lodMeta.name}</strong>`,
    `REMA ${lodMeta.resolution} · stable adaptive terrain · LOD 0–${lodMeta.lod.maxLevel}`,
    `${lodMeta.lod.samples} × ${lodMeta.lod.samples} samples/tile`,
    `finest sampling ~${effectiveX.toFixed(1)} × ${effectiveY.toFixed(1)} m`,
    `${lodMeta.elevation.min.toFixed(0)}–${lodMeta.elevation.max.toFixed(0)} m source elevation`,
    `GPU cache target: ${MAX_READY_TILES} tiles · ${MAX_CONCURRENT_LOADS} concurrent loads`,
    `steady state uses one LOD level; LOD 0 remains underneath while streaming`,
  ].join('<br>');

  currentRenderLevel = 0;
  lodDirty = true;
}

async function loadLegacyTerrain() {
  const metaResponse = await fetch(LEGACY_META_URL);
  if (!metaResponse.ok) {
    throw new Error(`LOD assets are not built yet for ${RESOLUTION}. Run scripts/build_viewer_lod_assets.sh --resolution ${RESOLUTION}`);
  }
  const meta = await metaResponse.json();
  const base = LEGACY_META_URL.slice(0, LEGACY_META_URL.lastIndexOf('/') + 1);
  const [heightResponse, loadedTexture] = await Promise.all([
    fetch(base + meta.heightmap),
    textureLoader.loadAsync(base + meta.texture),
  ]);
  if (!heightResponse.ok) throw new Error(`Unable to load ${meta.heightmap}`);

  const heights = new Float32Array(await heightResponse.arrayBuffer());
  const expected = meta.width * meta.height;
  if (heights.length !== expected) throw new Error('Legacy height grid has unexpected size');

  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (const h of heights) {
    if (!Number.isFinite(h) || h <= -9000) continue;
    minHeight = Math.min(minHeight, h);
    maxHeight = Math.max(maxHeight, h);
  }

  const spanX = meta.extent.xmax - meta.extent.xmin;
  const spanZ = meta.extent.ymax - meta.extent.ymin;
  const positions = new Float32Array(expected * 3);
  const uvs = new Float32Array(expected * 2);
  let p = 0;
  let t = 0;
  for (let row = 0; row < meta.height; row++) {
    const v = row / (meta.height - 1);
    for (let col = 0; col < meta.width; col++) {
      const u = col / (meta.width - 1);
      const raw = heights[row * meta.width + col];
      positions[p++] = (u - 0.5) * spanX;
      positions[p++] = raw <= -9000 || !Number.isFinite(raw) ? 0 : raw - minHeight;
      positions[p++] = (v - 0.5) * spanZ;
      uvs[t++] = u;
      uvs[t++] = 1 - v;
    }
  }

  const indices = new Uint32Array((meta.width - 1) * (meta.height - 1) * 6);
  let k = 0;
  for (let row = 0; row < meta.height - 1; row++) {
    for (let col = 0; col < meta.width - 1; col++) {
      const a = row * meta.width + col;
      const b = a + 1;
      const c = a + meta.width;
      const d = c + 1;
      indices[k++] = a; indices[k++] = c; indices[k++] = b;
      indices[k++] = b; indices[k++] = c; indices[k++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  loadedTexture.colorSpace = THREE.SRGBColorSpace;
  loadedTexture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  legacyTexture = loadedTexture;
  legacyTerrain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    map: loadedTexture,
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  }));
  terrainGroup.add(legacyTerrain);
  applyMaterialControls(legacyTerrain, legacyTexture);
  setDefaultCamera(spanX, spanZ, maxHeight - minHeight);

  metaEl.innerHTML = [
    `<strong>${meta.name}</strong>`,
    `${meta.width} × ${meta.height} legacy terrain mesh`,
    `${(spanX / 1000).toFixed(1)} × ${(spanZ / 1000).toFixed(1)} km`,
    `${minHeight.toFixed(0)}–${maxHeight.toFixed(0)} m source elevation`,
    '<em>Build LOD assets for higher detail.</em>',
  ].join('<br>');
  setStatus(`REMA ${RESOLUTION} + LIMA · legacy mesh`);
}

async function loadTerrain() {
  const lodResponse = await fetch(LOD_META_URL);
  if (lodResponse.ok) {
    await loadLODTerrain(lodResponse);
  } else {
    await loadLegacyTerrain();
  }
}

exaggerationEl.addEventListener('input', () => {
  const value = Number(exaggerationEl.value);
  exaggerationValueEl.textContent = `${value.toFixed(1)}×`;
  forEachTerrain((mesh) => { mesh.scale.y = value; });
  lodDirty = true;
});

textureToggleEl.addEventListener('change', () => {
  forEachTerrain((mesh, texture) => applyMaterialControls(mesh, texture));
});

wireframeToggleEl.addEventListener('change', () => {
  forEachTerrain((mesh, texture) => applyMaterialControls(mesh, texture));
});

resetViewEl.addEventListener('click', resetView);
controls.addEventListener('change', () => {
  if (lodMeta) lodDirty = true;
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  lodDirty = true;
});

function animate(now = 0) {
  controls.update();
  if (lodMeta && lodDirty && now - lastLodUpdate >= LOD_UPDATE_INTERVAL_MS) {
    lastLodUpdate = now;
    updateLOD();
  }
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

loadTerrain().catch((error) => {
  console.error(error);
  setStatus(error.message, true);
});
