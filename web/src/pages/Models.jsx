/** Modelos foco, productos clave por canal y variantes (version y color). */
import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { useData, useQuery } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { BarCell, Card, DataTable, Empty, ErrorBox, Kpi, Spinner, ViewToggle } from '../components/ui.jsx';
import { ShareBars } from '../components/charts/index.jsx';
import { d2, n, pct } from '../utils/format.js';

export default function Models() {
  const { filters, hasData } = useData();
  const { data, error, loading, refreshing } = useQuery(
    (signal) => api.models(filters, signal),
    [JSON.stringify(filters)],
    { skip: !hasData }
  );

  return (
    <AppShell title="Modelos y mezcla" subtitle="Que se esta vendiendo y en que canal" filterBar={<FilterBar />}>
      {!hasData && <Empty>Aun no hay informacion cargada.</Empty>}
      <ErrorBox error={error} />
      {loading && !data && <Spinner />}
      {data && (
        <div className={`stack${refreshing ? ' is-refreshing' : ''}`}>
          <FocusModels data={data} />
          <KeyProducts groups={data.keyProducts} />
          {data.variants.length > 0 && <Variants variants={data.variants} />}
        </div>
      )}
    </AppShell>
  );
}

function FocusModels({ data }) {
  const [view, setView] = useState('chart');
  const total = data.focusModels.reduce((a, m) => a + m.qty, 0);
  const top = data.focusModels[0];

  return (
    <>
      <section className="kpis">
        <Kpi label="Piezas de modelos foco" value={n(total)} unit="pzs" meta={`${data.focusModels.length} modelos con seguimiento`} />
        {top && (
          <Kpi
            label="Modelo lider"
            compact
            value={top.model}
            meta={`${n(top.qty)} pzs · ${pct(top.share)} de la mezcla`}
          />
        )}
        {data.focusModels.slice(1, 4).map((m) => (
          <Kpi key={m.model} label={m.model} value={n(m.qty)} unit="pzs" meta={`${pct(m.share)} de la mezcla`} progress={m.share} />
        ))}
      </section>

      <Card
        title="Mezcla de modelos foco"
        hint="Piezas por modelo en el corte actual, con la participacion de cada uno sobre el total."
        actions={<ViewToggle value={view} onChange={setView} />}
      >
        {view === 'chart' ? (
          <ShareBars data={data.focusModels} />
        ) : (
          <DataTable
            columns={[
              { key: 'model', label: 'Modelo', cellClass: 'name' },
              { key: 'qty', label: 'Piezas', numeric: true, render: (m) => n(m.qty) },
              { key: 'share', label: 'Participacion', numeric: true, render: (m) => pct(m.share) },
              { key: 'dailyAvg', label: 'Pzs/dia', numeric: true, render: (m) => d2(m.dailyAvg) },
            ]}
            rows={data.focusModels}
            rowKey={(m) => m.model}
            initialSort={{ key: 'qty', dir: 'desc' }}
          />
        )}
      </Card>
    </>
  );
}

function KeyProducts({ groups }) {
  // "TODOS" es la vista util por defecto: el resto de canales queda a un clic.
  const [channel, setChannel] = useState(
    groups.find((g) => g.channel === 'TODOS')?.channel || groups[0]?.channel || null
  );
  const active = useMemo(() => groups.find((g) => g.channel === channel) || groups[0], [groups, channel]);
  if (!groups.length) return null;
  const max = Math.max(...(active?.models || []).map((m) => m.total || 0), 1);

  return (
    <Card
      title="Productos clave por canal"
      hint="Sell-out del portafolio completo por cadena, tal como lo reporta la hoja de productos clave. Incluye modelos fuera del grupo foco."
      actions={
        <div className="row">
          {groups.map((g) => (
            <button
              key={g.channel}
              type="button"
              className={`btn btn--sm${active?.channel === g.channel ? ' btn--primary' : ''}`}
              onClick={() => setChannel(g.channel)}
            >
              {g.channel}
            </button>
          ))}
        </div>
      }
    >
      <DataTable
        columns={[
          { key: 'model', label: 'Modelo', cellClass: 'name' },
          { key: 'total', label: 'Piezas', numeric: true, render: (m) => <BarCell value={m.total || 0} max={max} /> },
          { key: 'stores', label: 'Tiendas', numeric: true, render: (m) => n(m.stores) },
          {
            key: 'productivity',
            label: 'Pzs por tienda',
            numeric: true,
            sortValue: (m) => (m.stores ? (m.total || 0) / m.stores : 0),
            render: (m) => d2(m.stores ? (m.total || 0) / m.stores : null),
          },
          {
            key: 'share',
            label: 'Participacion',
            numeric: true,
            sortValue: (m) => m.total,
            render: (m) => pct(active.total ? (m.total || 0) / active.total : null),
          },
        ]}
        rows={active?.models || []}
        rowKey={(m) => `${m.channel}-${m.model}`}
        initialSort={{ key: 'total', dir: 'desc' }}
      />
    </Card>
  );
}

function Variants({ variants }) {
  const models = useMemo(() => [...new Set(variants.map((v) => v.model))], [variants]);
  const [model, setModel] = useState(models[0]);
  const rows = variants.filter((v) => v.model === model && v.channel === 'TODOS');
  const carriers = rows.filter((v) => v.dimension === 'carrier');
  const colors = rows.filter((v) => v.dimension === 'color');

  return (
    <Card
      title="Variantes del modelo"
      hint="Desglose por version de operador y por color. Sirve para detectar desbalance de inventario o de preferencia."
      actions={
        <div className="row">
          {models.map((m) => (
            <button key={m} type="button" className={`btn btn--sm${model === m ? ' btn--primary' : ''}`} onClick={() => setModel(m)}>
              {m}
            </button>
          ))}
        </div>
      }
    >
      <div className="grid grid--2">
        <VariantTable title="Por version de operador" rows={carriers} />
        <VariantTable title="Por color" rows={colors} />
      </div>
    </Card>
  );
}

function VariantTable({ title, rows }) {
  const total = rows.reduce((a, r) => a + (r.so || 0), 0);
  const max = Math.max(...rows.map((r) => r.so || 0), 1);
  if (!rows.length) return null;
  return (
    <div>
      <div className="small secondary" style={{ marginBottom: 6, fontWeight: 560 }}>
        {title}
      </div>
      <DataTable
        columns={[
          { key: 'variant', label: 'Variante', cellClass: 'name' },
          { key: 'so', label: 'Piezas', numeric: true, render: (r) => <BarCell value={r.so || 0} max={max} /> },
          { key: 'share', label: 'Participacion', numeric: true, sortValue: (r) => r.so, render: (r) => pct(total ? (r.so || 0) / total : null) },
        ]}
        rows={rows}
        rowKey={(r) => `${r.dimension}-${r.variant}`}
        initialSort={{ key: 'so', dir: 'desc' }}
      />
    </div>
  );
}
