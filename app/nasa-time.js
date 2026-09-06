const temporalEl = document.getElementById('temporalMeta');

if (temporalEl) {
  const params = new URLSearchParams(window.location.search);
  const region = params.get('region') || 'ferrar-glacier';
  const requestedEpoch = params.get('epoch');
  const url = `../data/processed/${region}/nasa/nasa-observations.json`;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function dateOnly(value) {
    if (!value) return 'unknown date';
    return String(value).slice(0, 10);
  }

  function renderUnavailable() {
    temporalEl.innerHTML = [
      '<strong>Time-aware NASA data</strong>',
      `Reference epoch: ${requestedEpoch ? esc(requestedEpoch) : 'not selected'}`,
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
      const effectiveEpoch = requestedEpoch || index.query?.reference_time || index.query?.end || 'not selected';
      const productLines = Object.entries(index.products || {}).map(([name, info]) => {
        const exact = Number(info.exact_granule_count ?? info.granule_count ?? 0);
        if (exact > 0) {
          return `${esc(name)} v${esc(info.version)}: ${exact} exact-window granule${exact === 1 ? '' : 's'}`;
        }

        const nearest = Array.isArray(info.nearest_granules) ? info.nearest_granules[0] : null;
        if (nearest) {
          const nearestTime = nearest.time_start || nearest.time_end;
          const distance = Number(info.nearest_distance_days);
          const distanceText = Number.isFinite(distance) ? ` · ${distance.toFixed(1)} days from reference` : '';
          return `${esc(name)} v${esc(info.version)}: 0 exact · nearest ${esc(dateOnly(nearestTime))}${distanceText}`;
        }

        return `${esc(name)} v${esc(info.version)}: no observation found for this footprint in the fallback search`;
      });

      const anyExact = Object.values(index.products || {}).some((info) =>
        Number(info.exact_granule_count ?? info.granule_count ?? 0) > 0,
      );
      const anyNearest = Object.values(index.products || {}).some((info) =>
        Array.isArray(info.nearest_granules) && info.nearest_granules.length > 0,
      );

      let note = 'Metadata index loaded; science granules are not yet rendered.';
      if (!anyExact && anyNearest) {
        note = 'No exact-window pass was found; nearest dated observations are shown instead. Science granules are not yet rendered.';
      } else if (!anyExact && !anyNearest) {
        note = 'No ICESat-2 observation was found for this footprint in the indexed search; verify the spatial footprint before treating this as a true coverage gap.';
      }

      temporalEl.innerHTML = [
        '<strong>Time-aware NASA data</strong>',
        `Reference epoch: ${esc(effectiveEpoch)}`,
        `Exact search window: ${esc(index.query?.start)} → ${esc(index.query?.end)}`,
        ...productLines,
        `Index generated: ${esc(index.generated_at)}`,
        `<em>${esc(note)}</em>`,
      ].join('<br>');
    })
    .catch(() => renderUnavailable());
}
