/**
 * Ficha de una guia: todo lo que se sabe del paquete y su bitacora completa.
 *
 * La bitacora no es adorno. Es el unico dato del sitio que no se puede volver
 * a construir desde un Excel, asi que cada cambio queda registrado con quien
 * lo hizo y cuando, y es tambien de donde saldran los avisos de llegada.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useQuery } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import { Card, ErrorBox, Spinner } from '../components/ui.jsx';
import { dateLabel, dayLabel } from '../utils/format.js';
import { PackageForm, PkgPill, etaLabel } from './Packages.jsx';

const KINDS = {
  alta: 'Alta',
  estado: 'Cambio de estado',
  datos: 'Cambio de datos',
  baja: 'Baja',
};

export default function PackageDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [reloadKey, setReloadKey] = useState(0);
  const [editando, setEditando] = useState(false);

  const { data: pkg, error, loading } = useQuery((signal) => api.pkg.get(id, signal), [id, reloadKey]);
  const { data: catalogs } = useQuery((signal) => api.pkg.catalogs(signal), [reloadKey]);

  const puedeEditar = user?.role === 'admin' || user?.role === 'editor';
  const recargar = () => setReloadKey((k) => k + 1);

  async function mover(status) {
    try {
      await api.pkg.setStatus(pkg.id, status);
      recargar();
    } catch (e) {
      window.alert(e.message);
    }
  }

  async function borrar() {
    if (!window.confirm(`Dar de baja la guia ${pkg.tracking}? Deja de aparecer en las listas, pero su historial se conserva.`)) return;
    try {
      await api.pkg.remove(pkg.id);
      navigate('/paqueteria');
    } catch (e) {
      window.alert(e.message);
    }
  }

  return (
    <AppShell
      title={pkg ? `Guia ${pkg.tracking}` : 'Guia'}
      subtitle={pkg ? `${pkg.carrierName} · para ${pkg.recipientName}` : undefined}
      showSnapshot={false}
      actions={
        <div className="row no-print">
          <Link className="btn btn--sm" to="/paqueteria">
            Volver
          </Link>
          {pkg && pkg.trackUrl && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                // La liga abre la pagina de rastreo de la empresa; el numero va
                // al portapapeles porque cada una lo pide en su propio campo.
                navigator.clipboard?.writeText(pkg.tracking).catch(() => {});
                window.open(pkg.trackUrl, '_blank', 'noopener');
              }}
            >
              Rastrear en {pkg.carrierName}
            </button>
          )}
          {pkg && puedeEditar && (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => setEditando(true)}>
              Editar
            </button>
          )}
          {pkg && user?.role === 'admin' && (
            <button type="button" className="btn btn--sm btn--danger" onClick={borrar}>
              Dar de baja
            </button>
          )}
        </div>
      }
    >
      <ErrorBox error={error} />
      {loading && !pkg && <Spinner label="Cargando la guia…" />}

      {pkg && editando && catalogs && (
        <div style={{ marginBottom: 16 }}>
          <PackageForm
            catalogs={catalogs}
            pkg={pkg}
            onCancel={() => setEditando(false)}
            onSaved={() => {
              setEditando(false);
              recargar();
            }}
          />
        </div>
      )}

      {pkg && !editando && (
        <div className="stack" style={{ gap: 16 }}>
          <Card title="Estado">
            <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <PkgPill status={pkg.status} label={pkg.statusLabel} />
              {pkg.open && pkg.etaDate && (
                <span className={pkg.late ? 'is-late' : 'muted'}>
                  Llegada estimada {dayLabel(pkg.etaDate)} · {etaLabel(pkg.daysToEta)}
                </span>
              )}
              {pkg.open && !pkg.etaDate && <span className="muted">Sin fecha de llegada capturada</span>}
              {!pkg.open && pkg.deliveredAt && <span className="muted">Entregado el {dayLabel(pkg.deliveredAt)}</span>}
            </div>

            {puedeEditar && pkg.open && (
              <div className="chip-row" style={{ paddingTop: 12 }}>
                {['EN_TRANSITO', 'EN_SUCURSAL', 'INCIDENCIA', 'ENTREGADO', 'CANCELADO']
                  .filter((s) => s !== pkg.status)
                  .map((s) => (
                    <button key={s} type="button" className="btn btn--sm" onClick={() => mover(s)}>
                      {catalogs?.statuses.find((x) => x.key === s)?.label || s}
                    </button>
                  ))}
              </div>
            )}
          </Card>

          <Card title="Datos de la guia">
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  <tr>
                    <Celda label="Numero de guia" value={pkg.tracking} />
                    <Celda label="Paqueteria" value={pkg.carrierName} />
                  </tr>
                  <tr>
                    <Celda
                      label="Destinatario"
                      value={
                        pkg.recipientKind === 'PERSONA' && pkg.recipientKey ? (
                          <Link to={`/personal/${encodeURIComponent(pkg.recipientKey)}`}>{pkg.recipientName}</Link>
                        ) : (
                          pkg.recipientName
                        )
                      }
                    />
                    <Celda label="Rol y region" value={[pkg.recipientRole, pkg.recipientRegion].filter(Boolean).join(' · ')} />
                  </tr>
                  <tr>
                    <Celda label="Como se entrega" value={pkg.deliveryLabel} />
                    <Celda label="Lugar de entrega" value={pkg.destPlace} />
                  </tr>
                  <tr>
                    <Celda label="Origen" value={[pkg.originCity, pkg.originState].filter(Boolean).join(', ')} />
                    <Celda label="Destino" value={[pkg.destCity, pkg.destState].filter(Boolean).join(', ')} />
                  </tr>
                  <tr>
                    <Celda label="Fecha de envio" value={pkg.shippedDate ? dayLabel(pkg.shippedDate) : null} />
                    <Celda label="Llegada aproximada" value={pkg.etaDate ? dayLabel(pkg.etaDate) : null} />
                  </tr>
                  <tr>
                    <Celda label="Dias en transito" value={pkg.transitDays !== null ? String(pkg.transitDays) : null} />
                    <Celda label="Capturada por" value={`${pkg.createdBy || 'sistema'} el ${dateLabel(pkg.createdAt)}`} />
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Contenido">
            {pkg.contents ? <p className="pkg-text">{pkg.contents}</p> : <p className="muted">Sin detalle capturado.</p>}
            {pkg.notes && (
              <>
                <h3 className="pkg-text__h">Notas</h3>
                <p className="pkg-text">{pkg.notes}</p>
              </>
            )}
          </Card>

          <Card title="Bitacora" hint={`${pkg.events.length} ${pkg.events.length === 1 ? 'movimiento' : 'movimientos'}`}>
            <ol className="timeline">
              {pkg.events.map((e, i) => (
                <li key={i}>
                  {/* Marca de tiempo completa: `dateLabel` la traduce a la
                      hora del navegador, que es la de quien la lee. */}
                  <div className="timeline__when">{dateLabel(e.at)}</div>
                  <div className="timeline__what">
                    <strong>{KINDS[e.kind] || e.kind}</strong>
                    {e.detail ? ` — ${e.detail}` : ''}
                  </div>
                  <div className="timeline__who muted small">{e.actor || 'sistema'}</div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      )}
    </AppShell>
  );
}

function Celda({ label, value }) {
  return (
    <>
      <th className="is-static" scope="row">
        {label}
      </th>
      <td>{value || <span className="muted">—</span>}</td>
    </>
  );
}
