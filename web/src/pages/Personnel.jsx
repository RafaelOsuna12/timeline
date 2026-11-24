/**
 * Datos del personal.
 *
 * El archivo de plantilla cubre mas cadenas y mas roles que el reporte de
 * ventas, y se actualiza dos veces por semana, asi que vive en su propia
 * seccion con sus propios filtros. La region va al frente porque es el corte
 * con el que se consulta a diario.
 *
 * La vista esta pensada para crecer: el directorio, las tiendas y los cambios
 * salen de los mismos endpoints que podran consumir otras secciones.
 */
import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, downloadCsv, uploadFile } from '../api.js';
import { useAuth, useQuery } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import { Card, DataTable, Empty, ErrorBox, Kpi, Spinner, StatusPill } from '../components/ui.jsx';
import { dateLabel, n, pct } from '../utils/format.js';

const TABS = [
  { key: 'directorio', label: 'Directorio' },
  { key: 'tiendas', label: 'Tiendas' },
  { key: 'vacantes', label: 'Vacantes' },
  { key: 'cambios', label: 'Cambios' },
];

/** Antiguedad legible: los meses sueltos se leen peor que "1 año 3 meses". */
export function tenureLabel(months) {
  if (months === null || months === undefined) return '—';
  if (months < 1) return 'menos de 1 mes';
  if (months < 12) return `${months} ${months === 1 ? 'mes' : 'meses'}`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return `${y} ${y === 1 ? 'año' : 'años'}${m ? ` ${m} ${m === 1 ? 'mes' : 'meses'}` : ''}`;
}

export default function Personnel() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [reloadKey, setReloadKey] = useState(0);

  const filters = useMemo(
    () => ({
      region: params.get('region') || undefined,
      role: params.get('role') || undefined,
      channel: params.get('channel') || undefined,
      state: params.get('state') || undefined,
      city: params.get('city') || undefined,
      search: params.get('search') || undefined,
    }),
    [params]
  );
  const tab = params.get('tab') || 'directorio';

  /**
   * Aplica uno o varios filtros de una vez. Tiene que ser una sola escritura:
   * al cambiar de region se limpian estado y ciudad, y tres llamadas
   * encadenadas partirian las tres del mismo estado, con lo que solo la
   * ultima quedaria.
   */
  const setFilter = useCallback(
    (keyOrPatch, value) => {
      const patch = typeof keyOrPatch === 'string' ? { [keyOrPatch]: value } : keyOrPatch;
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null || v === '') next.delete(k);
        else next.set(k, String(v));
      }
      setParams(next, { replace: true });
    },
    [params, setParams]
  );

  const { data: catalog, error: catalogError } = useQuery(
    (signal) => api.hc.filters({}, signal),
    [reloadKey]
  );
  const { data: snaps } = useQuery((signal) => api.hc.snapshots(signal), [reloadKey]);

  const sinDatos = catalogError?.code === 'NO_HEADCOUNT';
  const puedeCargar = user?.role === 'admin' || user?.role === 'editor';
  const ultima = snaps?.snapshots?.[0];

  return (
    <AppShell
      title="Datos del personal"
      subtitle={
        ultima
          ? `Plantilla de campo y mandos medios · actualizada el ${dateLabel(ultima.createdAt)}`
          : 'Plantilla de campo y mandos medios'
      }
      actions={
        !sinDatos && (
          <div className="row no-print">
            <button type="button" className="btn btn--sm" onClick={() => downloadCsv('personal', filters, '/hc/export')}>
              Exportar CSV
            </button>
          </div>
        )
      }
    >
      {sinDatos ? (
        <Empty>Aun no hay plantilla cargada.</Empty>
      ) : (
        <ErrorBox error={catalogError} />
      )}

      {catalog && (
        <>
          <PersonnelFilters catalog={catalog} filters={filters} onChange={setFilter} />

          <div className="chip-row no-print" style={{ paddingBottom: 12 }}>
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`btn btn--sm${tab === t.key ? ' btn--primary' : ''}`}
                onClick={() => setFilter('tab', t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'directorio' && <Directory filters={filters} reloadKey={reloadKey} />}
          {tab === 'tiendas' && <StoreRoster filters={filters} reloadKey={reloadKey} />}
          {tab === 'vacantes' && <Vacancies filters={filters} reloadKey={reloadKey} />}
          {tab === 'cambios' && <Changes filters={filters} reloadKey={reloadKey} />}
        </>
      )}

      {/* La carga va al final: se usa dos veces por semana, mientras que la
          consulta es diaria y merece la parte de arriba de la pantalla. */}
      {puedeCargar && (
        <div style={{ marginTop: 18 }}>
          <UploadCard onDone={() => setReloadKey((k) => k + 1)} snapshots={snaps} />
        </div>
      )}
    </AppShell>
  );
}

