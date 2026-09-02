/** Serializacion CSV con BOM para que Excel respete acentos y separadores. */

function escape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  if (!rows || !rows.length) return '﻿';
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
