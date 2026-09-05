/**
 * Motor de metricas y proyecciones.
 *
 * Todas las vistas del dashboard (compania, region, CM, supervisor, promotor,
 * canal, tienda, modelo) se construyen con las mismas funciones para que los
 * numeros sean consistentes en cualquier nivel de la jerarquia.
 *
 * Conceptos:
 *   - MTD      : acumulado del mes hasta el dia de corte.
 *   - Corte    : ultimo dia del mes con informacion en el archivo.
 *   - Target   : objetivo HQ del mes (modelos foco).
 *   - ACH%     : MTD / Target.
 *   - Avance   : corte / dias del mes (progreso de tiempo).
 *   - Forecast : cierre estimado al ultimo dia del mes.
 */

/**
 * Clasificacion de desempeño.
 *
 * El 60% es el minimo requerido: por debajo de esa linea el resultado se
 * considera fuera de meta, sin matices. De ahi hacia arriba hay tres escalones
 * antes del objetivo, para distinguir a quien apenas cumple de quien esta a un
 * paso de lograrlo.
 */
export const STATUS = {
  ON_TARGET: 'en_meta',       // 100% o mas
  IDEAL: 'ideal',             // 90% a 99%
  REGULAR: 'regular',         // 70% a 89%
  MINIMUM: 'minimo',          // 60% a 69%
  BELOW: 'fuera_de_meta',     // menos de 60%
  NO_TARGET: 'sin_target',
};

/** Umbral inferior de cada banda, de mayor a menor. */
export const STATUS_BANDS = [
  { status: STATUS.ON_TARGET, min: 1 },
  { status: STATUS.IDEAL, min: 0.9 },
  { status: STATUS.REGULAR, min: 0.7 },
  { status: STATUS.MINIMUM, min: 0.6 },
  { status: STATUS.BELOW, min: Number.NEGATIVE_INFINITY },
];

/** Minimo exigido: por debajo de este porcentaje el resultado no es aceptable. */
export const MINIMUM_ACHIEVEMENT = 0.6;

const round = (n, d = 2) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

export const sum = (arr) => (arr || []).reduce((a, b) => a + (b || 0), 0);

/** Suma elemento a elemento de varias series de la misma longitud. */
export function addSeries(target, source) {
  if (!source) return target;
  for (let i = 0; i < target.length; i += 1) target[i] += source[i] || 0;
  return target;
}

export function zeros(n) {
  return new Array(n).fill(0);
}

/** Serie acumulada. */
export function cumulative(series) {
  let acc = 0;
  return series.map((v) => {
    acc += v || 0;
    return acc;
  });
}

/** Dia de la semana (0 = domingo) para el dia `day` del periodo. */
export function weekdayOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export const WEEKDAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];

/**
 * Proyeccion de cierre de mes.
 *
 * Se calculan tres escenarios y se elige como base el estacional, porque en
 * retail el fin de semana concentra una parte desproporcionada del sell-out y
 * un promedio simple sesga la proyeccion segun en que dia caiga el corte.
 *
 *   - `runRate`  : promedio simple de los dias transcurridos.
 *   - `seasonal` : promedio por dia de la semana aplicado a los dias restantes.
 *   - `recent`   : promedio de los ultimos 7 dias con informacion.
 *
 * @returns {{mtd:number, runRate:number, seasonal:number, recent:number, base:number}}
 */
