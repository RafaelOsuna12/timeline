/** Ficha individual de un promotor: dia a dia, modelos y comparativo con su equipo. */
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useData, useQuery } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import { AchCell, Card, DataTable, Empty, ErrorBox, Kpi, Spinner, StatusPill } from '../components/ui.jsx';
import { AdvanceCurve, DailyBars, ShareBars } from '../components/charts/index.jsx';
import { d1, d2, n, pct, statusTone } from '../utils/format.js';

export default function PromoterDetail() {
  const { id } = useParams();
  const { filters, hasData } = useData();
  const { data, error, loading } = useQuery(
    (signal) => api.promoter(id, filters, signal),
    [id, JSON.stringify(filters)],
    { skip: !hasData }
  );

  return (
    <AppShell
      title={data ? data.promoter.name : 'Promotor'}
      subtitle={data ? `${data.promoter.store} · ${data.promoter.channel}` : ''}
      actions={
        <Link to="/promotores" className="btn btn--sm">
          Volver al listado
        </Link>
      }
    >
      <ErrorBox error={error} />
      {loading && !data && <Spinner />}
      {data && <Detail data={data} />}
      {!loading && !data && !error && <Empty>No se encontro al promotor.</Empty>}
    </AppShell>
  );
}

function Detail({ data }) {
  const p = data.promoter;
  const ctx = data.context;
  const closed = ctx.cutoffDay >= ctx.daysInMonth;

  // Se reconstruye la curva de avance con el mismo formato que usa el resumen.
  const daily = data.daily.map((d) => ({
    ...d,
    targetCurve: p.target ? (p.target / ctx.daysInMonth) * d.day : null,
    projection: d.day >= ctx.cutoffDay ? projectionAt(data.daily, ctx, p, d.day) : null,
  }));

  return (
    <div className="stack">
      <section className="kpis">
        <Kpi
          label="Sell-out modelos foco"
          value={n(p.so)}
          unit="pzs"
          meta={`Target ${n(p.target)} · faltan ${n(Math.max(0, p.gap ?? 0))}`}
          progress={p.ach}
          marker={p.timeProgress}
        />
        <Kpi label="Avance" value={pct(p.ach)} meta={`Tiempo transcurrido ${pct(p.timeProgress, 0)}`} progress={p.ach} marker={p.timeProgress} />
        <Kpi
          label={closed ? 'Cierre real' : 'Cierre proyectado'}
          value={n(p.forecast)}
          unit="pzs"
          meta={`${pct(p.projectedAch)} del target`}
          tone={statusTone(p.status)}
        />
        <Kpi label="Sell-out total" value={n(p.soAll)} unit="pzs" meta={`Incluye ${n(p.soIot)} pzs de IOT`} />
        <Kpi
          label="Asistencia"
          value={`${n(p.attendanceDays)}/${ctx.cutoffDay}`}
          unit="dias"
          meta={`${n(p.zeroSaleDays)} dias sin vender (${pct(p.zeroSaleRate)})`}
        />
        <Kpi label="Productividad" value={d2(p.productivity)} unit="pzs/dia asistido" meta={data.peerAverage ? `Promedio del equipo ${d2(data.peerAverage.productivity)}` : undefined} />
      </section>

      <Card title="Ficha" >
        <div className="table-wrap">
          <table className="data">
            <tbody>
              <tr>
                <th className="is-static">Region</th>
                <td>{p.region}</td>
                <th className="is-static">City manager</th>
                <td>{p.cm || '—'}</td>
              </tr>
              <tr>
                <th className="is-static">Supervisor</th>
                <td>{p.supervisor || '—'}</td>
                <th className="is-static">Tipo de plaza</th>
                <td>{p.employment}</td>
              </tr>
              <tr>
                <th className="is-static">Tienda</th>
                <td>{p.store}</td>
                <th className="is-static">Estatus</th>
                <td>
                  <StatusPill status={p.status} />
                </td>
              </tr>
              <tr>
                <th className="is-static">Ritmo actual</th>
                <td>{d1(p.dailyAvg)} pzs/dia</td>
                <th className="is-static">{closed ? 'Mes cerrado' : 'Ritmo requerido'}</th>
                <td>{closed ? '—' : `${d1(p.requiredDaily)} pzs/dia`}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Avance acumulado" hint="Acumulado del promotor contra el reparto lineal de su target.">
        <AdvanceCurve daily={daily} target={p.target} cutoffDay={ctx.cutoffDay} height={250} />
      </Card>

      <Card title="Sell-out diario" hint="Los dias sin barra y sin asistencia registrada aparecen en la tabla de abajo.">
        <DailyBars daily={data.daily} height={220} />
      </Card>

      <div className="grid grid--2">
        <Card title="Mezcla de modelos" hint="Piezas por modelo foco en el mes.">
          {data.models.length ? <ShareBars data={data.models} /> : <Empty>Sin desglose de modelos.</Empty>}
        </Card>

        <Card title="Detalle diario" hint="Asistencia, venta y acumulado dia por dia.">
          <DataTable
            columns={[
              { key: 'day', label: 'Dia', numeric: true },
              { key: 'weekday', label: 'Dia sem.', cellClass: 'dim' },
              { key: 'attendance', label: 'Asistio', render: (d) => (d.isFuture ? '—' : d.attendance > 0 ? 'Si' : 'No') },
              { key: 'so', label: 'SO foco', numeric: true, render: (d) => (d.isFuture ? '—' : n(d.so)) },
              { key: 'soAll', label: 'SO total', numeric: true, render: (d) => (d.isFuture ? '—' : n(d.soAll)) },
              { key: 'cumulative', label: 'Acumulado', numeric: true, render: (d) => (d.cumulative === null ? '—' : n(d.cumulative)) },
            ]}
            rows={data.daily}
            rowKey={(d) => d.day}
            initialSort={{ key: 'day', dir: 'asc' }}
          />
        </Card>
      </div>

      {data.modelDaily.length > 0 && (
        <Card title="Evolucion por modelo" hint="Piezas acumuladas de cada modelo con seguimiento diario.">
          <DataTable
            columns={[
              { key: 'model', label: 'Modelo', cellClass: 'name' },
              { key: 'total', label: 'Piezas', numeric: true, render: (m) => n(m.total) },
              {
                key: 'share',
                label: 'Participacion',
                numeric: true,
                sortValue: (m) => m.total,
                render: (m) => <AchCell value={p.so ? m.total / p.so : null} />,
              },
            ]}
            rows={data.modelDaily}
            rowKey={(m) => m.model}
            initialSort={{ key: 'total', dir: 'desc' }}
          />
        </Card>
      )}
    </div>
  );
}

/** Proyeccion acumulada del promotor con el promedio por dia de la semana. */
function projectionAt(daily, ctx, promoter, day) {
  const observed = daily.filter((d) => d.day <= ctx.cutoffDay);
  const mtd = observed.reduce((a, b) => a + b.so, 0);
  if (day === ctx.cutoffDay) return mtd;
  const byWeekday = {};
  for (const d of observed) {
    if (!byWeekday[d.weekday]) byWeekday[d.weekday] = { total: 0, days: 0 };
    byWeekday[d.weekday].total += d.so;
    byWeekday[d.weekday].days += 1;
  }
  const avg = observed.length ? mtd / observed.length : 0;
  let acc = mtd;
  for (const d of daily) {
    if (d.day <= ctx.cutoffDay || d.day > day) continue;
    const b = byWeekday[d.weekday];
    acc += b && b.days ? b.total / b.days : avg;
  }
  return Math.round(acc * 10) / 10;
}
