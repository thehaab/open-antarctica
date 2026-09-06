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
      const referenceSource = requestedEpoch
        ? 'URL epoch'
        : index.query?.reference_source === 'search_window_midpoint'
          ? 'search-window midpoint'
          : 'indexed reference';

      const productLines = Object.entries(index.products || {}).map(([name, info]) => {
        if (info.temporal_model === 'repeat_track_time_series') {
          const count = Number(info.series_granule_count || 0);
          const coverage = info.collection_temporal_coverage || {};
          const start = coverage.start ? dateOnly(coverage.start) : 'unknown';
          const end = coverage.end || 'unknown';
          const cadence = coverage.nominal_resolution ? ` · ${esc(coverage.nominal_resolution)} repeat` : '';
          return `${esc(name)} v${esc(info.version)}: ${count} spatial time-series granule${count === 1 ? '' : 's'} · collection ${esc(start)} → ${esc(end)}${cadence}`;
        }

        const exact = Number(info.exact_granule_count ?? info.granule_count ?? 0);
        if (exact > 0) {
          return `${esc(name)} v${esc(info.version)}: ${exact} exact-window granule${exact === 1 ? '' : 's'}`;
        }

        const nearest = Array.isArray(info.nearest_granules) ? info.nearest_granules[0] : null;
        if (nearest) {
          const nearestTime = nearest.time_start || nearest.time_end;
          const distance = Number(info.nearest_distance_days);
          const relation = info.nearest_relation === 'before'
            ? 'before reference'
            : info.nearest_relation === 'after'
              ? 'after reference'
              : 'from reference';
          const distanceText = Number.isFinite(distance) ? ` · ${distance.toFixed(1)} days ${relation}` : '';
          return `${esc(name)} v${esc(info.version)}: 0 exact · nearest ${esc(dateOnly(nearestTime))}${distanceText}`;
        }

        return `${esc(name)} v${esc(info.version)}: no dated observation found for this footprint in the fallback search`;
      });

      const datedProducts = Object.values(index.products || {}).filter((info) =>
        info.temporal_model !== 'repeat_track_time_series',
      );
      const anyExact = datedProducts.some((info) =>
        Number(info.exact_granule_count ?? info.granule_count ?? 0) > 0,
      );
      const anyNearest = datedProducts.some((info) =>
        Array.isArray(info.nearest_granules) && info.nearest_granules.length > 0,
      );
      const anySeries = Object.values(index.products || {}).some((info) =>
        info.temporal_model === 'repeat_track_time_series' && Number(info.series_granule_count || 0) > 0,
      );

      let note = 'Metadata index loaded; science granules are not yet rendered.';
      if (!anyExact && anyNearest) {
        note = 'No exact-window ATL06 pass was found; nearest dated ATL06 observation is shown. ATL11 dates live inside its time-series HDF5 and are not inferred from granule metadata.';
      } else if (!anyExact && !anyNearest && anySeries) {
        note = 'ATL11 time-series granules exist for this footprint, but their internal cycle epochs have not yet been read from HDF5.';
      } else if (!anyExact && !anyNearest && !anySeries) {
        note = 'No ICESat-2 data were found for this footprint in the indexed search; verify the spatial footprint before treating this as a true coverage gap.';
      }

      temporalEl.innerHTML = [
        '<strong>Time-aware NASA data</strong>',
        `Reference epoch: ${esc(effectiveEpoch)} (${esc(referenceSource)})`,
        `Exact ATL06 search window: ${esc(index.query?.start)} → ${esc(index.query?.end)}`,
        ...productLines,
        `Index generated: ${esc(index.generated_at)}`,
        `<em>${esc(note)}</em>`,
      ].join('<br>');
    })
    .catch(() => renderUnavailable());
}
