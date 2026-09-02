/**
 * Asistencia y dias en cero.
 * Explica si un equipo no llega por falta de cobertura o por falta de conversion.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useData, useQuery } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { Card, DataTable, Empty, ErrorBox, Kpi, Spinner, ViewToggle } from '../components/ui.jsx';
import { DailyBars, HeatLegend, Heatmap } from '../components/charts/index.jsx';
import { d2, n, pct } from '../utils/format.js';

export default function Attendance() {
  const { filters, hasData } = useData();
  const navigate = useNavigate();
  const [view, setView] = useState('chart');
  const [limit, setLimit] = useState(40);

  const { data, error, loading, refreshing } = useQuery(
    (signal) => api.attendance(filters, signal),
    [JSON.stringify(filters)],
    { skip: !hasData }
  );

  const stats = useMemo(() => {
    if (!data) return null;
    const rows = data.promoters;
    const cutoff = data.context.cutoffDay;
    const worked = rows.reduce((a, r) => a + r.workedDays, 0);
    const zero = rows.reduce((a, r) => a + r.zeroDays, 0);
    const possible = rows.length * cutoff;
    return {
      coverage: possible ? worked / possible : null,
      worked,
      zero,
      zeroRate: worked ? zero / worked : null,
      lowCoverage: rows.filter((r) => r.coverage !== null && r.coverage < 0.7).length,
      maxSo: Math.max(...rows.flatMap((r) => r.so), 1),
    };
  }, [data]);

  const heatRows = useMemo(() => (data ? data.promoters.slice(0, limit) : []), [data, limit]);

  return (
    <AppShell title="Asistencia y cero venta" subtitle="Cobertura de piso y efectividad diaria" filterBar={<FilterBar />}>
      {!hasData && <Empty>Aun no hay informacion cargada.</Empty>}
      <ErrorBox error={error} />
      {loading && !data && <Spinner />}
      {data && stats && (
        <div className={`stack${refreshing ? ' is-refreshing' : ''}`}>
          <section className="kpis">
            <Kpi
              label="Cobertura de piso"
              value={pct(stats.coverage)}
              meta={`${n(stats.worked)} dias trabajados sobre ${n(data.promoters.length * data.context.cutoffDay)} posibles`}
              progress={stats.coverage}
              tone={stats.coverage < 0.85 ? 'warning' : 'good'}
            />
            <Kpi
              label="Dias en cero"
              value={pct(stats.zeroRate)}
              meta={`${n(stats.zero)} dias con asistencia pero sin venta de modelos foco`}
              progress={stats.zeroRate}
              tone={stats.zeroRate > 0.35 ? 'critical' : 'warning'}
            />
            <Kpi
              label="Promotores con baja cobertura"
              value={n(stats.lowCoverage)}
              meta="Menos del 70% de los dias del corte"
              tone={stats.lowCoverage ? 'warning' : undefined}
            />
            <Kpi label="Promotores en el corte" value={n(data.headcount)} meta="Segun los filtros aplicados" />
          </section>

          <Card
            title="Asistencia y venta por dia"
            hint="Barras: piezas vendidas. Compara la curva de asistencia de la tabla para ver si las caidas son de cobertura o de conversion."
          >
            <DailyBars daily={data.byDay} height={220} showAverage={false} />
            <DataTable
              columns={[
                { key: 'day', label: 'Dia', numeric: true },
                { key: 'weekday', label: 'Dia sem.', cellClass: 'dim' },
                { key: 'present', label: 'Promotores en piso', numeric: true, render: (d) => (d.isFuture ? '—' : n(d.present)) },
                { key: 'so', label: 'Piezas', numeric: true, render: (d) => (d.isFuture ? '—' : n(d.so)) },
                { key: 'zeroSale', label: 'En cero', numeric: true, render: (d) => (d.isFuture ? '—' : n(d.zeroSale)) },
                {
                  key: 'rate',
                  label: 'Pzs por promotor',
                  numeric: true,
                  sortValue: (d) => (d.present ? d.so / d.present : 0),
                  render: (d) => (d.isFuture ? '—' : d2(d.present ? d.so / d.present : null)),
                },
              ]}
              rows={data.byDay}
              rowKey={(d) => d.day}
              initialSort={{ key: 'day', dir: 'asc' }}
            />
          </Card>

          <Card
            title="Mapa de calor por promotor"
            hint="Cada celda es un dia. La intensidad es el numero de piezas; las celdas claras con borde son dias en piso sin venta y las grises son ausencias."
            actions={
              <div className="row">
                <ViewToggle value={view} onChange={setView} />
                {view === 'chart' && data.promoters.length > limit && (
                  <button type="button" className="btn btn--sm" onClick={() => setLimit((l) => l + 40)}>
                    Ver mas
                  </button>
                )}
              </div>
            }
          >
            {view === 'chart' ? (
              <>
                <HeatLegend max={stats.maxSo} />
                <Heatmap
                  rows={heatRows}
                  days={data.context.daysInMonth}
                  cutoffDay={data.context.cutoffDay}
                  max={stats.maxSo}
                  onSelect={(row) => navigate(`/promotores/${encodeURIComponent(row.key)}`)}
                />
                <p className="card__hint" style={{ marginTop: 10 }}>
                  Mostrando {heatRows.length} de {data.promoters.length} promotores, ordenados por menor cobertura.
                </p>
              </>
            ) : (
              <DataTable
                columns={[
                  { key: 'name', label: 'Promotor', cellClass: 'name' },
                  { key: 'store', label: 'Tienda', cellClass: 'dim' },
                  { key: 'supervisor', label: 'Supervisor', cellClass: 'dim' },
                  { key: 'workedDays', label: 'Dias trabajados', numeric: true, render: (r) => n(r.workedDays) },
                  { key: 'coverage', label: 'Cobertura', numeric: true, render: (r) => pct(r.coverage) },
                  { key: 'zeroDays', label: 'Dias en cero', numeric: true, render: (r) => n(r.zeroDays) },
                  { key: 'zeroRate', label: '% en cero', numeric: true, render: (r) => pct(r.zeroRate) },
                  { key: 'productivity', label: 'Pzs/dia asistido', numeric: true, render: (r) => d2(r.productivity) },
                ]}
                rows={data.promoters}
                initialSort={{ key: 'coverage', dir: 'asc' }}
                onRowClick={(r) => navigate(`/promotores/${encodeURIComponent(r.key)}`)}
              />
            )}
          </Card>
        </div>
      )}
    </AppShell>
  );
}
