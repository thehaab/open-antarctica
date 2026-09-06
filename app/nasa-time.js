const temporalEl = document.getElementById('temporalMeta');

if (temporalEl) {
  const params = new URLSearchParams(window.location.search);
  const region = params.get('region') || 'ferrar-glacier';
  const epoch = params.get('epoch');
  const url = `../data/processed/${region}/nasa/nasa-observations.json`;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function renderUnavailable() {
    temporalEl.innerHTML = [
      '<strong>Time-aware NASA data</strong>',
      `Reference epoch: ${epoch ? esc(epoch) : 'not selected'}`,
      'NASA temporal index: not built locally',
      '<em>Terrain shown above is REMA, not NASA temporal science data.</em>',
    ].join('<br>');
  }

  renderUnavailable();

  fetch(url, { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((index) => {
      const productLines = Object.entries(index.products || {}).map(([name, info]) =>
        `${esc(name)} v${esc(info.version)}: ${Number(info.granule_count || 0)} matching granules`,
      );
      temporalEl.innerHTML = [
        '<strong>Time-aware NASA data</strong>',
        `Reference epoch: ${epoch ? esc(epoch) : 'not selected'}`,
        `Search window: ${esc(index.query?.start)} → ${esc(index.query?.end)}`,
        ...productLines,
        `Index generated: ${esc(index.generated_at)}`,
        '<em>Metadata index loaded; science granules are not yet rendered.</em>',
      ].join('<br>');
    })
    .catch(() => renderUnavailable());
}
