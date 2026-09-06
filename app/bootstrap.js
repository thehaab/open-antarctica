import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// main.js intentionally owns terrain engine internals. Bootstrap exposes only the
// stable scene/camera/renderer/controls surface optional science overlays need.
const originalRender = THREE.WebGLRenderer.prototype.render;
const originalControlsUpdate = OrbitControls.prototype.update;
let bridgePublished = false;
let controlsInstance = null;

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
      requestRender() {
        requestAnimationFrame(() => originalRender.call(renderer, scene, camera));
      },
    };
    window.openAntarcticaViewer = api;
    window.dispatchEvent(new CustomEvent('open-antarctica-viewer-ready', { detail: api }));
  } else if (controlsInstance && window.openAntarcticaViewer && !window.openAntarcticaViewer.controls) {
    window.openAntarcticaViewer.controls = controlsInstance;
  }
  return originalRender.call(this, scene, camera);
};

await import('./main.js?v=20260906-uniform-lod');
await import('./nasa-time.js?v=20260906-atl11-series-v3');
await import('./atl06-overlay.js?v=20260906-atl06-overlay-v2');
