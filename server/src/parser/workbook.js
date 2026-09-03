/**
 * Carga del libro en memoria.
 *
 * Leer el archivo completo con ExcelJS cuesta cerca de 900 MB de RSS para un
 * libro de 14 MB: el peso no esta en las hojas del reporte sino en los volcados
 * intermedios (miles de filas) y sobre todo en X8D y M8L, que declaran mas de
 * 2700 columnas casi vacias.
 *
 * Aqui se recorre el archivo en streaming y solo se materializan las hojas que
 * el parser necesita, acotadas a un rango razonable de filas y columnas. El
 * consumo baja a un tercio y el resultado es identico, porque el lector en
 * streaming conserva tanto las fechas reales como el resultado cacheado de las
 * formulas.
 *
 * Las hojas materializadas exponen la misma superficie minima que usa el
 * parser (`name`, `rowCount`, `columnCount`, `getRow(r).getCell(c).value`),
 * de modo que el resto del codigo no distingue de donde vienen.
 */
import ExcelJS from 'exceljs';

/** Hojas que el parser necesita; el resto solo se cuenta, no se guarda. */
const NEEDED_SHEETS = [
  /BY[_ ]?SUPERVISORS/i,
  /DAILY[_ ]?RETAIL[_ ]?FF[_ ]?SO[_ ]?TARGET/i,
  /DAILY[_ ]?SORETAIL[_ ]?FF.*ALL[_ ]?SERIES/i,
  /MONTHLY[_ ]?SO[_ ]?FOCUS[_ ]?MODELS/i,
  /DAILY[_ ]?RETAIL[_ ]?FF[_ ]?SO[_ ]?IOT/i,
  /^SO[_ ]?MODEL$/i,
  /^DAILY[_ ]?SO[_ ]?.+[_ ]?MODEL$/i,
  /^(X8D|M8L|X7D|X6C|X5D)$/i,
];

// Margen amplio sobre lo que hoy usan las hojas (168 columnas, ~400 filas) para
// que el libro pueda crecer en promotores o dias sin tocar nada.
const MAX_COL = 400;
const MAX_ROW = 20000;

const EMPTY_CELL = Object.freeze({ value: null });

class SheetRow {
  constructor(cells) {
    this.cells = cells;
  }

  getCell(colNumber) {
    if (!this.cells) return EMPTY_CELL;
    const value = this.cells.get(colNumber);
    return value === undefined ? EMPTY_CELL : { value };
  }
}

const EMPTY_ROW = new SheetRow(null);

class SheetSnapshot {
  constructor(name) {
    this.name = name;
    this.rows = new Map();
    this.rowCount = 0;
    this.columnCount = 0;
  }

  setCell(rowNumber, colNumber, value) {
    let row = this.rows.get(rowNumber);
    if (!row) {
      row = new Map();
      this.rows.set(rowNumber, row);
    }
    row.set(colNumber, value);
    if (rowNumber > this.rowCount) this.rowCount = rowNumber;
    if (colNumber > this.columnCount) this.columnCount = colNumber;
  }

  getRow(rowNumber) {
    const cells = this.rows.get(rowNumber);
    return cells ? new SheetRow(cells) : EMPTY_ROW;
  }
}

function isNeeded(name) {
  return NEEDED_SHEETS.some((pattern) => pattern.test(name));
}

/**
 * Lee el archivo y devuelve un objeto con la forma que espera el parser.
 * @returns {Promise<{worksheets: SheetSnapshot[], sheetNames: string[]}>}
 */
export async function loadWorkbook(filePath) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    worksheets: 'emit',
    // Las fechas y las cadenas dependen de estos dos: sin ellos, una fecha
    // llegaria como numero de serie y el parser no detectaria el periodo.
    sharedStrings: 'cache',
    styles: 'cache',
    hyperlinks: 'ignore',
    entries: 'emit',
  });

  const worksheets = [];
  const sheetNames = [];

  for await (const worksheet of reader) {
    const name = worksheet.name || '';
    sheetNames.push(name);

    if (!isNeeded(name)) {
      // Hay que drenar la hoja igualmente para que el stream avance.
      // eslint-disable-next-line no-unused-vars
      for await (const _row of worksheet) {
        /* descartada */
      }
      continue;
    }

    const snapshot = new SheetSnapshot(name);
    for await (const row of worksheet) {
      if (row.number > MAX_ROW) continue;
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (colNumber > MAX_COL) return;
        snapshot.setCell(row.number, colNumber, cell.value);
      });
    }
    worksheets.push(snapshot);
  }

  if (!worksheets.length) {
    throw new Error(
      'El archivo no contiene ninguna de las hojas del reporte diario. Verifica que sea el libro correcto.'
    );
  }

  return { worksheets, sheetNames };
}

export const __testing = { SheetSnapshot, isNeeded, MAX_COL, MAX_ROW };
