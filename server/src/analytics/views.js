/**
 * Construccion de las vistas del dashboard a partir de un snapshot cargado.
 *
 * Cada vista devuelve datos ya listos para graficar: el frontend no recalcula
 * metricas, solo las presenta. Asi el mismo numero sale igual en la pantalla
 * ejecutiva, en el detalle por supervisor y en cualquier exportacion.
 */
import {
  STATUS,
  WEEKDAY_LABELS,
  computeMetrics,
  cumulative,
  rank,
  round,
  sum,
  targetCurve,
  weekdayOf,
  zeros,
} from './metrics.js';

/* ------------------------------ filtros ------------------------------ */

/**
 * Aplica los filtros de la peticion sobre la lista de promotores.
 * `includeOffline` incorpora las plazas sin region asignada (status OFFLINE),
 * que por defecto quedan fuera para que los totales cuadren con el reporte HQ.
 */
export function filterPromoters(promoters, filters = {}) {
  const {
    region,
    cm,
    supervisor,
    channel,
    store,
    status,
    search,
    includeOffline = false,
  } = filters;

  const norm = (v) => (v === null || v === undefined ? '' : String(v).trim().toUpperCase());
  const wanted = {
    region: norm(region),
    cm: norm(cm),
    supervisor: norm(supervisor),
    channel: norm(channel),
    store: norm(store),
    status: norm(status),
    search: norm(search),
  };

  return promoters.filter((p) => {
    if (!includeOffline && p.status === 'OFFLINE') return false;
    if (wanted.region && norm(p.region) !== wanted.region) return false;
    if (wanted.cm && norm(p.cm) !== wanted.cm) return false;
    if (wanted.supervisor && norm(p.supervisor) !== wanted.supervisor) return false;
    if (wanted.channel && norm(p.channel) !== wanted.channel) return false;
    if (wanted.store && norm(p.store) !== wanted.store) return false;
    if (wanted.status && norm(p.status) !== wanted.status) return false;
    if (wanted.search) {
      const hay = `${p.advisor} ${p.store} ${p.supervisor || ''} ${p.cm || ''} ${p.channel}`.toUpperCase();
      if (!hay.includes(wanted.search)) return false;
    }
    return true;
  });
}

/**
 * Contexto de periodo que consumen las funciones de metricas.
 *
 * `asOfDay` permite "rebobinar" el mes y ver el tablero tal como se veia en un
 * dia anterior: util para validar que tan buena fue la proyeccion y para
 * revisar la evolucion del avance sin necesidad de guardar un archivo por dia.
 */
export function contextOf(snapshot, filters = {}) {
  const m = snapshot.meta;
  const asOf = Number(filters.asOfDay);
  const cutoffDay =
    Number.isFinite(asOf) && asOf >= 1 ? Math.min(Math.floor(asOf), m.cutoffDay) : m.cutoffDay;
  return {
    periodKey: m.periodKey,
    periodYear: m.periodYear,
    periodMonth: m.periodMonth,
    daysInMonth: m.daysInMonth,
    cutoffDay,
    cutoffDate: `${m.periodKey}-${String(cutoffDay).padStart(2, '0')}`,
    realCutoffDay: m.cutoffDay,
    isReplay: cutoffDay !== m.cutoffDay,
  };
}

