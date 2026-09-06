import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Bridge stable viewer objects out of main.js without changing the known-good
// terrain renderer. The ATL06 module is intentionally imported BEFORE main.js so
// it can subscribe to the viewer-ready event before terrain streaming begins.
const originalRender = THREE.WebGLRenderer.prototype.render;
const originalControlsUpdate = OrbitControls.prototype.update;
const originalSceneAdd = THREE.Scene.prototype.add;
let bridgePublished = false;
let controlsInstance = null;
let terrainGroupInstance = null;

THREE.Scene.prototype.add = function openAntarcticaSceneAddBridge(...objects) {
  const result = originalSceneAdd.apply(this, objects);
  if (!terrainGroupInstance) {
    const candidate = objects.find((object) => object?.isGroup);
    if (candidate) {
      terrainGroupInstance = candidate;
      candidate.name = candidate.name || 'Open Antarctica REMA terrain';
      if (window.openAntarcticaViewer) window.openAntarcticaViewer.terrainGroup = candidate;
    }
  }
  return result;
};

OrbitControls.prototype.update = function openAntarcticaControlsBridge(...args) {
  controlsInstance = this;
  if (window.openAntarcticaViewer) window.openAntarcticaViewer.controls = this;
  return originalControlsUpdate.apply(this, args);
};

THREE.WebGLRenderer.prototype.render = function openAntarcticaRenderBridge(scene, camera) {
  if (!bridgePublished) {
    bridgePublished = true;
    const renderer = this;
    const api = {
      scene,
      camera,
      renderer,
      controls: controlsInstance,
      terrainGroup: terrainGroupInstance,
      requestRender() {
        requestAnimationFrame(() => originalRender.call(renderer, scene, camera));
      },
    };
    window.openAntarcticaViewer = api;
    window.dispatchEvent(new CustomEvent('open-antarctica-viewer-ready', { detail: api }));
  } else if (window.openAntarcticaViewer) {
    if (controlsInstance) window.openAntarcticaViewer.controls = controlsInstance;
    if (terrainGroupInstance) window.openAntarcticaViewer.terrainGroup = terrainGroupInstance;
  }
  return originalRender.call(this, scene, camera);
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

// Start this import first. It does not need the viewer yet; it registers the
// viewer-ready listener and gives us deterministic lifecycle diagnostics.
const atl06ModulePromise = import('./atl06-overlay.js?v=20260906-atl06-core-v7')
  .catch((error) => {
    showAtl06ModuleError(error);
    return null;
  });

await import('./main.js?v=20260906-uniform-lod');
await import('./nasa-time.js?v=20260906-atl11-series-v3');
await atl06ModulePromise;
