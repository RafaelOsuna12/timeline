/**
 * Paqueteria: guias activas y su seguimiento.
 *
 * Es la unica seccion del sitio donde se captura informacion en vez de
 * consultarla, y la unica que no pertenece a un periodo: un paquete esta en
 * camino hoy, no "en noviembre". Por eso no lleva la barra de filtros del
 * tablero ni la linea del corte en el encabezado.
 *
 * La vista esta pensada para la funcion de notificaciones que viene despues:
 * la agenda agrupada por cercania de llegada es, literalmente, lo que un aviso
 * tendria que decir cada manana.
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, downloadCsv } from '../api.js';
import { useAuth, useQuery } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import { FilterPanel } from '../components/FilterPanel.jsx';
import { Card, DataTable, Empty, ErrorBox, Kpi, Spinner } from '../components/ui.jsx';
import { dayLabel } from '../utils/format.js';

const TABS = [
  { key: 'pendientes', label: 'Pendientes' },
  { key: 'agenda', label: 'Agenda de llegadas' },
  { key: 'historial', label: 'Historial' },
];

/**
 * Tono de cada estado. Solo hay cuatro colores reservados para estado en el
 * sistema, asi que se reparten por urgencia: lo que pide accion se calienta.
 */
export const PKG_TONE = {
  EN_TRANSITO: 'neutral',
  EN_SUCURSAL: 'warning',
  RETRASADO: 'serious',
  INCIDENCIA: 'critical',
  ENTREGADO: 'good',
  CANCELADO: 'neutral',
};

export function PkgPill({ status, label }) {
  const tone = PKG_TONE[status] || 'neutral';
  return (
    <span className={`pill pill--${tone}`}>
      <span className="pill__dot" />
      {label || status}
    </span>
  );
}

/** "faltan 3 dias", "hoy", "hace 2 dias". Mas claro que una fecha suelta. */
export function etaLabel(days) {
  if (days === null || days === undefined) return null;
  if (days === 0) return 'llega hoy';
  if (days === 1) return 'llega manana';
  if (days > 1) return `faltan ${days} dias`;
  const d = Math.abs(days);
  return `${d} ${d === 1 ? 'dia' : 'dias'} de retraso`;
}

export default function Packages() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState(null); // null | 'nuevo' | objeto guia

  const tab = params.get('tab') || 'pendientes';
  const filters = useMemo(
    () => ({
      region: params.get('region') || undefined,
      carrier: params.get('carrier') || undefined,
      status: params.get('status') || undefined,
      recipient: params.get('recipient') || undefined,
      deliveryMode: params.get('deliveryMode') || undefined,
      search: params.get('search') || undefined,
    }),
    [params]
  );

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

  const { data: catalogs, error: catalogsError } = useQuery((signal) => api.pkg.catalogs(signal), [reloadKey]);

  const scope = tab === 'historial' ? 'cerradas' : 'abiertas';
  const { data, error } = useQuery(
    (signal) =>
      tab === 'agenda'
        ? api.pkg.agenda(filters, signal)
        : api.pkg.list({ ...filters, scope }, signal),
    [tab, scope, JSON.stringify(filters), reloadKey]
  );

  const puedeEditar = user?.role === 'admin' || user?.role === 'editor';
  const recargar = () => setReloadKey((k) => k + 1);

  /**
   * `useQuery` conserva la respuesta anterior mientras llega la nueva, para
   * que la pantalla no parpadee. Pero las dos consultas de esta seccion
   * devuelven formas distintas —la agenda trae `groups` y las listas traen
   * `items`—, asi que justo despues de cambiar de pestaña la respuesta en
   * memoria todavia es la de la pestaña anterior. Por eso cada rama se dibuja
   * solo cuando el payload es el suyo, y no solo cuando la pestaña coincide:
   * leer `data.items` sobre una respuesta de agenda rompia la vista entera.
   */
  const esAgenda = tab === 'agenda';
  const grupos = esAgenda ? data?.groups : null;
  const items = esAgenda ? null : data?.items;
  const esperando = !grupos && !items;

  return (
    <AppShell
      title="Paqueteria"
      subtitle="Guias en camino y su seguimiento"
      showSnapshot={false}
      actions={
        <div className="row no-print">
          <button type="button" className="btn btn--sm" onClick={() => downloadCsv('paquetes', { ...filters, scope: 'todas' }, '/paqueteria/export')}>
            Exportar CSV
          </button>
          {puedeEditar && (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => setEditing('nuevo')}>
              Nueva guia
            </button>
          )}
        </div>
      }
    >
      <ErrorBox error={catalogsError} />

      <Summary summary={data?.summary} today={data?.today} />

      {editing && catalogs && (
        <div style={{ marginBottom: 16 }}>
          <PackageForm
            catalogs={catalogs}
            pkg={editing === 'nuevo' ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={(guia) => {
              setEditing(null);
              recargar();
              if (editing === 'nuevo') navigate(`/paqueteria/${guia.id}`);
            }}
          />
        </div>
      )}

      {catalogs && <Filters catalogs={catalogs} filters={filters} onChange={setFilter} />}

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

      <ErrorBox error={error} />
      {esperando && !error && <Spinner label="Cargando guias…" />}

      {grupos && (
        <Agenda groups={grupos} puedeEditar={puedeEditar} onChanged={recargar} onEdit={setEditing} />
      )}
      {items && (
        <Card
          flush
          title={tab === 'historial' ? 'Guias cerradas' : 'Guias pendientes'}
          hint={`${items.length} ${items.length === 1 ? 'guia' : 'guias'}`}
        >
          <PackageTable
            rows={items}
            cerradas={tab === 'historial'}
            puedeEditar={puedeEditar}
            onChanged={recargar}
            onEdit={setEditing}
            emptyText={
              tab === 'historial'
                ? 'Todavia no hay guias entregadas o canceladas.'
                : 'No hay guias pendientes con estos filtros.'
            }
          />
        </Card>
      )}
    </AppShell>
  );
}

