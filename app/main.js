import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const viewer = document.getElementById('viewer');
const statusEl = document.getElementById('status');
const metaEl = document.getElementById('meta');
const exaggerationEl = document.getElementById('exaggeration');
const exaggerationValueEl = document.getElementById('exaggerationValue');
const reliefToggleEl = document.getElementById('reliefToggle');
const textureToggleEl = document.getElementById('textureToggle');
const imageryOpacityEl = document.getElementById('imageryOpacity');
const imageryOpacityValueEl = document.getElementById('imageryOpacityValue');
const imageryBlendControlEl = document.getElementById('imageryBlendControl');
const wireframeToggleEl = document.getElementById('wireframeToggle');
const resetViewEl = document.getElementById('resetView');

const params = new URLSearchParams(window.location.search);
const REGION = params.get('region') || 'ferrar-glacier';
const RESOLUTION = params.get('resolution') || '10m';
const LOD_META_URL = `../data/processed/${REGION}/viewer/${RESOLUTION}/terrain-lod.json`;
const LEGACY_META_URL = `../data/processed/${REGION}/viewer/${RESOLUTION}/terrain.json`;

const terrainStyle = {
  reliefEnabled: true,
  imageryEnabled: false,
  imageryOpacity: 0.20,
  sunAzimuthDeg: 315,
  sunElevationDeg: 28,
  ambientStrength: 0.28,
  diffuseStrength: 0.72,
  slopeAccentStrength: 0.12,
};

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

const terrainGroup = new THREE.Group();
scene.add(terrainGroup);

const textureLoader = new THREE.TextureLoader();
const tileCache = new Map();
const boundsCache = new Map();
const loadQueue = [];
const lodFrustum = new THREE.Frustum();
const projectionView = new THREE.Matrix4();
const boxScratch = new THREE.Box3();

const MAX_CONCURRENT_LOADS = 6;
const MAX_READY_TILES = RESOLUTION === '2m' ? 160 : 96;
const MAX_TARGET_VISIBLE_MOVING = RESOLUTION === '2m' ? 60 : 72;
const MAX_TARGET_VISIBLE_SETTLED = RESOLUTION === '2m' ? 144 : 96;
const SETTLE_REFINEMENT_DELAY_MS = 650;
const TARGET_PIXEL_SPACING_MOVING = RESOLUTION === '2m' ? 1.25 : 1.5;
const TARGET_PIXEL_SPACING_SETTLED = RESOLUTION === '2m' ? 0.65 : 0.9;
const LOD_UPDATE_INTERVAL_MS = 90;
const MAX_RENDER_FPS = RESOLUTION === '2m' ? 45 : 60;
const MIN_RENDER_INTERVAL_MS = 1000 / MAX_RENDER_FPS;

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
let renderDirty = true;
let lastRenderTime = -Infinity;
let lastInteractionTime = performance.now();
let settleRefinementApplied = false;