export function forecastMonth(series, { year, month, cutoffDay, daysInMonth }) {
  const mtd = sum(series.slice(0, cutoffDay));
  const remaining = Math.max(0, daysInMonth - cutoffDay);
  if (cutoffDay <= 0) {
    return { mtd: 0, runRate: 0, seasonal: 0, recent: 0, base: 0, remainingDays: remaining };
  }
  if (remaining === 0) {
    return { mtd, runRate: mtd, seasonal: mtd, recent: mtd, base: mtd, remainingDays: 0 };
  }

  const dailyAvg = mtd / cutoffDay;
  const runRate = mtd + dailyAvg * remaining;

  // Promedio por dia de la semana con los dias ya transcurridos.
  const byWeekday = Array.from({ length: 7 }, () => ({ total: 0, days: 0 }));
  for (let d = 1; d <= cutoffDay; d += 1) {
    const w = weekdayOf(year, month, d);
    byWeekday[w].total += series[d - 1] || 0;
    byWeekday[w].days += 1;
  }
  let seasonalRemainder = 0;
  for (let d = cutoffDay + 1; d <= daysInMonth; d += 1) {
    const w = weekdayOf(year, month, d);
    const b = byWeekday[w];
    seasonalRemainder += b.days > 0 ? b.total / b.days : dailyAvg;
  }
  const seasonal = mtd + seasonalRemainder;

  const window = Math.min(7, cutoffDay);
  const recentAvg = sum(series.slice(cutoffDay - window, cutoffDay)) / window;
  const recent = mtd + recentAvg * remaining;

  return {
    mtd,
    runRate: round(runRate, 1),
    seasonal: round(seasonal, 1),
    recent: round(recent, 1),
    base: round(seasonal, 1),
    remainingDays: remaining,
  };
}

/**
 * Clasificacion a partir del cierre proyectado contra el target.
 *
 * Se evalua sobre la proyeccion y no sobre el avance del dia porque a mitad de
 * mes el acumulado siempre es bajo: clasificar por avance marcaria a todo el
 * equipo fuera de meta el dia 10. Al cierre del mes ambos valores coinciden.
 */
export function statusOf(projected, target) {
  if (!target || target <= 0) return STATUS.NO_TARGET;
  const ratio = projected / target;
  const band = STATUS_BANDS.find((b) => ratio >= b.min);
  return band ? band.status : STATUS.BELOW;
}

/**
 * Construye el bloque de metricas de una entidad (compania, region, CM, SP,
 * promotor, canal, tienda...) a partir de sus promotores.
 *
 * @param {object} ctx  contexto del snapshot (periodo, corte, dias)
 * @param {Array}  rows promotores que pertenecen a la entidad
 */
