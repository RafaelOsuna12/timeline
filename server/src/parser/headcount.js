/**
 * Lectura del archivo de plantilla (HC_R123).
 *
 * El libro trae once hojas, pero solo tres son fuente de datos: `FF`, que es
 * una matriz tienda x rol, `INGRESO` con las fechas de alta de los promotores
 * y `MM` con los mandos medios. El resto son tablas dinamicas que el propio
 * Excel recalcula.
 *
 * Como el de ventas, este parser no usa posiciones fijas de columna: localiza
 * la fila de encabezado por sus etiquetas ancla y los bloques de rol por la
 * columna "Tipo de piso" con la que todos empiezan. Asi el archivo puede
 * crecer en roles o moverse de columnas sin romper la lectura.
 *
 * El formato nativo es `.xlsb` (binario), que ExcelJS no abre; se lee con
 * SheetJS, que tambien acepta `.xlsx` por si algun dia cambian de formato.
 */
import fs from 'node:fs';
import * as XLSX from 'xlsx';

/* ------------------------------ utilidades ------------------------------ */

/** Las celdas vacias del libro vienen como 0, como "-" o como error. */
export function clean(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value === 0 ? null : String(value);
  if (value instanceof Date) return value;
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (!s || s === '0' || s === '-' || s === '#N/A' || s === '#VALUE!' || s === '#REF!') return null;
  return s;
}

/**
 * Etiqueta que funciona como codigo (region, canal, estado, ciudad).
 * El archivo escribe "Sonora" y "SONORA" en filas distintas, que al filtrar
 * saldrian como dos estados; se normaliza a mayusculas para que sea uno.
 */
export function code(value) {
  const v = text(value);
  return v === null ? null : v.toUpperCase();
}

export function text(value) {
  const v = clean(value);
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/** Clave estable de persona o tienda: sin acentos, sin dobles espacios. */
export function nameKey(value) {
  if (!value) return null;
  return String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase() || null;
}

const VACANCY_RE = /^(VACANCY|VACANTE|SIN\s+ASIGNAR|POR\s+ASIGNAR)/i;
export function isVacancy(value) {
  const v = text(value);
  return Boolean(v && VACANCY_RE.test(v));
}

/** Fecha de Excel o JS a `AAAA-MM-DD`; cualquier otra cosa es null. */
export function toIsoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate())).toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000).toISOString().slice(0, 10);
  }
  return null;
}

const upper = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toUpperCase();

/* --------------------------------- roles --------------------------------- */

/**
 * Roles conocidos. La clave sale de la etiqueta de grupo del archivo; el
 * orden es el de la jerarquia, para presentarlos siempre igual.
 */
export const ROLES = [
  { key: 'FIXED_PROMOTER', match: /^FIXED PROMOTER/i, label: 'Promotor fijo', group: 'campo' },
  { key: 'DOUBLE_PROMOTER', match: /^DOUBLE PROMOTER/i, label: 'Promotor doble', group: 'campo' },
  { key: 'LOBO_PROMOTER', match: /^LOBO PROMOTER/i, label: 'Promotor lobo', group: 'campo' },
  { key: 'TEMPORAL_PROMOTER', match: /^TEMPORAL PROMOTER|^TEMP PROMOTER/i, label: 'Promotor temporal', group: 'campo' },
  { key: 'ATT_PRM_PROMOTER', match: /^ATT PRM/i, label: 'Promotor ATT PRM', group: 'campo' },
  { key: 'MERCHANDISER', match: /^MERCHANDISER/i, label: 'Merchandiser', group: 'campo' },
  { key: 'SUPERVISOR_MIX', match: /^SUPERVISOR MIX/i, label: 'Supervisor mix', group: 'mando' },
  { key: 'SUPERVISOR', match: /^SUPERVISOR$/i, label: 'Supervisor', group: 'mando' },
  { key: 'CITY_MANAGER', match: /^CITY MANAGER/i, label: 'City manager', group: 'mando' },
  { key: 'TRAINER', match: /^TRAINER/i, label: 'Trainer', group: 'mando' },
  { key: 'FIELD_REP', match: /^FIELD REP/i, label: 'Field rep', group: 'mando' },
];

const ROLE_ORDER = new Map(ROLES.map((r, i) => [r.key, i]));
export const roleLabel = (key) => ROLES.find((r) => r.key === key)?.label || key;
export const roleRank = (key) => ROLE_ORDER.get(key) ?? 99;

function roleKeyOf(label) {
  const u = upper(label);
  return ROLES.find((r) => r.match.test(u))?.key || (u ? u.replace(/[^A-Z0-9]+/g, '_') : null);
}

/* ------------------------------- hoja FF -------------------------------- */

