/**
 * Utilidades de lectura de celdas de ExcelJS.
 *
 * Las hojas del reporte diario mezclan valores literales, formulas con
 * resultado cacheado, texto enriquecido y errores (#REF!, #VALUE!). Todas las
 * lecturas del parser pasan por aqui para obtener siempre un escalar limpio.
 */

/** Normaliza cualquier forma de valor de ExcelJS a un escalar JS. */
export function normalize(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (depth > 4) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'error')) return null;
    if (Object.prototype.hasOwnProperty.call(value, 'result')) return normalize(value.result, depth + 1);
    if (Array.isArray(value.richText)) return value.richText.map((t) => t.text).join('');
    if (Object.prototype.hasOwnProperty.call(value, 'text')) return normalize(value.text, depth + 1);
    if (Object.prototype.hasOwnProperty.call(value, 'hyperlink')) return null;
    if (Object.prototype.hasOwnProperty.call(value, 'formula')) return null;
    return null;
  }
  return value;
}

/** Valor normalizado de la celda (fila, columna 1-based). */
export function cell(row, colIndex) {
  if (!row) return null;
  return normalize(row.getCell(colIndex).value);
}

/** Texto recortado o null. */
export function str(row, colIndex) {
  const v = cell(row, colIndex);
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

/** Numero o null (acepta "1,234", "45%", "12 pzs"). */
export function num(row, colIndex) {
  return toNumber(cell(row, colIndex));
}

export function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const cleaned = String(v).replace(/[^0-9.,\-]/g, '').replace(/,/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Numero forzado a entero >= 0 (los conteos diarios nunca son negativos). */
export function count(row, colIndex) {
  const n = num(row, colIndex);
  if (n === null) return 0;
  return Math.max(0, Math.round(n));
}

/** Fecha (Date) o null. */
export function date(row, colIndex) {
  const v = cell(row, colIndex);
  if (v instanceof Date) return v;
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // Numero de serie de Excel (base 1899-12-30).
    return new Date(Math.round((v - 25569) * 86400 * 1000));
  }
  return null;
}

/** Clave estable e insensible a mayusculas/acentos para nombres de personas y tiendas. */
export function key(value) {
  if (value === null || value === undefined) return null;
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** Convierte una fecha a 'YYYY-MM-DD' en UTC (las fechas del libro vienen sin zona). */
export function isoDay(d) {
  if (!(d instanceof Date)) return null;
  return d.toISOString().slice(0, 10);
}
