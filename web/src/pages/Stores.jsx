/** Desempeño por punto de venta. */
import { useMemo } from 'react';
import { api, downloadCsv } from '../api.js';
import { useData, useQuery } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { AchCell, BarCell, Card, DataTable, Empty, ErrorBox, Kpi, Spinner, StatusPill } from '../components/ui.jsx';
import { d2, n, pct } from '../utils/format.js';

export default function Stores() {
  const { filters, hasData, setFilter } = useData();
  const { data, error, loading, refreshing } = useQuery(
    (signal) => api.stores(filters, signal),
    [JSON.stringify(filters)],
    { skip: !hasData }
  );

  const stats = useMemo(() => {
    if (!data) return null;
    const rows = data.stores;
    const withTarget = rows.filter((s) => s.target > 0);
    const onTrack = rows.filter((s) => s.status === 'en_meta').length;
    const zero = rows.filter((s) => s.so === 0).length;
    return {
      count: rows.length,
      onTrack,
      zero,
      avg: withTarget.length ? withTarget.reduce((a, s) => a + s.so, 0) / withTarget.length : 0,
      max: Math.max(...rows.map((s) => s.so), 1),
    };
  }, [data]);

  return (
    <AppShell
      title="Tiendas"
      subtitle="Sell-out y cumplimiento por punto de venta"
      filterBar={<FilterBar />}
      actions={
        data && (
          <button type="button" className="btn btn--sm" onClick={() => downloadCsv('tiendas', filters)}>
            Exportar CSV
          </button>
        )
      }
    >
      {!hasData && <Empty>Aun no hay informacion cargada.</Empty>}
      <ErrorBox error={error} />
      {loading && !data && <Spinner />}
      {data && stats && (
        <div className={`stack${refreshing ? ' is-refreshing' : ''}`}>
          <section className="kpis">
            <Kpi label="Tiendas en el corte" value={n(stats.count)} meta="Con al menos un promotor asignado" />
            <Kpi label="Tiendas en meta" value={n(stats.onTrack)} meta={`${pct(stats.count ? stats.onTrack / stats.count : null)} del total`} tone="good" />
            <Kpi label="Tiendas sin venta" value={n(stats.zero)} meta="Sin una sola pieza de modelos foco" tone={stats.zero ? 'critical' : undefined} />
            <Kpi label="Promedio por tienda" value={n(stats.avg)} unit="pzs" meta="Solo tiendas con target asignado" />
          </section>

          <Card title="Detalle por tienda" hint="Haz clic en una fila para filtrar todo el tablero por esa tienda.">
            <DataTable
              columns={[
                { key: 'rank', label: '#', numeric: true, render: (s) => s.rank },
                { key: 'name', label: 'Tienda', cellClass: 'name' },
                { key: 'channel', label: 'Canal', cellClass: 'dim' },
                { key: 'region', label: 'Region', cellClass: 'dim' },
                { key: 'supervisor', label: 'Supervisor', cellClass: 'dim' },
                { key: 'headcount', label: 'Promotores', numeric: true, render: (s) => n(s.headcount) },
                { key: 'target', label: 'Target', numeric: true, render: (s) => n(s.target) },
                { key: 'so', label: 'SO foco', numeric: true, render: (s) => <BarCell value={s.so} max={stats.max} /> },
                { key: 'soAll', label: 'SO total', numeric: true, render: (s) => n(s.soAll) },
                { key: 'ach', label: 'ACH%', numeric: true, render: (s) => <AchCell value={s.ach} /> },
                { key: 'forecast', label: 'Cierre proy.', numeric: true, render: (s) => n(s.forecast) },
                { key: 'productivity', label: 'Pzs/dia asistido', numeric: true, render: (s) => d2(s.productivity) },
                { key: 'status', label: 'Estatus', render: (s) => <StatusPill status={s.status} /> },
              ]}
              rows={data.stores}
              initialSort={{ key: 'so', dir: 'desc' }}
              onRowClick={(s) => setFilter('store', s.name)}
            />
          </Card>
        </div>
      )}
    </AppShell>
  );
}