/* -------------------------------- filtros -------------------------------- */

function Select({ label, value, onChange, options, allLabel, width = 170 }) {
  return (
    <label className="field" style={{ minWidth: width }}>
      <span className="field__label">{label}</span>
      <select className="control" value={value || ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.key ?? o} value={o.key ?? o}>
            {o.label ?? o}
          </option>
        ))}
      </select>
    </label>
  );
}

function PersonnelFilters({ catalog, filters, onChange }) {
  // Las listas se encadenan: al elegir region solo quedan sus estados y
  // ciudades, igual que en el resto del tablero.
  const rel = catalog.relations || [];
  const options = useMemo(() => {
    const inRegion = (r) => !filters.region || r.region === filters.region;
    const inState = (r) => !filters.state || r.state === filters.state;
    const uniq = (fn, pred) => [...new Set(rel.filter(pred).map(fn))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'es'));
    return {
      states: uniq((r) => r.state, inRegion),
      cities: uniq((r) => r.city, (r) => inRegion(r) && inState(r)),
      channels: uniq((r) => r.channel, inRegion),
    };
  }, [rel, filters.region, filters.state]);

  const activos = [
    filters.region && { key: 'region', label: `Region: ${filters.region}` },
    filters.role && { key: 'role', label: `Rol: ${catalog.roles.find((r) => r.key === filters.role)?.label || filters.role}` },
    filters.channel && { key: 'channel', label: `Canal: ${filters.channel}` },
    filters.state && { key: 'state', label: `Estado: ${filters.state}` },
    filters.city && { key: 'city', label: `Ciudad: ${filters.city}` },
    filters.search && { key: 'search', label: `Busqueda: ${filters.search}` },
  ].filter(Boolean);

  return (
    <div className="no-print">
      <div className="filterbar">
        <Select
          label="Region"
          value={filters.region}
          onChange={(v) => onChange({ region: v, state: undefined, city: undefined })}
          options={catalog.regions}
          allLabel="Todas las regiones"
          width={150}
        />
        <Select label="Rol" value={filters.role} onChange={(v) => onChange('role', v)} options={catalog.roles} allLabel="Todos los roles" width={185} />
        <Select label="Canal" value={filters.channel} onChange={(v) => onChange('channel', v)} options={options.channels} allLabel="Todos los canales" />
        <Select
          label="Estado"
          value={filters.state}
          onChange={(v) => onChange({ state: v, city: undefined })}
          options={options.states}
          allLabel="Todos los estados"
          width={200}
        />
        <Select label="Ciudad" value={filters.city} onChange={(v) => onChange('city', v)} options={options.cities} allLabel="Todas las ciudades" />
        <label className="field" style={{ flex: '1 1 200px' }}>
          <span className="field__label">Buscar</span>
          <input
            className="control"
            style={{ width: '100%' }}
            type="search"
            placeholder="Nombre, ID o tienda"
            defaultValue={filters.search || ''}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onChange('search', e.currentTarget.value.trim());
            }}
            onBlur={(e) => onChange('search', e.currentTarget.value.trim())}
          />
        </label>
      </div>

      {activos.length > 0 && (
        <div className="chip-row" style={{ paddingBottom: 12 }}>
          {activos.map((c) => (
            <span className="chip" key={c.key}>
              {c.label}
              <button type="button" aria-label={`Quitar ${c.label}`} onClick={() => onChange(c.key, undefined)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- directorio ------------------------------- */

function Directory({ filters, reloadKey }) {
  const { data, error, loading, refreshing } = useQuery(
    (signal) => api.hc.directory(filters, signal),
    [JSON.stringify(filters), reloadKey]
  );
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const t = data.totals;

  return (
    <div className={`stack${refreshing ? ' is-refreshing' : ''}`}>
      <section className="kpis">
        <Kpi
          label="Personas en el corte"
          value={n(t.people)}
          meta={
            t.supportStores
              ? `${n(t.stores)} tiendas base · ${n(t.supportStores)} de apoyo`
              : `${n(t.stores)} tiendas base`
          }
        />
        <Kpi
          label="Cobertura de plazas"
          value={pct(t.coverage, 0)}
          meta={`${n(t.vacancies)} vacantes por cubrir`}
          progress={t.coverage}
          tone={t.coverage !== null && t.coverage < 0.9 ? 'warning' : 'good'}
        />
        <Kpi
          label="Antiguedad mediana"
          value={tenureLabel(t.medianTenure)}
          meta={`${n(t.withoutHireDate)} sin fecha de ingreso registrada`}
        />
        <Kpi label="Ingresos de este mes" value={n(t.newThisMonth)} meta="Segun la fecha de ingreso" />
      </section>

      <Card title="Plantilla por rol" hint="Cuantas personas hay en cada rol y cuantas plazas quedan sin cubrir.">
        <DataTable
          columns={[
            { key: 'label', label: 'Rol', cellClass: 'name' },
            { key: 'people', label: 'Personas', numeric: true, render: (r) => n(r.people) },
            {
              key: 'stores',
              label: 'Tiendas base',
              numeric: true,
              render: (r) => (
                <>
                  {n(r.stores)}
                  {r.support ? <span className="tag tag--soft">+{n(r.support)} apoyo</span> : null}
                </>
              ),
            },
            { key: 'vacancies', label: 'Vacantes', numeric: true, render: (r) => n(r.vacancies || 0) },
          ]}
          rows={data.byRole}
          rowKey={(r) => r.role}
          initialSort={{ key: 'people', dir: 'desc' }}
        />
      </Card>

      <Card
        title={`Directorio (${n(data.people.length)})`}
        hint="Haz clic en una persona para ver sus tiendas y su cadena de mando."
      >
        <DataTable
          columns={[
            {
              key: 'name',
              label: 'Nombre',
              cellClass: 'name',
              render: (p) => <Link to={`/personal/${encodeURIComponent(p.key)}`}>{p.name}</Link>,
            },
            { key: 'roleLabel', label: 'Rol', cellClass: 'dim' },
            { key: 'region', label: 'Region', cellClass: 'dim' },
            { key: 'city', label: 'Ciudad', cellClass: 'dim' },
            {
              key: 'storeCount',
              label: 'Tiendas',
              numeric: true,
              sortValue: (p) => p.storeCount,
              render: (p) =>
                p.storeCount || p.supportCount ? (
                  <>
                    {n(p.storeCount)}
                    {p.supportCount ? <span className="tag tag--soft">+{n(p.supportCount)} apoyo</span> : null}
                  </>
                ) : (
                  '—'
                ),
            },
            { key: 'employment', label: 'Plaza', cellClass: 'dim', render: (p) => p.employment || '—' },
            { key: 'hireDate', label: 'Ingreso', cellClass: 'dim', render: (p) => p.hireDate || '—' },
            {
              key: 'tenureMonths',
              label: 'Antiguedad',
              numeric: true,
              sortValue: (p) => p.tenureMonths ?? -1,
              render: (p) => tenureLabel(p.tenureMonths),
            },
            { key: 'personId', label: 'ID HONOR', cellClass: 'dim', render: (p) => p.personId || '—' },
          ]}
          rows={data.people}
          initialSort={{ key: 'name', dir: 'asc' }}
          emptyText="Ninguna persona coincide con los filtros."
        />
      </Card>
    </div>
  );
}

/* -------------------------------- tiendas -------------------------------- */

function StoreRoster({ filters, reloadKey }) {
  // El universo del archivo son 1,079 tiendas, pero solo las que tienen plaza
  // de promotor estan operando; se arranca mostrando esas.
  const [soloActivas, setSoloActivas] = useState(true);
  const consulta = useMemo(() => ({ ...filters, onlyActive: soloActivas || undefined }), [filters, soloActivas]);
  const { data, error, loading, refreshing } = useQuery(
    (signal) => api.hc.stores(consulta, signal),
    [JSON.stringify(consulta), reloadKey]
  );
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  return (
    <div className={`stack${refreshing ? ' is-refreshing' : ''}`}>
      <section className="kpis">
        <Kpi
          label="Tiendas base"
          value={n(data.totals.base)}
          meta={`Las que cuentan como tienda a trabajar${
            data.totals.support ? ` · ${n(data.totals.support)} de apoyo aparte` : ''
          }`}
        />
        <Kpi
          label={soloActivas ? 'Tiendas con plaza' : 'Tiendas en el archivo'}
          value={n(data.totals.stores)}
          meta={soloActivas ? `${n(data.totals.withStaff)} con personal asignado` : `${n(data.totals.empty)} sin nadie asignado`}
        />
        <Kpi
          label="Con alguna vacante"
          value={n(data.totals.withVacancy)}
          meta="Plazas abiertas en la tienda"
          tone={data.totals.withVacancy ? 'warning' : undefined}
        />
      </section>

      <Card
        title={`Tiendas (${n(data.stores.length)})`}
        hint={
          soloActivas
            ? 'Tiendas con plaza de promotor. Solo las base cuentan como tienda asignada para el supervisor mix y el city manager; las de apoyo son donde el promotor tambien puede vender.'
            : 'Todo el universo del archivo, incluidas las tiendas que aun no abren plaza de promotor.'
        }
        actions={
          <div className="row">
            <button
              type="button"
              className={`btn btn--sm${soloActivas ? ' btn--primary' : ''}`}
              onClick={() => setSoloActivas((v) => !v)}
            >
              {soloActivas ? 'Solo activas' : 'Todas las tiendas'}
            </button>
            <button type="button" className="btn btn--sm" onClick={() => downloadCsv('tiendas', consulta, '/hc/export')}>
              Exportar CSV
            </button>
          </div>
        }
      >
        <DataTable
          columns={[
            { key: 'store', label: 'Tienda', cellClass: 'name' },
            { key: 'channel', label: 'Canal', cellClass: 'dim' },
            { key: 'region', label: 'Region', cellClass: 'dim' },
            { key: 'city', label: 'Ciudad', cellClass: 'dim' },
            {
              key: 'floor',
              label: 'Plaza',
              render: (s) =>
                s.floor === 'SUPPORT' ? (
                  <span className="tag tag--soft">apoyo</span>
                ) : s.floor === 'BASE' ? (
                  'Base'
                ) : (
                  <span className="muted">sin plaza</span>
                ),
            },
            {
              key: 'staff',
              label: 'Plantilla',
              sortable: false,
              render: (s) =>
                s.staff.length ? (
                  <span className="small">
                    {s.staff.map((a) => (
                      <span key={`${a.role}-${a.personKey || 'v'}`} style={{ display: 'block' }}>
                        <span className="muted">{a.roleLabel}: </span>
                        {a.vacancy ? <span className="tag tag--soft">vacante</span> : a.name}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="muted">sin asignar</span>
                ),
            },
            { key: 'vacancies', label: 'Vacantes', numeric: true, render: (s) => n(s.vacancies) },
          ]}
          rows={data.stores}
          rowKey={(s) => s.storeId}
          initialSort={{ key: 'store', dir: 'asc' }}
          emptyText="Ninguna tienda coincide con los filtros."
        />
      </Card>
    </div>
  );
}

/* ------------------------------- vacantes ------------------------------- */

function Vacancies({ filters, reloadKey }) {
  const { data, error, loading } = useQuery(
    (signal) => api.hc.directory(filters, signal),
    [JSON.stringify(filters), reloadKey]
  );
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  return (
    <Card
      title={`Plazas vacantes (${n(data.vacancies.length)})`}
      hint="Posiciones abiertas en el archivo de plantilla, con la tienda a la que pertenecen."
      actions={
        <button type="button" className="btn btn--sm" onClick={() => downloadCsv('vacantes', filters, '/hc/export')}>
          Exportar CSV
        </button>
      }
    >
      <DataTable
        columns={[
          { key: 'store', label: 'Tienda', cellClass: 'name' },
          { key: 'roleLabel', label: 'Rol', cellClass: 'dim' },
          { key: 'channel', label: 'Canal', cellClass: 'dim' },
          { key: 'region', label: 'Region', cellClass: 'dim' },
          { key: 'city', label: 'Ciudad', cellClass: 'dim' },
          { key: 'storeId', label: 'ID de tienda', cellClass: 'dim' },
        ]}
        rows={data.vacancies}
        rowKey={(v) => `${v.storeId}-${v.role}`}
        initialSort={{ key: 'store', dir: 'asc' }}
        emptyText="No hay vacantes en este corte."
      />
    </Card>
  );
}

/* -------------------------------- cambios -------------------------------- */

const KIND_LABEL = {
  alta: 'Alta',
  baja: 'Baja',
  cambio_tienda: 'Cambio de tienda',
  cambio_rol: 'Cambio de rol',
  cambio_datos: 'Dato actualizado',
  vacante_abierta: 'Vacante abierta',
  vacante_cubierta: 'Vacante cubierta',
};

const KIND_TONE = {
  alta: 'good',
  baja: 'critical',
  vacante_abierta: 'warning',
  vacante_cubierta: 'good',
};

function detailText(c) {
  const d = c.detail || {};
  if (c.kind === 'cambio_tienda') {
    const partes = [];
    if (d.dejo?.length) partes.push(`dejo ${d.dejo.join(', ')}`);
    if (d.tomo?.length) partes.push(`tomo ${d.tomo.join(', ')}`);
    return partes.join(' · ');
  }
  if (c.kind === 'alta') return d.tiendas?.length ? `en ${d.tiendas.join(', ')}` : 'sin tienda asignada';
  if (c.kind === 'cambio_rol') return `${(d.antes || []).join(', ')} → ${(d.ahora || []).join(', ')}`;
  if (c.kind === 'cambio_datos') return `${d.campo}: ${d.antes || '—'} → ${d.ahora || '—'}`;
  if (c.kind === 'vacante_abierta' || c.kind === 'vacante_cubierta') return d.tienda || d.storeId || '';
  return '';
}

function Changes({ filters, reloadKey }) {
  const { data, error, loading } = useQuery(
    (signal) => api.hc.changes({ region: filters.region }, signal),
    [filters.region, reloadKey]
  );
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  if (!data.meta.previousId) {
    return <Empty>Esta es la primera carga de plantilla: no hay con que compararla todavia.</Empty>;
  }

  return (
    <div className="stack">
      <section className="kpis">
        {Object.entries(KIND_LABEL).map(([kind, label]) => (
          <Kpi key={kind} label={label} value={n(data.byKind[kind] || 0)} compact tone={data.byKind[kind] ? KIND_TONE[kind] : undefined} />
        ))}
      </section>

      <Card
        title={`Movimientos desde la carga anterior (${n(data.total)})`}
        hint="Se comparan las dos ultimas cargas por el ID de cada persona, que es mas estable que el nombre."
        actions={
          <button type="button" className="btn btn--sm" onClick={() => downloadCsv('cambios', { region: filters.region }, '/hc/export')}>
            Exportar CSV
          </button>
        }
      >
        <DataTable
          columns={[
            { key: 'kind', label: 'Movimiento', render: (c) => KIND_LABEL[c.kind] || c.kind },
            {
              key: 'name',
              label: 'Persona',
              cellClass: 'name',
              render: (c) =>
                c.personKey ? <Link to={`/personal/${encodeURIComponent(c.personKey)}`}>{c.name}</Link> : <span className="muted">—</span>,
            },
            { key: 'roleLabel', label: 'Rol', cellClass: 'dim', render: (c) => c.roleLabel || '—' },
            { key: 'region', label: 'Region', cellClass: 'dim', render: (c) => c.region || '—' },
            { key: 'detail', label: 'Detalle', sortable: false, render: (c) => detailText(c) },
          ]}
          rows={data.changes}
          rowKey={(c, i) => i}
          initialSort={{ key: 'kind', dir: 'asc' }}
          emptyText="No hubo movimientos entre las dos ultimas cargas."
        />
      </Card>
    </div>
  );
}

/* --------------------------------- carga --------------------------------- */

function UploadCard({ onDone, snapshots }) {
  const [state, setState] = useState({ busy: false, progress: 0, result: null, error: null });
  const ultima = snapshots?.snapshots?.[0];

  async function enviar(file) {
    if (!file) return;
    setState({ busy: true, progress: 0, result: null, error: null });
    try {
      const res = await uploadFile(file, (p) => setState((s) => ({ ...s, progress: p })), '/api/hc/uploads');
      setState({ busy: false, progress: 100, result: res, error: null });
      onDone();
    } catch (err) {
      setState({ busy: false, progress: 0, result: null, error: err });
    }
  }

  return (
    <Card
      title="Actualizar plantilla"
      hint="Sube el archivo HC (.xlsb). El sistema lo lee, reemplaza los datos del personal y te dice que cambio respecto de la carga anterior."
      className="no-print"
    >
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <label className="btn btn--primary btn--sm" style={{ cursor: 'pointer' }}>
          {state.busy ? `Procesando… ${state.progress}%` : 'Elegir archivo'}
          <input
            type="file"
            accept=".xlsb,.xlsx,.xlsm"
            style={{ display: 'none' }}
            disabled={state.busy}
            onChange={(e) => enviar(e.target.files?.[0])}
          />
        </label>
        {ultima && (
          <span className="muted small">
            Ultima carga: {dateLabel(ultima.createdAt)} · {n(ultima.peopleCount)} personas · {n(ultima.storeCount)} tiendas
          </span>
        )}
      </div>

      <ErrorBox error={state.error} />

      {state.result && (
        <div className="alert alert--good" style={{ marginTop: 12 }}>
          Carga lista: {n(state.result.people)} personas y {n(state.result.stores)} tiendas.{' '}
          {state.result.previousId
            ? `Se detectaron ${n(state.result.changes)} movimientos contra la carga anterior.`
            : 'Es la primera carga, no hay con que compararla.'}
        </div>
      )}

      {ultima?.warnings?.length > 0 && (
        <div className="alert alert--warning" style={{ marginTop: 12 }}>
          <strong>Avisos del archivo</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {ultima.warnings.map((w) => (
              <li key={w} className="small">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
