/**
 * Documento imprimible.
 *
 * Se compone de secciones que empiezan cada una en pagina nueva. Todo el
 * formato de impresion vive en `.report` dentro de styles.css: aqui solo se
 * decide que se dice y en que orden.
 *
 * La regla de oro de cada bloque es la misma —meta, venta, cumplimiento y
 * cierre— para que quien lea el reporte encuentre los mismos cuatro numeros en
 * el mismo lugar, hable de una region o de un promotor.
 */
import { Brand } from './Brand.jsx';
import { AdvanceCurve, DailyBars } from './charts/index.jsx';
import { d1, d2, dateLabel, n, pct, periodLabel, STATUS_LABELS, STATUS_RANGES } from '../utils/format.js';

const SECTION_TITLES = {
  regiones: 'Analisis por region',
  cms: 'Analisis por city manager',
  supervisores: 'Analisis por supervisor',
  promotores: 'Ficha por promotor',
  bajo_rendimiento: 'Reporte de bajo rendimiento',
};

export default function ReportDocument({ data }) {
  const ctx = data.context;
  const closed = ctx.cutoffDay >= ctx.daysInMonth;
  const has = (k) => data.sections.includes(k);

  return (
    <div className="report">
      <Cover data={data} closed={closed} />

      {has('resumen') && <SummarySection data={data} closed={closed} />}

      {has('regiones') &&
        data.regions?.map((region) => (
          <RegionSection key={region.key} region={region} ctx={ctx} closed={closed} data={data} />
        ))}

      {has('promotores') &&
        data.promoterSheets?.map((p) => <PromoterSection key={p.key} p={p} ctx={ctx} closed={closed} />)}

      {has('bajo_rendimiento') && data.lowPerformance && (
        <LowPerformanceSection lp={data.lowPerformance} ctx={ctx} closed={closed} />
      )}

      <p className="report__foot">
        Generado el {dateLabel(data.generatedAt)} · archivo {data.meta.sourceName || 's/n'} · corte al dia{' '}
        {ctx.cutoffDay} de {ctx.daysInMonth}
      </p>
    </div>
  );
}

/* ------------------------------- portada ------------------------------- */

function Cover({ data, closed }) {
  const ctx = data.context;
  const s = data.scope;
  const list = (arr, all) => (arr.length === 0 ? all : arr.length <= 4 ? arr.join(', ') : `${arr.length} seleccionados`);

  return (
    <section className="report__section report__cover">
      <Brand height={26} className="report__brand" />
      <h1 className="report__title">Avance de ventas y proyeccion de cierre</h1>
      <p className="report__lead">
        {periodLabel(ctx.periodKey)} · informacion al dia {ctx.cutoffDay} de {ctx.daysInMonth}
        {closed ? ' (mes cerrado)' : ` · faltan ${ctx.daysInMonth - ctx.cutoffDay} dias`}
      </p>

      <table className="report__meta">
        <tbody>
          <tr>
            <th>Regiones</th>
            <td>{list(s.regions, 'Todas')}</td>
            <th>City managers</th>
            <td>{list(s.cms, 'Todos')}</td>
          </tr>
          <tr>
            <th>Supervisores</th>
            <td>{list(s.supervisors, 'Todos')}</td>
            <th>Promotores</th>
            <td>
              {n(s.promoterCount)}
              {s.isPartial ? ` de ${n(s.universePromoters)}` : ''} en {n(s.storeCount)} tiendas
            </td>
          </tr>
          <tr>
            <th>Archivo</th>
            <td>{data.meta.sourceName || 's/n'}</td>
            <th>Generado</th>
            <td>{dateLabel(data.generatedAt)}</td>
          </tr>
        </tbody>
      </table>

      <FourUp m={data.summary} closed={closed} />

      <p className="report__note">
        El cumplimiento (ACH%) compara lo vendido contra la meta del mes. El cierre proyectado estima donde termina el
        mes con el ritmo observado, dando a cada dia que falta el peso historico de su dia de la semana. El estatus sale
        del cierre proyectado, no del avance del dia: {STATUS_RANGES.en_meta} en meta, {STATUS_RANGES.ideal} ideal,{' '}
        {STATUS_RANGES.regular} regular, {STATUS_RANGES.minimo} minimo y {STATUS_RANGES.fuera_de_meta} fuera de meta.
      </p>
    </section>
  );
}