const STORE_FIELDS = [
  ['channel', /^CUSTOMER$/i],
  ['region', /^RG$/i],
  ['state', /^ESTADO$/i],
  ['city', /^CIUDAD$/i],
  ['cityCoverage', /^CITY COVERAGE$/i],
  ['locality', /^LOCALITY CLASSIFICATION$/i],
  ['cityClass', /^CITY CLASIFICATION$/i],
  ['listing', /^NEW ADD$/i],
  ['storeId', /^ID$/i],
  ['store', /^NAME$/i],
  ['channelStoreId', /^ID USED +IN CHANNEL$/i],
  ['address', /^DIRECCION$/i],
  ['tier', /^TIER$/i],
  ['coverageTime', /^TIME FOR COVERAGE$/i],
];

// Columnas de un bloque de rol que nunca son el nombre de la persona. Van
// como lista y no como una sola alternancia porque unas se reconocen por el
// encabezado completo y otras solo por como empieza: "Tipo de piso" trae un
// salto de linea y el tipo de plaza pegado detras.
const NOT_A_NAME = [
  /^TIPO DE PISO/i,
  /^STATUS$/i,
  /^ID$/i,
  /^ID AGENCY$/i,
  /^ZONA?$/i,
  /^ZONE$/i,
  /^NO\. RUTA/i,
  /VISIT/i,
  /^CUSTOMER$/i,
  /^RG$/i,
  /^X+$/i,
];
const isNotName = (header) => NOT_A_NAME.some((re) => re.test(header));

/** Fila de encabezado: la que trae juntas las etiquetas ancla de tienda. */
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i += 1) {
    const labels = (rows[i] || []).map(upper);
    const hits = ['CUSTOMER', 'RG', 'NAME', 'ID'].filter((a) => labels.includes(a)).length;
    if (hits >= 4) return i;
  }
  return -1;
}

/**
 * Bloques de rol.
 *
 * Todos empiezan con una columna "Tipo de piso", asi que esa columna marca el
 * inicio y el siguiente inicio marca el final. El nombre del rol viene de la
 * fila de grupo, arrastrada hacia la derecha porque solo se escribe una vez.
 */
function findRoleBlocks(groupRow, headerRow) {
  const starts = [];
  for (let c = 0; c < headerRow.length; c += 1) {
    if (/^TIPO DE PISO/i.test(upper(headerRow[c]))) starts.push(c);
  }
  if (!starts.length) return [];

  const groupAt = (col) => {
    for (let c = col; c >= 0; c -= 1) {
      const g = clean(groupRow[c]);
      if (g) return String(g);
    }
    return null;
  };

  return starts.map((start, i) => {
    const next = starts[i + 1];
    // El ultimo bloque no tiene siguiente: los bloques nunca pasan de seis
    // columnas, y mas alla viven columnas sueltas del libro.
    const end = next !== undefined ? next - 1 : Math.min(start + 5, headerRow.length - 1);
    return { start, end, label: groupAt(start) };
  });
}

