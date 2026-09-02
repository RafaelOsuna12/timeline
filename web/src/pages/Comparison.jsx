/** Avance entre dos cargas del mismo periodo (por ejemplo hoy contra ayer). */
import { api } from '../api.js';
import { useData, useQuery } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { Card, DataTable, Empty, ErrorBox, Kpi, Spinner } from '../components/ui.jsx';
import { DeltaBars } from '../components/charts/index.jsx';
import { d1, n, pct, signed } from '../utils/format.js';

export default function Comparison() {
  const { filters, hasData } = useData();
  const { data, error, loading, refreshing } = useQuery(
    (signal) => api.comparison(filters, signal),
    [JSON.stringify(filters)],
    { skip: !hasData }
  );

  return (
    <AppShell
      title="Avance entre cargas"
      subtitle="Cuanto se movio cada equipo desde la actualizacion anterior"
      filterBar={<FilterBar showDaySlider={false} />}
    >
      {!hasData && <Empty>Aun no hay informacion cargada.</Empty>}
      <ErrorBox error={error} />
      {loading && !data && <Spinner />}
      {data && !data.available && (
        <Empty>
          {data.message || 'Se necesita mas de una carga del mismo periodo para comparar.'}
          <br />
          Sube el archivo actualizado cada dia y esta vista mostrara el avance diario de cada equipo.
        </Empty>
      )}
      {data?.available && (
        <div className={`stack${refreshing ? ' is-refreshing' : ''}`}>
          <section className="kpis">
            <Kpi
              label="Piezas ganadas"
              value={signed(data.total.delta)}
              unit="pzs"
              meta={`De ${n(data.total.soPrevious)} a ${n(data.total.so)} piezas`}
              tone={data.total.delta >= 0 ? 'good' : 'critical'}
            />
            <Kpi
              label="Dias avanzados"
              value={n(data.total.daysAdvanced)}
              unit={data.total.daysAdvanced === 1 ? 'dia' : 'dias'}
              meta={`Del dia ${data.previous.cutoffDay} al dia ${data.current.cutoffDay}`}
            />
            <Kpi
              label="Ritmo del periodo"
              value={d1(data.total.daysAdvanced ? data.total.delta / data.total.daysAdvanced : null)}
              unit="pzs/dia"
              meta="Piezas ganadas entre dias transcurridos"
            />
            <Kpi
              label="Cambio en el cierre proyectado"
              value={signed(data.total.forecast - data.total.forecastPrevious)}
              unit="pzs"
              meta={`De ${n(data.total.forecastPrevious)} a ${n(data.total.forecast)} piezas proyectadas`}
              tone={data.total.forecast >= data.total.forecastPrevious ? 'good' : 'critical'}
            />
          </section>

          <DeltaSection title="Avance por region" rows={data.regions} />
          <DeltaSection title="Avance por city manager" rows={data.cms} />
          <DeltaSection title="Avance por supervisor" rows={data.supervisors} />
          <DeltaSection title="Avance por canal" rows={data.channels} />
        </div>
      )}
    </AppShell>
  );
}

function DeltaSection({ title, rows }) {
  if (!rows.length) return null;
  return (
    <Card title={title} hint="Piezas ganadas desde la carga anterior. En azul avanza, en rojo retrocede (correcciones del archivo).">
      <DeltaBars data={rows} format={(v) => signed(v)} />
      <DataTable
        columns={[
          { key: 'name', label: 'Equipo', cellClass: 'name' },
          { key: 'soPrevious', label: 'Antes', numeric: true, render: (r) => n(r.soPrevious) },
          { key: 'so', label: 'Ahora', numeric: true, render: (r) => n(r.so) },
          {
            key: 'delta',
            label: 'Avance',
            numeric: true,
            render: (r) => <span className={r.delta >= 0 ? 'delta--up tnum' : 'delta--down tnum'}>{signed(r.delta)}</span>,
          },
          { key: 'ach', label: 'ACH% ahora', numeric: true, render: (r) => pct(r.ach) },
          {
            key: 'achDelta',
            label: 'Cambio ACH%',
            numeric: true,
            render: (r) =>
              r.achDelta === null ? (
                '—'
              ) : (
                <span className={r.achDelta >= 0 ? 'delta--up tnum' : 'delta--down tnum'}>
                  {r.achDelta >= 0 ? '+' : '−'}
                  {Math.abs(r.achDelta * 100).toFixed(1)} pp
                </span>
              ),
          },
          { key: 'forecast', label: 'Cierre proy.', numeric: true, render: (r) => n(r.forecast) },
        ]}
        rows={rows}
        initialSort={{ key: 'delta', dir: 'desc' }}
      />
    </Card>
  );
}