/** Agrupa promotores por una propiedad y calcula metricas de cada grupo. */
function groupBy(ctx, rows, keyFn, labelFn = (k) => k) {
  const groups = new Map();
  for (const p of rows) {
    const k = keyFn(p) ?? 'SIN ASIGNAR';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const out = [];
  for (const [k, items] of groups) {
    out.push(computeMetrics(ctx, items, { key: String(k), name: labelFn(k, items) }));
  }
  return out;
}

/** Version ligera (sin series diarias) para tablas grandes. */
function slim(entity) {
  const { series, ...rest } = entity;
  return rest;
}

/* --------------------------- vista ejecutiva --------------------------- */

export function buildOverview(snapshot, filters = {}) {
  const ctx = contextOf(snapshot, filters);
  const rows = filterPromoters(snapshot.promoters, filters);
  const total = computeMetrics(ctx, rows, { key: 'TOTAL', name: 'Total operacion' });

  const days = ctx.daysInMonth;
  const dayLabels = Array.from({ length: days }, (_, i) => i + 1);
  const weekdays = dayLabels.map((d) => WEEKDAY_LABELS[weekdayOf(ctx.periodYear, ctx.periodMonth, d)]);
  const curve = targetCurve(total.target, total.series.soTarget, {
    year: ctx.periodYear,
    month: ctx.periodMonth,
    cutoffDay: ctx.cutoffDay,
    daysInMonth: days,
  });

  // Proyeccion dia a dia para la parte futura de la curva.
  const projectedCurve = buildProjectedCurve(total.series.soTarget, ctx);

  const daily = dayLabels.map((d, i) => ({
    day: d,
    date: `${ctx.periodKey}-${String(d).padStart(2, '0')}`,
    weekday: weekdays[i],
    isFuture: d > ctx.cutoffDay,
    so: total.series.soTarget[i],
    soAll: total.series.soAll[i],
    iot: total.series.soIot[i],
    attendance: total.series.attendance[i],
    zeroSale: total.series.zeroSale[i],
    cumulative: d <= ctx.cutoffDay ? total.series.cumulative[i] : null,
    cumulativeAll: d <= ctx.cutoffDay ? total.series.cumulativeAll[i] : null,
    targetCurve: curve[i],
    projection: projectedCurve[i],
  }));

  const regions = rank(groupBy(ctx, rows, (p) => p.region).map(slim), 'ach');
  const channels = rank(groupBy(ctx, rows, (p) => p.channel).map(slim), 'so');
  const cms = rank(groupBy(ctx, rows, (p) => p.cm || 'SIN CM').map(slim), 'ach');
  const supervisors = rank(groupBy(ctx, rows, (p) => p.supervisor || 'SIN SUPERVISOR').map(slim), 'ach');

  const promoterMetrics = rows.map((p) =>
    slim(
      computeMetrics(ctx, [p], {
        key: p.id,
        name: p.advisor,
        store: p.store,
        channel: p.channel,
        region: p.region,
        cm: p.cm,
        supervisor: p.supervisor,
        employment: p.status,
      })
    )
  );
  rank(promoterMetrics, 'ach');

  const withTarget = promoterMetrics.filter((p) => p.target > 0);
  const topPromoters = [...withTarget].sort((a, b) => (b.ach ?? 0) - (a.ach ?? 0)).slice(0, 10);
  const bottomPromoters = [...withTarget].sort((a, b) => (a.ach ?? 0) - (b.ach ?? 0)).slice(0, 10);
  const topVolume = [...promoterMetrics].sort((a, b) => b.so - a.so).slice(0, 10);

  return {
    context: ctx,
    meta: snapshot.meta,
    filters,
    total: { ...total, series: undefined },
    daily,
    weekdayProfile: weekdayProfile(total.series.soTarget, ctx),
    regions,
    channels,
    cms,
    supervisors,
    models: modelMix(rows),
    ranking: { topPromoters, bottomPromoters, topVolume },
    alerts: buildAlerts(ctx, promoterMetrics, supervisors, regions),
    counts: {
      promoters: rows.length,
      supervisors: supervisors.length,
      cms: cms.length,
      stores: new Set(rows.map((p) => p.store)).size,
      channels: channels.length,
    },
  };
}

/** Curva de cierre proyectada (acumulado real hasta el corte + estimacion). */
function buildProjectedCurve(series, ctx) {
  const { periodYear: year, periodMonth: month, cutoffDay, daysInMonth } = ctx;
  const out = new Array(daysInMonth).fill(null);
  if (cutoffDay <= 0) return out;

  const byWeekday = Array.from({ length: 7 }, () => ({ total: 0, days: 0 }));
  for (let d = 1; d <= cutoffDay; d += 1) {
    const w = weekdayOf(year, month, d);
    byWeekday[w].total += series[d - 1] || 0;
    byWeekday[w].days += 1;
  }
  const mtd = sum(series.slice(0, cutoffDay));
  const avg = mtd / cutoffDay;

  let acc = mtd;
  out[cutoffDay - 1] = round(acc, 1);
  for (let d = cutoffDay + 1; d <= daysInMonth; d += 1) {
    const b = byWeekday[weekdayOf(year, month, d)];
    acc += b.days > 0 ? b.total / b.days : avg;
    out[d - 1] = round(acc, 1);
  }
  return out;
}

/** Promedio de sell-out por dia de la semana (estacionalidad). */
export function weekdayProfile(series, ctx) {
  const acc = Array.from({ length: 7 }, () => ({ total: 0, days: 0 }));
  for (let d = 1; d <= ctx.cutoffDay; d += 1) {
    const w = weekdayOf(ctx.periodYear, ctx.periodMonth, d);
    acc[w].total += series[d - 1] || 0;
    acc[w].days += 1;
  }
  // Se presenta iniciando en lunes, como se lee el calendario comercial.
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order.map((w) => ({
    weekday: WEEKDAY_LABELS[w],
    total: round(acc[w].total, 0),
    days: acc[w].days,
    average: acc[w].days ? round(acc[w].total / acc[w].days, 1) : 0,
  }));
}

/** Mezcla de modelos foco agregada. */
export function modelMix(rows) {
  const totals = {};
  for (const p of rows) {
    for (const [m, v] of Object.entries(p.models || {})) totals[m] = (totals[m] || 0) + (v || 0);
  }
  const grand = Object.values(totals).reduce((a, b) => a + b, 0);
  return Object.entries(totals)
    .map(([model, qty]) => ({ model, qty: round(qty, 0), share: grand ? round(qty / grand, 4) : 0 }))
    .sort((a, b) => b.qty - a.qty);
}

/* ------------------------------- alertas ------------------------------- */

/**
 * Alertas accionables. El orden importa: primero lo que pone en riesgo el
 * cierre de mes, despues los casos individuales.
 */
function buildAlerts(ctx, promoters, supervisors, regions) {
  const alerts = [];
  const remaining = Math.max(0, ctx.daysInMonth - ctx.cutoffDay);
  const closed = remaining === 0;

  // Gravedad de la alerta segun la banda en la que cae el cierre proyectado.
  const alertLevel = (status) => {
    if (status === STATUS.BELOW) return 'critical';
    if (status === STATUS.MINIMUM) return 'serious';
    if (status === STATUS.REGULAR) return 'warning';
    return null;
  };

  for (const r of regions) {
    // Las regiones son pocas: se avisa desde que no proyectan el objetivo.
    const level = alertLevel(r.status) || (r.status === STATUS.IDEAL ? 'warning' : null);
    if (level) {
      alerts.push({
        level,
        scope: 'region',
        entity: r.name,
        title: closed
          ? `${r.name} cerro en ${pct(r.ach)} del target`
          : `${r.name} proyecta ${pct(r.projectedAch)} del target`,
        detail: closed
          ? `Quedaron ${fmt(Math.max(0, r.gap))} piezas sin vender. Promedio del mes ${fmt(r.dailyAvg)} pzs/dia con ${r.headcount} promotores.`
          : `Faltan ${fmt(r.gap)} piezas en ${remaining} dias: requiere ${fmt(r.requiredDaily)} pzs/dia contra ${fmt(
              r.dailyAvg
            )} pzs/dia actuales.`,
      });
    }
  }

  for (const s of supervisors) {
    // Para supervisores solo se avisa por debajo del 70%: con el umbral en 90%
    // aparecerian casi todos y la lista dejaria de señalar nada.
    const level = s.status === STATUS.BELOW ? 'critical' : s.status === STATUS.MINIMUM ? 'serious' : null;
    if (s.target > 0 && level) {
      alerts.push({
        level,
        scope: 'supervisor',
        entity: s.name,
        title: `${s.name}: ${pct(s.ach)} de avance`,
        detail: closed
          ? `Cerro con ${fmt(s.so)} de ${fmt(s.target)} piezas y ${s.headcount} promotores a cargo.`
          : `${fmt(s.so)} de ${fmt(s.target)} piezas con ${s.headcount} promotores. Necesita ${fmt(
              s.requiredDaily
            )} pzs/dia para cerrar en meta.`,
      });
    }
  }

  const noSales = promoters.filter((p) => p.so === 0 && p.attendanceDays > 0);
  if (noSales.length) {
    alerts.push({
      level: 'critical',
      scope: 'promotor',
      entity: `${noSales.length} promotores`,
      title: `${noSales.length} promotores sin una sola venta de modelos foco`,
      detail:
        noSales
          .slice(0, 6)
          .map((p) => p.name)
          .join(', ') + (noSales.length > 6 ? ` y ${noSales.length - 6} mas` : ''),
    });
  }

  const highZero = promoters
    .filter((p) => p.attendanceDays >= 5 && p.zeroSaleRate !== null && p.zeroSaleRate >= 0.5)
    .sort((a, b) => b.zeroSaleRate - a.zeroSaleRate);
  if (highZero.length) {
    alerts.push({
      level: 'warning',
      scope: 'promotor',
      entity: `${highZero.length} promotores`,
      title: `${highZero.length} promotores con la mitad o mas de sus dias en cero`,
      detail: highZero
        .slice(0, 6)
        .map((p) => `${p.name} (${pct(p.zeroSaleRate)})`)
        .join(', '),
    });
  }

  const noAttendance = promoters.filter((p) => p.attendanceDays === 0);
  if (noAttendance.length) {
    alerts.push({
      level: 'info',
      scope: 'promotor',
      entity: `${noAttendance.length} plazas`,
      title: `${noAttendance.length} plazas sin registro de asistencia en el mes`,
      detail: 'Revisa vacantes, bajas o fallas de check-in en la app de retail.',
    });
  }

  return alerts;
}

const pct = (v) => (v === null || v === undefined ? 'n/d' : `${(v * 100).toFixed(1)}%`);
const fmt = (v) => (v === null || v === undefined ? 'n/d' : Number(v).toLocaleString('es-MX'));

/* ---------------------------- vista jerarquia ---------------------------- */

/**
 * Arbol Region -> CM -> Supervisor -> Promotor con metricas en cada nivel.
 * Es la vista que responde "donde exactamente se esta perdiendo el target".
 */
export function buildHierarchy(snapshot, filters = {}) {
  const ctx = contextOf(snapshot, filters);
  const rows = filterPromoters(snapshot.promoters, filters);
  const leaderIndex = new Map(snapshot.leaders.map((l) => [`${l.position}||${normKey(l.name)}`, l]));

  const regions = [];
  for (const [regionName, regionRows] of group(rows, (p) => p.region)) {
    const region = computeMetrics(ctx, regionRows, { key: regionName, name: regionName, level: 'region' });
    const cms = [];
    for (const [cmName, cmRows] of group(regionRows, (p) => p.cm || 'SIN CM')) {
      const leader = leaderIndex.get(`CM||${normKey(cmName)}`);
      const cm = computeMetrics(ctx, cmRows, {
        key: `${regionName}::${cmName}`,
        name: cmName,
        level: 'cm',
        region: regionName,
        ffsInCharge: leader?.ffsInCharge ?? cmRows.length,
      });
      const sups = [];
      for (const [supName, supRows] of group(cmRows, (p) => p.supervisor || 'SIN SUPERVISOR')) {
        const spLeader = leaderIndex.get(`SP||${normKey(supName)}`);
        const sp = computeMetrics(ctx, supRows, {
          key: `${regionName}::${cmName}::${supName}`,
          name: supName,
          level: 'supervisor',
          region: regionName,
          cm: cmName,
          ffsInCharge: spLeader?.ffsInCharge ?? supRows.length,
        });
        sp.promoters = rank(
          supRows.map((p) =>
            slim(
              computeMetrics(ctx, [p], {
                key: p.id,
                name: p.advisor,
                level: 'promotor',
                store: p.store,
                channel: p.channel,
                region: p.region,
                cm: p.cm,
                supervisor: p.supervisor,
                employment: p.status,
              })
            )
          ),
          'ach'
        );
        sups.push(sp);
      }
      cm.supervisors = rank(sups, 'ach');
      cms.push(cm);
    }
    region.cms = rank(cms, 'ach');
    regions.push(region);
  }

  return { context: ctx, meta: snapshot.meta, regions: rank(regions, 'ach') };
}

function group(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r) ?? 'SIN ASIGNAR';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return [...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'es'));
}

