/** Formatos y etiquetas compartidas por todo el tablero. */

const numberFmt = new Intl.NumberFormat('es-MX');
const decimalFmt = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const decimal2Fmt = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function n(value, fallback = '—') {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  return numberFmt.format(Math.round(value));
}

export function d1(value, fallback = '—') {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  return decimalFmt.format(value);
}

export function d2(value, fallback = '—') {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  return decimal2Fmt.format(value);
}

export function pct(value, digits = 1, fallback = '—') {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  return `${(value * 100).toFixed(digits)}%`;
}

export function signed(value, fallback = '—') {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  const s = numberFmt.format(Math.abs(Math.round(value)));
  if (value > 0) return `+${s}`;
  if (value < 0) return `−${s}`;
  return '0';
}

export const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

export function periodLabel(periodKey) {
  if (!periodKey) return '';
  const [y, m] = periodKey.split('-').map(Number);
  const name = MONTHS[m - 1] || periodKey;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${y}`;
}

export function dateLabel(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}

export const STATUS_LABELS = {
  en_meta: 'En meta',
  en_riesgo: 'En riesgo',
  fuera_de_meta: 'Fuera de meta',
  sin_target: 'Sin target',
};

export const STATUS_TONE = {
  en_meta: 'good',
  en_riesgo: 'warning',
  fuera_de_meta: 'critical',
  sin_target: 'neutral',
};

/** Los 8 slots categoricos, en el orden fijo de la paleta validada. */
export const SERIES = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
];

/**
 * Color estable por entidad: se asigna por nombre, no por posicion en la lista,
 * para que filtrar no repinte las series que sobreviven.
 */
export function seriesColorFor(name, catalog) {
  if (!catalog || !catalog.length) return SERIES[0];
  const index = catalog.indexOf(name);
  if (index < 0) return SERIES[0];
  return SERIES[index % SERIES.length];
}

/** Rampa secuencial de 7 pasos para mapas de calor. */
export const SEQUENTIAL = [
  'var(--seq-100)',
  'var(--seq-200)',
  'var(--seq-300)',
  'var(--seq-400)',
  'var(--seq-500)',
  'var(--seq-600)',
  'var(--seq-700)',
];

export function sequentialStep(value, max) {
  if (!max || value === null || value === undefined) return null;
  if (value <= 0) return null;
  const ratio = Math.min(1, value / max);
  const idx = Math.min(SEQUENTIAL.length - 1, Math.floor(ratio * SEQUENTIAL.length));
  return SEQUENTIAL[idx];
}
