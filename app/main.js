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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
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

const MAX_CONCURRENT_LOADS = 6;
const MAX_READY_TILES = RESOLUTION === '2m' ? 72 : 96;
const LOD_PIXEL_THRESHOLD = RESOLUTION === '2m' ? 1.35 : 1.6;
const SKIRT_DEPTH_METERS = RESOLUTION === '2m' ? 24 : 40;

let activeLoads = 0;
let lodMeta = null;
let lodBase = '';
let defaultCamera = null;
let sharedUV = null;
let sharedIndex = null;
let legacyTerrain = null;
let legacyTexture = null;
let lodFrame = 0;
let lastStatus = '';
let lastSelected = new Set();
let lastMaxSelected = 0;

function setStatus(text, error = false) {
  if (text === lastStatus && !error) return;
  lastStatus = text;
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

function resetView() {
  if (!defaultCamera) return;
  camera.position.copy(defaultCamera.position);
  controls.target.copy(defaultCamera.target);
  controls.update();
  updateLOD();
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

function enqueueLoad(task, priority = 0) {
  return new Promise((resolve, reject) => {
    loadQueue.push({ task, priority, resolve, reject });
    loadQueue.sort((a, b) => b.priority - a.priority);
    pumpLoadQueue();
  });
}

function pumpLoadQueue() {
  while (activeLoads < MAX_CONCURRENT_LOADS && loadQueue.length > 0) {
    const entry = loadQueue.shift();
    activeLoads += 1;
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        activeLoads -= 1;
        pumpLoadQueue();
      });
  }
}

