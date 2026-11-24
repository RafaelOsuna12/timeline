#!/usr/bin/env node
/** Carga el archivo de plantilla desde la terminal: npm run ingest-hc -- <archivo> */
import path from 'node:path';
import { parseHeadcountFile } from '../parser/headcount.js';
import { fileHash, saveHeadcount } from '../ingest-headcount.js';

const file = process.argv[2];
if (!file) {
  console.error('Uso: node src/scripts/ingest-hc.js <ruta/al/HC_R123.xlsb>');
  process.exit(1);
}

const t = Date.now();
console.log(`Procesando ${file} ...`);
const dataset = parseHeadcountFile(path.resolve(file));
const res = saveHeadcount(dataset, { hash: fileHash(path.resolve(file)) });
console.log(`Carga #${res.id} creada en ${((Date.now() - t) / 1000).toFixed(1)}s`);
console.log(`  ${res.people} personas · ${res.stores} tiendas`);
console.log(res.previousId ? `  ${res.changes} cambios contra la carga #${res.previousId}` : '  primera carga: sin comparacion');
for (const w of dataset.meta.warnings) console.log(`  aviso: ${w}`);
