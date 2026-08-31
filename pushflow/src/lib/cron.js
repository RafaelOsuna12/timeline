/**
 * Evaluador mínimo de expresiones cron de 5 campos
 * (minuto hora día-del-mes mes día-de-semana). Admite `*`, listas `1,2`,
 * rangos `1-5` y pasos `*​/15`. Suficiente para automatizaciones programadas
 * sin añadir dependencias.
 */
function matchField(expr, value, min, max) {
  if (expr === '*') return true;
  for (const part of String(expr).split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isFinite(step) || step < 1) return false;

    let start = min, end = max;
    if (range !== '*') {
      const [a, b] = range.split('-');
      start = Number(a);
      end = b !== undefined ? Number(b) : (stepRaw ? max : Number(a));
      if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    }
    if (value < start || value > end) continue;
    if ((value - start) % step === 0) return true;
  }
  return false;
}

/** ¿La expresión cron coincide con el instante dado (en UTC)? */
export function cronMatches(expression, date = new Date()) {
  const fields = String(expression).trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const dow = date.getUTCDay();
  return matchField(minute, date.getUTCMinutes(), 0, 59)
    && matchField(hour, date.getUTCHours(), 0, 23)
    && matchField(dayOfMonth, date.getUTCDate(), 1, 31)
    && matchField(month, date.getUTCMonth() + 1, 1, 12)
    && (matchField(dayOfWeek, dow, 0, 6) || (dow === 0 && matchField(dayOfWeek, 7, 0, 7)));
}

export function isValidCron(expression) {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return /^[\d*,\-/]+$/.test(fields.join(''));
}

export default { cronMatches, isValidCron };
