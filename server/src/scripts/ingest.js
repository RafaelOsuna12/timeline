#!/usr/bin/env node
/**
 * Carga manual de un archivo desde la linea de comandos:
 *   npm run ingest -- /ruta/al/R123_DailySO_Models_*.xlsx
 *
 * Util para la carga inicial del historico o para reprocesar un archivo sin
 * pasar por la interfaz web.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseWorkbookFile } from '../parser/index.js';
import { fileHash, saveSnapshot } from '../ingest.js';
import { invalidateCache } from '../analytics/snapshot.js';
import { config } from '../config.js';

const input = process.argv[2];
if (!input) {
  console.error('Uso: npm run ingest -- <archivo.xlsx>');
  process.exit(1);
}
const abs = path.resolve(input);
if (!fs.existsSync(abs)) {
  console.error(`No existe el archivo: ${abs}`);
  process.exit(1);
}

console.log(`Procesando ${abs} ...`);
const started = Date.now();
const dataset = await parseWorkbookFile(abs);
const hash = fileHash(abs);

let stored = null;
if (config.keepSourceFiles) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  stored = path.join(config.uploadDir, `${dataset.meta.periodKey}_${hash.slice(0, 12)}.xlsx`);
  fs.copyFileSync(abs, stored);
}

const id = saveSnapshot(dataset, { storedFile: stored, hash, uploadedBy: 'cli' });
invalidateCache();
console.log(`Snapshot #${id} creado en ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`  Periodo ${dataset.meta.periodKey} · corte dia ${dataset.meta.cutoffDay}/${dataset.meta.daysInMonth}`);
console.log(`  ${dataset.promoters.length} promotores · ${dataset.supervisors.length} lideres`);
if (dataset.meta.warnings.length) {
  console.log('  Avisos:');
  for (const w of dataset.meta.warnings) console.log(`   - ${w}`);
}
