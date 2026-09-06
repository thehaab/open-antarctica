import * as THREE from 'three';

// main.js intentionally owns the terrain engine internals. The bootstrap keeps that
// stable while exposing only the rendered scene/camera needed by optional science
// overlays. This avoids coupling ATL06 visualization to the LOD implementation.
const originalRender = THREE.WebGLRenderer.prototype.render;
let bridgePublished = false;

THREE.WebGLRenderer.prototype.render = function openAntarcticaRenderBridge(scene, camera) {
  if (!bridgePublished) {
    bridgePublished = true;
    const renderer = this;
    const api = {
      scene,
      camera,
      renderer,
      requestRender() {
        requestAnimationFrame(() => originalRender.call(renderer, scene, camera));
      },
    };
    window.openAntarcticaViewer = api;
    window.dispatchEvent(new CustomEvent('open-antarctica-viewer-ready', { detail: api }));
  }
  return originalRender.call(this, scene, camera);
};

await import('./main.js?v=20260906-uniform-lod');
await import('./nasa-time.js?v=20260906-atl11-series-v3');
await import('./atl06-overlay.js?v=20260906-atl06-overlay-v1');