function normKey(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}

/* ---------------------------- vista promotores ---------------------------- */

export function buildPromoters(snapshot, filters = {}) {
  const ctx = contextOf(snapshot, filters);
  const rows = filterPromoters(snapshot.promoters, filters);
  const list = rows.map((p) => {
    const m = computeMetrics(ctx, [p], {
      key: p.id,
      name: p.advisor,
      store: p.store,
      channel: p.channel,
      region: p.region,
      cm: p.cm,
      supervisor: p.supervisor,
      employment: p.status,
    });
    return { ...slim(m), daily: m.series.soTarget, dailyAll: m.series.soAll };
  });
  rank(list, 'ach');
  return { context: ctx, meta: snapshot.meta, promoters: list, total: slim(computeMetrics(ctx, rows)) };
}

/** Detalle completo de un promotor, incluida su serie por modelo. */
export function buildPromoterDetail(snapshot, promoterId, filters = {}) {
  const ctx = contextOf(snapshot, filters);
  const p = snapshot.promoters.find((x) => x.id === promoterId);
  if (!p) return null;
  const m = computeMetrics(ctx, [p], {
    key: p.id,
    name: p.advisor,
    store: p.store,
    channel: p.channel,
    region: p.region,
    cm: p.cm,
    supervisor: p.supervisor,
    employment: p.status,
  });
  const days = ctx.daysInMonth;
  const daily = Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    weekday: WEEKDAY_LABELS[weekdayOf(ctx.periodYear, ctx.periodMonth, i + 1)],
    isFuture: i + 1 > ctx.cutoffDay,
    so: m.series.soTarget[i],
    soAll: m.series.soAll[i],
    iot: m.series.soIot[i],
    attendance: m.series.attendance[i],
    zeroSale: m.series.zeroSale[i],
    cumulative: i + 1 <= ctx.cutoffDay ? m.series.cumulative[i] : null,
  }));

  // Comparativa contra el promedio del equipo del mismo supervisor.
  const peers = snapshot.promoters.filter((x) => x.supervisor === p.supervisor && x.id !== p.id);
  const peerMetrics = peers.length ? computeMetrics(ctx, peers) : null;

  return {
    context: ctx,
    meta: snapshot.meta,
    promoter: slim(m),
    daily,
    modelDaily: Object.entries(p.modelDaily || {}).map(([model, series]) => ({
      model,
      total: round(sum(series.slice(0, ctx.cutoffDay)), 0),
      series,
      cumulative: cumulative(series),
    })),
    models: Object.entries(p.models || {})
      .map(([model, qty]) => ({ model, qty }))
      .sort((a, b) => b.qty - a.qty),
    peerAverage: peerMetrics
      ? {
          so: round(peerMetrics.so / peers.length, 1),
          ach: peerMetrics.ach,
          productivity: peerMetrics.productivity,
          zeroSaleRate: peerMetrics.zeroSaleRate,
        }
      : null,
  };
}

