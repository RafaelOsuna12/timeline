/** Regiones y canales: quien aporta, quien cumple y como va cada uno. */
import { useState } from 'react';
import { api } from '../api.js';
import { useData, useQuery } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { AchCell, BarCell, Card, DataTable, Empty, ErrorBox, Kpi, Spinner, StatusPill, ViewToggle } from '../components/ui.jsx';
import { RankingBars } from '../components/charts/index.jsx';
import { d1, d2, n, pct, statusTone } from '../utils/format.js';

export default function Regions() {
  const { filters, hasData } = useData();
  const { data, error, loading, refreshing } = useQuery(
    (signal) => api.overview(filters, signal),
    [JSON.stringify(filters)],
    { skip: !hasData }
  );

  return (
    <AppShell title="Regiones y canales" subtitle="Aportacion, cumplimiento y proyeccion por region y cadena" filterBar={<FilterBar />}>
      {!hasData && <Empty>Aun no hay informacion cargada.</Empty>}
      <ErrorBox error={error} />
      {loading && !data && <Spinner />}
      {data && (
        <div className={`stack${refreshing ? ' is-refreshing' : ''}`}>
          <section className="kpis">
            {data.regions.map((r) => (
              <Kpi
                key={r.key}
                label={`${r.name} · ${n(r.headcount)} promotores`}
                value={pct(r.ach)}
                meta={`${n(r.so)} de ${n(r.target)} pzs · cierre proy. ${n(r.forecast)}`}
                progress={r.ach}
                marker={r.timeProgress}
                tone={statusTone(r.status)}
              />
            ))}
          </section>

          <Breakdown
            title="Detalle por region"
            hint="Cumplimiento al corte y cierre proyectado con el patron semanal de cada region."
            rows={data.regions}
            entityLabel="Region"
          />

          <Breakdown
            title="Detalle por city manager"
            hint="Cada CM agrupa a sus supervisores y al equipo completo de promotores."
            rows={data.cms}
            entityLabel="City manager"
          />

          <Breakdown
            title="Detalle por canal"
            hint="Comportamiento por cadena. AT&T y Movistar operan con pocas tiendas, por lo que su porcentaje se mueve mucho con pocas piezas."
            rows={data.channels}
            entityLabel="Canal"
          />
        </div>
      )}
    </AppShell>
  );
}

function Breakdown({ title, hint, rows, entityLabel }) {
  const [view, setView] = useState('table');
  const max = Math.max(...rows.map((r) => r.so), 1);
  const chartData = rows.map((r) => ({ ...r, value: r.ach ? Math.round(r.ach * 1000) / 10 : 0 }));

  return (
    <Card title={title} hint={hint} actions={<ViewToggle value={view} onChange={setView} />}>
      {view === 'chart' ? (
        <RankingBars data={chartData} dataKey="value" format={(v) => `${Math.round(v)}%`} reference={100} referenceLabel="Target" />
      ) : (
        <DataTable
          columns={[
            { key: 'name', label: entityLabel, cellClass: 'name' },
            { key: 'headcount', label: 'Promotores', numeric: true, render: (r) => n(r.headcount) },
            { key: 'target', label: 'Target', numeric: true, render: (r) => n(r.target) },
            { key: 'so', label: 'Sell-out', numeric: true, render: (r) => <BarCell value={r.so} max={max} /> },
            { key: 'soAll', label: 'Todas las series', numeric: true, render: (r) => n(r.soAll) },
            { key: 'ach', label: 'ACH%', numeric: true, render: (r) => <AchCell value={r.ach} /> },
            { key: 'forecast', label: 'Cierre proy.', numeric: true, render: (r) => n(r.forecast) },
            { key: 'projectedAch', label: 'ACH% proy.', numeric: true, render: (r) => <AchCell value={r.projectedAch} /> },
            { key: 'dailyAvg', label: 'Pzs/dia', numeric: true, render: (r) => d1(r.dailyAvg) },
            { key: 'requiredDaily', label: 'Req. pzs/dia', numeric: true, render: (r) => d1(r.requiredDaily) },
            { key: 'productivity', label: 'Pzs/dia asistido', numeric: true, render: (r) => d2(r.productivity) },
            { key: 'zeroSaleRate', label: 'Dias en cero', numeric: true, render: (r) => pct(r.zeroSaleRate) },
            { key: 'status', label: 'Estatus', render: (r) => <StatusPill status={r.status} /> },
          ]}
          rows={rows}
          initialSort={{ key: 'ach', dir: 'desc' }}
        />
      )}
    </Card>
  );
}
