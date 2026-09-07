/**
 * Reporte para impresion.
 *
 * A diferencia de las vistas del tablero —que responden a un filtro a la vez—
 * aqui se arma un documento completo: se eligen varias regiones, CMs,
 * supervisores o promotores y se obtiene el analisis de cada uno, al nivel de
 * detalle que se pida, en una sola respuesta lista para paginar e imprimir.
 *
 * El documento se construye con las mismas funciones del tablero, de modo que
 * un numero impreso y el mismo numero en pantalla no pueden discrepar.
 */
import { WEEKDAY_LABELS, computeMetrics, rank, round, sum, targetCurve, weekdayOf } from './metrics.js';
import { collapsePersons, isPlaceholderName, personKeyOf, placementBreakdown } from './persons.js';
import { contextOf, filterPromoters, modelMix, weekdayProfile } from './views.js';

/** Piezas por dia asistido por debajo de las cuales se considera bajo desempeño. */
export const DEFAULT_MIN_DAILY = 2;

export const SECTIONS = ['resumen', 'regiones', 'cms', 'supervisores', 'promotores', 'bajo_rendimiento'];

const norm = (v) => String(v ?? '').trim().toUpperCase();

/** Conjunto de valores seleccionados; vacio significa "todos". */
function setOf(list) {
  const values = (Array.isArray(list) ? list : String(list ?? '').split(','))
    .map((v) => norm(v))
    .filter(Boolean);
  return values.length ? new Set(values) : null;
}

/**
 * Recorta el universo de plazas al alcance elegido.
 * Cada dimension es independiente y acumulativa: elegir dos regiones y un
 * supervisor da las plazas de ese supervisor dentro de esas dos regiones.
 */
function applyScope(rows, selection) {
  const regions = setOf(selection.regions);
  const cms = setOf(selection.cms);
  const supervisors = setOf(selection.supervisors);
  const people = setOf(selection.promoters);

  return rows.filter((p) => {
    if (regions && !regions.has(norm(p.region))) return false;
    if (cms && !cms.has(norm(p.cm))) return false;
    if (supervisors && !supervisors.has(norm(p.supervisor))) return false;
    if (people && !people.has(norm(p.id)) && !people.has(norm(personKeyOf(p)))) return false;
    return true;
  });
}

/** Bloque de metricas sin las series, que en el reporte no se grafican. */
function block(ctx, rows, extra) {
  const m = computeMetrics(ctx, rows, extra);
  const { series, ...rest } = m;
  return rest;
}

/** Ficha de un promotor tal como se imprime: cabecera, tiendas y modelos. */
function promoterSheet(ctx, person, { withDaily }) {
  const m = computeMetrics(ctx, [person], {
    key: person.id,
    name: person.advisor,
    store: person.store,
    stores: person.stores || [person.store],
    storeCount: person.storeCount || 1,
    channel: person.channel,
    region: person.region,
    cm: person.cm,
    supervisor: person.supervisor,
    employment: person.status,
  });
  const { series, ...rest } = m;

  const sheet = {
    ...rest,
    stores: placementBreakdown(person, ctx),
    models: Object.entries(person.models || {})
      .map(([model, qty]) => ({ model, qty: round(qty, 0) }))
      .filter((x) => x.qty > 0)
      .sort((a, b) => b.qty - a.qty),
  };

  if (withDaily) {
    sheet.daily = Array.from({ length: ctx.daysInMonth }, (_, i) => ({
      day: i + 1,
      weekday: WEEKDAY_LABELS[weekdayOf(ctx.periodYear, ctx.periodMonth, i + 1)],
      isFuture: i + 1 > ctx.cutoffDay,
      so: series.soTarget[i],
      soAll: series.soAll[i],
      attendance: series.attendance[i],
      zeroSale: series.zeroSale[i],
      cumulative: i + 1 <= ctx.cutoffDay ? series.cumulative[i] : null,
    }));
  }
  return sheet;
}

/**
 * Reporte de bajo desempeño.
 *
 * El criterio pedido es el per capita: piezas por dia trabajado. Se acompaña
 * siempre del cierre proyectado, porque son dos preguntas distintas —cuanto
 * vende por dia y a donde llega el mes— y la lista es accionable solo si se
 * ven juntas.
 */
