/**
 * Charts, drawn as SVG with no library.
 *
 * Accepts both dialects:
 *   legacy  — `data=[{label,value}]`              (hand-written demos)
 *   shimmed — `data` + `series[]` + `xAxis.dataKey` (what `<Chart content>` lowers to)
 *
 * The SVG is laid out in real pixels (measured container width), so text and strokes
 * are never stretched; a ResizeObserver redraws on width changes.
 */
import { el, esc, applyCommon } from '../dom.js';

const PALETTE = ['var(--dil-chart-1)', 'var(--dil-chart-2)', 'var(--dil-chart-3)', 'var(--dil-chart-4)', 'var(--dil-chart-5)'];

function fmtNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '');
  const abs = Math.abs(n);
  if (abs >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (abs >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function fmtValue(v, s) {
  return (s?.valuePrefix || '') + fmtNumber(v) + (s?.valueSuffix || '');
}

/** "Nice" axis ticks: 4–6 steps of 1/2/2.5/5 × 10^k covering [lo, hi]. */
function niceTicks(lo, hi) {
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const start = Math.floor(lo / step) * step;
  const ticks = [];
  for (let t = start; t <= hi + step * 1e-9; t += step) ticks.push(+t.toFixed(10));
  if (ticks[ticks.length - 1] < hi) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function model(p) {
  const rows = Array.isArray(p.data) ? p.data : [];
  const series = Array.isArray(p.series) && p.series.length ? p.series : [{ dataKey: 'value', type: p.type || 'bar' }];
  let xKey = p.xAxis && typeof p.xAxis === 'object' ? p.xAxis.dataKey : typeof p.xAxis === 'string' ? p.xAxis : null;
  if (!xKey) xKey = rows[0] && rows[0].label != null ? 'label' : 'name';
  return { rows, series, xKey };
}

function legend(series) {
  if (series.length < 2 && !series[0]?.label) return '';
  return `<div class="dil-chart-legend">${series
    .map((s, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(s.label || s.dataKey)}</span>`)
    .join('')}</div>`;
}

function cartesian(p, width) {
  const { rows, series, xKey } = model(p);
  const H = typeof p.height === 'number' ? p.height : 220;
  const W = Math.max(240, width);
  const pad = { l: 48, r: 12, t: 12, b: 28 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  const values = rows.flatMap((r) => series.map((s) => Number(r[s.dataKey]))).filter(Number.isFinite);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values, 1));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const y = (v) => pad.t + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const band = plotW / Math.max(1, rows.length);
  const x = (i) => pad.l + band * i + band / 2;
  const out = [];

  for (const t of ticks) {
    const yy = y(t).toFixed(1);
    out.push(`<line x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}" class="dil-chart-grid${t === 0 ? ' dil-chart-zero' : ''}"/>`);
    out.push(`<text x="${pad.l - 8}" y="${yy}" class="dil-chart-axis" text-anchor="end" dominant-baseline="middle">${esc(fmtNumber(t))}</text>`);
  }
  const stride = Math.max(1, Math.ceil((rows.length * 64) / plotW));
  rows.forEach((r, i) => {
    if (i % stride) return;
    out.push(`<text x="${x(i).toFixed(1)}" y="${H - 8}" class="dil-chart-axis" text-anchor="middle">${esc(r[xKey])}</text>`);
  });

  const bars = series.filter((s) => (s.type || 'bar') === 'bar');
  const barW = Math.max(4, Math.min(40, (band * 0.64) / Math.max(1, bars.length)));
  series.forEach((s, si) => {
    const tone = PALETTE[si % PALETTE.length];
    const tip = (r, v) => `<title>${esc(r[xKey])} · ${esc(s.label || s.dataKey)}：${esc(fmtValue(v, s))}</title>`;
    if ((s.type || 'bar') === 'line' || s.type === 'scatter') {
      const pts = rows.map((r, i) => [x(i), y(Number(r[s.dataKey]) || 0)]);
      if (s.type !== 'scatter') {
        const d = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join('');
        out.push(`<path d="${d}" fill="none" stroke="${tone}" class="dil-chart-line"/>`);
      }
      if (p.showDots !== false || s.type === 'scatter') {
        rows.forEach((r, i) => out.push(`<circle cx="${pts[i][0].toFixed(1)}" cy="${pts[i][1].toFixed(1)}" r="3.5" fill="${tone}" class="dil-chart-dot">${tip(r, r[s.dataKey])}</circle>`));
      }
      return;
    }
    const bi = bars.indexOf(s);
    rows.forEach((r, i) => {
      const v = Number(r[s.dataKey]) || 0;
      const bx = x(i) - (barW * bars.length) / 2 + bi * barW + 1;
      const top = y(Math.max(v, 0));
      const h = Math.max(1, y(Math.min(v, 0)) - top);
      out.push(`<rect x="${bx.toFixed(1)}" y="${top.toFixed(1)}" width="${(barW - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${tone}" class="dil-chart-bar">${tip(r, v)}</rect>`);
    });
  });

  return legend(series) + `<svg class="dil-chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">${out.join('')}</svg>`;
}