function setStatus(text, error = false) {
  if (text === lastStatus && !error) return;
  lastStatus = text;
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

function requestRender() {
  renderDirty = true;
}

function getSunDirection() {
  const az = THREE.MathUtils.degToRad(terrainStyle.sunAzimuthDeg);
  const el = THREE.MathUtils.degToRad(terrainStyle.sunElevationDeg);
  const cosEl = Math.cos(el);
  return new THREE.Vector3(
    Math.sin(az) * cosEl,
    Math.sin(el),
    Math.cos(az) * cosEl,
  ).normalize();
}

function getSurfaceModeLabel() {
  if (terrainStyle.reliefEnabled && terrainStyle.imageryEnabled) {
    return `REMA relief + LIMA ${Math.round(terrainStyle.imageryOpacity * 100)}%`;
  }
  if (terrainStyle.reliefEnabled) return 'REMA relief';
  if (terrainStyle.imageryEnabled) return 'LIMA only';
  return 'neutral terrain';
}

function createTerrainMaterial(texture, level = 1) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSunDirectionWorld: { value: getSunDirection() },
      uAmbientStrength: { value: terrainStyle.ambientStrength },
      uDiffuseStrength: { value: terrainStyle.diffuseStrength },
      uSlopeAccentStrength: { value: terrainStyle.slopeAccentStrength },
      uReliefEnabled: { value: terrainStyle.reliefEnabled ? 1.0 : 0.0 },
      uImageryEnabled: { value: terrainStyle.imageryEnabled ? 1.0 : 0.0 },
      uImageryOpacity: { value: terrainStyle.imageryOpacity },
      uImagery: { value: texture },
      uHasImagery: { value: texture ? 1.0 : 0.0 },
    },
    vertexShader: `
      uniform vec3 uSunDirectionWorld;
      varying vec2 vUv;
      varying vec3 vNormalView;
      varying vec3 vSunView;
      varying vec3 vUpView;
      varying float vElevation;

      void main() {
        vUv = uv;
        vNormalView = normalize(normalMatrix * normal);
        vSunView = normalize(mat3(viewMatrix) * uSunDirectionWorld);
        vUpView = normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0));

        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vElevation = worldPosition.y;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform float uAmbientStrength;
      uniform float uDiffuseStrength;
      uniform float uSlopeAccentStrength;
      uniform float uReliefEnabled;
      uniform float uImageryEnabled;
      uniform float uImageryOpacity;
      uniform sampler2D uImagery;
      uniform float uHasImagery;

      varying vec2 vUv;
      varying vec3 vNormalView;
      varying vec3 vSunView;
      varying vec3 vUpView;
      varying float vElevation;

      void main() {
        vec3 N = normalize(vNormalView);
        vec3 L = normalize(vSunView);
        vec3 U = normalize(vUpView);

        float lambert = max(dot(N, L), 0.0);
        float wrapped = clamp(lambert * 0.92 + 0.08, 0.0, 1.0);
        float slope = 1.0 - clamp(abs(dot(N, U)), 0.0, 1.0);

        float reliefLight = clamp(uAmbientStrength + uDiffuseStrength * pow(wrapped, 1.12), 0.0, 1.0);
        float elevationTone = clamp(vElevation / 3200.0, 0.0, 1.0);
        vec3 iceBase = mix(vec3(0.62, 0.68, 0.74), vec3(0.88, 0.92, 0.96), elevationTone * 0.18 + 0.30);
        vec3 reliefColor = iceBase * reliefLight;
        reliefColor -= vec3(uSlopeAccentStrength * pow(slope, 0.80));
        reliefColor = smoothstep(vec3(0.055), vec3(0.90), reliefColor);
        reliefColor = clamp(reliefColor, 0.025, 0.94);

        vec3 finalColor = reliefColor;

        if (uHasImagery > 0.5 && uImageryEnabled > 0.5) {
          vec3 imagery = texture2D(uImagery, vUv).rgb;
          vec3 shadedImagery = imagery * (0.58 + 0.46 * wrapped);
          if (uReliefEnabled > 0.5) {
            finalColor = mix(reliefColor, shadedImagery, uImageryOpacity);
          } else {
            finalColor = imagery;
          }
        } else if (uReliefEnabled < 0.5) {
          finalColor = vec3(0.66, 0.70, 0.75);
        }

        gl_FragColor = vec4(finalColor, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: THREE.DoubleSide,
    wireframe: wireframeToggleEl.checked,
    polygonOffset: level === 0,
    polygonOffsetFactor: level === 0 ? 1 : 0,
    polygonOffsetUnits: level === 0 ? 1 : 0,
  });
  material.userData.openAntarcticaTerrain = true;
  return material;
}

function applyMaterialControls(mesh, texture) {
  const material = mesh.material;
  if (material?.userData?.openAntarcticaTerrain && material.uniforms) {
    material.uniforms.uSunDirectionWorld.value.copy(getSunDirection());
    material.uniforms.uAmbientStrength.value = terrainStyle.ambientStrength;
    material.uniforms.uDiffuseStrength.value = terrainStyle.diffuseStrength;
    material.uniforms.uSlopeAccentStrength.value = terrainStyle.slopeAccentStrength;
    material.uniforms.uReliefEnabled.value = terrainStyle.reliefEnabled ? 1.0 : 0.0;
    material.uniforms.uImageryEnabled.value = terrainStyle.imageryEnabled ? 1.0 : 0.0;
    material.uniforms.uImageryOpacity.value = terrainStyle.imageryOpacity;
    material.uniforms.uImagery.value = texture;
    material.uniforms.uHasImagery.value = texture ? 1.0 : 0.0;
  }
  material.wireframe = wireframeToggleEl.checked;
  material.needsUpdate = true;
  mesh.scale.y = Number(exaggerationEl.value);
}

function updateAllTerrainMaterials() {
  forEachTerrain((mesh, texture) => applyMaterialControls(mesh, texture));
  if (imageryBlendControlEl) {
    imageryBlendControlEl.style.opacity = terrainStyle.imageryEnabled ? '1' : '0.5';
  }
  lodDirty = true;
  requestRender();
}

function forEachTerrain(callback) {
  if (legacyTerrain) callback(legacyTerrain, legacyTexture);
  for (const state of tileCache.values()) {
    if (state.ready) callback(state.mesh, state.texture);
  }
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
  requestRender();
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
        requestRender();
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

    const material = createTerrainMaterial(loadedTexture, level);
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
    requestRender();
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
  boxScratch.min.set(
    bounds.centerX - bounds.width * 0.5,
    0,
    bounds.centerZ - bounds.depth * 0.5,
  );
  boxScratch.max.set(
    bounds.centerX + bounds.width * 0.5,
    relief,
    bounds.centerZ + bounds.depth * 0.5,
  );
  return lodFrustum.intersectsBox(boxScratch);
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
  const settled = performance.now() - lastInteractionTime >= SETTLE_REFINEMENT_DELAY_MS;
  const visibleBudget = settled ? MAX_TARGET_VISIBLE_SETTLED : MAX_TARGET_VISIBLE_MOVING;
  const targetPixelSpacing = settled ? TARGET_PIXEL_SPACING_SETTLED : TARGET_PIXEL_SPACING_MOVING;

  let desired = lodMeta.lod.maxLevel;
  for (let level = 0; level <= lodMeta.lod.maxLevel; level++) {
    const bounds = tileBounds(level, 0, 0);
    const spacing = Math.max(bounds.width, bounds.depth) / (lodMeta.lod.samples - 1);
    const projectedPixels = spacing * focalPixels / distance;
    if (projectedPixels <= targetPixelSpacing) {
      desired = level;
      break;
    }
  }

  while (desired > 0) {
    const keys = visibleTileKeys(desired);
    if (keys.length <= visibleBudget) return { level: desired, keys };
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
  const settled = performance.now() - lastInteractionTime >= SETTLE_REFINEMENT_DELAY_MS;
  setStatus(
    `${getSurfaceModeLabel()} · REMA ${RESOLUTION} · target LOD ${targetLevel}/${lodMeta.lod.maxLevel}` +
    ` · shown ${currentRenderLevel}` +
    ` · surface ${renderReady}/${renderKeys.length}` +
    ` · ${shownCount} drawn · ${readyCount} cached` +
    (settled ? ' · settled refine' : ' · moving') +
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
  const nextLevel = currentRenderLevel < targetLevel ? currentRenderLevel + 1 : null;
  const nextKeys = nextLevel === null ? [] : visibleTileKeys(nextLevel);

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
  requestRender();

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
    `surface: native REMA relief; LIMA optional blend`,
    `GPU cache target: ${MAX_READY_TILES} tiles · ${MAX_CONCURRENT_LOADS} concurrent loads`,
    `moving tile budget: ${MAX_TARGET_VISIBLE_MOVING} · settled refine budget: ${MAX_TARGET_VISIBLE_SETTLED}`,
    `LOD pixel target: ${TARGET_PIXEL_SPACING_MOVING.toFixed(2)} px moving · ${TARGET_PIXEL_SPACING_SETTLED.toFixed(2)} px settled`,
    `settled refinement delay: ${SETTLE_REFINEMENT_DELAY_MS} ms`,
    `interactive render cap: ${MAX_RENDER_FPS} fps · renderer sleeps when idle`,
    `steady state uses one LOD level; LOD 0 remains underneath while streaming`,
  ].join('<br>');

  currentRenderLevel = 0;
  lodDirty = true;
  requestRender();
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
  legacyTerrain = new THREE.Mesh(geometry, createTerrainMaterial(loadedTexture, 1));
  terrainGroup.add(legacyTerrain);
  applyMaterialControls(legacyTerrain, legacyTexture);
  setDefaultCamera(spanX, spanZ, maxHeight - minHeight);

  metaEl.innerHTML = [
    `<strong>${meta.name}</strong>`,
    `${meta.width} × ${meta.height} legacy terrain mesh`,
    `${(spanX / 1000).toFixed(1)} × ${(spanZ / 1000).toFixed(1)} km`,
    `${minHeight.toFixed(0)}–${maxHeight.toFixed(0)} m source elevation`,
    'surface: native REMA relief; LIMA optional blend',
    '<em>Build LOD assets for higher detail.</em>',
  ].join('<br>');
  setStatus(`${getSurfaceModeLabel()} · REMA ${RESOLUTION} · legacy mesh`);
  requestRender();
}

async function loadTerrain() {
  const lodResponse = await fetch(LOD_META_URL);
  if (lodResponse.ok) {
    await loadLODTerrain(lodResponse);
  } else {
    await loadLegacyTerrain();
  }
}

reliefToggleEl.checked = terrainStyle.reliefEnabled;
textureToggleEl.checked = terrainStyle.imageryEnabled;
imageryOpacityEl.value = String(Math.round(terrainStyle.imageryOpacity * 100));
imageryOpacityValueEl.textContent = `${Math.round(terrainStyle.imageryOpacity * 100)}%`;
imageryBlendControlEl.style.opacity = terrainStyle.imageryEnabled ? '1' : '0.5';

exaggerationEl.addEventListener('input', () => {
  const value = Number(exaggerationEl.value);
  exaggerationValueEl.textContent = `${value.toFixed(1)}×`;
  forEachTerrain((mesh) => { mesh.scale.y = value; });
  lodDirty = true;
  requestRender();
});

reliefToggleEl.addEventListener('change', () => {
  terrainStyle.reliefEnabled = reliefToggleEl.checked;
  updateAllTerrainMaterials();
});

textureToggleEl.addEventListener('change', () => {
  terrainStyle.imageryEnabled = textureToggleEl.checked;
  updateAllTerrainMaterials();
});

imageryOpacityEl.addEventListener('input', () => {
  terrainStyle.imageryOpacity = Number(imageryOpacityEl.value) / 100;
  imageryOpacityValueEl.textContent = `${imageryOpacityEl.value}%`;
  updateAllTerrainMaterials();
});

wireframeToggleEl.addEventListener('change', () => {
  updateAllTerrainMaterials();
});

resetViewEl.addEventListener('click', resetView);
controls.addEventListener('change', () => {
  lastInteractionTime = performance.now();
  settleRefinementApplied = false;
  if (lodMeta) lodDirty = true;
  requestRender();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  lastInteractionTime = performance.now();
  settleRefinementApplied = false;
  lodDirty = true;
  requestRender();
});

function animate(now = 0) {
  const controlsChanged = controls.update();
  if (controlsChanged) {
    lastInteractionTime = now;
    settleRefinementApplied = false;
    if (lodMeta) lodDirty = true;
    requestRender();
  }

  if (
    lodMeta &&
    !settleRefinementApplied &&
    now - lastInteractionTime >= SETTLE_REFINEMENT_DELAY_MS
  ) {
    settleRefinementApplied = true;
    lodDirty = true;
  }

  if (lodMeta && lodDirty && now - lastLodUpdate >= LOD_UPDATE_INTERVAL_MS) {
    lastLodUpdate = now;
    updateLOD();
  }

  if (renderDirty && now - lastRenderTime >= MIN_RENDER_INTERVAL_MS) {
    renderer.render(scene, camera);
    lastRenderTime = now;
    renderDirty = false;
  }

  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

loadTerrain().catch((error) => {
  console.error(error);
  setStatus(error.message, true);
});
