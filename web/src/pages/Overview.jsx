/**
 * Resumen ejecutivo: como va el mes, como va a cerrar y donde esta el problema.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadCsv } from '../api.js';
import { useData, useQuery } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { AchCell, BarCell, Card, DataTable, Empty, ErrorBox, Kpi, Spinner, StatusPill, ViewToggle } from '../components/ui.jsx';
import { AdvanceCurve, DailyBars, RankingBars, ShareBars, WeekdayProfile } from '../components/charts/index.jsx';
import { d1, d2, n, pct } from '../utils/format.js';

export default function Overview() {
  const { filters, hasData } = useData();
  const { data, error, loading, refreshing } = useQuery(
    (signal) => api.overview(filters, signal),
    [JSON.stringify(filters)],
    { skip: !hasData }
  );

  return (
    <AppShell
      title="Resumen ejecutivo"
      subtitle="Avance del mes y proyeccion de cierre"
      filterBar={<FilterBar />}
      actions={
        data && (
          <button type="button" className="btn btn--sm" onClick={() => downloadCsv('diario', filters)}>
            Exportar diario CSV
          </button>
        )
      }
    >
      {!hasData && <Empty>Aun no hay informacion cargada. Ve a “Cargar archivo” y sube el Excel del reporte diario.</Empty>}
      <ErrorBox error={error} />
      {loading && !data && <Spinner label="Calculando el avance…" />}
      {data && <OverviewBody data={data} refreshing={refreshing} filters={filters} />}
    </AppShell>
  );
}

function OverviewBody({ data, refreshing, filters }) {
  const t = data.total;
  const ctx = data.context;
  const closed = ctx.cutoffDay >= ctx.daysInMonth;

  return (
    <div className={`stack${refreshing ? ' is-refreshing' : ''}`}>
      {ctx.isReplay && (
        <div className="alert alert--info">
          <div>
            <div className="alert__title">Vista retrospectiva</div>
            <div className="alert__detail">
              Estas viendo el mes como se veia al cierre del dia {ctx.cutoffDay}. La informacion cargada llega hasta el
              dia {ctx.realCutoffDay}.
            </div>
          </div>
        </div>
      )}

      <section className="kpis">
        <Kpi
          label="Sell-out modelos foco"
          value={n(t.so)}
          unit="pzs"
          meta={`Target ${n(t.target)} · faltan ${n(Math.max(0, t.gap ?? 0))}`}
          progress={t.ach}
          marker={t.timeProgress}
          tone={t.ach >= 1 ? 'good' : undefined}
        />
        <Kpi
          label="Avance vs. target"
          value={pct(t.ach)}
          meta={`Tiempo transcurrido ${pct(t.timeProgress, 0)} (dia ${ctx.cutoffDay} de ${ctx.daysInMonth})`}
          progress={t.ach}
          marker={t.timeProgress}
          tone={t.pace >= 1 ? 'good' : t.pace >= 0.9 ? 'warning' : 'critical'}
        />
        <Kpi
          label={closed ? 'Cierre real' : 'Cierre proyectado'}
          value={n(t.forecast)}
          unit="pzs"
          meta={`${pct(t.projectedAch)} del target · ${t.projectedGap >= 0 ? 'sobre' : 'bajo'} meta por ${n(
            Math.abs(t.projectedGap ?? 0)
          )} pzs`}
          tone={t.status === 'en_meta' ? 'good' : t.status === 'en_riesgo' ? 'warning' : 'critical'}
        />
        <Kpi
          label="Ritmo diario"
          value={d1(t.dailyAvg)}
          unit="pzs/dia"
          meta={
            closed
              ? 'Mes cerrado'
              : `Se necesitan ${d1(t.requiredDaily)} pzs/dia en los ${t.remainingDays} dias restantes`
          }
          tone={!closed && t.effortIndex > 1.15 ? 'critical' : undefined}
        />
        <Kpi
          label="Sell-out total (todas las series)"
          value={n(t.soAll)}
          unit="pzs"
          meta={`Incluye ${n(t.soIot)} pzs de IOT · ${pct(t.achAll)} del target HQ`}
        />
        <Kpi
          label="Productividad"
          value={d2(t.productivity)}
          unit="pzs/dia asistido"
          meta={`${n(t.attendanceDays)} dias trabajados · ${pct(t.zeroSaleRate)} en cero`}
        />
      </section>

      <div className="grid grid--wide-left">
        <Card
          title="Curva de avance y proyeccion de cierre"
          hint="El acumulado real se compara con la curva de target repartida segun el peso historico de cada dia de la semana. La proyeccion aplica ese mismo patron a los dias que faltan."
        >
          <AdvanceCurve daily={data.daily} target={t.target} cutoffDay={ctx.cutoffDay} height={310} />
          <ForecastScenarios total={t} closed={closed} />
        </Card>

        <Card title="Alertas" hint="Ordenadas por impacto en el cierre del mes.">
          {data.alerts.length === 0 ? (
            <Empty>Sin alertas: todas las regiones proyectan cumplir el target.</Empty>
          ) : (
            <div className="stack" style={{ gap: 8, maxHeight: 420, overflowY: 'auto' }}>
              {data.alerts.map((a, i) => (
                <div className={`alert alert--${a.level}`} key={`${a.scope}-${a.entity}-${i}`}>
                  <div>
                    <div className="alert__title">{a.title}</div>
                    <div className="alert__detail">{a.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Sell-out diario"
        hint="Barras: piezas de modelos foco vendidas cada dia. Linea: promedio movil de 7 dias para ver la tendencia sin el ruido del fin de semana."
      >
        <DailyBars daily={data.daily} height={260} />
      </Card>

      <div className="grid grid--2">
        <RegionCard regions={data.regions} />
        <Card
          title="Estacionalidad por dia de la semana"
          hint="Promedio de piezas por dia de la semana en lo que va del mes. Es el patron que usa la proyeccion."
        >
          <WeekdayProfile data={data.weekdayProfile} />
        </Card>
      </div>

      <div className="grid grid--2">
        <ChannelCard channels={data.channels} />
        <Card title="Mezcla de modelos foco" hint="Piezas vendidas por modelo en el periodo.">
          <ShareBars data={data.models} />
        </Card>
      </div>

      <SupervisorCard supervisors={data.supervisors} filters={filters} />

      <div className="grid grid--2">
        <RankingCard
          title="Mejor desempeño"
          hint="Promotores con mayor cumplimiento sobre su propio target."
          rows={data.ranking.topPromoters}
        />
        <RankingCard
          title="Requieren atencion"
          hint="Promotores con el menor cumplimiento; son la palanca mas rapida para recuperar el target."
          rows={data.ranking.bottomPromoters}
        />
      </div>
    </div>
  );
}

function ForecastScenarios({ total, closed }) {
  if (closed) {
    return (
      <p className="card__hint" style={{ marginTop: 10 }}>
        El mes esta cerrado: la cifra mostrada es el resultado final, no una estimacion.
      </p>
    );
  }
  const s = total.forecastScenarios;
  const items = [
    { label: 'Estacional (base)', value: s.estacional, hint: 'Aplica el promedio de cada dia de la semana' },
    { label: 'Ritmo simple', value: s.ritmo, hint: 'Promedio de todos los dias transcurridos' },
    { label: 'Tendencia reciente', value: s.reciente, hint: 'Promedio de los ultimos 7 dias' },
  ];
  return (
    <div className="table-wrap" style={{ marginTop: 12 }}>
      <table className="data">
        <thead>
          <tr>
            <th className="is-static">Escenario de cierre</th>
            <th className="num is-static">Piezas</th>
            <th className="num is-static">% del target</th>
            <th className="is-static">Criterio</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.label}>
              <td>{it.label}</td>
              <td className="num tnum">{n(it.value)}</td>
              <td className="num">
                <AchCell value={total.target ? it.value / total.target : null} />
              </td>
              <td className="dim">{it.hint}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RegionCard({ regions }) {
  const [view, setView] = useState('chart');
  const chartData = regions.map((r) => ({ ...r, value: r.ach ? r.ach * 100 : 0 }));
  return (
    <Card
      title="Cumplimiento por region"
      hint="Porcentaje del target alcanzado a la fecha de corte. La linea marca el 100%."
      actions={<ViewToggle value={view} onChange={setView} />}
    >
      {view === 'chart' ? (
        <RankingBars
          data={chartData}
          dataKey="value"
          format={(v) => `${Math.round(v)}%`}
          reference={100}
          referenceLabel="Target"
          height={Math.max(150, regions.length * 34 + 34)}
        />
      ) : (
        <DataTable
          columns={[
            { key: 'name', label: 'Region', cellClass: 'name' },
            { key: 'headcount', label: 'FF', numeric: true, render: (r) => n(r.headcount) },
            { key: 'target', label: 'Target', numeric: true, render: (r) => n(r.target) },
            { key: 'so', label: 'Sell-out', numeric: true, render: (r) => n(r.so) },
            { key: 'ach', label: 'ACH%', numeric: true, render: (r) => <AchCell value={r.ach} /> },
            { key: 'forecast', label: 'Cierre proy.', numeric: true, render: (r) => n(r.forecast) },
            { key: 'status', label: 'Estatus', render: (r) => <StatusPill status={r.status} /> },
          ]}
          rows={regions}
          initialSort={{ key: 'ach', dir: 'desc' }}
        />
      )}
    </Card>
  );
}

function ChannelCard({ channels }) {
  const max = Math.max(...channels.map((c) => c.so), 1);
  return (
    <Card title="Sell-out por canal" hint="Volumen y cumplimiento de cada cadena.">
      <DataTable
        columns={[
          { key: 'name', label: 'Canal', cellClass: 'name' },
          { key: 'headcount', label: 'FF', numeric: true, render: (c) => n(c.headcount) },
          { key: 'so', label: 'Sell-out', numeric: true, render: (c) => <BarCell value={c.so} max={max} /> },
          { key: 'target', label: 'Target', numeric: true, render: (c) => n(c.target) },
          { key: 'ach', label: 'ACH%', numeric: true, render: (c) => <AchCell value={c.ach} /> },
          { key: 'productivity', label: 'Pzs/dia', numeric: true, render: (c) => d2(c.productivity) },
        ]}
        rows={channels}
        initialSort={{ key: 'so', dir: 'desc' }}
      />
    </Card>
  );
}

function SupervisorCard({ supervisors, filters }) {
  const max = useMemo(() => Math.max(...supervisors.map((s) => s.so), 1), [supervisors]);
  return (
    <Card
      title="Supervisores"
      hint="Cada supervisor con su equipo, su avance y el ritmo que necesita para cerrar en meta."
      actions={
        <button type="button" className="btn btn--sm" onClick={() => downloadCsv('supervisores', filters)}>
          Exportar CSV
        </button>
      }
    >
      <DataTable
        columns={[
          { key: 'rank', label: '#', numeric: true, render: (s) => s.rank },
          { key: 'name', label: 'Supervisor', cellClass: 'name' },
          { key: 'headcount', label: 'Promotores', numeric: true, render: (s) => n(s.headcount) },
          { key: 'target', label: 'Target', numeric: true, render: (s) => n(s.target) },
          { key: 'so', label: 'Sell-out', numeric: true, render: (s) => <BarCell value={s.so} max={max} /> },
          { key: 'ach', label: 'ACH%', numeric: true, render: (s) => <AchCell value={s.ach} /> },
          { key: 'forecast', label: 'Cierre proy.', numeric: true, render: (s) => n(s.forecast) },
          { key: 'requiredDaily', label: 'Req. pzs/dia', numeric: true, render: (s) => d1(s.requiredDaily) },
          { key: 'zeroSaleRate', label: 'Dias en cero', numeric: true, render: (s) => pct(s.zeroSaleRate) },
          { key: 'status', label: 'Estatus', render: (s) => <StatusPill status={s.status} /> },
        ]}
        rows={supervisors}
        initialSort={{ key: 'ach', dir: 'desc' }}
      />
    </Card>
  );
}

function RankingCard({ title, hint, rows }) {
  return (
    <Card title={title} hint={hint}>
      <DataTable
        columns={[
          { key: 'name', label: 'Promotor', cellClass: 'name', render: (r) => (
            <Link to={`/promotores/${encodeURIComponent(r.key)}`}>{r.name}</Link>
          ) },
          { key: 'store', label: 'Tienda', cellClass: 'dim trunc', render: (r) => <span title={r.store}>{r.store}</span> },
          { key: 'so', label: 'SO', numeric: true, render: (r) => n(r.so) },
          { key: 'target', label: 'Target', numeric: true, render: (r) => n(r.target) },
          { key: 'ach', label: 'ACH%', numeric: true, render: (r) => <AchCell value={r.ach} /> },
        ]}
        rows={rows}
        emptyText="Sin promotores con target asignado."
      />
    </Card>
  );
}
