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

const META_URL = '../data/processed/ferrar-glacier/viewer/10m/terrain-lod.json';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
controls.minDistance = 500;
controls.maxDistance = 180000;

scene.add(new THREE.HemisphereLight(0xd9e8ff, 0x18202b, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(-1, 2, 1.2);
scene.add(sun);

const terrainGroup = new THREE.Group();
scene.add(terrainGroup);

const textureLoader = new THREE.TextureLoader();
const tileCache = new Map();
let meta = null;
let baseUrl = '';
let sharedUV = null;
let sharedIndex = null;
let defaultCamera = null;
let currentLevel = -1;
let desiredLevel = 0;
let levelLoadToken = 0;
let frameCounter = 0;
let lastStatus = '';

function setStatus(text, error = false) {
  if (text === lastStatus && !error) return;
  lastStatus = text;
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
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
  const scale = 2 ** level;
  const nx = meta.lod.rootTilesX * scale;
  const ny = meta.lod.rootTilesY * scale;
  const global = meta.extent;
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
  return { width, depth, centerX, centerZ };
}

function tileUrl(pattern, level, x, y) {
  return baseUrl + pattern
    .replace('{level}', level)
    .replace('{x}', x)
    .replace('{y}', y);
}

function applyMaterialControls(state) {
  if (!state.ready) return;
  state.mesh.material.map = textureToggleEl.checked ? state.texture : null;
  state.mesh.material.color.set(textureToggleEl.checked ? 0xffffff : 0xcfd6df);
  state.mesh.material.wireframe = wireframeToggleEl.checked;
  state.mesh.material.needsUpdate = true;
  state.mesh.scale.y = Number(exaggerationEl.value);
}

async function ensureTile(level, x, y) {
  const key = tileKey(level, x, y);
  const existing = tileCache.get(key);
  if (existing) return existing.promise;

  const state = { key, level, x, y, ready: false, mesh: null, texture: null, promise: null };
  tileCache.set(key, state);

  state.promise = (async () => {
    const [heightResponse, loadedTexture] = await Promise.all([
      fetch(tileUrl(meta.lod.heightPattern, level, x, y)),
      textureLoader.loadAsync(tileUrl(meta.lod.texturePattern, level, x, y)),
    ]);

    if (!heightResponse.ok) throw new Error(`Unable to load terrain tile ${key}`);
    const heights = new Float32Array(await heightResponse.arrayBuffer());
    const samples = meta.lod.samples;
    const expected = samples * samples;
    if (heights.length !== expected) {
      throw new Error(`Terrain tile ${key} has ${heights.length} samples; expected ${expected}`);
    }

    const bounds = tileBounds(level, x, y);
    const positions = new Float32Array(expected * 3);
    const minHeight = meta.elevation.min;
    let p = 0;
    for (let row = 0; row < samples; row++) {
      const v = row / (samples - 1);
      const z = (v - 0.5) * bounds.depth;
      for (let col = 0; col < samples; col++) {
        const u = col / (samples - 1);
        const raw = heights[row * samples + col];
        const y = !Number.isFinite(raw) || raw <= -9000 ? 0 : raw - minHeight;
        positions[p++] = (u - 0.5) * bounds.width;
        positions[p++] = y;
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
    terrainGroup.add(mesh);

    state.mesh = mesh;
    state.texture = loadedTexture;
    state.ready = true;
    applyMaterialControls(state);
    return state;
  })().catch((error) => {
    tileCache.delete(key);
    throw error;
  });

  return state.promise;
}

function levelDimensions(level) {
  const scale = 2 ** level;
  return {
    nx: meta.lod.rootTilesX * scale,
    ny: meta.lod.rootTilesY * scale,
  };
}

async function ensureLevel(level) {
  const { nx, ny } = levelDimensions(level);
  const jobs = [];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) jobs.push(ensureTile(level, x, y));
  }
  await Promise.all(jobs);
}

function showOnlyLevel(level) {
  let visible = 0;
  for (const state of tileCache.values()) {
    if (!state.ready) continue;
    const show = state.level === level;
    state.mesh.visible = show;
    if (show) visible += 1;
  }
  currentLevel = level;
  setStatus(`REMA + LIMA · ${visible} tiles · seam-safe LOD ${level}/${meta.lod.maxLevel}`);
}

async function switchToLevel(level) {
  desiredLevel = level;
  if (level === currentLevel) return;
  const token = ++levelLoadToken;
  const { nx, ny } = levelDimensions(level);
  setStatus(`Loading LOD ${level} · ${nx * ny} tiles…`);
  try {
    await ensureLevel(level);
    if (token !== levelLoadToken || desiredLevel !== level) return;
    showOnlyLevel(level);
  } catch (error) {
    console.error(error);
    setStatus(error.message, true);
  }
}

function chooseLevel() {
  if (!meta) return 0;
  const spanX = meta.extent.xmax - meta.extent.xmin;
  const distance = camera.position.distanceTo(controls.target);
  if (meta.lod.maxLevel >= 2 && distance < spanX * 0.45) return 2;
  if (meta.lod.maxLevel >= 1 && distance < spanX * 1.1) return 1;
  return 0;
}

function updateLOD() {
  if (!meta) return;
  const next = chooseLevel();
  if (next !== desiredLevel || currentLevel < 0) switchToLevel(next);
}

function resetView() {
  if (!defaultCamera) return;
  camera.position.copy(defaultCamera.position);
  controls.target.copy(defaultCamera.target);
  controls.update();
  updateLOD();
}

function setDefaultCamera(spanX, spanZ, relief) {
  defaultCamera = {
    target: new THREE.Vector3(0, Math.max(relief * 0.35, 400), 0),
    position: new THREE.Vector3(
      spanX * 0.16,
      Math.max(spanX * 0.26, 12000),
      spanZ * 1.7,
    ),
  };
  resetView();
}

async function loadTerrain() {
  const response = await fetch(META_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error('LOD assets are missing; rebuild viewer LOD assets');
  meta = await response.json();
  if (meta.format !== 'open-antarctica-lod-v2') {
    throw new Error('Old LOD assets detected; rerun scripts/build_viewer_lod_assets.sh');
  }
  baseUrl = META_URL.slice(0, META_URL.lastIndexOf('/') + 1);
  buildSharedTopology(meta.lod.samples);

  await ensureLevel(0);
  showOnlyLevel(0);

  const spanX = meta.extent.xmax - meta.extent.xmin;
  const spanZ = meta.extent.ymax - meta.extent.ymin;
  const relief = meta.elevation.max - meta.elevation.min;
  setDefaultCamera(spanX, spanZ, relief);

  const finestX = meta.lod.rootTilesX * (2 ** meta.lod.maxLevel);
  const finestY = meta.lod.rootTilesY * (2 ** meta.lod.maxLevel);
  const effectiveX = spanX / finestX / (meta.lod.samples - 1);
  const effectiveY = spanZ / finestY / (meta.lod.samples - 1);

  metaEl.innerHTML = [
    `<strong>${meta.name}</strong>`,
    `seam-safe tiled terrain · LOD 0–${meta.lod.maxLevel}`,
    `${meta.lod.samples} × ${meta.lod.samples} samples/tile`,
    `finest sampling ~${effectiveX.toFixed(1)} × ${effectiveY.toFixed(1)} m`,
    `${meta.elevation.min.toFixed(0)}–${meta.elevation.max.toFixed(0)} m source elevation`,
  ].join('<br>');

  updateLOD();
}

exaggerationEl.addEventListener('input', () => {
  const value = Number(exaggerationEl.value);
  exaggerationValueEl.textContent = `${value.toFixed(1)}×`;
  for (const state of tileCache.values()) {
    if (state.ready) state.mesh.scale.y = value;
  }
});

textureToggleEl.addEventListener('change', () => {
  for (const state of tileCache.values()) applyMaterialControls(state);
});

wireframeToggleEl.addEventListener('change', () => {
  for (const state of tileCache.values()) applyMaterialControls(state);
});

resetViewEl.addEventListener('click', resetView);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  controls.update();
  frameCounter += 1;
  if (frameCounter % 12 === 0) updateLOD();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

animate();
loadTerrain().catch((error) => {
  console.error(error);
  setStatus(error.message, true);
});
