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

function showLayerModuleError({ label, metaId, toggleId, focusId }, error) {
  console.error(`${label} module failed to load:`, error);
  const meta = document.getElementById(metaId);
  const toggle = document.getElementById(toggleId);
  const focus = focusId ? document.getElementById(focusId) : null;
  if (toggle) {
    toggle.checked = false;
    toggle.disabled = true;
  }
  if (focus) focus.disabled = true;
  if (meta) {
    meta.innerHTML = `<strong>${label}</strong><br>` +
      '<strong>Module load error:</strong> ' + String(error?.message || error);
  }
}

// Register science-layer listeners before main.js creates the viewer.
const atl06ModulePromise = import('./atl06-overlay.js?v=20260906-atl06-series-v9')
  .catch((error) => {
    showLayerModuleError({
      label: 'ICESat-2 ATL06 science overlay',
      metaId: 'atl06Meta',
      toggleId: 'atl06Toggle',
      focusId: 'atl06Focus',
    }, error);
    return null;
  });

const coverageModulePromise = import('./atl06-coverage.js?v=20260906-atl06-coverage-v10')
  .catch((error) => {
    showLayerModuleError({
      label: 'ICESat-2 mission coverage',
      metaId: 'atl06CoverageMeta',
      toggleId: 'atl06CoverageToggle',
    }, error);
    return null;
  });

const atl11ModulePromise = import('./atl11-change.js?v=20260906-atl11-change-v11')
  .catch((error) => {
    showLayerModuleError({
      label: 'ICESat-2 ATL11 repeat-track change',
      metaId: 'atl11Meta',
      toggleId: 'atl11Toggle',
      focusId: 'atl11Focus',
    }, error);
    return null;
  });

await import('./main.js?v=20260906-uniform-lod');
await import('./nasa-time.js?v=20260906-atl11-series-v3');
await Promise.all([atl06ModulePromise, coverageModulePromise, atl11ModulePromise]);
