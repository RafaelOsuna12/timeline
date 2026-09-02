/**
 * Deteccion de la estructura (layout) de las hojas del reporte diario.
 *
 * El libro cambia de mes: las columnas de dias se recorren, aparecen nuevos
 * targets y las cabeceras se mueven de fila. En vez de fijar columnas por
 * letra, el parser localiza:
 *
 *   1. La fila de encabezado, buscando una etiqueta ancla ("CHANNEL", "Channel"...).
 *   2. La fila de fechas: la fila de las primeras 6 con mas celdas de tipo Date.
 *   3. Los "bloques de dias": rachas consecutivas de columnas con fecha real en
 *      la fila de fechas. En las hojas diarias el orden siempre es
 *      [Sell-Out] [Asistencia] [Cero venta].
 *
 * Asi el mismo codigo lee agosto (31 dias) o febrero (28) sin tocar nada.
 */
import { normalize } from '../utils/cell.js';

const MAX_HEADER_SCAN_ROWS = 12;

/**
 * Algunas celdas del libro son formulas con formato de fecha cuyo resultado
 * cacheado no es convertible (por ejemplo la fila de dias de la semana).
 * ExcelJS las devuelve como `Invalid Date`, asi que se descartan siempre.
 */
function isValidDate(v) {
  return v instanceof Date && !Number.isNaN(v.getTime());
}

/** Devuelve el valor normalizado de (fila, col) de forma segura. */
function at(ws, r, c) {
  const row = ws.getRow(r);
  if (!row) return null;
  return normalize(row.getCell(c).value);
}

function text(ws, r, c) {
  const v = at(ws, r, c);
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

/**
 * Busca la fila de encabezado que contenga TODAS las etiquetas indicadas.
 * @returns {{row:number, cols:Record<string,number>}}
 */
export function findHeaderRow(ws, labels, { maxRow = MAX_HEADER_SCAN_ROWS, maxCol = 40 } = {}) {
  const wanted = labels.map((l) => l.toUpperCase());
  for (let r = 1; r <= Math.min(maxRow, ws.rowCount || maxRow); r += 1) {
    const found = {};
    for (let c = 1; c <= maxCol; c += 1) {
      const t = text(ws, r, c).toUpperCase();
      if (!t) continue;
      const idx = wanted.indexOf(t);
      if (idx >= 0 && found[wanted[idx]] === undefined) found[wanted[idx]] = c;
    }
    if (wanted.every((w) => found[w] !== undefined)) {
      return { row: r, cols: found };
    }
  }
  return null;
}

/**
 * Mapa etiqueta -> columna de una fila de encabezado (todas las etiquetas).
 */
export function headerMap(ws, headerRow, maxCol) {
  const map = new Map();
  const limit = maxCol || ws.columnCount || 200;
  for (let c = 1; c <= limit; c += 1) {
    const t = text(ws, headerRow, c);
    if (!t) continue;
    const k = t.toUpperCase().replace(/\s+/g, ' ');
    if (!map.has(k)) map.set(k, c);
  }
  return map;
}

/** Localiza una columna por coincidencia flexible sobre una fila de encabezado. */
export function findColumn(ws, headerRow, matcher, { maxCol } = {}) {
  const limit = maxCol || ws.columnCount || 200;
  for (let c = 1; c <= limit; c += 1) {
    const t = text(ws, headerRow, c);
    if (!t) continue;
    if (matcher(t.toUpperCase(), c)) return c;
  }
  return null;
}

/**
 * Fila que contiene las fechas de los dias. Se elige la fila (dentro de las
 * primeras filas del encabezado) con mayor cantidad de celdas Date.
 */
export function findDateRow(ws, { maxRow = 8, maxCol } = {}) {
  const limit = maxCol || ws.columnCount || 300;
  let best = { row: null, hits: 0 };
  for (let r = 1; r <= maxRow; r += 1) {
    let hits = 0;
    for (let c = 1; c <= limit; c += 1) {
      if (isValidDate(at(ws, r, c))) hits += 1;
    }
    if (hits > best.hits) best = { row: r, hits };
  }
  return best.hits >= 7 ? best.row : null;
}

/**
 * Rachas consecutivas de columnas con fecha en `dateRow`.
 * @returns {Array<{start:number,end:number,dates:Date[]}>}
 */
export function findDateBlocks(ws, dateRow, { maxCol, minLength = 7 } = {}) {
  const limit = maxCol || ws.columnCount || 300;
  const blocks = [];
  let current = null;
  for (let c = 1; c <= limit + 1; c += 1) {
    const v = c <= limit ? at(ws, dateRow, c) : null;
    if (isValidDate(v)) {
      if (!current) current = { start: c, end: c, dates: [] };
      current.end = c;
      current.dates.push(v);
    } else if (current) {
      if (current.dates.length >= minLength) blocks.push(current);
      current = null;
    }
  }
  return blocks;
}

/**
 * Convierte un bloque de fechas en un mapa columna -> 'YYYY-MM-DD', quedandose
 * solo con los dias del periodo objetivo (año/mes). Las hojas incluyen los
 * primeros dias del mes siguiente como colchon; se descartan.
 */
export function blockDayColumns(block, year, month) {
  const cols = [];
  for (let i = 0; i < block.dates.length; i += 1) {
    const d = block.dates[i];
    if (d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month) {
      cols.push({ col: block.start + i, day: d.getUTCDate() });
    }
  }
  return cols;
}

/** Ultima fila con contenido en una columna dada. */
export function lastRowWithValue(ws, col, fromRow) {
  let last = fromRow - 1;
  const limit = ws.rowCount || fromRow;
  for (let r = fromRow; r <= limit; r += 1) {
    const v = at(ws, r, col);
    if (v !== null && v !== undefined && String(v).trim() !== '') last = r;
  }
  return last;
}

export { at as rawAt, text as textAt, isValidDate };
