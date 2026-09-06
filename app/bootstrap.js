import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Bridge the stable viewer objects out of main.js without touching the known-good
// terrain engine. THREE.WebGLRenderer defines render on each renderer instance,
// so patching WebGLRenderer.prototype.render does not intercept main.js. Instead,
// capture the Scene/terrain Group through Scene.add and the camera/controls through
// OrbitControls.update, then publish as soon as both sides exist.
const originalControlsUpdate = OrbitControls.prototype.update;
const originalSceneAdd = THREE.Scene.prototype.add;
let bridgePublished = false;
let sceneInstance = null;
let controlsInstance = null;
let terrainGroupInstance = null;

function publishViewerBridge() {
  if (bridgePublished || !sceneInstance || !controlsInstance || !terrainGroupInstance) return;

  bridgePublished = true;
  const camera = controlsInstance.object;
  const api = {
    scene: sceneInstance,
    camera,
    controls: controlsInstance,
    terrainGroup: terrainGroupInstance,
    requestRender() {
      // main.js owns renderDirty. Dispatching the same controls event it already
      // listens to asks the terrain loop for a render without exposing internals.
      controlsInstance.dispatchEvent({ type: 'change' });
    },
  };

  window.openAntarcticaViewer = api;
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

// Register the science-layer listener before main.js creates the viewer.
const atl06ModulePromise = import('./atl06-overlay.js?v=20260906-atl06-core-v8')
  .catch((error) => {
    showAtl06ModuleError(error);
    return null;
  });

await import('./main.js?v=20260906-uniform-lod');
await import('./nasa-time.js?v=20260906-atl11-series-v3');
await atl06ModulePromise;
