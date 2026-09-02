/** Tabla maestra de promotores, con todas las metricas del mes. */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, downloadCsv } from '../api.js';
import { useData, useQuery } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { AchCell, BarCell, Card, DataTable, Empty, ErrorBox, Kpi, Spinner, StatusPill } from '../components/ui.jsx';
import { d1, d2, n, pct } from '../utils/format.js';

const GROUPS = {
  todos: () => true,
  riesgo: (p) => p.status === 'fuera_de_meta' || p.status === 'en_riesgo',
  meta: (p) => p.status === 'en_meta',
  sin_venta: (p) => p.so === 0,
  sin_asistencia: (p) => p.attendanceDays === 0,
};

const GROUP_LABELS = {
  todos: 'Todos',
  riesgo: 'En riesgo o fuera de meta',
  meta: 'En meta',
  sin_venta: 'Sin venta de modelos foco',
  sin_asistencia: 'Sin asistencia registrada',
};

export default function Promoters() {
  const { filters, hasData } = useData();
  const navigate = useNavigate();
  const [group, setGroup] = useState('todos');

  const { data, error, loading, refreshing } = useQuery(
    (signal) => api.promoters(filters, signal),
    [JSON.stringify(filters)],
    { skip: !hasData }
  );

  const rows = useMemo(() => (data ? data.promoters.filter(GROUPS[group]) : []), [data, group]);
  const maxSo = useMemo(() => Math.max(...rows.map((r) => r.so), 1), [rows]);

  return (
    <AppShell
      title="Promotores"
      subtitle="Detalle individual de cada promotor de campo"
      filterBar={<FilterBar />}
      actions={
        data && (
          <button type="button" className="btn btn--sm" onClick={() => downloadCsv('promotores', filters)}>
            Exportar CSV
          </button>
        )
      }
    >
      {!hasData && <Empty>Aun no hay informacion cargada.</Empty>}
      <ErrorBox error={error} />
      {loading && !data && <Spinner />}
      {data && (
        <div className={`stack${refreshing ? ' is-refreshing' : ''}`}>
          <section className="kpis">
            <Kpi label="Promotores en el corte" value={n(data.total.headcount)} meta={`${n(data.total.baseCount)} base · ${n(data.total.supportCount)} soporte`} />
            <Kpi label="Sell-out del grupo" value={n(data.total.so)} unit="pzs" meta={`Target ${n(data.total.target)}`} progress={data.total.ach} marker={data.total.timeProgress} />
            <Kpi label="Promedio por promotor" value={d1(data.total.perFF)} unit="pzs" meta={`Productividad ${d2(data.total.productivity)} pzs/dia asistido`} />
            <Kpi label="Dias en cero" value={pct(data.total.zeroSaleRate)} meta={`${n(data.total.zeroSaleDays)} de ${n(data.total.attendanceDays)} dias trabajados`} tone={data.total.zeroSaleRate > 0.35 ? 'warning' : undefined} />
          </section>

          <Card
            title={`${GROUP_LABELS[group]} (${n(rows.length)})`}
            hint="Haz clic en un promotor para ver su detalle diario y su mezcla de modelos."
            actions={
              <div className="row">
                {Object.keys(GROUPS).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`btn btn--sm${group === k ? ' btn--primary' : ''}`}
                    onClick={() => setGroup(k)}
                  >
                    {GROUP_LABELS[k]}
                  </button>
                ))}
              </div>
            }
          >
            <DataTable
              columns={[
                { key: 'rank', label: '#', numeric: true, render: (p) => p.rank },
                {
                  key: 'name',
                  label: 'Promotor',
                  cellClass: 'name',
                  render: (p) => <Link to={`/promotores/${encodeURIComponent(p.key)}`}>{p.name}</Link>,
                },
                { key: 'store', label: 'Tienda', cellClass: 'dim' },
                { key: 'channel', label: 'Canal', cellClass: 'dim' },
                { key: 'region', label: 'Region', cellClass: 'dim' },
                { key: 'supervisor', label: 'Supervisor', cellClass: 'dim' },
                { key: 'employment', label: 'Tipo', cellClass: 'dim' },
                { key: 'target', label: 'Target', numeric: true, render: (p) => n(p.target) },
                { key: 'so', label: 'SO foco', numeric: true, render: (p) => <BarCell value={p.so} max={maxSo} /> },
                { key: 'soAll', label: 'SO total', numeric: true, render: (p) => n(p.soAll) },
                { key: 'soIot', label: 'IOT', numeric: true, render: (p) => n(p.soIot) },
                { key: 'ach', label: 'ACH%', numeric: true, render: (p) => <AchCell value={p.ach} /> },
                { key: 'forecast', label: 'Cierre proy.', numeric: true, render: (p) => n(p.forecast) },
                { key: 'attendanceDays', label: 'Dias trab.', numeric: true, render: (p) => n(p.attendanceDays) },
                { key: 'zeroSaleDays', label: 'Dias en cero', numeric: true, render: (p) => n(p.zeroSaleDays) },
                { key: 'productivity', label: 'Pzs/dia', numeric: true, render: (p) => d2(p.productivity) },
                { key: 'status', label: 'Estatus', render: (p) => <StatusPill status={p.status} /> },
              ]}
              rows={rows}
              initialSort={{ key: 'so', dir: 'desc' }}
              onRowClick={(p) => navigate(`/promotores/${encodeURIComponent(p.key)}`)}
            />
          </Card>
        </div>
      )}
    </AppShell>
  );
}