/** Los cuatro numeros que encabezan cada bloque del reporte. */
function FourUp({ m, closed }) {
  return (
    <div className="report__kpis">
      <Figure label="Meta del mes" value={n(m.target)} unit="pzs" />
      <Figure label="Venta al corte" value={n(m.so)} unit="pzs" note={`${n(m.soAll)} incluyendo todas las series`} />
      <Figure label="Cumplimiento" value={pct(m.ach)} note={`Tiempo transcurrido ${pct(m.timeProgress, 0)}`} />
      <Figure
        label={closed ? 'Cierre real' : 'Cierre proyectado'}
        value={n(m.forecast)}
        unit="pzs"
        note={`${pct(m.projectedAch)} de la meta`}
        status={m.status}
      />
    </div>
  );
}

function Figure({ label, value, unit, note, status }) {
  return (
    <div className="report__kpi">
      <div className="report__kpi-label">{label}</div>
      <div className="report__kpi-value">
        {value}
        {unit && <span className="report__kpi-unit"> {unit}</span>}
      </div>
      {note && <div className="report__kpi-note">{note}</div>}
      {status && (
        <div className="report__kpi-note">
          <StatusText status={status} withRange />
        </div>
      )}
    </div>
  );
}

/**
 * En papel el color no basta —y en blanco y negro no existe—, asi que el
 * estatus se imprime con su nombre. El rango solo acompaña donde hay espacio:
 * repetirlo en cada fila de una tabla se come el ancho de los nombres.
 */
function StatusText({ status, withRange = false }) {
  return (
    <span className={`report__status report__status--${status}`}>
      {STATUS_LABELS[status] || status}
      {withRange && <span className="report__status-range"> ({STATUS_RANGES[status]})</span>}
    </span>
  );
}

/* ------------------------------- resumen ------------------------------- */