/** Dentro del bloque, la columna del nombre es la que de verdad trae nombres. */
function pickNameColumn(block, headerRow, rows, headerIndex) {
  const candidates = [];
  for (let c = block.start; c <= block.end; c += 1) {
    const h = upper(headerRow[c]);
    if (!h || isNotName(h)) continue;
    candidates.push(c);
  }
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  // Varias columnas comparten encabezado con el rol (una trae el nombre y la
  // otra una marca numerica): gana la que tenga mas texto con forma de nombre.
  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    let score = 0;
    for (let r = headerIndex + 1; r < rows.length; r += 1) {
      const v = clean(rows[r]?.[c]);
      if (typeof v === 'string' && /[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}/.test(v) && !/^\d+(\.\d+)?$/.test(v)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  // Un bloque sin una sola fila ocupada no tiene con que desempatar: se queda
  // con el primer candidato por encabezado. El rol existe en la estructura
  // aunque hoy no haya nadie, y asi entra solo el dia que lo llenen.
  return best;
}

function columnIn(block, headerRow, re) {
  for (let c = block.start; c <= block.end; c += 1) {
    if (re.test(upper(headerRow[c]))) return c;
  }
  return null;
}

/**
 * Lee la hoja FF.
 * @returns {{stores:Array, assignments:Array, warnings:string[]}}
 */
export function parseFF(rows) {
  const headerIndex = findHeaderRow(rows);
  if (headerIndex < 0) {
    throw new Error('La hoja FF no tiene la fila de encabezado esperada (Customer, RG, NAME, ID).');
  }
  const headerRow = rows[headerIndex] || [];
  const groupRow = rows[headerIndex - 1] || [];
  const warnings = [];

  const storeCols = {};
  for (const [field, re] of STORE_FIELDS) {
    const col = headerRow.findIndex((h) => re.test(upper(h)));
    if (col >= 0) storeCols[field] = col;
  }
  if (storeCols.storeId === undefined || storeCols.store === undefined) {
    throw new Error('La hoja FF no trae las columnas de identificador y nombre de tienda.');
  }

  const blocks = findRoleBlocks(groupRow, headerRow)
    .map((b) => ({
      ...b,
      role: roleKeyOf(b.label),
      nameCol: pickNameColumn(b, headerRow, rows, headerIndex),
      statusCol: columnIn(b, headerRow, /^STATUS$/i),
      idCol: columnIn(b, headerRow, /^ID$/i),
      agencyCol: columnIn(b, headerRow, /^ID AGENCY$/i),
      floorCol: columnIn(b, headerRow, /^TIPO DE PISO/i),
      zoneCol: columnIn(b, headerRow, /^ZONA?$/i),
      routeCol: columnIn(b, headerRow, /^NO\. RUTA$/i),
    }))
    .filter((b) => {
      if (b.role && b.nameCol !== null && b.nameCol !== undefined) return true;
      warnings.push(`No se pudo interpretar el bloque de rol "${b.label || '(sin etiqueta)'}" en la hoja FF.`);
      return false;
    });

  const stores = [];
  const assignments = [];

  for (let r = headerIndex + 1; r < rows.length; r += 1) {
    const row = rows[r] || [];
    const storeId = text(row[storeCols.storeId]);
    const store = text(row[storeCols.store]);
    if (!storeId && !store) continue;

    const record = { rowIndex: r + 1 };
    for (const [field, col] of Object.entries(storeCols)) record[field] = text(row[col]);
    for (const field of ['channel', 'region', 'state', 'city', 'cityCoverage']) {
      if (record[field]) record[field] = record[field].toUpperCase();
    }
    record.storeKey = nameKey(record.store) || storeId;
    stores.push(record);

    for (const b of blocks) {
      const rawName = text(row[b.nameCol]);
      const status = upper(text(row[b.statusCol])) || null;
      if (!rawName && !status) continue;
      const vacancy = isVacancy(rawName) || status === 'VACANCY';
      assignments.push({
        storeId,
        storeKey: record.storeKey,
        store: record.store,
        channel: record.channel,
        region: record.region,
        state: record.state,
        city: record.city,
        role: b.role,
        name: vacancy ? null : rawName,
        nameKey: vacancy ? null : nameKey(rawName),
        personId: vacancy ? null : (text(row[b.idCol]) || '').toLowerCase() || null,
        agencyId: vacancy ? null : text(row[b.agencyCol]),
        employment: upper(text(row[b.floorCol])) || null,
        zone: text(row[b.zoneCol]),
        route: text(row[b.routeCol]),
        status: vacancy ? 'VACANCY' : status || 'COVERED',
        vacancy,
      });
    }
  }

  return { stores, assignments, blocks, warnings };
}

/* ----------------------------- hoja INGRESO ----------------------------- */

/** Nombre -> fecha de ingreso. Las vacantes se omiten; sin fecha queda null. */
export function parseIngreso(rows) {
  const headerIndex = rows.findIndex((r) => (r || []).some((c) => /PROMOTER NAME|NOMBRE/i.test(upper(c))));
  const start = headerIndex >= 0 ? headerIndex + 1 : 0;
  const header = rows[headerIndex] || [];
  const nameCol = Math.max(0, header.findIndex((c) => /PROMOTER NAME|NOMBRE/i.test(upper(c))));
  const dateCol = header.findIndex((c) => /INGRESO|FECHA/i.test(upper(c)));

  const byName = new Map();
  let withDate = 0;
  let withoutDate = 0;
  let vacancies = 0;

  for (let r = start; r < rows.length; r += 1) {
    const row = rows[r] || [];
    const name = text(row[nameCol]);
    if (!name) continue;
    if (isVacancy(name)) {
      vacancies += 1;
      continue;
    }
    const iso = toIsoDate(dateCol >= 0 ? row[dateCol] : null);
    if (iso) withDate += 1;
    else withoutDate += 1;
    // Si el mismo nombre viniera dos veces, gana la fecha mas antigua.
    const key = nameKey(name);
    const prev = byName.get(key);
    if (!prev || (iso && (!prev.hireDate || iso < prev.hireDate))) byName.set(key, { name, hireDate: iso });
  }

  return { byName, stats: { withDate, withoutDate, vacancies, total: byName.size } };
}

/* -------------------------------- hoja MM -------------------------------- */

const MM_FIELDS = [
  ['region', /^REGION$/i],
  ['agency', /^AGENCY$/i],
  ['position', /^POSICI/i],
  ['status', /^STATUS$/i],
  ['personId', /^ID HONO/i],
  ['agencyId', /^ID SP$/i],
  ['name', /^NOMBRE$/i],
  ['state', /^ESTADO$/i],
  ['city', /^CIUDAD$/i],
  ['headcount', /^PLANTILLA/i],
];

/** Mandos medios: una fila por persona. */
export function parseMM(rows) {
  const headerIndex = rows.findIndex((r) => {
    const labels = (r || []).map(upper);
    return labels.includes('NOMBRE') && labels.some((l) => /^POSICI/.test(l));
  });
  if (headerIndex < 0) return { people: [], warnings: ['No se encontro el encabezado de la hoja MM.'] };

  const header = rows[headerIndex] || [];
  const cols = {};
  for (const [field, re] of MM_FIELDS) {
    const col = header.findIndex((h) => re.test(upper(h)));
    if (col >= 0 && cols[field] === undefined) cols[field] = col;
  }

  const people = [];
  for (let r = headerIndex + 1; r < rows.length; r += 1) {
    const row = rows[r] || [];
    const name = text(row[cols.name]);
    if (!name) continue;
    const vacancy = isVacancy(name) || upper(text(row[cols.status])) === 'VACANCY';
    people.push({
      name: vacancy ? null : name,
      nameKey: vacancy ? null : nameKey(name),
      personId: vacancy ? null : (text(row[cols.personId]) || '').toLowerCase() || null,
      agencyId: vacancy ? null : text(row[cols.agencyId]),
      position: text(row[cols.position]),
      role: roleKeyOf(text(row[cols.position])),
      region: code(row[cols.region]),
      agency: text(row[cols.agency]),
      state: code(row[cols.state]),
      city: code(row[cols.city]),
      status: vacancy ? 'VACANCY' : upper(text(row[cols.status])) || 'COVERED',
      vacancy,
    });
  }
  return { people, warnings: [] };
}

/* ------------------------------- entrada -------------------------------- */

const SHEET_FF = /^FF$/i;
const SHEET_INGRESO = /^INGRESO$/i;
const SHEET_MM = /^MM$/i;

function sheetRows(wb, pattern) {
  const name = wb.SheetNames.find((n) => pattern.test(String(n).trim()));
  if (!name) return null;
  return { name, rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: null, raw: true }) };
}