/* ------------------------------ vista modelos ------------------------------ */

export function buildModels(snapshot, filters = {}) {
  const ctx = contextOf(snapshot, filters);
  const rows = filterPromoters(snapshot.promoters, filters);
  const days = ctx.daysInMonth;

  // Series diarias por modelo foco, sumando a los promotores filtrados.
  const modelSeries = new Map();
  for (const p of rows) {
    for (const [model, series] of Object.entries(p.modelDaily || {})) {
      if (!modelSeries.has(model)) modelSeries.set(model, zeros(days));
      const target = modelSeries.get(model);
      for (let i = 0; i < days; i += 1) target[i] += series[i] || 0;
    }
  }

  const focusModels = modelMix(rows).map((m) => {
    const series = modelSeries.get(m.model) || null;
    const base = series
      ? {
          series,
          cumulative: cumulative(series),
          dailyAvg: ctx.cutoffDay ? round(sum(series.slice(0, ctx.cutoffDay)) / ctx.cutoffDay, 2) : 0,
        }
      : {};
    return { ...m, ...base };
  });

  // Productos clave por canal (hoja SO_Model): solo tiene sentido sin filtrar
  // por persona, porque viene agregada de origen.
  const keyProducts = snapshot.modelChannel.map((r) => ({
    ...r,
    total: round(sum(r.daily.slice(0, ctx.cutoffDay)) || r.so, 0),
  }));

  const byChannel = new Map();
  for (const r of keyProducts) {
    if (!byChannel.has(r.channel)) byChannel.set(r.channel, []);
    byChannel.get(r.channel).push(r);
  }

  return {
    context: ctx,
    meta: snapshot.meta,
    focusModels,
    keyProducts: [...byChannel.entries()].map(([channel, models]) => ({
      channel,
      models: models.sort((a, b) => (b.total || 0) - (a.total || 0)),
      total: round(
        models.reduce((a, b) => a + (b.total || 0), 0),
        0
      ),
    })),
    variants: snapshot.variants,
  };
}

