import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Bridge the stable viewer objects out of main.js without touching the known-good
// terrain engine. THREE.WebGLRenderer defines render on each renderer instance,
// so capture the Scene/terrain Group through Scene.add and the camera/controls
// through OrbitControls.update, then publish as soon as both sides exist.
const originalControlsUpdate = OrbitControls.prototype.update;
const originalSceneAdd = THREE.Scene.prototype.add;
const terrainSurfaceToggleEl = document.getElementById('terrainSurfaceToggle');
let bridgePublished = false;
let sceneInstance = null;
let controlsInstance = null;
let terrainGroupInstance = null;

function requestMainRender() {
  if (controlsInstance) controlsInstance.dispatchEvent({ type: 'change' });
}

function syncTerrainSurface() {
  if (!terrainGroupInstance || !terrainSurfaceToggleEl) return;
  terrainGroupInstance.visible = Boolean(terrainSurfaceToggleEl.checked);
  requestMainRender();
}

function publishViewerBridge() {
  if (bridgePublished || !sceneInstance || !controlsInstance || !terrainGroupInstance) return;

  bridgePublished = true;
  const camera = controlsInstance.object;
  const api = {
    scene: sceneInstance,
    camera,
    controls: controlsInstance,
    terrainGroup: terrainGroupInstance,
    requestRender: requestMainRender,
  };

  window.openAntarcticaViewer = api;
  syncTerrainSurface();
  window.dispatchEvent(new CustomEvent('open-antarctica-viewer-ready', { detail: api }));
}

THREE.Scene.prototype.add = function openAntarcticaSceneAddBridge(...objects) {
  const result = originalSceneAdd.apply(this, objects);
  sceneInstance = this;

  if (!terrainGroupInstance) {
    const candidate = objects.find((object) => object?.isGroup);
    if (candidate) {
      terrainGroupInstance = candidate;
      candidate.name = candidate.name || 'Open Antarctica REMA terrain';
      syncTerrainSurface();
    }
  }

  publishViewerBridge();
  return result;
};

OrbitControls.prototype.update = function openAntarcticaControlsBridge(...args) {
  controlsInstance = this;
  const result = originalControlsUpdate.apply(this, args);
  publishViewerBridge();
  return result;
};

if (terrainSurfaceToggleEl) terrainSurfaceToggleEl.addEventListener('change', syncTerrainSurface);

function showAtl06ModuleError(error) {
  console.error('ATL06 overlay module failed to load:', error);
  const meta = document.getElementById('atl06Meta');
  const toggle = document.getElementById('atl06Toggle');
  const focus = document.getElementById('atl06Focus');
  if (toggle) {
    toggle.checked = false;
    toggle.disabled = true;
  }
  if (focus) focus.disabled = true;
  if (meta) {
    meta.innerHTML = '<strong>ICESat-2 ATL06 science overlay</strong><br>' +
      '<strong>Module load error:</strong> ' + String(error?.message || error);
  }
}

function showCoverageModuleError(error) {
  console.error('ATL06 coverage module failed to load:', error);
  const meta = document.getElementById('atl06CoverageMeta');
  const toggle = document.getElementById('atl06CoverageToggle');
  if (toggle) {
    toggle.checked = false;
    toggle.disabled = true;
  }
  if (meta) {
    meta.innerHTML = '<strong>ICESat-2 mission coverage</strong><br>' +
      '<strong>Module load error:</strong> ' + String(error?.message || error);
  }
}

// Register science-layer listeners before main.js creates the viewer.
const atl06ModulePromise = import('./atl06-overlay.js?v=20260906-atl06-series-v9')
  .catch((error) => {
    showAtl06ModuleError(error);
    return null;
  });

const coverageModulePromise = import('./atl06-coverage.js?v=20260906-atl06-coverage-v10')
  .catch((error) => {
    showCoverageModuleError(error);
    return null;
  });

await import('./main.js?v=20260906-uniform-lod');
await import('./nasa-time.js?v=20260906-atl11-series-v3');
await Promise.all([atl06ModulePromise, coverageModulePromise]);
