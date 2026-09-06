import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// main.js intentionally owns the terrain engine internals. Bootstrap exposes only
// stable scene/camera/renderer/controls references to optional science overlays.
// Capture the exact terrain Group when main.js adds it to the scene; science
// layers should never have to guess which scene child is the REMA surface.
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

await import('./main.js?v=20260906-uniform-lod');
await import('./nasa-time.js?v=20260906-atl11-series-v3');
await import('./atl06-overlay.js?v=20260906-atl06-ribbon-v4');
