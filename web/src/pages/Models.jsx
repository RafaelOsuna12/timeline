/** Modelos foco, productos clave por canal y variantes (version y color). */
import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { useData, useQuery } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { BarCell, Card, DataTable, Empty, ErrorBox, Kpi, Spinner, StoreCell, ViewToggle } from '../components/ui.jsx';
import { AdoptionCurve, DailyBars, ShareBars } from '../components/charts/index.jsx';
import { d2, n, pct, seriesColorFor } from '../utils/format.js';
import { promoterPath, useFilteredNavigate } from '../app/links.js';

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
          {data.tracked && <Tracked tracked={data.tracked} ctx={data.context} />}
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

/**
 * Seguimiento diario de los modelos que traen hoja propia.
 *
 * El acumulado del mes dice cuanto se vendio; esto dice cuando arranco, a que
 * ritmo va y, sobre todo, cuantos promotores ya lo colocaron. En un lanzamiento
 * la cobertura —cuanta gente lo ha vendido al menos una vez— explica mas que el
 * total: 500 piezas repartidas entre 120 promotores y 500 en manos de 20 son
 * dos situaciones distintas.
 */
function Tracked({ tracked, ctx }) {
  const navigate = useFilteredNavigate();
  const [sel, setSel] = useState(tracked.models[0]?.model || null);
  const [view, setView] = useState('chart');
  const [soloCero, setSoloCero] = useState(false);

  // El color sigue al modelo y no a su posicion, para que cambiar de seleccion
  // no repinte las curvas.
  const catalog = useMemo(() => tracked.models.map((m) => m.model), [tracked.models]);
  const colorOf = (model) => seriesColorFor(model, catalog);

  const activo = tracked.models.find((m) => m.model === sel) || tracked.models[0];
  const filas = useMemo(() => {
    if (!activo) return [];
    const base = tracked.promoters.map((p) => ({ ...p, qty: p.qty[activo.model] || 0 }));
    return soloCero ? base.filter((p) => p.qty === 0) : base;
  }, [tracked.promoters, activo, soloCero]);

  if (!tracked.models.length) return null;
  const maxQty = Math.max(...filas.map((f) => f.qty), 1);

  return (
    <>
      <Card
        title="Curva de adopcion por modelo"
        hint="Acumulado dia a dia de cada modelo con seguimiento diario. Sirve para ver que tan rapido arranco un lanzamiento, no solo cuanto lleva vendido."
      >
        <AdoptionCurve
          models={tracked.models}
          days={ctx.daysInMonth}
          cutoffDay={ctx.cutoffDay}
          colorOf={colorOf}
          height={290}
        />
        <DataTable
          columns={[
            { key: 'model', label: 'Modelo', cellClass: 'name' },
            { key: 'total', label: 'Piezas', numeric: true, render: (m) => n(m.total) },
            { key: 'dailyAvg', label: 'Pzs/dia', numeric: true, render: (m) => d2(m.dailyAvg) },
            { key: 'firstDay', label: 'Primera venta', numeric: true, render: (m) => (m.firstDay ? `Dia ${m.firstDay}` : '—') },
            {
              key: 'bestDay',
              label: 'Mejor dia',
              numeric: true,
              sortValue: (m) => m.bestDayQty,
              render: (m) => (m.bestDay ? `Dia ${m.bestDay} · ${n(m.bestDayQty)} pzs` : '—'),
            },
            {
              key: 'coverage',
              label: 'Promotores que lo venden',
              numeric: true,
              render: (m) => `${n(m.sellers)} de ${n(m.headcount)} (${pct(m.coverage, 0)})`,
            },
            { key: 'storeCount', label: 'Tiendas', numeric: true, render: (m) => n(m.storeCount) },
            { key: 'perSeller', label: 'Pzs por vendedor', numeric: true, render: (m) => d2(m.perSeller) },
          ]}
          rows={tracked.models}
          rowKey={(m) => m.model}
          initialSort={{ key: 'total', dir: 'desc' }}
          onRowClick={(m) => setSel(m.model)}
        />
      </Card>

      {activo && (
        <Card
          title={`Detalle de ${activo.model}`}
          hint="Venta diaria, reparto por region y canal, y quien lo esta colocando. Un promotor sin piezas no necesariamente tiene el modelo en piso, pero es por donde empieza la revision."
          actions={
            <div className="row">
              {tracked.models.map((m) => (
                <button
                  key={m.model}
                  type="button"
                  className={`btn btn--sm${m.model === activo.model ? ' btn--primary' : ''}`}
                  onClick={() => setSel(m.model)}
                >
                  {m.model.replace(/^HONOR /, '')}
                </button>
              ))}
            </div>
          }
        >
          <section className="kpis" style={{ marginBottom: 14 }}>
            <Kpi label="Piezas en el corte" value={n(activo.total)} unit="pzs" meta={`${d2(activo.dailyAvg)} pzs/dia`} />
            <Kpi
              label="Cobertura de promotores"
              value={pct(activo.coverage, 0)}
              meta={`${n(activo.sellers)} de ${n(activo.headcount)} han colocado al menos una pieza`}
              progress={activo.coverage}
              tone={activo.coverage < 0.3 ? 'warning' : undefined}
            />
            <Kpi label="Tiendas con venta" value={n(activo.storeCount)} meta={`${d2(activo.perSeller)} pzs por promotor que lo vende`} />
            <Kpi
              label="Dias vendiendo"
              value={n(activo.daysSelling)}
              meta={activo.firstDay ? `Primera venta el dia ${activo.firstDay} de ${ctx.daysInMonth}` : 'Sin venta en el corte'}
            />
          </section>

          <DailyBars
            daily={activo.series.map((v, i) => ({
              day: i + 1,
              so: v,
              isFuture: i + 1 > ctx.cutoffDay,
            }))}
            height={180}
          />

          <div className="grid grid--2" style={{ marginTop: 14 }}>
            <Breakdown title="Por region" rows={activo.byRegion} />
            <Breakdown title="Por canal" rows={activo.byChannel} />
          </div>

          <div className="spread" style={{ margin: '16px 0 8px' }}>
            <h4 style={{ margin: 0, fontSize: 13, fontWeight: 620 }}>
              Promotores {soloCero ? 'sin una sola pieza' : 'y sus piezas'} ({n(filas.length)})
            </h4>
            <div className="row">
              <button type="button" className={`btn btn--sm${soloCero ? ' btn--primary' : ''}`} onClick={() => setSoloCero((v) => !v)}>
                {soloCero ? 'Ver todos' : 'Solo los que no lo han vendido'}
              </button>
              <ViewToggle value={view} onChange={setView} />
            </div>
          </div>

          {view === 'chart' ? (
            <DataTable
              columns={[
                { key: 'name', label: 'Promotor', cellClass: 'name' },
                {
                  key: 'store',
                  label: 'Tienda',
                  cellClass: 'dim',
                  render: (p) => <StoreCell store={p.store} stores={p.stores} count={p.storeCount} />,
                },
                { key: 'region', label: 'Region', cellClass: 'dim' },
                { key: 'channel', label: 'Canal', cellClass: 'dim' },
                { key: 'supervisor', label: 'Supervisor', cellClass: 'dim' },
                {
                  key: 'qty',
                  label: `Piezas de ${activo.model.replace(/^HONOR /, '')}`,
                  numeric: true,
                  render: (p) => <BarCell value={p.qty} max={maxQty} color={colorOf(activo.model)} />,
                },
                { key: 'total', label: 'Total con seguimiento', numeric: true, render: (p) => n(p.total) },
              ]}
              rows={filas}
              initialSort={{ key: 'qty', dir: 'desc' }}
              onRowClick={(p) => navigate(promoterPath(p.key))}
              emptyText="Ningun promotor en esta condicion."
            />
          ) : (
            <DataTable
              columns={[
                { key: 'name', label: 'Promotor', cellClass: 'name' },
                ...tracked.models.map((m) => ({
                  key: m.model,
                  label: m.model.replace(/^HONOR /, ''),
                  numeric: true,
                  sortValue: (p) => p.qty[m.model] || 0,
                  render: (p) => n(p.qty[m.model] || 0),
                })),
                { key: 'total', label: 'Total', numeric: true, render: (p) => n(p.total) },
              ]}
              rows={tracked.promoters}
              initialSort={{ key: 'total', dir: 'desc' }}
              onRowClick={(p) => navigate(promoterPath(p.key))}
            />
          )}
        </Card>
      )}
    </>
  );
}

/** Reparto de un modelo en una dimension, con la cobertura de cada grupo. */
function Breakdown({ title, rows }) {
  const total = rows.reduce((a, r) => a + r.qty, 0);
  return (
    <div>
      <h4 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 620 }}>{title}</h4>
      <DataTable
        columns={[
          { key: 'name', label: title.replace('Por ', ''), cellClass: 'name' },
          { key: 'qty', label: 'Piezas', numeric: true, render: (r) => n(r.qty) },
          { key: 'share', label: 'Participacion', numeric: true, render: (r) => pct(total ? r.qty / total : null) },
          {
            key: 'sellers',
            label: 'Lo venden',
            numeric: true,
            sortValue: (r) => (r.headcount ? r.sellers / r.headcount : 0),
            render: (r) => `${n(r.sellers)} de ${n(r.headcount)}`,
          },
        ]}
        rows={rows}
        rowKey={(r) => r.name}
        initialSort={{ key: 'qty', dir: 'desc' }}
      />
    </div>
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
