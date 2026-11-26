// Dependency-free SVG line chart: income and/or expenses per month, with a dashed forecast.

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

export function buildChart(data, { currentIdx, axisFmt, monthFmt, wide = false, keys = ['income', 'expense'], label = 'Income and expenses by month' }) {
  // A wider drawing on computers, so the labels stay small instead of the chart scaling up
  const W = wide ? 640 : 340, H = wide ? 230 : 190, L = 44, R = 12, T = 12, B = 24;
  const n = data.length;
  const iw = W - L - R, ih = H - T - B;
  const max = Math.max(1, ...data.flatMap(d => keys.map(k => d[k])));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;

  const x = i => L + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
  const y = v => T + ih - (Math.max(0, v) / top) * ih; // a month of refunds sits on the axis

  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="${label}">`;

  // Forecast shading
  if (currentIdx < n - 1) {
    s += `<rect x="${x(currentIdx)}" y="${T}" width="${x(n - 1) - x(currentIdx)}" height="${ih}" class="c-future"/>`;
    s += `<text x="${x(n - 1) - 2}" y="${T + 10}" text-anchor="end" class="c-label">Forecast</text>`;
  }

  // Grid + y labels
  for (let v = 0; v <= top + 1e-9; v += step) {
    s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="c-grid"/>`;
    s += `<text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end" class="c-label">${axisFmt(v)}</text>`;
  }

  // X labels (max ~6, or ~12 when wide)
  const every = Math.max(1, Math.ceil(n / (wide ? 12 : 6)));
  data.forEach((d, i) => {
    if (((currentIdx - i) % every + every) % every !== 0) return; // evenly spaced, always incl. "now"
    s += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="c-label${i === currentIdx ? ' c-now' : ''}">${monthFmt(d)}</text>`;
  });

  const pts = (key, a, b) => data.slice(a, b + 1).map((d, j) => `${x(a + j).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');
  for (const key of keys) {
    s += `<polyline points="${pts(key, 0, currentIdx)}" class="c-line c-${key}"/>`;
    if (currentIdx < n - 1) s += `<polyline points="${pts(key, currentIdx, n - 1)}" class="c-line c-${key} c-dash"/>`;
    if (n <= 15) data.forEach((d, i) => { s += `<circle cx="${x(i)}" cy="${y(d[key])}" r="2.2" class="c-dot c-${key}"/>`; });
  }

  // Highlight (moved by the app on tap / drag)
  s += `<g class="c-hl"><line class="c-hl-line" y1="${T}" y2="${T + ih}"/>` +
       keys.map(k => `<circle class="c-hl-dot c-${k}" r="4.5"/>`).join('') + `</g>`;
  s += `<rect class="c-hit" x="0" y="0" width="${W}" height="${H}"/>`;
  s += `</svg>`;

  return {
    svg: s,
    /** Map a clientX on the rendered svg to the nearest data index. */
    indexAt(svgEl, clientX) {
      const r = svgEl.getBoundingClientRect();
      const vx = ((clientX - r.left) / r.width) * W;
      const i = n === 1 ? 0 : Math.round(((vx - L) / iw) * (n - 1));
      return Math.max(0, Math.min(n - 1, i));
    },
    highlight(svgEl, i) {
      const d = data[i];
      const line = svgEl.querySelector('.c-hl-line');
      line.setAttribute('x1', x(i)); line.setAttribute('x2', x(i));
      svgEl.querySelectorAll('.c-hl-dot').forEach((dot, j) => { dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(d[keys[j]])); });
    },
  };
}

/** Tap or drag on a drawn chart to pick a month: calls onSelect(index). */
export function attachChart(svgEl, ctl, onSelect) {
  const pick = ev => onSelect(ctl.indexAt(svgEl, ev.clientX));
  svgEl.addEventListener('pointerdown', pick);
  svgEl.addEventListener('pointermove', ev => { if (ev.buttons || ev.pointerType === 'touch') pick(ev); });
}
