/**
 * Parser del libro "R123_DailySO_Models_*.xlsx".
 *
 * Convierte el archivo mensual en un dataset normalizado listo para persistir:
 *   - promotores (Field Force) con su jerarquia, targets y series diarias
 *   - supervisores (SP) y city managers (CM) con sus series diarias
 *   - mezcla de modelos por promotor y por canal
 *   - variantes (carrier / color) de los modelos foco
 *
 * El parser nunca asume posiciones fijas de columnas: usa `layout.js` para
 * descubrir encabezados y bloques de dias, de modo que el mismo codigo sirva
 * para cualquier mes.
 */
import { loadWorkbook } from './workbook.js';
import { count, key, num, str } from '../utils/cell.js';
import {
  blockDayColumns,
  findColumn,
  findDateBlocks,
  findDateRow,
  findHeaderRow,
  lastRowWithValue,
  textAt,
} from './layout.js';

const SHEET_PATTERNS = {
  supervisors: /BY[_ ]?SUPERVISORS/i,
  dailyTarget: /DAILY[_ ]?RETAIL[_ ]?FF[_ ]?SO[_ ]?TARGET/i,
  dailyAllSeries: /DAILY[_ ]?SORETAIL[_ ]?FF.*ALL[_ ]?SERIES/i,
  monthlyModels: /MONTHLY[_ ]?SO[_ ]?FOCUS[_ ]?MODELS/i,
  dailyIot: /DAILY[_ ]?RETAIL[_ ]?FF[_ ]?SO[_ ]?IOT/i,
  soModel: /^SO[_ ]?MODEL$/i,
};

const MODEL_SHEET = /^DAILY[_ ]?SO[_ ]?(.+?)[_ ]?MODEL$/i;

/** Etiqueta legible para cada hoja Daily_SO_<X>_Model. */
const MODEL_SHEET_LABELS = {
  H600E: 'HONOR 600e',
  H600: 'HONOR 600',
  M8L: 'HONOR Magic8 Lite',
  WATCH6: 'HONOR Watch 6',
  X5D: 'HONOR X5d',
};

const REGION_RE = /^R\s?([0-9]{1,2})$/i;
const NO_REGION = 'SIN REGION';

export function normalizeRegion(value) {
  if (value === null || value === undefined) return NO_REGION;
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (!s || s === '0') return NO_REGION;
  const m = REGION_RE.exec(s.replace(/\s+/g, ''));
  if (m) return `R${Number(m[1])}`;
  const alt = /REGION\s*([0-9]{1,2})/i.exec(s);
  if (alt) return `R${Number(alt[1])}`;
  return NO_REGION;
}

export function normalizeChannel(value) {
  if (value === null || value === undefined) return 'SIN CANAL';
  const s = String(value).replace(/\s+/g, ' ').trim().toUpperCase();
  if (!s || s === '0') return 'SIN CANAL';
  if (s.startsWith('AT&T') || s.startsWith('ATT')) return 'AT&T';
  if (s.startsWith('TELCEL')) return 'TELCEL';
  if (s.startsWith('COPPEL')) return 'COPPEL';
  if (s.startsWith('LIVERPOOL') || s === 'LVP') return 'LIVERPOOL';
  if (s.startsWith('SEARS')) return 'SEARS';
  if (s.startsWith('MOVISTAR')) return 'MOVISTAR';
  return s;
}

function normalizeStatus(value) {
  if (!value) return 'BASE';
  const s = String(value).trim().toUpperCase();
  if (s.startsWith('SUP')) return 'SUPPORT';
  if (s.startsWith('OFF')) return 'OFFLINE';
  if (s.startsWith('BASE')) return 'BASE';
  return s;
}

/** Nombre "vacio" usado por el libro para plazas sin titular. */
function isBlankName(name) {
  if (!name) return true;
  const s = name.trim().toUpperCase();
  return s === '' || s === '0' || s === '-' || s === 'N/A' || s === '#REF!';
}

function resolveSheet(wb, pattern) {
  return wb.worksheets.find((ws) => pattern.test(ws.name)) || null;
}