/* ------------------------------ indicadores ------------------------------ */

function Summary({ summary, today }) {
  if (!summary) return null;
  return (
    <div className="kpis" style={{ marginBottom: 16 }}>
      <Kpi label="Guias activas" value={summary.activos} meta="en transito o por recoger" />
      <Kpi label="Llegan esta semana" value={summary.semana} meta="en los proximos 7 dias" />
      <Kpi
        label="Retrasadas"
        value={summary.retrasados}
        meta={summary.retrasados ? 'pasaron su fecha estimada' : 'ninguna pasada de fecha'}
        tone={summary.retrasados ? 'serious' : 'good'}
      />
      <Kpi label="Entregadas este mes" value={summary.entregadosMes} meta={today ? `al ${dayLabel(today)}` : undefined} />
    </div>
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
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Filters({ catalogs, filters, onChange }) {
  const regiones = useMemo(
    () => [...new Set(catalogs.recipients.map((r) => r.region).filter(Boolean))].sort(),
    [catalogs.recipients]
  );
  const destinatarios = useMemo(
    () => [
      ...catalogs.offices.map((o) => ({ key: o.key, label: o.name })),
      ...catalogs.recipients
        .filter((r) => !filters.region || r.region === filters.region)
        .map((r) => ({ key: r.key, label: r.name })),
    ],
    [catalogs, filters.region]
  );

  const activos = [
    filters.region && { key: 'region', label: `Region: ${filters.region}` },
    filters.carrier && { key: 'carrier', label: `Paqueteria: ${catalogs.carriers.find((c) => c.code === filters.carrier)?.name || filters.carrier}` },
    filters.status && { key: 'status', label: `Estado: ${catalogs.statuses.find((s) => s.key === filters.status)?.label || filters.status}` },
    filters.recipient && { key: 'recipient', label: `Destinatario: ${destinatarios.find((d) => d.key === filters.recipient)?.label || filters.recipient}` },
    filters.deliveryMode && { key: 'deliveryMode', label: `Entrega: ${catalogs.deliveryModes.find((d) => d.key === filters.deliveryMode)?.label || filters.deliveryMode}` },
    filters.search && { key: 'search', label: `Busqueda: ${filters.search}` },
  ].filter(Boolean);

  return (
    <div className="no-print">
      <FilterPanel active={activos.length}>
        <div className="filterbar">
        <Select
          label="Region"
          value={filters.region}
          onChange={(v) => onChange({ region: v, recipient: undefined })}
          options={regiones.map((r) => ({ key: r, label: r }))}
          allLabel="Todas las regiones"
          width={150}
        />
        <Select
          label="Destinatario"
          value={filters.recipient}
          onChange={(v) => onChange('recipient', v)}
          options={destinatarios}
          allLabel="Todos"
          width={230}
        />
        <Select
          label="Paqueteria"
          value={filters.carrier}
          onChange={(v) => onChange('carrier', v)}
          options={catalogs.carriers.map((c) => ({ key: c.code, label: c.name }))}
          allLabel="Todas"
          width={160}
        />
        <Select
          label="Estado"
          value={filters.status}
          onChange={(v) => onChange('status', v)}
          options={catalogs.statuses.map((s) => ({ key: s.key, label: s.label }))}
          allLabel="Todos"
          width={200}
        />
        <Select
          label="Entrega"
          value={filters.deliveryMode}
          onChange={(v) => onChange('deliveryMode', v)}
          options={catalogs.deliveryModes.map((d) => ({ key: d.key, label: d.label }))}
          allLabel="Todas"
          width={200}
        />
        <label className="field" style={{ flex: '1 1 180px' }}>
          <span className="field__label">Buscar</span>
          <input
            className="control"
            style={{ width: '100%' }}
            type="search"
            placeholder="Guia, destinatario o contenido"
            defaultValue={filters.search || ''}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onChange('search', e.currentTarget.value.trim());
            }}
            onBlur={(e) => onChange('search', e.currentTarget.value.trim())}
          />
        </label>
        </div>
      </FilterPanel>

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
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => onChange(Object.fromEntries(activos.map((c) => [c.key, undefined])))}>
            Limpiar
          </button>
        </div>
      )}
    </div>
  );
}