function buildSkirtGeometry(positions, samples, depth) {
  const edge = [];
  for (let col = 0; col < samples; col++) edge.push(col);
  for (let row = 1; row < samples; row++) edge.push(row * samples + (samples - 1));
  for (let col = samples - 2; col >= 0; col--) edge.push((samples - 1) * samples + col);
  for (let row = samples - 2; row > 0; row--) edge.push(row * samples);

  const count = edge.length;
  const skirtPositions = new Float32Array(count * 2 * 3);
  const skirtUVs = new Float32Array(count * 2 * 2);
  const skirtIndices = new Uint32Array(count * 6);

  for (let i = 0; i < count; i++) {
    const sourceIndex = edge[i];
    const row = Math.floor(sourceIndex / samples);
    const col = sourceIndex % samples;
    const sourceOffset = sourceIndex * 3;
    const upperOffset = i * 6;
    const uvOffset = i * 4;
    const x = positions[sourceOffset];
    const y = positions[sourceOffset + 1];
    const z = positions[sourceOffset + 2];
    const u = col / (samples - 1);
    const v = 1 - row / (samples - 1);

    skirtPositions[upperOffset] = x;
    skirtPositions[upperOffset + 1] = y;
    skirtPositions[upperOffset + 2] = z;
    skirtPositions[upperOffset + 3] = x;
    skirtPositions[upperOffset + 4] = y - depth;
    skirtPositions[upperOffset + 5] = z;

    skirtUVs[uvOffset] = u;
    skirtUVs[uvOffset + 1] = v;
    skirtUVs[uvOffset + 2] = u;
    skirtUVs[uvOffset + 3] = v;

    const next = (i + 1) % count;
    const a = i * 2;
    const b = a + 1;
    const c = next * 2;
    const d = c + 1;
    const k = i * 6;
    skirtIndices[k] = a;
    skirtIndices[k + 1] = b;
    skirtIndices[k + 2] = c;
    skirtIndices[k + 3] = c;
    skirtIndices[k + 4] = b;
    skirtIndices[k + 5] = d;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(skirtPositions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(skirtUVs, 2));
  geometry.setIndex(new THREE.BufferAttribute(skirtIndices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
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

  state.promise = enqueueLoad(async () => {
    const heightUrl = tileUrl(lodMeta.lod.heightPattern, level, x, y);
    const textureUrl = tileUrl(lodMeta.lod.texturePattern, level, x, y);
    const [heightResponse, loadedTexture] = await Promise.all([
      fetch(heightUrl),
      textureLoader.loadAsync(textureUrl),
    ]);

    if (!heightResponse.ok) throw new Error(`Unable to load terrain tile ${key}`);
    const buffer = await heightResponse.arrayBuffer();
    const heights = new Float32Array(buffer);
    const samples = lodMeta.lod.samples;
    const expected = samples * samples;
    if (heights.length !== expected) {
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
        const i = row * samples + col;
        const raw = heights[i];
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
    loadedTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    const material = new THREE.MeshStandardMaterial({
      map: loadedTexture,
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(bounds.centerX, 0, bounds.centerZ);
    mesh.visible = false;
    mesh.userData.tileKey = key;

    const sampleSpacing = Math.max(bounds.width, bounds.depth) / (samples - 1);
    const skirtDepth = Math.max(SKIRT_DEPTH_METERS, sampleSpacing * 3);
    const skirt = new THREE.Mesh(buildSkirtGeometry(positions, samples, skirtDepth), material);
    skirt.userData.isTerrainSkirt = true;
    mesh.add(skirt);

    terrainGroup.add(mesh);

    state.mesh = mesh;
    state.texture = loadedTexture;
    state.ready = true;
    state.loading = false;
    state.lastUsed = performance.now();
    applyMaterialControls(mesh, loadedTexture);
    return state;
  }, priority).catch((error) => {
    tileCache.delete(key);
    throw error;
  });

  return state.promise;
}

function updateFrustum() {
  camera.updateMatrixWorld();
  projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  lodFrustum.setFromProjectionMatrix(projectionView);
}

function tileSphere(level, x, y) {
  const bounds = tileBounds(level, x, y);
  const exaggeration = Number(exaggerationEl.value);
  const relief = (lodMeta.elevation.max - lodMeta.elevation.min) * exaggeration;
  const center = new THREE.Vector3(bounds.centerX, relief * 0.5, bounds.centerZ);
  const radius = Math.hypot(bounds.width * 0.5, bounds.depth * 0.5, relief * 0.5);
  return { bounds, center, radius };
}

function tileIsVisible(level, x, y) {
  const { center, radius } = tileSphere(level, x, y);
  return lodFrustum.intersectsSphere(new THREE.Sphere(center, radius));
}

function shouldRefine(level, x, y) {
  if (level >= lodMeta.lod.maxLevel) return false;
  const { bounds, center, radius } = tileSphere(level, x, y);
  const samples = lodMeta.lod.samples;
  const sampleSpacing = Math.max(bounds.width, bounds.depth) / (samples - 1);
  const centerDistance = camera.position.distanceTo(center);
  const surfaceDistance = Math.max(centerDistance - radius, sampleSpacing * 4);
  const viewportHeight = Math.max(renderer.domElement.clientHeight, 1);
  const focalPixels = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5));
  const projectedSamplePixels = sampleSpacing * focalPixels / surfaceDistance;
  return projectedSamplePixels > LOD_PIXEL_THRESHOLD;
}

function visitTile(level, x, y, selected) {
  if (!tileIsVisible(level, x, y)) return false;

  const key = tileKey(level, x, y);
  const state = tileCache.get(key);
  if (!state || !state.ready) {
    ensureTile(level, x, y, level).catch((error) => {
      console.error(error);
      setStatus(error.message, true);
    });
    return false;
  }

  state.lastUsed = performance.now();

  if (shouldRefine(level, x, y)) {
    const children = [
      [level + 1, x * 2, y * 2],
      [level + 1, x * 2 + 1, y * 2],
      [level + 1, x * 2, y * 2 + 1],
      [level + 1, x * 2 + 1, y * 2 + 1],
    ];

    let allReady = true;
    for (const [cl, cx, cy] of children) {
      const childKey = tileKey(cl, cx, cy);
      const child = tileCache.get(childKey);
      if (!child || !child.ready) {
        allReady = false;
        ensureTile(cl, cx, cy, cl).catch((error) => {
          console.error(error);
          setStatus(error.message, true);
        });
      }
    }

    if (allReady) {
      for (const [cl, cx, cy] of children) visitTile(cl, cx, cy, selected);
      return true;
    }
  }

  selected.add(key);
  return true;
}

function addAncestorsToKeep(selected) {
  const keep = new Set(selected);
  for (const key of selected) {
    const [levelText, xText, yText] = key.split('/');
    let level = Number(levelText);
    let x = Number(xText);
    let y = Number(yText);
    while (level > 0) {
      level -= 1;
      x = Math.floor(x / 2);
      y = Math.floor(y / 2);
      keep.add(tileKey(level, x, y));
    }
  }
  for (let y = 0; y < lodMeta.lod.rootTilesY; y++) {
    for (let x = 0; x < lodMeta.lod.rootTilesX; x++) keep.add(tileKey(0, x, y));
  }
  return keep;
}

function disposeTile(state) {
  if (!state?.ready || !state.mesh) return;
  terrainGroup.remove(state.mesh);
  for (const child of state.mesh.children) {
    if (child.geometry) child.geometry.dispose();
  }
  state.mesh.geometry.dispose();
  state.texture?.dispose();
  state.mesh.material.dispose();
  tileCache.delete(state.key);
}

function evictTiles(selected) {
  const keep = addAncestorsToKeep(selected);
  const ready = [...tileCache.values()].filter((state) => state.ready);
  if (ready.length <= MAX_READY_TILES) return;

  const candidates = ready
    .filter((state) => !keep.has(state.key))
    .sort((a, b) => a.lastUsed - b.lastUsed);

  let readyCount = ready.length;
  for (const state of candidates) {
    if (readyCount <= MAX_READY_TILES) break;
    disposeTile(state);
    readyCount -= 1;
  }
}

function updateStatus(selected, maxSelected) {
  const readyCount = [...tileCache.values()].filter((state) => state.ready).length;
  const loadingCount = [...tileCache.values()].filter((state) => state.loading).length;
  setStatus(
    `REMA ${RESOLUTION} + LIMA · ${selected.size} visible · ${readyCount} cached` +
    (loadingCount ? ` · ${loadingCount} loading` : '') +
    ` · adaptive LOD ${maxSelected}/${lodMeta.lod.maxLevel}`,
  );
}

function updateLOD() {
  if (!lodMeta) return;
  updateFrustum();

  const selected = new Set();
  for (let y = 0; y < lodMeta.lod.rootTilesY; y++) {
    for (let x = 0; x < lodMeta.lod.rootTilesX; x++) {
      visitTile(0, x, y, selected);
    }
  }

  let maxSelected = 0;
  for (const state of tileCache.values()) {
    if (!state.ready) continue;
    const show = selected.has(state.key);
    state.mesh.visible = show;
    if (show) maxSelected = Math.max(maxSelected, state.level);
  }

  lastSelected = selected;
  lastMaxSelected = maxSelected;
  evictTiles(selected);
  updateStatus(selected, maxSelected);
}

async function loadLODTerrain(metaResponse) {
  lodMeta = await metaResponse.json();
  lodBase = LOD_META_URL.slice(0, LOD_META_URL.lastIndexOf('/') + 1);
  buildSharedTopology(lodMeta.lod.samples);

  const roots = [];
  for (let y = 0; y < lodMeta.lod.rootTilesY; y++) {
    for (let x = 0; x < lodMeta.lod.rootTilesX; x++) roots.push(ensureTile(0, x, y, 100));
  }
  await Promise.all(roots);

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
    `REMA ${lodMeta.resolution} · adaptive tiled terrain · LOD 0–${lodMeta.lod.maxLevel}`,
    `${lodMeta.lod.samples} × ${lodMeta.lod.samples} samples/tile`,
    `finest sampling ~${effectiveX.toFixed(1)} × ${effectiveY.toFixed(1)} m`,
    `${lodMeta.elevation.min.toFixed(0)}–${lodMeta.elevation.max.toFixed(0)} m source elevation`,
    `GPU budget: ${MAX_READY_TILES} cached tiles · ${MAX_CONCURRENT_LOADS} concurrent loads`,
    'mixed LOD seams hidden with terrain skirts',
  ].join('<br>');

  updateLOD();
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
  loadedTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
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
  updateLOD();
});

textureToggleEl.addEventListener('change', () => {
  forEachTerrain((mesh, texture) => applyMaterialControls(mesh, texture));
});

wireframeToggleEl.addEventListener('change', () => {
  forEachTerrain((mesh, texture) => applyMaterialControls(mesh, texture));
});

resetViewEl.addEventListener('click', resetView);
controls.addEventListener('change', () => {
  if (lodMeta) updateLOD();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (lodMeta) updateLOD();
});

function animate() {
  controls.update();
  if (lodMeta && (++lodFrame % 45 === 0)) updateLOD();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

loadTerrain().catch((error) => {
  console.error(error);
  setStatus(error.message, true);
});