function lowPerformance(ctx, people, minDaily) {
  const rows = people
    .map((person) =>
      block(ctx, [person], {
        key: person.id,
        name: person.advisor,
        store: person.store,
        stores: person.stores || [person.store],
        storeCount: person.storeCount || 1,
        channel: person.channel,
        region: person.region,
        cm: person.cm,
        supervisor: person.supervisor,
        employment: person.status,
      })
    )
    .filter((p) => p.target > 0);

  const belowRate = (p) => (p.productivity ?? 0) < minDaily;
  const belowMinimum = (p) => (p.projectedAch ?? 0) < 0.6;

  // Las dos condiciones no son la misma: hay quien vende poco por dia y aun
  // asi cierra en meta (metas bajas, muchos dias en piso) y quien vende bien
  // los dias que va pero no alcanza el mes. Se agrupan por prioridad para que
  // el caso critico no se pierda entre los informativos.
  const groupOf = (p) => (belowRate(p) && belowMinimum(p) ? 'ambas' : belowMinimum(p) ? 'solo_minimo' : 'solo_percapita');

  const flagged = rows.filter((p) => belowRate(p) || belowMinimum(p)).map((p) => ({
    ...p,
    belowRate: belowRate(p),
    belowMinimum: belowMinimum(p),
    group: groupOf(p),
    // Una plaza vacante tambien sale sin venta, pero no es alguien a quien
    // acompañar: se marca para que el supervisor no la persiga.
    isVacancy: isPlaceholderName(p.name),
    // Cuanto tendria que subir el ritmo diario para cerrar en el minimo.
    dailyForMinimum:
      ctx.cutoffDay < ctx.daysInMonth && p.target
        ? round(Math.max(0, p.target * 0.6 - p.so) / Math.max(1, ctx.daysInMonth - ctx.cutoffDay), 2)
        : null,
    missingForMinimum: p.target ? round(Math.max(0, p.target * 0.6 - p.forecast), 0) : null,
  }));

  rank(flagged, 'productivity', { descending: false });

  const both = flagged.filter((p) => p.group === 'ambas');
  const groups = {
    ambas: flagged.filter((p) => p.group === 'ambas'),
    solo_minimo: flagged.filter((p) => p.group === 'solo_minimo'),
    solo_percapita: flagged.filter((p) => p.group === 'solo_percapita'),
  };
  return {
    minDaily,
    evaluated: rows.length,
    rows: flagged,
    groups,
    vacancies: flagged.filter((p) => p.isVacancy).length,
    counts: {
      belowRate: rows.filter(belowRate).length,
      belowMinimum: rows.filter(belowMinimum).length,
      both: both.length,
      onlyRate: rows.filter((p) => belowRate(p) && !belowMinimum(p)).length,
      onlyMinimum: rows.filter((p) => !belowRate(p) && belowMinimum(p)).length,
    },
    impact: {
      // Piezas que faltan para que los señalados cierren en el minimo.
      gapToMinimum: round(
        both.reduce((a, p) => a + Math.max(0, p.target * 0.6 - p.forecast), 0),
        0
      ),
      gapToTarget: round(
        flagged.reduce((a, p) => a + Math.max(0, p.target - p.forecast), 0),
        0
      ),
    },
  };
}

/**
 * Construye el documento completo.
 *
 * @param {object} snapshot  snapshot cargado
 * @param {object} filters   filtros normales del tablero (corte, offline...)
 * @param {object} options   alcance (regions/cms/supervisors/promoters),
 *                           secciones a incluir y umbral de bajo desempeño
 */
