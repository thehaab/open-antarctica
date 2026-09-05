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

const META_URL = '../data/processed/ferrar-glacier/viewer/10m/terrain.json';

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
controls.minDistance = 1500;
controls.maxDistance = 180000;

scene.add(new THREE.HemisphereLight(0xd9e8ff, 0x18202b, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(-1, 2, 1.2);
scene.add(sun);

let terrain = null;
let texture = null;
let defaultCamera = null;

function setStatus(text, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

function resetView() {
  if (!defaultCamera) return;
  camera.position.copy(defaultCamera.position);
  controls.target.copy(defaultCamera.target);
  controls.update();
}

async function loadTerrain() {
  const metaResponse = await fetch(META_URL);
  if (!metaResponse.ok) throw new Error(`Unable to load ${META_URL}`);
  const meta = await metaResponse.json();

  const base = META_URL.slice(0, META_URL.lastIndexOf('/') + 1);
  const [heightResponse, loadedTexture] = await Promise.all([
    fetch(base + meta.heightmap),
    new THREE.TextureLoader().loadAsync(base + meta.texture),
  ]);

  if (!heightResponse.ok) throw new Error(`Unable to load ${meta.heightmap}`);
  const buffer = await heightResponse.arrayBuffer();
  const heights = new Float32Array(buffer);
  const expected = meta.width * meta.height;
  if (heights.length !== expected) {
    throw new Error(`Height grid has ${heights.length} samples; expected ${expected}`);
  }

  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (const h of heights) {
    if (!Number.isFinite(h) || h <= -9000) continue;
    minHeight = Math.min(minHeight, h);
    maxHeight = Math.max(maxHeight, h);
  }
  if (!Number.isFinite(minHeight) || !Number.isFinite(maxHeight)) {
    throw new Error('No valid elevations found in height grid');
  }

  const spanX = meta.extent.xmax - meta.extent.xmin;
  const spanZ = meta.extent.ymax - meta.extent.ymin;
  const relief = maxHeight - minHeight;

  const positions = new Float32Array(expected * 3);
  const uvs = new Float32Array(expected * 2);

  let p = 0;
  let t = 0;
  for (let row = 0; row < meta.height; row++) {
    const v = row / (meta.height - 1);
    const z = (v - 0.5) * spanZ;
    for (let col = 0; col < meta.width; col++) {
      const u = col / (meta.width - 1);
      const i = row * meta.width + col;
      const raw = heights[i];
      const y = raw <= -9000 || !Number.isFinite(raw) ? 0 : raw - minHeight;

      positions[p++] = (u - 0.5) * spanX;
      positions[p++] = y;
      positions[p++] = z;

      uvs[t++] = u;
      uvs[t++] = 1 - v;
    }
  }

  const cellCount = (meta.width - 1) * (meta.height - 1);
  const indices = new Uint32Array(cellCount * 6);
  let k = 0;
  for (let row = 0; row < meta.height - 1; row++) {
    for (let col = 0; col < meta.width - 1; col++) {
      const a = row * meta.width + col;
      const b = a + 1;
      const c = a + meta.width;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  loadedTexture.colorSpace = THREE.SRGBColorSpace;
  loadedTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture = loadedTexture;

  const material = new THREE.MeshStandardMaterial({
    map: texture,
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });

  terrain = new THREE.Mesh(geometry, material);
  terrain.scale.y = Number(exaggerationEl.value);
  scene.add(terrain);

  const box = new THREE.Box3().setFromObject(terrain);
  const size = box.getSize(new THREE.Vector3());
  const target = new THREE.Vector3(0, Math.max(relief * 0.35, 400), 0);
  const position = new THREE.Vector3(spanX * 0.16, Math.max(spanX * 0.26, 12000), spanZ * 1.7);
  defaultCamera = { position, target };
  resetView();

  metaEl.innerHTML = [
    `<strong>${meta.name}</strong>`,
    `${meta.width} × ${meta.height} terrain mesh`,
    `${(spanX / 1000).toFixed(1)} × ${(spanZ / 1000).toFixed(1)} km`,
    `${minHeight.toFixed(0)}–${maxHeight.toFixed(0)} m source elevation`,
  ].join('<br>');

  setStatus('REMA + LIMA loaded');
}

exaggerationEl.addEventListener('input', () => {
  const value = Number(exaggerationEl.value);
  exaggerationValueEl.textContent = `${value.toFixed(1)}×`;
  if (terrain) terrain.scale.y = value;
});

textureToggleEl.addEventListener('change', () => {
  if (!terrain) return;
  terrain.material.map = textureToggleEl.checked ? texture : null;
  terrain.material.color.set(textureToggleEl.checked ? 0xffffff : 0xcfd6df);
  terrain.material.needsUpdate = true;
});

wireframeToggleEl.addEventListener('change', () => {
  if (!terrain) return;
  terrain.material.wireframe = wireframeToggleEl.checked;
});

resetViewEl.addEventListener('click', resetView);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

loadTerrain().catch((error) => {
  console.error(error);
  setStatus(error.message, true);
});