/* ------------------------------ vista tiendas ------------------------------ */

export function buildStores(snapshot, filters = {}) {
  const ctx = contextOf(snapshot, filters);
  const rows = filterPromoters(snapshot.promoters, filters);
  const stores = groupBy(ctx, rows, (p) => p.store).map((s) => slim(s));
  for (const s of stores) {
    const items = rows.filter((p) => p.store === s.name);
    s.channel = items[0]?.channel ?? null;
    s.region = items[0]?.region ?? null;
    s.cm = items[0]?.cm ?? null;
    s.supervisor = items[0]?.supervisor ?? null;
    s.advisors = items.map((p) => p.advisor);
  }
  rank(stores, 'so');
  return { context: ctx, meta: snapshot.meta, stores };
}

/* --------------------------- vista asistencia --------------------------- */

/**
 * Mapa de calor de asistencia y dias en cero por promotor.
 * Es la vista que explica por que un equipo no llega: falta de cobertura o
 * falta de conversion.
 */
export function buildAttendance(snapshot, filters = {}) {
  const ctx = contextOf(snapshot, filters);
  const rows = filterPromoters(snapshot.promoters, filters);
  const days = ctx.daysInMonth;

  const matrix = rows.map((p) => {
    const attendance = p.daily.attendance.slice(0, days);
    const so = p.daily.soTarget.slice(0, days);
    const worked = sum(attendance.slice(0, ctx.cutoffDay));
    const zero = sum(p.daily.zeroSale.slice(0, ctx.cutoffDay));
    return {
      key: p.id,
      name: p.advisor,
      store: p.store,
      region: p.region,
      cm: p.cm,
      supervisor: p.supervisor,
      channel: p.channel,
      employment: p.status,
      attendance,
      so,
      zeroSale: p.daily.zeroSale.slice(0, days),
      workedDays: round(worked, 0),
      zeroDays: round(zero, 0),
      coverage: ctx.cutoffDay ? round(worked / ctx.cutoffDay, 4) : null,
      zeroRate: worked ? round(zero / worked, 4) : null,
      productivity: worked ? round(sum(so.slice(0, ctx.cutoffDay)) / worked, 2) : null,
    };
  });

  const byDay = Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    weekday: WEEKDAY_LABELS[weekdayOf(ctx.periodYear, ctx.periodMonth, i + 1)],
    isFuture: i + 1 > ctx.cutoffDay,
    present: round(sum(rows.map((p) => p.daily.attendance[i] || 0)), 0),
    zeroSale: round(sum(rows.map((p) => p.daily.zeroSale[i] || 0)), 0),
    so: round(sum(rows.map((p) => p.daily.soTarget[i] || 0)), 0),
  }));

  return {
    context: ctx,
    meta: snapshot.meta,
    promoters: matrix.sort((a, b) => (a.coverage ?? 0) - (b.coverage ?? 0)),
    byDay,
    headcount: rows.length,
  };
}