export function buildReport(snapshot, filters = {}, options = {}) {
  const ctx = contextOf(snapshot, filters);
  const days = ctx.daysInMonth;

  const universe = filterPromoters(snapshot.promoters, filters);
  const rows = applyScope(universe, options);
  const wanted = new Set(
    (options.sections && options.sections.length ? options.sections : SECTIONS).map((s) => String(s).toLowerCase())
  );
  const withDaily = Boolean(options.withDaily);
  const minDaily = Number.isFinite(Number(options.minDaily)) ? Number(options.minDaily) : DEFAULT_MIN_DAILY;

  const people = collapsePersons(rows, days);
  const summary = block(ctx, rows, { key: 'TOTAL', name: 'Alcance del reporte' });

  // Curva del alcance: acumulado real contra la curva de target del periodo.
  const full = computeMetrics(ctx, rows, {});
  const curve = targetCurve(full.target, full.series.soTarget, {
    year: ctx.periodYear,
    month: ctx.periodMonth,
    cutoffDay: ctx.cutoffDay,
    daysInMonth: days,
  });
  const daily = Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    weekday: WEEKDAY_LABELS[weekdayOf(ctx.periodYear, ctx.periodMonth, i + 1)],
    isFuture: i + 1 > ctx.cutoffDay,
    so: full.series.soTarget[i],
    soAll: full.series.soAll[i],
    present: full.series.attendance[i],
    zeroSale: full.series.zeroSale[i],
    cumulative: i + 1 <= ctx.cutoffDay ? full.series.cumulative[i] : null,
    targetCurve: curve[i],
  }));

  const report = {
    context: ctx,
    meta: snapshot.meta,
    generatedAt: new Date().toISOString(),
    sections: [...wanted],
    scope: {
      regions: [...new Set(rows.map((p) => p.region))].sort(),
      cms: [...new Set(rows.map((p) => p.cm).filter(Boolean))].sort(),
      supervisors: [...new Set(rows.map((p) => p.supervisor).filter(Boolean))].sort(),
      promoterCount: people.length,
      placementCount: rows.length,
      storeCount: new Set(rows.map((p) => p.store)).size,
      isPartial: rows.length < universe.length,
      universePromoters: collapsePersons(universe, days).length,
    },
    summary,
    daily,
    weekdayProfile: weekdayProfile(full.series.soTarget, ctx),
    models: modelMix(rows),
  };

  if (wanted.has('regiones') || wanted.has('cms') || wanted.has('supervisores') || wanted.has('promotores')) {
    report.regions = rank(
      groupTree(ctx, rows, {
        withCms: wanted.has('cms') || wanted.has('supervisores') || wanted.has('promotores'),
        withSupervisors: wanted.has('supervisores') || wanted.has('promotores'),
        withPromoters: wanted.has('promotores'),
        days,
      }),
      'ach'
    );
  }

  if (wanted.has('promotores')) {
    report.promoterSheets = rank(
      people.map((person) => promoterSheet(ctx, person, { withDaily })),
      'ach'
    );
  }

  if (wanted.has('bajo_rendimiento')) {
    report.lowPerformance = lowPerformance(ctx, people, minDaily);
  }

  return report;
}

/** Arbol region -> CM -> supervisor -> promotor, hasta el nivel pedido. */
function groupTree(ctx, rows, { withCms, withSupervisors, withPromoters, days }) {
  const byKey = (list, keyFn) => {
    const map = new Map();
    for (const r of list) {
      const k = keyFn(r) ?? 'SIN ASIGNAR';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    return [...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'es'));
  };

  return byKey(rows, (p) => p.region).map(([regionName, regionRows]) => {
    const region = block(ctx, regionRows, { key: regionName, name: regionName, level: 'region' });
    region.storeCount = new Set(regionRows.map((p) => p.store)).size;
    if (!withCms) return region;

    region.cms = rank(
      byKey(regionRows, (p) => p.cm || 'SIN CM').map(([cmName, cmRows]) => {
        const cm = block(ctx, cmRows, {
          key: `${regionName}::${cmName}`,
          name: cmName,
          level: 'cm',
          region: regionName,
        });
        cm.storeCount = new Set(cmRows.map((p) => p.store)).size;
        if (!withSupervisors) return cm;

        cm.supervisors = rank(
          byKey(cmRows, (p) => p.supervisor || 'SIN SUPERVISOR').map(([supName, supRows]) => {
            const sp = block(ctx, supRows, {
              key: `${regionName}::${cmName}::${supName}`,
              name: supName,
              level: 'supervisor',
              region: regionName,
              cm: cmName,
            });
            sp.storeCount = new Set(supRows.map((p) => p.store)).size;
            sp.promoters = rank(
              collapsePersons(supRows, days).map((person) =>
                block(ctx, [person], {
                  key: person.id,
                  name: person.advisor,
                  level: 'promotor',
                  store: person.store,
                  stores: person.stores || [person.store],
                  storeCount: person.storeCount || 1,
                  channel: person.channel,
                  region: person.region,
                  cm: person.cm,
                  supervisor: person.supervisor,
                  employment: person.status,
                })
              ),
              'ach'
            );
            if (!withPromoters) sp.promoters = sp.promoters.map(({ models, ...rest }) => rest);
            return sp;
          }),
          'ach'
        );
        return cm;
      }),
      'ach'
    );
    return region;
  });
}