export function computeMetrics(ctx, rows, extra = {}) {
  const { daysInMonth, cutoffDay, periodYear: year, periodMonth: month } = ctx;
  const soTarget = zeros(daysInMonth);
  const soAll = zeros(daysInMonth);
  const soIot = zeros(daysInMonth);
  const attendance = zeros(daysInMonth);
  const zeroSale = zeros(daysInMonth);
  const models = {};

  let target = 0;
  let targetAdjusted = 0;
  let headcount = 0;
  let activeHeadcount = 0;
  let baseCount = 0;
  let supportCount = 0;

  for (const p of rows) {
    addSeries(soTarget, p.daily.soTarget);
    addSeries(soAll, p.daily.soAll);
    addSeries(soIot, p.daily.soIot);
    addSeries(attendance, p.daily.attendance);
    addSeries(zeroSale, p.daily.zeroSale);
    target += p.targetHQ || 0;
    targetAdjusted += p.targetAdjusted || 0;
    headcount += 1;
    if (p.status === 'SUPPORT') supportCount += 1;
    else if (p.status === 'BASE') baseCount += 1;
    if (sum(p.daily.attendance) > 0) activeHeadcount += 1;
    for (const [m, v] of Object.entries(p.models || {})) models[m] = (models[m] || 0) + (v || 0);
  }

  const period = { year, month, cutoffDay, daysInMonth };
  const fcTarget = forecastMonth(soTarget, period);
  const fcAll = forecastMonth(soAll, period);

  const mtd = fcTarget.mtd;
  const mtdAll = fcAll.mtd;
  const gap = target ? target - mtd : null;
  const remaining = Math.max(0, daysInMonth - cutoffDay);
  const dailyAvg = cutoffDay > 0 ? mtd / cutoffDay : 0;
  const requiredDaily = target && remaining > 0 ? Math.max(0, (target - mtd) / remaining) : null;
  const attendanceDays = sum(attendance.slice(0, cutoffDay));
  const zeroSaleDays = sum(zeroSale.slice(0, cutoffDay));

  return {
    ...extra,
    headcount,
    activeHeadcount,
    baseCount,
    supportCount,
    target: round(target, 0),
    targetAdjusted: round(targetAdjusted, 0),
    so: round(mtd, 0),
    soAll: round(mtdAll, 0),
    soIot: round(sum(soIot.slice(0, cutoffDay)), 0),
    ach: target ? round(mtd / target, 4) : null,
    achAll: target ? round(mtdAll / target, 4) : null,
    timeProgress: daysInMonth ? round(cutoffDay / daysInMonth, 4) : null,
    pace: target && cutoffDay ? round(mtd / (target * (cutoffDay / daysInMonth)), 4) : null,
    gap: gap === null ? null : round(gap, 0),
    remainingDays: remaining,
    dailyAvg: round(dailyAvg, 2),
    dailyAvgAll: round(cutoffDay > 0 ? mtdAll / cutoffDay : 0, 2),
    requiredDaily: requiredDaily === null ? null : round(requiredDaily, 2),
    effortIndex: requiredDaily !== null && dailyAvg > 0 ? round(requiredDaily / dailyAvg, 2) : null,
    forecast: fcTarget.base,
    forecastAll: fcAll.base,
    forecastScenarios: {
      ritmo: fcTarget.runRate,
      estacional: fcTarget.seasonal,
      reciente: fcTarget.recent,
    },
    projectedAch: target ? round(fcTarget.base / target, 4) : null,
    projectedGap: target ? round(fcTarget.base - target, 0) : null,
    status: statusOf(fcTarget.base, target),
    attendanceDays: round(attendanceDays, 0),
    zeroSaleDays: round(zeroSaleDays, 0),
    zeroSaleRate: attendanceDays > 0 ? round(zeroSaleDays / attendanceDays, 4) : null,
    productivity: attendanceDays > 0 ? round(mtd / attendanceDays, 2) : null,
    productivityAll: attendanceDays > 0 ? round(mtdAll / attendanceDays, 2) : null,
    perFF: headcount > 0 ? round(mtd / headcount, 1) : null,
    models,
    series: {
      soTarget,
      soAll,
      soIot,
      attendance,
      zeroSale,
      cumulative: cumulative(soTarget),
      cumulativeAll: cumulative(soAll),
    },
  };
}

/**
 * Curva de target lineal para comparar contra el acumulado real.
 * Se reparte el objetivo entre los dias del mes usando el peso historico de
 * cada dia de la semana (mismo criterio que la proyeccion estacional).
 */
export function targetCurve(target, series, { year, month, cutoffDay, daysInMonth }) {
  if (!target) return zeros(daysInMonth);
  const weights = zeros(daysInMonth);
  const byWeekday = Array.from({ length: 7 }, () => ({ total: 0, days: 0 }));
  for (let d = 1; d <= Math.max(1, cutoffDay); d += 1) {
    const w = weekdayOf(year, month, d);
    byWeekday[w].total += series[d - 1] || 0;
    byWeekday[w].days += 1;
  }
  const observed = sum(series.slice(0, Math.max(1, cutoffDay)));
  const useSeasonal = observed > 0;
  for (let d = 1; d <= daysInMonth; d += 1) {
    if (!useSeasonal) {
      weights[d - 1] = 1;
      continue;
    }
    const b = byWeekday[weekdayOf(year, month, d)];
    weights[d - 1] = b.days > 0 ? b.total / b.days : observed / Math.max(1, cutoffDay);
  }
  const totalWeight = sum(weights) || daysInMonth;
  let acc = 0;
  return weights.map((w) => {
    acc += (w / totalWeight) * target;
    return round(acc, 1);
  });
}

/** Ranking descendente por una metrica, agregando la posicion a cada fila. */
export function rank(list, metric = 'ach', { descending = true } = {}) {
  const sorted = [...list].sort((a, b) => {
    const av = a[metric] ?? -Infinity;
    const bv = b[metric] ?? -Infinity;
    return descending ? bv - av : av - bv;
  });
  sorted.forEach((item, i) => {
    item.rank = i + 1;
  });
  return sorted;
}

export { round };