/* --------------------------------- tabla --------------------------------- */

export function PackageTable({ rows, cerradas = false, puedeEditar, onChanged, onEdit, emptyText }) {
  const navigate = useNavigate();

  const columns = [
    {
      key: 'tracking',
      label: 'Guia',
      render: (r) => (
        <div>
          <div style={{ fontWeight: 560 }}>{r.tracking}</div>
          <div className="muted small">{r.carrierName}</div>
        </div>
      ),
    },
    {
      key: 'recipientName',
      label: 'Destinatario',
      render: (r) => (
        <div>
          <div style={{ fontWeight: 530 }}>{r.recipientName}</div>
          <div className="muted small">
            {[r.recipientRole, r.recipientRegion].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
      ),
    },
    {
      key: 'route',
      label: 'Origen y destino',
      sortValue: (r) => r.destCity || '',
      render: (r) => (
        <div>
          <div>{[r.originCity, r.destCity].filter(Boolean).join(' → ') || '—'}</div>
          <div className="muted small">{r.deliveryLabel}{r.destPlace ? ` · ${r.destPlace}` : ''}</div>
        </div>
      ),
    },
    {
      key: 'etaDate',
      label: cerradas ? 'Entregado' : 'Llegada estimada',
      defaultDir: 'asc',
      sortValue: (r) => (cerradas ? r.deliveredAt : r.etaDate) || '',
      render: (r) =>
        cerradas ? (
          r.deliveredAt ? dayLabel(r.deliveredAt) : '—'
        ) : (
          <div>
            <div>{r.etaDate ? dayLabel(r.etaDate) : 'sin fecha'}</div>
            {etaLabel(r.daysToEta) && (
              <div className={`small ${r.late ? 'is-late' : 'muted'}`}>{etaLabel(r.daysToEta)}</div>
            )}
          </div>
        ),
    },
    {
      key: 'status',
      label: 'Estado',
      render: (r) => (
        <div className="row" style={{ gap: 6 }}>
          <PkgPill status={r.status} label={r.statusLabel} />
          {r.late && r.status !== 'RETRASADO' && <span className="flag-late">pasada de fecha</span>}
        </div>
      ),
    },
  ];

  if (puedeEditar) {
    columns.push({
      key: 'acciones',
      label: '',
      sortable: false,
      cellClass: 'no-print',
      render: (r) => <RowActions pkg={r} onChanged={onChanged} onEdit={onEdit} />,
    });
  }

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      onRowClick={(r) => navigate(`/paqueteria/${r.id}`)}
      emptyText={emptyText}
    />
  );
}