/**
 * Lee el archivo completo de plantilla.
 * @param {string} filePath ruta al .xlsb o .xlsx
 */
export function parseHeadcountFile(filePath, { sourceName } = {}) {
  // Se lee el archivo a memoria y se entrega como buffer: la compilacion ESM
  // de SheetJS no abre rutas por si misma, y asi el parser tambien sirve para
  // un archivo que llega por la red sin tocar disco.
  return parseHeadcountBuffer(fs.readFileSync(filePath), { sourceName: sourceName || filePath.split('/').pop() });
}

/** Igual que `parseHeadcountFile`, a partir del contenido del archivo. */
export function parseHeadcountBuffer(buffer, { sourceName } = {}) {
  const wb = XLSX.read(buffer, { sheets: ['FF', 'INGRESO', 'MM'], cellDates: true, type: 'buffer' });

  const ff = sheetRows(wb, SHEET_FF);
  if (!ff) throw new Error('El archivo no contiene la hoja "FF" con la plantilla por tienda.');
  const ingreso = sheetRows(wb, SHEET_INGRESO);
  const mm = sheetRows(wb, SHEET_MM);

  const warnings = [];
  const { stores, assignments, blocks, warnings: ffWarnings } = parseFF(ff.rows);
  warnings.push(...ffWarnings);

  const hire = ingreso ? parseIngreso(ingreso.rows) : { byName: new Map(), stats: null };
  if (!ingreso) warnings.push('El archivo no trae la hoja "INGRESO": no habra fechas de ingreso.');

  const middle = mm ? parseMM(mm.rows) : { people: [], warnings: ['El archivo no trae la hoja "MM".'] };
  warnings.push(...middle.warnings);

  return {
    meta: {
      sourceName: sourceName || filePath.split('/').pop(),
      sheetNames: wb.SheetNames,
      roleBlocks: blocks.map((b) => ({ role: b.role, label: b.label })),
      hireStats: hire.stats,
      parsedAt: new Date().toISOString(),
      warnings,
    },
    stores,
    assignments,
    hireByName: hire.byName,
    middleManagement: middle.people,
  };
}

export const __testing = { findHeaderRow, findRoleBlocks, pickNameColumn };