function pie(p) {
  const rows = Array.isArray(p.data) ? p.data : [];
  const vKey = (Array.isArray(p.series) && p.series[0]?.dataKey) || 'value';
  const nKey = typeof p.xAxis === 'string' ? p.xAxis : rows[0] && rows[0].label != null ? 'label' : 'name';
  const items = rows.map((r) => ({ label: r[nKey] ?? r.label, value: Math.max(0, Number(r[vKey]) || 0) }));
  const total = items.reduce((a, d) => a + d.value, 0) || 1;
  const R = 70;
  const r0 = 44; // donut hole
  let angle = -Math.PI / 2;
  const arcs = items.map((d, i) => {
    const sweep = (d.value / total) * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + Math.max(sweep - 0.012, 0.001);
    angle += sweep;
    const pt = (rad, a) => `${(80 + rad * Math.cos(a)).toFixed(2)} ${(80 + rad * Math.sin(a)).toFixed(2)}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const path = sweep >= Math.PI * 2 - 1e-6
      ? `M${pt(R, 0)}A${R} ${R} 0 1 1 ${pt(R, Math.PI)}A${R} ${R} 0 1 1 ${pt(R, 0)}M${pt(r0, 0)}A${r0} ${r0} 0 1 0 ${pt(r0, Math.PI)}A${r0} ${r0} 0 1 0 ${pt(r0, 0)}Z`
      : `M${pt(R, a0)}A${R} ${R} 0 ${large} 1 ${pt(R, a1)}L${pt(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${pt(r0, a0)}Z`;
    return `<path d="${path}" fill="${PALETTE[i % PALETTE.length]}" fill-rule="evenodd" class="dil-chart-slice"><title>${esc(d.label)}：${esc(fmtNumber(d.value))}</title></path>`;
  });
  const legendRows = items
    .map((d, i) => `<div class="dil-pie-item"><i style="background:${PALETTE[i % PALETTE.length]}"></i><span>${esc(d.label)}</span><b>${esc(fmtNumber(d.value))}</b><em>${Math.round((d.value / total) * 100)}%</em></div>`)
    .join('');
  return `<div class="dil-pie"><svg viewBox="0 0 160 160" width="160" height="160" role="img">${arcs.join('')}</svg><div class="dil-pie-legend">${legendRows}</div></div>`;
}

function chartFactory(draw) {
  return (props) => {
    const node = el('div', 'dil-chart');
    let sig = null;
    let latest = props;
    let width = 0;
    const redraw = () => {
      const next = JSON.stringify([latest.data, latest.series, latest.xAxis, latest.height, latest.type, width]);
      if (next === sig) return;
      sig = next;
      node.innerHTML = draw(latest, width);
    };
    function update(p) {
      applyCommon(node, p);
      latest = p;
      width = node.clientWidth || width || 560;
      redraw();
    }
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(([entry]) => {
        const w = Math.round(entry.contentRect.width);
        if (w && Math.abs(w - width) > 2) {
          width = w;
          redraw();
        }
      }).observe(node);
    }
    update(props);
    return { node, update };
  };
}

export default {
  chart: chartFactory(cartesian),
  'pie-chart': chartFactory(pie),
};

export { niceTicks, fmtNumber };