/* --------------------------- comparativa snapshots --------------------------- */

/**
 * Compara dos snapshots del mismo periodo (por ejemplo el de hoy contra el de
 * ayer) para ver cuanto avanzo cada region, CM, supervisor y promotor.
 */
export function buildComparison(current, previous, filters = {}) {
  const ctxA = contextOf(current, filters);
  const ctxB = contextOf(previous, filters);
  const rowsA = filterPromoters(current.promoters, filters);
  const rowsB = filterPromoters(previous.promoters, filters);

  const totalA = computeMetrics(ctxA, rowsA);
  const totalB = computeMetrics(ctxB, rowsB);

  const dimension = (keyFn) => {
    const a = new Map(groupBy(ctxA, rowsA, keyFn).map((g) => [g.key, g]));
    const b = new Map(groupBy(ctxB, rowsB, keyFn).map((g) => [g.key, g]));
    const keys = new Set([...a.keys(), ...b.keys()]);
    return [...keys]
      .map((k) => {
        const cur = a.get(k);
        const prev = b.get(k);
        return {
          key: k,
          name: cur?.name ?? prev?.name ?? k,
          so: cur?.so ?? 0,
          soPrevious: prev?.so ?? 0,
          delta: round((cur?.so ?? 0) - (prev?.so ?? 0), 0),
          ach: cur?.ach ?? null,
          achPrevious: prev?.ach ?? null,
          achDelta: cur?.ach !== null && prev?.ach !== null ? round((cur?.ach ?? 0) - (prev?.ach ?? 0), 4) : null,
          forecast: cur?.forecast ?? null,
          forecastPrevious: prev?.forecast ?? null,
        };
      })
      .sort((x, y) => y.delta - x.delta);
  };

  return {
    current: { ...ctxA, snapshotId: current.meta.id, createdAt: current.meta.createdAt },
    previous: { ...ctxB, snapshotId: previous.meta.id, createdAt: previous.meta.createdAt },
    total: {
      so: totalA.so,
      soPrevious: totalB.so,
      delta: round(totalA.so - totalB.so, 0),
      daysAdvanced: ctxA.cutoffDay - ctxB.cutoffDay,
      ach: totalA.ach,
      achPrevious: totalB.ach,
      forecast: totalA.forecast,
      forecastPrevious: totalB.forecast,
    },
    regions: dimension((p) => p.region),
    cms: dimension((p) => p.cm || 'SIN CM'),
    supervisors: dimension((p) => p.supervisor || 'SIN SUPERVISOR'),
    channels: dimension((p) => p.channel),
  };
}

/* ------------------------------ catalogos ------------------------------ */

/** Valores disponibles para poblar los filtros del frontend. */
export function buildFilters(snapshot) {
  const rows = snapshot.promoters;
  const uniq = (fn) => [...new Set(rows.map(fn).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'es'));
  const relations = rows.map((p) => ({
    region: p.region,
    cm: p.cm || 'SIN CM',
    supervisor: p.supervisor || 'SIN SUPERVISOR',
    channel: p.channel,
    store: p.store,
  }));
  return {
    regions: uniq((p) => p.region),
    cms: uniq((p) => p.cm),
    supervisors: uniq((p) => p.supervisor),
    channels: uniq((p) => p.channel),
    stores: uniq((p) => p.store),
    statuses: uniq((p) => p.status),
    relations,
  };
}