/** Deduce año/mes del periodo a partir de la primera fecha del primer bloque. */
function detectPeriod(ws) {
  const dateRow = findDateRow(ws, { maxRow: 8, maxCol: Math.min(ws.columnCount || 200, 200) });
  if (!dateRow) return null;
  const blocks = findDateBlocks(ws, dateRow, { maxCol: Math.min(ws.columnCount || 200, 200) });
  if (!blocks.length) return null;
  const first = blocks[0].dates[0];
  return { year: first.getUTCFullYear(), month: first.getUTCMonth() + 1, dateRow, blocks };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Lee los bloques de dias de una hoja "diaria" de promotores.
 * @returns {{dateRow:number, blocks:Array, dayCols:Array<Array<{col:number,day:number}>>}}
 */
function dayLayout(ws, year, month, maxCol) {
  const dateRow = findDateRow(ws, { maxRow: 8, maxCol });
  if (!dateRow) return null;
  const blocks = findDateBlocks(ws, dateRow, { maxCol });
  const dayCols = blocks.map((b) => blockDayColumns(b, year, month));
  return { dateRow, blocks, dayCols };
}

function emptySeries(n) {
  return new Array(n).fill(0);
}

function readSeries(row, cols, days) {
  const out = emptySeries(days);
  if (!cols) return out;
  for (const { col, day } of cols) {
    if (day >= 1 && day <= days) out[day - 1] = count(row, col);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Hoja 1: Daily_Retail_FF_SO_Target  (base maestra de promotores)    */
/* ------------------------------------------------------------------ */

function parsePromoterSheet(ws, period, opts = {}) {
  const maxCol = Math.min(ws.columnCount || 200, 260);
  const header = findHeaderRow(ws, ['CHANNEL', 'REGION', 'STORE NAME', 'SALES ADVISOR'], { maxCol: 60 });
  if (!header) return null;
  const headerRow = header.row;
  const layout = dayLayout(ws, period.year, period.month, maxCol);
  if (!layout) return null;

  const cols = {
    channel: header.cols.CHANNEL,
    region: header.cols.REGION,
    store: header.cols['STORE NAME'],
    advisor: header.cols['SALES ADVISOR'],
    supervisor: findColumn(ws, headerRow, (t) => t.startsWith('SUPERVISOR'), { maxCol: 60 }),
    cm: findColumn(ws, headerRow, (t) => t === 'CM', { maxCol: 60 }),
    status: findColumn(ws, headerRow, (t) => t.includes('BASE/SUPPORT'), { maxCol: 60 }),
    doubleAdvisor: findColumn(ws, headerRow, (t) => t.includes('DOUBLE ADVISOR'), { maxCol: 60 }),
    targetHQ: findColumn(ws, headerRow, (t) => t.startsWith('TARGET HQ'), { maxCol }),
    soTargetModels: findColumn(ws, headerRow, (t) => t.startsWith('SO (TGT'), { maxCol }),
    soAllModels: findColumn(ws, headerRow, (t) => t.includes('TTL SO ALL'), { maxCol }),
    achHQ: findColumn(ws, headerRow, (t) => t.startsWith('ACH% HQ'), { maxCol }),
    forecast: findColumn(ws, headerRow, (t) => t === 'FORECAST', { maxCol }),
    ...opts.extraCols,
  };

  // Targets mensuales: la ultima columna "*TARGET*" antes de la primera de dias
  // es el target ajustado vigente del mes en curso.
  const firstDayCol = layout.blocks[0]?.start ?? maxCol;
  const targetCols = [];
  for (let c = 1; c < firstDayCol; c += 1) {
    const t = textAt(ws, headerRow, c).toUpperCase();
    if (t.includes('TARGET') && !t.includes('HQ')) targetCols.push({ col: c, label: textAt(ws, headerRow, c) });
  }
  const adjusted = targetCols.filter((t) => /AJUST|ADJUST/i.test(t.label));
  const initial = targetCols.filter((t) => /INICIAL|INITIAL/i.test(t.label));
  cols.targetAdjusted = adjusted.length ? adjusted[adjusted.length - 1].col : null;
  cols.targetInitial = initial.length ? initial[initial.length - 1].col : null;

  const days = period.daysInMonth;
  const lastRow = lastRowWithValue(ws, cols.advisor, headerRow + 1);
  const rows = [];
  const seen = new Map();

  for (let r = headerRow + 1; r <= lastRow; r += 1) {
    const row = ws.getRow(r);
    const advisor = str(row, cols.advisor);
    const store = str(row, cols.store);
    if (isBlankName(advisor) && isBlankName(store)) continue;
    if (isBlankName(advisor)) continue;

    const channel = normalizeChannel(str(row, cols.channel));
    const storeName = store || 'SIN TIENDA';
    // Un asesor puede aparecer en dos tiendas (cobertura doble): la clave
    // unica es tienda + asesor.
    const id = `${key(storeName)}||${key(advisor)}`;

    const record = {
      id,
      rowIndex: r,
      advisor,
      advisorKey: key(advisor),
      channel,
      region: normalizeRegion(str(row, cols.region)),
      store: storeName,
      storeKey: key(storeName),
      supervisor: isBlankName(str(row, cols.supervisor)) ? null : str(row, cols.supervisor),
      cm: isBlankName(str(row, cols.cm)) ? null : str(row, cols.cm),
      status: normalizeStatus(str(row, cols.status)),
      doubleAdvisor: cols.doubleAdvisor ? str(row, cols.doubleAdvisor) : null,
      targetInitial: cols.targetInitial ? num(row, cols.targetInitial) : null,
      targetAdjusted: cols.targetAdjusted ? num(row, cols.targetAdjusted) : null,
      targetHQ: cols.targetHQ ? num(row, cols.targetHQ) : null,
      soTargetModels: cols.soTargetModels ? num(row, cols.soTargetModels) : null,
      soAllModels: cols.soAllModels ? num(row, cols.soAllModels) : null,
      achHQXls: cols.achHQ ? num(row, cols.achHQ) : null,
      forecastXls: cols.forecast ? num(row, cols.forecast) : null,
      daily: {
        soTarget: readSeries(row, layout.dayCols[0], days),
        attendance: readSeries(row, layout.dayCols[1], days),
        zeroSale: readSeries(row, layout.dayCols[2], days),
      },
    };

    if (seen.has(id)) {
      // Fila duplicada exacta: se conserva la de mayor sell-out.
      const prev = seen.get(id);
      const prevSum = prev.daily.soTarget.reduce((a, b) => a + b, 0);
      const curSum = record.daily.soTarget.reduce((a, b) => a + b, 0);
      if (curSum > prevSum) Object.assign(prev, record);
      continue;
    }
    seen.set(id, record);
    rows.push(record);
  }

  return { rows, cols, headerRow, layout };
}

/* ------------------------------------------------------------------ */
/*  Hojas diarias secundarias (All Series / IOT / por modelo)          */
/* ------------------------------------------------------------------ */

/**
 * Lee una hoja diaria auxiliar y devuelve Map(id -> serie diaria) usando el
 * primer bloque de dias. Se usa para "All Series", "IOT" y las hojas por modelo.
 */
function parseDailyAuxSheet(ws, period) {
  const maxCol = Math.min(ws.columnCount || 200, 260);
  const header = findHeaderRow(ws, ['CHANNEL', 'STORE NAME', 'SALES ADVISOR'], { maxCol: 60 });
  if (!header) return null;
  const layout = dayLayout(ws, period.year, period.month, maxCol);
  if (!layout || !layout.dayCols[0]?.length) return null;

  const days = period.daysInMonth;
  const advisorCol = header.cols['SALES ADVISOR'];
  const storeCol = header.cols['STORE NAME'];
  const lastRow = lastRowWithValue(ws, advisorCol, header.row + 1);
  const byId = new Map();

  for (let r = header.row + 1; r <= lastRow; r += 1) {
    const row = ws.getRow(r);
    const advisor = str(row, advisorCol);
    if (isBlankName(advisor)) continue;
    const store = str(row, storeCol) || 'SIN TIENDA';
    const id = `${key(store)}||${key(advisor)}`;
    const series = readSeries(row, layout.dayCols[0], days);
    if (byId.has(id)) {
      const prev = byId.get(id);
      for (let i = 0; i < days; i += 1) prev[i] += series[i];
    } else {
      byId.set(id, series);
    }
  }
  return { byId, header, layout };
}

/* ------------------------------------------------------------------ */
/*  Hoja 3: Monthly_SO_FOCUS_Models (mezcla de modelos por promotor)   */
/* ------------------------------------------------------------------ */

function parseMonthlyModels(ws) {
  const maxCol = Math.min(ws.columnCount || 60, 60);
  const header = findHeaderRow(ws, ['CHANNEL', 'STORE NAME', 'SALES ADVISOR'], { maxCol });
  if (!header) return null;
  const headerRow = header.row;
  const advisorCol = header.cols['SALES ADVISOR'];
  const storeCol = header.cols['STORE NAME'];

  // Columnas de modelo: todas las que empiezan con HONOR, mas IOT.
  const modelCols = [];
  for (let c = 1; c <= maxCol; c += 1) {
    const t = textAt(ws, headerRow, c);
    if (!t) continue;
    const up = t.toUpperCase();
    if (up.startsWith('HONOR') || up === 'IOT') modelCols.push({ col: c, model: t });
  }
  const totalAllCol = findColumn(ws, headerRow, (t) => t.includes('TTL SO ALL'), { maxCol });
  const totalTargetCol = findColumn(ws, headerRow, (t) => t.startsWith('SO (TGT'), { maxCol });

  const lastRow = lastRowWithValue(ws, advisorCol, headerRow + 1);
  const byId = new Map();
  for (let r = headerRow + 1; r <= lastRow; r += 1) {
    const row = ws.getRow(r);
    const advisor = str(row, advisorCol);
    if (isBlankName(advisor)) continue;
    const store = str(row, storeCol) || 'SIN TIENDA';
    const id = `${key(store)}||${key(advisor)}`;
    const models = {};
    for (const { col, model } of modelCols) models[model] = count(row, col);
    const entry = {
      models,
      soAllModels: totalAllCol ? num(row, totalAllCol) : null,
      soTargetModels: totalTargetCol ? num(row, totalTargetCol) : null,
    };
    if (byId.has(id)) {
      const prev = byId.get(id);
      for (const [m, v] of Object.entries(models)) prev.models[m] = (prev.models[m] || 0) + v;
      prev.soAllModels = (prev.soAllModels || 0) + (entry.soAllModels || 0);
      prev.soTargetModels = (prev.soTargetModels || 0) + (entry.soTargetModels || 0);
    } else {
      byId.set(id, entry);
    }
  }
  return { byId, models: modelCols.map((m) => m.model) };
}

/* ------------------------------------------------------------------ */
/*  Hoja 00: BY_Supervisors&CM                                         */
/* ------------------------------------------------------------------ */

/**
 * La hoja apila un bloque por region (R1, R2, R3...). Cada bloque tiene filas
 * SP (supervisores) y filas CM (city managers, subtotal de sus SP) y termina
 * con "<Region> TOTAL". Se recorre fila a fila manteniendo el contexto.
 */
function parseSupervisorSheet(ws, period) {
  const maxCol = Math.min(ws.columnCount || 200, 220);
  const dateRow = findDateRow(ws, { maxRow: 8, maxCol });
  if (!dateRow) return null;
  const blocks = findDateBlocks(ws, dateRow, { maxCol });
  const dayCols = blocks.map((b) => blockDayColumns(b, period.year, period.month));
  const days = period.daysInMonth;

  // La fila de encabezado de cada bloque contiene "Position" / "NAME".
  let posCol = null;
  let nameCol = null;
  let ffCol = null;
  let headerRows = [];
  const limitRow = ws.rowCount || 80;
  for (let r = 1; r <= limitRow; r += 1) {
    const a = textAt(ws, r, 1).toUpperCase();
    const b = textAt(ws, r, 2).toUpperCase();
    if (a === 'POSITION' && b === 'NAME') {
      headerRows.push(r);
      if (posCol === null) {
        posCol = 1;
        nameCol = 2;
        ffCol = findColumn(ws, r, (t) => t.includes('FFS IN CHARGE'), { maxCol: 12 }) || 3;
      }
    }
  }
  if (!headerRows.length) return null;

  const metricRow = headerRows[0];
  const metrics = {
    targetHQ: findColumn(ws, metricRow, (t) => t.startsWith('TARGET HQ'), { maxCol }),
    achievement: findColumn(ws, metricRow, (t) => t === 'ACHIVEMENT' || t === 'ACHIEVEMENT', { maxCol }),
    achHQ: findColumn(ws, metricRow, (t) => t.startsWith('ACH% HQ'), { maxCol }),
    timeProgress: findColumn(ws, metricRow, (t) => t.startsWith('TIME PROGRESS'), { maxCol }),
    forecast: findColumn(ws, metricRow, (t) => t === 'FORECAST', { maxCol }),
    ranking: findColumn(ws, metricRow, (t) => t === 'RANKING', { maxCol }),
  };
  // Modelos foco por supervisor viven en la fila superior (fila 4 del libro).
  const modelHeaderRow = metricRow - 1;
  const modelCols = [];
  for (let c = 1; c <= maxCol; c += 1) {
    const t = textAt(ws, modelHeaderRow, c);
    if (t && /^HONOR /i.test(t)) modelCols.push({ col: c, model: t.trim() });
  }
  const totalAllCol = findColumn(ws, modelHeaderRow, (t) => t.includes('TTL SO ALL'), { maxCol });

  const people = [];
  const regionTotals = [];
  let currentRegion = NO_REGION;
  let currentCmGroup = [];

  for (let r = 1; r <= limitRow; r += 1) {
    const a = textAt(ws, r, 1);
    const b = textAt(ws, r, 2);
    const aUp = a.toUpperCase();
    const bUp = b.toUpperCase();

    // Etiqueta de region: celda B con "R1"/"R2"/... sola.
    if (!a && REGION_RE.test(bUp.replace(/\s+/g, ''))) {
      currentRegion = normalizeRegion(bUp);
      currentCmGroup = [];
      continue;
    }
    const totalMatch = /^(R\s?[0-9]{1,2})\s+TOTAL$/i.exec(aUp) || /^(R\s?[0-9]{1,2})\s+TOTAL$/i.exec(bUp);
    if (totalMatch) {
      const row = ws.getRow(r);
      regionTotals.push({
        region: normalizeRegion(totalMatch[1]),
        ffsInCharge: num(row, ffCol),
        daily: readSeries(row, dayCols[0], days),
        targetHQ: metrics.targetHQ ? num(row, metrics.targetHQ) : null,
        soAllModels: totalAllCol ? num(row, totalAllCol) : null,
      });
      continue;
    }
    if (aUp !== 'SP' && aUp !== 'CM') continue;

    const row = ws.getRow(r);
    const name = str(row, nameCol);
    if (isBlankName(name)) continue;

    const models = {};
    for (const { col, model } of modelCols) models[model] = count(row, col);

    const person = {
      position: aUp,
      region: currentRegion,
      name,
      nameKey: key(name),
      ffsInCharge: num(row, ffCol) ?? 0,
      targetHQ: metrics.targetHQ ? num(row, metrics.targetHQ) : null,
      achievement: metrics.achievement ? num(row, metrics.achievement) : null,
      achHQXls: metrics.achHQ ? num(row, metrics.achHQ) : null,
      forecastXls: metrics.forecast ? num(row, metrics.forecast) : null,
      rankingXls: metrics.ranking ? str(row, metrics.ranking) : null,
      soAllModels: totalAllCol ? num(row, totalAllCol) : null,
      models,
      daily: {
        so: readSeries(row, dayCols[0], days),
        attendance: readSeries(row, dayCols[1], days),
        zeroSaleFF: readSeries(row, dayCols[2], days),
      },
      cm: null,
    };

    if (aUp === 'SP') {
      currentCmGroup.push(person);
    } else {
      // Fila CM: cierra el grupo de SPs inmediatamente anteriores.
      for (const sp of currentCmGroup) sp.cm = name;
      currentCmGroup = [];
    }
    people.push(person);
  }

  return { people, regionTotals };
}

/* ------------------------------------------------------------------ */
/*  Hoja SO_Model: SO de productos clave por canal y modelo            */
/* ------------------------------------------------------------------ */

function parseSoModelSheet(ws, period) {
  const maxCol = Math.min(ws.columnCount || 120, 120);
  const dateRow = findDateRow(ws, { maxRow: 4, maxCol });
  const blocks = dateRow ? findDateBlocks(ws, dateRow, { maxCol }) : [];
  const dayCols = blocks.length ? blockDayColumns(blocks[0], period.year, period.month) : [];
  const days = period.daysInMonth;

  const rows = [];
  const limitRow = ws.rowCount || 200;
  let cols = null;
  for (let r = 1; r <= limitRow; r += 1) {
    const a = textAt(ws, r, 1).toUpperCase();
    const b = textAt(ws, r, 2).toUpperCase();
    if (a === 'CHANNEL' && b === 'MODEL') {
      cols = {
        channel: 1,
        model: 2,
        stores: findColumn(ws, r, (t) => t.startsWith('STORE'), { maxCol: 8 }) || 3,
        so: findColumn(ws, r, (t) => t === 'SO', { maxCol: 8 }) || 4,
        prod: findColumn(ws, r, (t) => t === 'PROD', { maxCol: 8 }) || 5,
      };
      continue;
    }
    if (!cols) continue;
    const row = ws.getRow(r);
    const model = str(row, cols.model);
    if (!model || model.toUpperCase() === 'TOTAL') continue;
    if (!/^HONOR/i.test(model)) continue;
    const channel = normalizeChannel(str(row, cols.channel) || 'ALL');
    rows.push({
      channel: channel === 'ALL' ? 'TODOS' : channel,
      model: model.trim(),
      stores: num(row, cols.stores),
      so: num(row, cols.so) ?? 0,
      productivity: num(row, cols.prod),
      daily: readSeries(row, dayCols, days),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/*  Hojas X8D / M8L: variantes (carrier y color) de un modelo           */
/* ------------------------------------------------------------------ */

/**
 * Las hojas de variantes vienen del sistema de retail en chino. Se traducen
 * las etiquetas conocidas y, si aparece un color nuevo, se compone a partir de
 * los caracteres base para no perder el dato.
 */
const CARRIER_LABELS = {
  'AT&T版': 'Version AT&T',
  Telcel版: 'Version Telcel',
  公开渠道版: 'Version abierta',
  Movistar版: 'Version Movistar',
};

const COLOR_CHARS = [
  ['红棕', 'Marron rojizo'],
  ['天蓝', 'Azul cielo'],
  ['星空', 'Azul noche'],
  ['黑', 'Negro'],
  ['白', 'Blanco'],
  ['蓝', 'Azul'],
  ['灰', 'Gris'],
  ['绿', 'Verde'],
  ['金', 'Dorado'],
  ['银', 'Plata'],
  ['紫', 'Morado'],
  ['粉', 'Rosa'],
  ['红', 'Rojo'],
  ['橙', 'Naranja'],
  ['黄', 'Amarillo'],
  ['青', 'Cian'],
  ['棕', 'Cafe'],
];

/** Traduce la etiqueta de una variante; si no se reconoce, se deja tal cual. */
function variantLabel(raw, dimension) {
  const value = String(raw).trim();
  if (dimension === 'carrier') return CARRIER_LABELS[value] || value;
  for (const [token, label] of COLOR_CHARS) {
    if (value.includes(token)) return label;
  }
  return value;
}

function parseVariantSheet(ws, period, sheetLabel) {
  const maxCol = Math.min(ws.columnCount || 120, 120);
  const dateRow = findDateRow(ws, { maxRow: 4, maxCol });
  const blocks = dateRow ? findDateBlocks(ws, dateRow, { maxCol }) : [];
  const dayCols = blocks.length ? blockDayColumns(blocks[0], period.year, period.month) : [];
  const days = period.daysInMonth;

  const out = [];
  const limitRow = Math.min(ws.rowCount || 200, 400);
  let dimension = null;
  for (let r = 1; r <= limitRow; r += 1) {
    const a = textAt(ws, r, 1).toUpperCase();
    const b = textAt(ws, r, 2).toUpperCase();
    if (a === 'CHANNEL' && (b === 'CARRIER' || b === 'COLOR')) {
      dimension = b === 'CARRIER' ? 'carrier' : 'color';
      continue;
    }
    if (!dimension) continue;
    const row = ws.getRow(r);
    const label = str(row, 2);
    if (!label) continue;
    if (label.toUpperCase() === 'TOTAL') continue;
    const channelRaw = str(row, 1);
    if (!channelRaw) continue;
    out.push({
      sheet: sheetLabel,
      model: str(row, 4) || sheetLabel,
      dimension,
      channel: channelRaw.toUpperCase() === 'ALL' ? 'TODOS' : normalizeChannel(channelRaw),
      variant: variantLabel(label, dimension),
      so: num(row, 3) ?? 0,
      daily: readSeries(row, dayCols, days),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Corte del reporte (ultimo dia con informacion)                     */
/* ------------------------------------------------------------------ */

/**
 * El "dia de corte" es el ultimo dia del mes con actividad registrada
 * (sell-out o asistencia). Es la referencia para avance y proyeccion.
 */
function detectCutoffDay(promoters, days) {
  let cutoff = 0;
  for (let d = 0; d < days; d += 1) {
    let so = 0;
    let att = 0;
    for (const p of promoters) {
      so += p.daily.soTarget[d] || 0;
      so += p.daily.soAll?.[d] || 0;
      att += p.daily.attendance[d] || 0;
    }
    if (so > 0 || att > 0) cutoff = d + 1;
  }
  return cutoff;
}

/* ------------------------------------------------------------------ */
/*  Entrada principal                                                  */
/* ------------------------------------------------------------------ */

export async function parseWorkbookFile(filePath, { sourceName } = {}) {
  const wb = await loadWorkbook(filePath);
  return parseWorkbook(wb, { sourceName: sourceName || filePath.split('/').pop() });
}

export function parseWorkbook(wb, { sourceName } = {}) {
  const warnings = [];
  const sheets = {};
  for (const [name, pattern] of Object.entries(SHEET_PATTERNS)) {
    sheets[name] = resolveSheet(wb, pattern);
    if (!sheets[name]) warnings.push(`No se encontro la hoja para "${name}".`);
  }
  if (!sheets.dailyTarget) {
    throw new Error(
      'El archivo no contiene la hoja "1.Daily_Retail_FF_SO_Target". Verifica que sea el reporte diario correcto.'
    );
  }

  const detected = detectPeriod(sheets.dailyTarget);
  if (!detected) throw new Error('No se pudieron detectar las fechas del periodo en la hoja de sell-out diario.');
  const period = {
    year: detected.year,
    month: detected.month,
    daysInMonth: daysInMonth(detected.year, detected.month),
  };

  const main = parsePromoterSheet(sheets.dailyTarget, period);
  if (!main || !main.rows.length) throw new Error('No se encontraron promotores en la hoja de sell-out diario.');
  const promoters = main.rows;
  const byId = new Map(promoters.map((p) => [p.id, p]));

  // --- Serie diaria "todas las series" -------------------------------------
  if (sheets.dailyAllSeries) {
    const aux = parseDailyAuxSheet(sheets.dailyAllSeries, period);
    if (aux) {
      for (const p of promoters) p.daily.soAll = aux.byId.get(p.id) || emptySeries(period.daysInMonth);
      // Promotores presentes solo en esta hoja: se agregan con lo que se sabe.
      for (const [id, series] of aux.byId) {
        if (byId.has(id)) continue;
        warnings.push(`Promotor presente en "All Series" pero no en la hoja base: ${id}`);
      }
    } else {
      warnings.push('No se pudo leer la hoja de sell-out "All Series".');
    }
  }
  for (const p of promoters) {
    if (!p.daily.soAll) p.daily.soAll = emptySeries(period.daysInMonth);
  }

  // --- Serie diaria IOT ----------------------------------------------------
  if (sheets.dailyIot) {
    const aux = parseDailyAuxSheet(sheets.dailyIot, period);
    if (aux) for (const p of promoters) p.daily.iot = aux.byId.get(p.id) || emptySeries(period.daysInMonth);
    else warnings.push('No se pudo leer la hoja de sell-out IOT.');
  }
  for (const p of promoters) {
    if (!p.daily.iot) p.daily.iot = emptySeries(period.daysInMonth);
  }

  // --- Mezcla mensual de modelos por promotor ------------------------------
  let modelNames = [];
  if (sheets.monthlyModels) {
    const mm = parseMonthlyModels(sheets.monthlyModels);
    if (mm) {
      modelNames = mm.models;
      for (const p of promoters) {
        const entry = mm.byId.get(p.id);
        p.models = entry ? entry.models : {};
        if (p.soAllModels === null && entry) p.soAllModels = entry.soAllModels;
      }
    } else {
      warnings.push('No se pudo leer la hoja mensual de modelos foco.');
    }
  }
  for (const p of promoters) if (!p.models) p.models = {};

  // --- Series diarias por modelo foco --------------------------------------
  const modelDailySheets = wb.worksheets.filter((ws) => MODEL_SHEET.test(ws.name));
  const modelDaily = [];
  for (const ws of modelDailySheets) {
    const m = MODEL_SHEET.exec(ws.name);
    const rawKey = (m?.[1] || ws.name).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const label = MODEL_SHEET_LABELS[rawKey] || m?.[1] || ws.name;
    const aux = parseDailyAuxSheet(ws, period);
    if (!aux) {
      warnings.push(`No se pudo leer la hoja diaria de modelo "${ws.name}".`);
      continue;
    }
    modelDaily.push({ model: label, sheet: ws.name, byId: aux.byId });
  }

  // --- Supervisores y CM ---------------------------------------------------
  let supervisors = [];
  let regionTotals = [];
  if (sheets.supervisors) {
    const sp = parseSupervisorSheet(sheets.supervisors, period);
    if (sp) {
      supervisors = sp.people;
      regionTotals = sp.regionTotals;
    } else {
      warnings.push('No se pudo leer la hoja de supervisores y CM.');
    }
  }

  // --- Productos clave por canal ------------------------------------------
  const soModel = sheets.soModel ? parseSoModelSheet(sheets.soModel, period) : [];

  // --- Variantes de modelo (carrier / color) -------------------------------
  const variantSheets = wb.worksheets.filter((ws) => /^(X8D|M8L|X7D|X6C|X5D)$/i.test(ws.name));
  const variants = [];
  for (const ws of variantSheets) variants.push(...parseVariantSheet(ws, period, ws.name.toUpperCase()));

  const cutoffDay = detectCutoffDay(promoters, period.daysInMonth) || period.daysInMonth;

  return {
    meta: {
      sourceName: sourceName || null,
      periodYear: period.year,
      periodMonth: period.month,
      periodKey: `${period.year}-${String(period.month).padStart(2, '0')}`,
      daysInMonth: period.daysInMonth,
      cutoffDay,
      cutoffDate: `${period.year}-${String(period.month).padStart(2, '0')}-${String(cutoffDay).padStart(2, '0')}`,
      sheetNames: wb.sheetNames || wb.worksheets.map((ws) => ws.name),
      modelNames,
      warnings,
      parsedAt: new Date().toISOString(),
    },
    promoters,
    supervisors,
    regionTotals,
    soModel,
    variants,
    modelDaily,
  };
}

export const __testing = {
  parsePromoterSheet,
  parseSupervisorSheet,
  parseSoModelSheet,
  detectCutoffDay,
  daysInMonth,
};
