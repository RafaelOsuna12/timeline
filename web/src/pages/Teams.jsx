/**
 * Jerarquia Region → City Manager → Supervisor → Promotor.
 * Responde "donde exactamente se esta perdiendo el target" sin cambiar de vista.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadCsv } from '../api.js';
import { useData, useQuery } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { AchCell, Card, DataTable, Empty, ErrorBox, Spinner, StatusPill } from '../components/ui.jsx';
import { d1, n, pct } from '../utils/format.js';

export default function Teams() {
  const { filters, hasData, setFilter } = useData();
  const { data, error, loading, refreshing } = useQuery(
    (signal) => api.hierarchy(filters, signal),
    [JSON.stringify(filters)],
    { skip: !hasData }
  );

  return (
    <AppShell
      title="CM y supervisores"
      subtitle="Estructura completa del equipo con avance en cada nivel"
      filterBar={<FilterBar />}
      actions={
        data && (
          <button type="button" className="btn btn--sm" onClick={() => downloadCsv('supervisores', filters)}>
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
          {data.regions.map((region) => (
            <RegionBlock key={region.key} region={region} onFilter={setFilter} closed={data.context.cutoffDay >= data.context.daysInMonth} />
          ))}
          {data.regions.length === 0 && <Empty>No hay equipos que coincidan con los filtros.</Empty>}
        </div>
      )}
    </AppShell>
  );
}

function RegionBlock({ region, onFilter, closed }) {
  return (
    <Card
      title={`${region.name} — ${pct(region.ach)} del target`}
      hint={`${n(region.headcount)} promotores · ${n(region.so)} de ${n(region.target)} pzs · cierre proyectado ${n(
        region.forecast
      )} (${pct(region.projectedAch)})`}
      actions={
        <button type="button" className="btn btn--sm" onClick={() => onFilter('region', region.name)}>
          Filtrar por esta region
        </button>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        {region.cms.map((cm) => (
          <CmBlock key={cm.key} cm={cm} onFilter={onFilter} closed={closed} />
        ))}
      </div>
    </Card>
  );
}

function CmBlock({ cm, onFilter, closed }) {
  const [open, setOpen] = useState(null);
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
      <div className="spread" style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
        <div>
          <div style={{ fontWeight: 590, fontSize: 13.5 }}>{cm.name}</div>
          <div className="muted small">
            {n(cm.headcount)} promotores en {cm.supervisors.length} equipos · {n(cm.so)} de {n(cm.target)} pzs
          </div>
        </div>
        <div className="row">
          <span className="tnum" style={{ fontSize: 17, fontWeight: 620 }}>
            {pct(cm.ach)}
          </span>
          <StatusPill status={cm.status} />
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => onFilter('cm', cm.name)}>
            Filtrar
          </button>
        </div>
      </div>

      <DataTable
        columns={[
          { key: 'name', label: 'Supervisor', cellClass: 'name' },
          { key: 'headcount', label: 'Promotores', numeric: true, render: (s) => n(s.headcount) },
          { key: 'target', label: 'Target', numeric: true, render: (s) => n(s.target) },
          { key: 'so', label: 'Sell-out', numeric: true, render: (s) => n(s.so) },
          { key: 'ach', label: 'ACH%', numeric: true, render: (s) => <AchCell value={s.ach} /> },
          { key: 'forecast', label: closed ? 'Cierre' : 'Cierre proy.', numeric: true, render: (s) => n(s.forecast) },
          { key: 'dailyAvg', label: 'Pzs/dia', numeric: true, render: (s) => d1(s.dailyAvg) },
          { key: 'requiredDaily', label: 'Req. pzs/dia', numeric: true, render: (s) => d1(s.requiredDaily) },
          { key: 'zeroSaleRate', label: 'Dias en cero', numeric: true, render: (s) => pct(s.zeroSaleRate) },
          { key: 'status', label: 'Estatus', render: (s) => <StatusPill status={s.status} /> },
          {
            key: 'detail',
            label: 'Equipo',
            sortable: false,
            render: (s) => (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpen(open === s.key ? null : s.key)}>
                {open === s.key ? 'Ocultar' : `Ver ${s.promoters.length}`}
              </button>
            ),
          },
        ]}
        rows={cm.supervisors}
        initialSort={{ key: 'ach', dir: 'asc' }}
      />

      {open && <PromoterPanel supervisor={cm.supervisors.find((s) => s.key === open)} />}
    </div>
  );
}

function PromoterPanel({ supervisor }) {
  if (!supervisor) return null;
  return (
    <div style={{ padding: '10px 12px 14px', background: 'var(--wash)' }}>
      <div className="small secondary" style={{ marginBottom: 8 }}>
        Equipo de <strong>{supervisor.name}</strong> — {n(supervisor.headcount)} promotores
      </div>
      <DataTable
        columns={[
          {
            key: 'name',
            label: 'Promotor',
            cellClass: 'name',
            render: (p) => <Link to={`/promotores/${encodeURIComponent(p.key)}`}>{p.name}</Link>,
          },
          { key: 'store', label: 'Tienda', cellClass: 'dim' },
          { key: 'channel', label: 'Canal', cellClass: 'dim' },
          { key: 'employment', label: 'Tipo', cellClass: 'dim' },
          { key: 'target', label: 'Target', numeric: true, render: (p) => n(p.target) },
          { key: 'so', label: 'SO', numeric: true, render: (p) => n(p.so) },
          { key: 'ach', label: 'ACH%', numeric: true, render: (p) => <AchCell value={p.ach} /> },
          { key: 'forecast', label: 'Cierre proy.', numeric: true, render: (p) => n(p.forecast) },
          { key: 'attendanceDays', label: 'Dias trab.', numeric: true, render: (p) => n(p.attendanceDays) },
          { key: 'zeroSaleDays', label: 'Dias en cero', numeric: true, render: (p) => n(p.zeroSaleDays) },
          { key: 'status', label: 'Estatus', render: (p) => <StatusPill status={p.status} /> },
        ]}
        rows={supervisor.promoters}
        initialSort={{ key: 'ach', dir: 'asc' }}
      />
    </div>
  );
}
