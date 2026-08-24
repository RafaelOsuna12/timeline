/**
 * Gráficos SVG sin dependencias.
 *
 * Reglas de diseño aplicadas:
 *  - Un único eje Y por gráfico (nunca doble escala).
 *  - Colores de serie asignados por identidad en orden fijo, nunca por ranking.
 *  - Líneas de 2px, marcadores de 8px, rejilla fina y sólida, nunca discontinua.
 *  - Leyenda siempre visible con 2 o más series + etiqueta directa al final.
 *  - Capa de interacción: crosshair y tooltip en líneas, tooltip por barra.
 */

const SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4'];
export const seriesColor = (index) => `var(${SERIES_VARS[index % SERIES_VARS.length]})`;

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) node.setAttribute(key, value);
  }
  return node;
};

export const formatNumber = (value) => {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString('es-ES');
};

export const formatPercent = (value) => `${((Number(value) || 0) * 100).toFixed(1)}%`;

const shortDate = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
};

/** Escala "bonita" para el eje Y: 1, 2, 2.5 o 5 por década. */
function niceMax(max) {
  if (max <= 0) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const normalized = max / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function tooltipFor(container) {
  let tip = container.querySelector('.tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tooltip';
    container.appendChild(tip);
  }
  return tip;
}

function placeTooltip(tip, container, x, y) {
  const width = tip.offsetWidth || 150;
  const left = Math.min(Math.max(x - width / 2, 4), container.clientWidth - width - 4);
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(y - tip.offsetHeight - 12, 4)}px`;
}

/**
 * Gráfico de líneas con varias series sobre un único eje.
 * series = [{ name, color, values: [{ x: Date|string, y: number }] }]
 */
export function lineChart(container, series, options = {}) {
  container.innerHTML = '';
  container.classList.add('chart');

  const withData = series.filter((s) => s.values?.length);
  if (!withData.length || withData.every((s) => s.values.every((v) => !v.y))) {
    container.innerHTML = '<div class="empty small">Sin datos en este periodo.</div>';
    return;
  }

  // Leyenda: obligatoria a partir de dos series (la identidad nunca es solo color).
  if (withData.length > 1) {
    const legend = document.createElement('div');
    legend.className = 'legend';
    legend.innerHTML = withData.map((s, i) =>
      `<span class="legend-item"><span class="legend-swatch" style="background:${s.color || seriesColor(i)}"></span>${s.name}</span>`
    ).join('');
    container.appendChild(legend);
  }

  const height = options.height || 240;
  const pad = { top: 14, right: 52, bottom: 26, left: 46 };
  const width = Math.max(container.clientWidth || 640, 320);
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const points = withData[0].values.length;
  const maxY = niceMax(Math.max(...withData.flatMap((s) => s.values.map((v) => Number(v.y) || 0))));
  const xAt = (i) => pad.left + (points === 1 ? plotW / 2 : (i / (points - 1)) * plotW);
  const yAt = (v) => pad.top + plotH - ((Number(v) || 0) / maxY) * plotH;

  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img',
    'aria-label': options.ariaLabel || 'Serie temporal' });

  // Rejilla horizontal fina y sólida (recesiva).
  for (let i = 0; i <= 4; i++) {
    const value = (maxY / 4) * i;
    const y = yAt(value);
    svg.appendChild(el('line', { x1: pad.left, x2: pad.left + plotW, y1: y, y2: y,
      stroke: 'var(--grid)', 'stroke-width': 1 }));
    const label = el('text', { x: pad.left - 8, y: y + 4, 'text-anchor': 'end',
      fill: 'var(--text-muted)', 'font-size': 11 });
    label.textContent = formatNumber(value);
    svg.appendChild(label);
  }

  // Etiquetas del eje X (como mucho 6, para que no colisionen).
  const every = Math.max(1, Math.ceil(points / 6));
  withData[0].values.forEach((point, i) => {
    if (i % every !== 0 && i !== points - 1) return;
    const label = el('text', { x: xAt(i), y: height - 6, 'text-anchor': 'middle',
      fill: 'var(--text-muted)', 'font-size': 11 });
    label.textContent = shortDate(point.x);
    svg.appendChild(label);
  });

  withData.forEach((serie, index) => {
    const color = serie.color || seriesColor(index);
    const path = serie.values.map((v, i) => `${i ? 'L' : 'M'}${xAt(i)},${yAt(v.y)}`).join(' ');

    if (options.area !== false) {
      svg.appendChild(el('path', {
        d: `${path} L${xAt(points - 1)},${yAt(0)} L${xAt(0)},${yAt(0)} Z`,
        fill: color, 'fill-opacity': 0.1, stroke: 'none' }));
    }
    svg.appendChild(el('path', { d: path, fill: 'none', stroke: color,
      'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

    // Etiqueta directa al final de la serie: la identidad no depende del color.
    const lastValue = serie.values[points - 1].y;
    svg.appendChild(el('circle', { cx: xAt(points - 1), cy: yAt(lastValue), r: 4, fill: color }));
    const endLabel = el('text', { x: xAt(points - 1) + 8, y: yAt(lastValue) + 4,
      fill: 'var(--text-secondary)', 'font-size': 11, 'font-weight': 600 });
    endLabel.textContent = formatNumber(lastValue);
    svg.appendChild(endLabel);
  });

  // --- Capa de interacción: crosshair + tooltip ---
  const crosshair = el('line', { y1: pad.top, y2: pad.top + plotH, stroke: 'var(--border-strong)',
    'stroke-width': 1, opacity: 0 });
  svg.appendChild(crosshair);
  const markers = withData.map((serie, index) =>
    svg.appendChild(el('circle', { r: 5, fill: serie.color || seriesColor(index),
      stroke: 'var(--surface-1)', 'stroke-width': 2, opacity: 0 })));

  const tip = tooltipFor(container);
  const hit = el('rect', { x: 0, y: 0, width, height, fill: 'transparent',
    style: 'cursor:crosshair' });
  svg.appendChild(hit);

  hit.addEventListener('mousemove', (event) => {
    const bounds = svg.getBoundingClientRect();
    const relative = ((event.clientX - bounds.left) / bounds.width) * width;
    const index = Math.max(0, Math.min(points - 1,
      Math.round(((relative - pad.left) / plotW) * (points - 1))));
    const x = xAt(index);

    crosshair.setAttribute('x1', x); crosshair.setAttribute('x2', x);
    crosshair.setAttribute('opacity', 1);
    markers.forEach((marker, i) => {
      marker.setAttribute('cx', x);
      marker.setAttribute('cy', yAt(withData[i].values[index].y));
      marker.setAttribute('opacity', 1);
    });

    tip.innerHTML = `<div class="tt-title">${shortDate(withData[0].values[index].x)}</div>` +
      withData.map((serie, i) =>
        `<div class="tt-row"><span class="tt-key"><span class="legend-swatch" style="background:${serie.color || seriesColor(i)}"></span>${serie.name}</span>` +
        `<b>${formatNumber(serie.values[index].y)}</b></div>`).join('');
    tip.classList.add('show');
    placeTooltip(tip, container, (x / width) * (container.clientWidth || width), pad.top + 20);
  });
  hit.addEventListener('mouseleave', () => {
    tip.classList.remove('show');
    crosshair.setAttribute('opacity', 0);
    markers.forEach((marker) => marker.setAttribute('opacity', 0));
  });

  container.appendChild(svg);
}

/**
 * Barras horizontales para desgloses de una sola medida.
 * data = [{ label, value, extra? }]
 */
export function barChart(container, data, options = {}) {
  container.innerHTML = '';
  container.classList.add('chart');
  if (!data?.length) {
    container.innerHTML = '<div class="empty small">Sin datos todavía.</div>';
    return;
  }

  const rows = data.slice(0, options.limit || 10);
  const max = Math.max(...rows.map((r) => Number(r.value) || 0), 1);
  const rowHeight = 30;
  const barHeight = 16;                 // por debajo del tope de 24px
  const labelW = options.labelWidth || 110;
  const valueW = 58;
  const width = Math.max(container.clientWidth || 520, 300);
  const height = rows.length * rowHeight + 6;
  const plotW = width - labelW - valueW;

  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, height,
    role: 'img', 'aria-label': options.ariaLabel || 'Desglose' });
  const tip = tooltipFor(container);
  const color = options.color || seriesColor(0);

  rows.forEach((row, index) => {
    const y = index * rowHeight + 4;
    const value = Number(row.value) || 0;
    const barW = Math.max((value / max) * plotW, 2);

    const label = el('text', { x: 0, y: y + barHeight / 2 + 4, fill: 'var(--text-secondary)',
      'font-size': 12.5 });
    label.textContent = row.label.length > 16 ? `${row.label.slice(0, 15)}…` : row.label;
    svg.appendChild(label);

    // Carril de fondo: da referencia de escala sin gridlines.
    svg.appendChild(el('rect', { x: labelW, y, width: plotW, height: barHeight,
      rx: 4, fill: 'var(--grid)' }));
    // Extremo redondeado en el lado del dato, recto en la línea base.
    svg.appendChild(el('path', {
      d: `M${labelW},${y} h${Math.max(barW - 4, 0)} a4,4 0 0 1 4,4 v${barHeight - 8} a4,4 0 0 1 -4,4 h-${Math.max(barW - 4, 0)} z`,
      fill: color }));

    // Valor siempre visible: nunca depende solo del tooltip.
    const valueLabel = el('text', { x: width - 4, y: y + barHeight / 2 + 4, 'text-anchor': 'end',
      fill: 'var(--text-primary)', 'font-size': 12, 'font-weight': 600 });
    valueLabel.textContent = formatNumber(value);
    svg.appendChild(valueLabel);

    // Zona sensible más alta que la barra (objetivo cómodo).
    const hit = el('rect', { x: 0, y: index * rowHeight, width, height: rowHeight,
      fill: 'transparent' });
    hit.addEventListener('mouseenter', () => {
      const share = ((value / rows.reduce((sum, r) => sum + (Number(r.value) || 0), 0)) * 100).toFixed(1);
      tip.innerHTML = `<div class="tt-title">${row.label}</div>` +
        `<div class="tt-row"><span class="tt-key">${options.measure || 'Dispositivos'}</span><b>${formatNumber(value)}</b></div>` +
        `<div class="tt-row"><span class="tt-key">Del total</span><b>${share}%</b></div>` +
        (row.extra ? `<div class="tt-row"><span class="tt-key">${row.extra.label}</span><b>${row.extra.value}</b></div>` : '');
      tip.classList.add('show');
      placeTooltip(tip, container, labelW + barW / 2, index * rowHeight + 10);
    });
    hit.addEventListener('mouseleave', () => tip.classList.remove('show'));
    svg.appendChild(hit);
  });

  container.appendChild(svg);
}

/** Redibuja los gráficos al cambiar el tamaño de la ventana. */
export function onResize(callback) {
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(callback, 180);
  });
}