/** Acciones rapidas sin salir de la tabla: lo que se hace todos los dias. */
function RowActions({ pkg, onChanged, onEdit }) {
  const [busy, setBusy] = useState(false);

  const mover = async (status) => {
    setBusy(true);
    try {
      await api.pkg.setStatus(pkg.id, status);
      onChanged();
    } catch (e) {
      window.alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  // `stopPropagation` en el contenedor: la fila entera navega a la ficha y sin
  // esto cualquier clic en un boton abriria la ficha ademas de ejecutar la
  // accion.
  return (
    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
      {pkg.open && (
        <button type="button" className="btn btn--sm" disabled={busy} onClick={() => mover('ENTREGADO')}>
          Entregado
        </button>
      )}
      <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => onEdit(pkg)}>
        Editar
      </button>
    </div>
  );
}

/* --------------------------------- agenda -------------------------------- */

function Agenda({ groups, puedeEditar, onChanged, onEdit }) {
  if (!groups?.length) return <Empty>No hay guias pendientes con estos filtros.</Empty>;
  return (
    <div className="stack" style={{ gap: 16 }}>
      {groups.map((g) => (
        <Card
          key={g.key}
          flush
          title={g.label}
          hint={`${g.items.length} ${g.items.length === 1 ? 'guia' : 'guias'}`}
        >
          <PackageTable rows={g.items} puedeEditar={puedeEditar} onChanged={onChanged} onEdit={onEdit} />
        </Card>
      ))}
    </div>
  );
}

/* -------------------------------- formulario ------------------------------ */

const VACIO = {
  tracking: '',
  carrier: 'DHL',
  carrierOther: '',
  deliveryMode: 'OCURRE',
  recipientKey: '',
  destPlace: '',
  originCity: '',
  originState: '',
  destCity: '',
  destState: '',
  shippedDate: '',
  etaDate: '',
  status: 'EN_TRANSITO',
  contents: '',
  notes: '',
};

/** El nombre del lugar de entrega cambia segun como llega el paquete. */
const ETIQUETA_LUGAR = {
  DOMICILIO: 'Direccion de entrega',
  OCURRE: 'Sucursal donde ocurre',
  OFICINA: 'Oficina',
};

export function PackageForm({ catalogs, pkg, onCancel, onSaved }) {
  const [form, setForm] = useState(() =>
    pkg
      ? {
          tracking: pkg.tracking || '',
          carrier: pkg.carrier || 'DHL',
          carrierOther: pkg.carrierOther || '',
          deliveryMode: pkg.deliveryMode || 'OCURRE',
          recipientKey: pkg.recipientKey || '',
          destPlace: pkg.destPlace || '',
          originCity: pkg.originCity || '',
          originState: pkg.originState || '',
          destCity: pkg.destCity || '',
          destState: pkg.destState || '',
          shippedDate: pkg.shippedDate || '',
          etaDate: pkg.etaDate || '',
          status: pkg.status || 'EN_TRANSITO',
          contents: pkg.contents || '',
          notes: pkg.notes || '',
        }
      : VACIO
  );
  const [error, setError] = useState(null);
  const [duplicado, setDuplicado] = useState(null);
  const [saving, setSaving] = useState(false);

  const set = (campo) => (e) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [campo]: value }));
    if (campo === 'tracking' || campo === 'carrier') setDuplicado(null);
  };

  /** Al elegir una ciudad conocida se rellena su estado: un dato menos. */
  const setCity = (campoCiudad, campoEstado) => (e) => {
    const value = e.target.value;
    const conocida = catalogs.cities.find((c) => c.city.toUpperCase() === value.trim().toUpperCase());
    setForm((f) => ({ ...f, [campoCiudad]: value, [campoEstado]: conocida?.state || f[campoEstado] }));
  };

  const esOficina = catalogs.offices.some((o) => o.key === form.recipientKey);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const payload = {
      ...form,
      recipientKind: esOficina ? 'OFICINA' : 'PERSONA',
      force: Boolean(duplicado),
    };
    try {
      const guia = pkg ? await api.pkg.update(pkg.id, payload) : await api.pkg.create(payload);
      onSaved(guia);
    } catch (err) {
      if (err.code === 'DUPLICADO') setDuplicado(true);
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title={pkg ? `Editar guia ${pkg.tracking}` : 'Nueva guia'}>
      <form className="pkg-form" onSubmit={submit}>
        <label className="field">
          <span className="field__label">Numero de guia</span>
          <input className="control" value={form.tracking} onChange={set('tracking')} autoComplete="off" required autoFocus />
        </label>

        <label className="field">
          <span className="field__label">Paqueteria</span>
          <select className="control" value={form.carrier} onChange={set('carrier')}>
            {catalogs.carriers.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        {form.carrier === 'OTRA' && (
          <label className="field">
            <span className="field__label">Nombre de la paqueteria</span>
            <input className="control" value={form.carrierOther} onChange={set('carrierOther')} required />
          </label>
        )}

        <label className="field">
          <span className="field__label">Como se entrega</span>
          <select className="control" value={form.deliveryMode} onChange={set('deliveryMode')}>
            {catalogs.deliveryModes.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">Quien recibe</span>
          <select className="control" value={form.recipientKey} onChange={set('recipientKey')} required>
            <option value="">Elige a quien va dirigido…</option>
            <optgroup label="Oficinas HONOR">
              {catalogs.offices.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Mandos medios">
              {catalogs.recipients.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name} · {r.roleLabel}
                  {r.region ? ` · ${r.region}` : ''}
                </option>
              ))}
            </optgroup>
          </select>
        </label>

        <label className="field pkg-form__wide">
          <span className="field__label">{ETIQUETA_LUGAR[form.deliveryMode] || 'Lugar de entrega'}</span>
          <input
            className="control"
            value={form.destPlace}
            onChange={set('destPlace')}
            placeholder={form.deliveryMode === 'DOMICILIO' ? 'Calle, numero, colonia' : 'Nombre y direccion de la sucursal'}
          />
        </label>

        <label className="field">
          <span className="field__label">Ciudad de origen</span>
          <input className="control" list="pkg-ciudades" value={form.originCity} onChange={setCity('originCity', 'originState')} />
        </label>
        <label className="field">
          <span className="field__label">Estado de origen</span>
          <input className="control" value={form.originState} onChange={set('originState')} />
        </label>
        <label className="field">
          <span className="field__label">Ciudad de destino</span>
          <input className="control" list="pkg-ciudades" value={form.destCity} onChange={setCity('destCity', 'destState')} />
        </label>
        <label className="field">
          <span className="field__label">Estado de destino</span>
          <input className="control" value={form.destState} onChange={set('destState')} />
        </label>

        <datalist id="pkg-ciudades">
          {catalogs.cities.map((c) => (
            <option key={c.city} value={c.city} />
          ))}
        </datalist>

        <label className="field">
          <span className="field__label">Fecha de envio</span>
          <input className="control" type="date" value={form.shippedDate} onChange={set('shippedDate')} />
        </label>
        <label className="field">
          <span className="field__label">Llegada aproximada</span>
          <input className="control" type="date" value={form.etaDate} onChange={set('etaDate')} />
        </label>
        <label className="field">
          <span className="field__label">Estado</span>
          <select className="control" value={form.status} onChange={set('status')}>
            {catalogs.statuses.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field pkg-form__full">
          <span className="field__label">Que va en el paquete</span>
          <textarea
            className="control"
            rows={3}
            value={form.contents}
            onChange={set('contents')}
            placeholder="Ej: 3 demos Honor X9c, material POP y 2 uniformes"
          />
        </label>

        <label className="field pkg-form__full">
          <span className="field__label">Notas</span>
          <textarea className="control" rows={2} value={form.notes} onChange={set('notes')} />
        </label>

        {error && (
          <div className="form-error pkg-form__full">
            {error.message}
            {duplicado && ' Vuelve a presionar Guardar para registrarla de todas formas.'}
          </div>
        )}

        <div className="row pkg-form__full" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn--sm btn--ghost" onClick={onCancel}>
            Cancelar
          </button>
          <button type="submit" className="btn btn--sm btn--primary" disabled={saving}>
            {saving ? 'Guardando…' : duplicado ? 'Guardar de todas formas' : 'Guardar'}
          </button>
        </div>
      </form>
    </Card>
  );
}