function SummarySection({ data, closed }) {
  const m = data.summary;
  const ctx = data.context;
  const daily = data.daily.map((d) => ({ ...d, projection: null }));

  return (
    <section className="report__section">
      <h2 className="report__h2">Resumen del alcance</h2>
      <FourUp m={m} closed={closed} />

      <table className="report__table">
        <tbody>
          <Row2
            a={['Promotores', `${n(m.headcount)} (${n(m.baseCount)} base, ${n(m.supportCount)} soporte)`]}
            b={['Con venta o asistencia', n(m.activeHeadcount)]}
          />
          <Row2 a={['Ritmo actual', `${d1(m.dailyAvg)} pzs/dia`]} b={['Promedio por promotor', `${d1(m.perFF)} pzs`]} />
          <Row2
            a={['Faltante contra la meta', m.gap === null ? '—' : `${n(m.gap)} pzs`]}
            b={[
              closed ? 'Dias del mes' : 'Ritmo requerido',
              closed ? n(ctx.daysInMonth) : `${d1(m.requiredDaily)} pzs/dia en ${n(m.remainingDays)} dias`,
            ]}
          />
          <Row2
            a={['Dias trabajados', `${n(m.attendanceDays)} dias`]}
            b={['Dias en cero', `${n(m.zeroSaleDays)} (${pct(m.zeroSaleRate)} de los trabajados)`]}
          />
          <Row2
            a={['Productividad', `${d2(m.productivity)} pzs por dia trabajado`]}
            b={['Indice de esfuerzo', m.effortIndex === null ? '—' : `${d2(m.effortIndex)}x el ritmo actual`]}
          />
          {!closed && (
            <Row2
              a={['Escenario de ritmo simple', `${n(m.forecastScenarios.ritmo)} pzs`]}
              b={['Escenario de tendencia reciente', `${n(m.forecastScenarios.reciente)} pzs`]}
            />
          )}
        </tbody>
      </table>

      <h3 className="report__h3">Avance acumulado contra la curva de meta</h3>
      <div className="report__chart">
        <AdvanceCurve daily={daily} target={m.target} cutoffDay={ctx.cutoffDay} height={230} />
      </div>

      <h3 className="report__h3">Venta por dia</h3>
      <div className="report__chart">
        <DailyBars daily={data.daily} height={190} />
      </div>

      {data.models?.length > 0 && (
        <>
          <h3 className="report__h3">Mezcla de modelos</h3>
          <table className="report__table report__table--data">
            <thead>
              <tr>
                <th>Modelo</th>
                <th className="num">Piezas</th>
                <th className="num">Participacion</th>
              </tr>
            </thead>
            <tbody>
              {data.models.map((x) => (
                <tr key={x.model}>
                  <td>{x.model}</td>
                  <td className="num">{n(x.qty)}</td>
                  <td className="num">{pct(x.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function Row2({ a, b }) {
  return (
    <tr>
      <th>{a[0]}</th>
      <td>{a[1]}</td>
      <th>{b[0]}</th>
      <td>{b[1]}</td>
    </tr>
  );
}

/* --------------------------- region / CM / SP --------------------------- */

function RegionSection({ region, ctx, closed, data }) {
  const has = (k) => data.sections.includes(k);
  return (
    <>
      <section className="report__section">
        <h2 className="report__h2">
          Region {region.name}
          <span className="report__h2-sub">
            {n(region.headcount)} promotores · {n(region.storeCount)} tiendas
          </span>
        </h2>
        <FourUp m={region} closed={closed} />
        {region.cms && <LevelTable rows={region.cms} label="City manager" closed={closed} />}
      </section>

      {has('cms') &&
        region.cms?.map((cm) => (
          <section className="report__section" key={cm.key}>
            <h2 className="report__h2">
              {cm.name}
              <span className="report__h2-sub">
                City manager · region {region.name} · {n(cm.headcount)} promotores
              </span>
            </h2>
            <FourUp m={cm} closed={closed} />
            {cm.supervisors && <LevelTable rows={cm.supervisors} label="Supervisor" closed={closed} />}

            {has('supervisores') &&
              cm.supervisors?.map((sp) => (
                <div className="report__block" key={sp.key}>
                  <h3 className="report__h3">
                    Equipo de {sp.name}
                    <span className="report__h3-sub">
                      {n(sp.headcount)} promotores · meta {n(sp.target)} · venta {n(sp.so)} ({pct(sp.ach)}) ·{' '}
                      {closed ? 'cierre' : 'cierre proy.'} {n(sp.forecast)} ({pct(sp.projectedAch)})
                    </span>
                  </h3>
                  <PromoterTable rows={sp.promoters} closed={closed} />
                </div>
              ))}
          </section>
        ))}
    </>
  );
}

function LevelTable({ rows, label, closed }) {
  return (
    <table className="report__table report__table--data">
      <thead>
        <tr>
          <th>{label}</th>
          <th className="num">Promotores</th>
          <th className="num">Meta</th>
          <th className="num">Venta</th>
          <th className="num">ACH%</th>
          <th className="num">{closed ? 'Cierre' : 'Cierre proy.'}</th>
          <th className="num">% cierre</th>
          <th className="num">Pzs/dia</th>
          <th className="num">Req./dia</th>
          <th>Estatus</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="name">{r.name}</td>
            <td className="num">{n(r.headcount)}</td>
            <td className="num">{n(r.target)}</td>
            <td className="num">{n(r.so)}</td>
            <td className="num">{pct(r.ach)}</td>
            <td className="num">{n(r.forecast)}</td>
            <td className="num">{pct(r.projectedAch)}</td>
            <td className="num">{d1(r.dailyAvg)}</td>
            <td className="num">{closed ? '—' : d1(r.requiredDaily)}</td>
            <td>
              <StatusText status={r.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PromoterTable({ rows, closed }) {
  if (!rows?.length) return <p className="report__note">Sin promotores en el alcance.</p>;
  return (
    <table className="report__table report__table--data">
      <thead>
        <tr>
          <th>Promotor</th>
          <th>Tienda</th>
          <th className="num">Meta</th>
          <th className="num">Venta</th>
          <th className="num">ACH%</th>
          <th className="num">{closed ? 'Cierre' : 'Cierre proy.'}</th>
          <th className="num">% cierre</th>
          <th className="num">Dias</th>
          <th className="num">Cero</th>
          <th className="num">Pzs/dia</th>
          <th>Estatus</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.key}>
            <td className="name">{p.name}</td>
            <td>
              {p.store}
              {(p.storeCount || 1) > 1 ? ` (+${p.storeCount - 1})` : ''}
            </td>
            <td className="num">{n(p.target)}</td>
            <td className="num">{n(p.so)}</td>
            <td className="num">{pct(p.ach)}</td>
            <td className="num">{n(p.forecast)}</td>
            <td className="num">{pct(p.projectedAch)}</td>
            <td className="num">{n(p.attendanceDays)}</td>
            <td className="num">{n(p.zeroSaleDays)}</td>
            <td className="num">{d2(p.productivity)}</td>
            <td>
              <StatusText status={p.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------------------------- ficha de promotor ---------------------------- */

function PromoterSection({ p, ctx, closed }) {
  return (
    <section className="report__section">
      <h2 className="report__h2">
        {p.name}
        <span className="report__h2-sub">
          {p.region} · {p.cm || 'sin CM'} · supervisor {p.supervisor || 'sin asignar'} · plaza {p.employment}
        </span>
      </h2>
      <FourUp m={p} closed={closed} />

      <table className="report__table">
        <tbody>
          <Row2
            a={[(p.storeCount || 1) > 1 ? 'Tiendas' : 'Tienda', (p.stores || [p.store]).join(' · ')]}
            b={['Canal', p.channel]}
          />
          <Row2
            a={['Dias trabajados', `${n(p.attendanceDays)} de ${n(ctx.cutoffDay)}`]}
            b={['Dias en cero', `${n(p.zeroSaleDays)} (${pct(p.zeroSaleRate)})`]}
          />
          <Row2
            a={['Productividad', `${d2(p.productivity)} pzs por dia trabajado`]}
            b={[
              closed ? 'Faltante final' : 'Ritmo requerido',
              closed ? `${n(Math.max(0, p.gap ?? 0))} pzs` : `${d1(p.requiredDaily)} pzs/dia en ${n(p.remainingDays)} dias`,
            ]}
          />
        </tbody>
      </table>

      {p.stores?.length > 1 && (
        <>
          <h3 className="report__h3">Venta por tienda</h3>
          <table className="report__table report__table--data">
            <thead>
              <tr>
                <th>Tienda</th>
                <th>Canal</th>
                <th>Plaza</th>
                <th className="num">Meta</th>
                <th className="num">Venta</th>
                <th className="num">Participacion</th>
                <th className="num">Dias en piso</th>
                <th className="num">Dias en cero</th>
                <th className="num">Pzs/dia</th>
              </tr>
            </thead>
            <tbody>
              {p.stores.map((s) => (
                <tr key={s.key}>
                  <td className="name">{s.store}</td>
                  <td>{s.channel}</td>
                  <td>{s.employment}</td>
                  <td className="num">{s.target ? n(s.target) : '—'}</td>
                  <td className="num">{n(s.so)}</td>
                  <td className="num">{pct(s.share)}</td>
                  <td className="num">{n(s.workedDays)}</td>
                  <td className="num">{n(s.zeroDays)}</td>
                  <td className="num">{d2(s.productivity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {p.models?.length > 0 && (
        <>
          <h3 className="report__h3">Mezcla de modelos</h3>
          <table className="report__table report__table--data">
            <thead>
              <tr>
                <th>Modelo</th>
                <th className="num">Piezas</th>
                <th className="num">Participacion</th>
              </tr>
            </thead>
            <tbody>
              {p.models.map((m) => (
                <tr key={m.model}>
                  <td>{m.model}</td>
                  <td className="num">{n(m.qty)}</td>
                  <td className="num">{pct(p.soAll ? m.qty / p.soAll : null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {p.daily && (
        <>
          <h3 className="report__h3">Detalle dia por dia</h3>
          <table className="report__table report__table--data report__table--compact">
            <thead>
              <tr>
                <th className="num">Dia</th>
                <th>Sem.</th>
                <th>Asistio</th>
                <th className="num">Venta foco</th>
                <th className="num">Venta total</th>
                <th className="num">Acumulado</th>
              </tr>
            </thead>
            <tbody>
              {p.daily.map((d) => (
                <tr key={d.day} className={d.isFuture ? 'is-future' : undefined}>
                  <td className="num">{d.day}</td>
                  <td>{d.weekday}</td>
                  <td>{d.isFuture ? '—' : d.attendance > 0 ? 'Si' : 'No'}</td>
                  <td className="num">{d.isFuture ? '—' : n(d.so)}</td>
                  <td className="num">{d.isFuture ? '—' : n(d.soAll)}</td>
                  <td className="num">{d.cumulative === null ? '—' : n(d.cumulative)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

/* ------------------------- bajo rendimiento ------------------------- */

function LowPerformanceSection({ lp, ctx, closed }) {
  const c = lp.counts;
  const g = lp.groups;
  const cierre = closed ? 'cierre' : 'cierre proyectado';

  return (
    <section className="report__section">
      <h2 className="report__h2">
        Bajo rendimiento
        <span className="report__h2-sub">
          Per capita minimo {d1(lp.minDaily)} pzs por dia trabajado · minimo requerido 60% del {cierre}
        </span>
      </h2>

      <div className="report__kpis">
        <Figure
          label="Prioridad de atencion"
          value={n(c.both)}
          note={`no llegan al per capita y ademas cierran bajo el 60%`}
          status={c.both ? 'fuera_de_meta' : undefined}
        />
        <Figure label={`Bajo ${d1(lp.minDaily)} pzs/dia`} value={n(c.belowRate)} note={`de ${n(lp.evaluated)} promotores con meta`} />
        <Figure label="Bajo el minimo del 60%" value={n(c.belowMinimum)} note={closed ? 'al cierre real' : 'en el cierre proyectado'} />
        <Figure
          label="Piezas para llevarlos al 60%"
          value={n(lp.impact.gapToMinimum)}
          unit="pzs"
          note={closed ? 'faltaron al cierre' : `en ${n(ctx.daysInMonth - ctx.cutoffDay)} dias restantes`}
        />
      </div>

      <p className="report__note">
        Las dos condiciones no coinciden y por eso el reporte va en tres bloques. En este corte{' '}
        <strong>{n(c.onlyRate)}</strong> promotores estan por debajo de {d1(lp.minDaily)} pzs por dia trabajado y aun
        asi cierran por encima del 60% —normalmente porque su meta es baja o porque acumulan muchos dias en piso—, y{' '}
        <strong>{n(c.onlyMinimum)}</strong> superan el per capita pero no alcanzan el minimo del mes. El bloque que pide
        accion inmediata es el primero.
        {lp.vacancies > 0 && (
          <>
            {' '}
            Se incluyen {n(lp.vacancies)} plazas vacantes, marcadas como tales: no tienen a quien acompañar, se cubren
            contratando.
          </>
        )}
      </p>

      <LowBlock
        title="1. No llegan al per capita ni al minimo del 60%"
        subtitle="Prioridad: venden poco cada dia y el mes no alcanza."
        rows={g.ambas}
        closed={closed}
        empty="Ningun promotor cae en ambas condiciones."
      />
      <LowBlock
        title="2. Cierran bajo el 60% aunque si llegan al per capita"
        subtitle="El ritmo por dia es correcto; lo que falta son dias en piso o una meta fuera de alcance."
        rows={g.solo_minimo}
        closed={closed}
        empty="Ninguno."
      />
      <LowBlock
        title={`3. Bajo ${d1(lp.minDaily)} pzs/dia pero cierran sobre el 60%`}
        subtitle="Informativo: no ponen en riesgo el minimo, pero hay recorrido en su venta diaria."
        rows={g.solo_percapita}
        closed={closed}
        empty="Ninguno."
      />
    </section>
  );
}

function LowBlock({ title, subtitle, rows, closed, empty }) {
  return (
    <div className="report__block">
      <h3 className="report__h3">
        {title}
        <span className="report__h3-sub">
          {rows.length ? `${rows.length} promotores · ${subtitle}` : subtitle}
        </span>
      </h3>
      {!rows.length ? (
        <p className="report__note">{empty}</p>
      ) : (
        <table className="report__table report__table--data">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Promotor</th>
              <th>Tienda</th>
              <th>Supervisor</th>
              <th className="num">Meta</th>
              <th className="num">Venta</th>
              <th className="num">ACH%</th>
              <th className="num">Dias</th>
              <th className="num">Pzs/dia</th>
              <th className="num">{closed ? 'Cierre' : 'Cierre proy.'}</th>
              <th className="num">% cierre</th>
              <th className="num">{closed ? 'Falto para 60%' : 'Pzs/dia para 60%'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr key={p.key}>
                <td className="num">{i + 1}</td>
                <td className="name">
                  {p.name}
                  {p.isVacancy && <span className="report__flag"> plaza vacante</span>}
                </td>
                <td>
                  {p.store}
                  {(p.storeCount || 1) > 1 ? ` (+${p.storeCount - 1})` : ''}
                </td>
                <td>{p.supervisor || '—'}</td>
                <td className="num">{n(p.target)}</td>
                <td className="num">{n(p.so)}</td>
                <td className="num">{pct(p.ach)}</td>
                <td className="num">{n(p.attendanceDays)}</td>
                <td className="num">{d2(p.productivity)}</td>
                <td className="num">{n(p.forecast)}</td>
                <td className="num">{pct(p.projectedAch)}</td>
                <td className="num">{closed ? n(p.missingForMinimum) : d1(p.dailyForMinimum)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
