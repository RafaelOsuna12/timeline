/**
 * Ficha de una persona de la plantilla.
 *
 * Reune lo que en el archivo esta repartido por tienda: sus datos, las plazas
 * que cubre y quien mas atiende esas mismas tiendas, que es como se reconstruye
 * su cadena de mando sin que el archivo la declare en ningun lado.
 */
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useQuery } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import { Card, DataTable, Empty, ErrorBox, Kpi, Spinner } from '../components/ui.jsx';
import { n } from '../utils/format.js';
import { tenureLabel } from './Personnel.jsx';

export default function PersonDetail() {
  const { key } = useParams();
  const { data, error, loading } = useQuery((signal) => api.hc.person(key, {}, signal), [key]);

  return (
    <AppShell
      title={data ? data.person.name : 'Persona'}
      subtitle={data ? `${data.person.roleLabel} · ${data.person.region || 'sin region'}` : ''}
      actions={
        <Link to="/personal" className="btn btn--sm">
          Volver al directorio
        </Link>
      }
    >
      <ErrorBox error={error} />
      {loading && !data && <Spinner />}
      {!loading && !data && !error && <Empty>No se encontro a la persona.</Empty>}
      {data && <Detail data={data} />}
    </AppShell>
  );
}

function Detail({ data }) {
  const p = data.person;
  return (
    <div className="stack">
      <section className="kpis">
        <Kpi label="Rol" value={p.roleLabel} compact meta={p.roles.length > 1 ? `Tambien: ${p.roles.slice(1).join(', ')}` : p.employment || undefined} />
        <Kpi
          label="Tiendas a cargo"
          value={n(p.storeCount)}
          meta={
            p.supportCount
              ? `Mas ${n(p.supportCount)} de apoyo, donde tambien vende`
              : p.channels.length
                ? p.channels.join(' · ')
                : 'Sin tienda asignada'
          }
        />
        <Kpi
          label="Antiguedad"
          value={tenureLabel(p.tenureMonths)}
          meta={p.hireDate ? `Ingreso el ${p.hireDate}` : 'Sin fecha de ingreso en el archivo'}
        />
        <Kpi label="Estatus" value={p.status === 'COVERED' ? 'Activo' : p.status} compact meta={`Origen: ${p.source === 'MM' ? 'mandos medios' : p.source === 'AMBOS' ? 'campo y mandos medios' : 'campo'}`} />
      </section>

      <Card title="Ficha">
        <div className="table-wrap">
          <table className="data">
            <tbody>
              <tr>
                <th className="is-static">ID HONOR</th>
                <td>{p.personId || '—'}</td>
                <th className="is-static">ID de agencia</th>
                <td>{p.agencyId || '—'}</td>
              </tr>
              <tr>
                <th className="is-static">Region</th>
                <td>{p.region || '—'}</td>
                <th className="is-static">Estado y ciudad</th>
                <td>{[p.state, p.city].filter(Boolean).join(' · ') || '—'}</td>
              </tr>
              <tr>
                <th className="is-static">Puesto</th>
                <td>{p.position || p.roleLabel}</td>
                <th className="is-static">Tipo de plaza</th>
                <td>{p.employment || '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      {data.chain.length > 0 && (
        <Card
          title="Cadena de mando"
          hint="Quienes cubren las mismas tiendas desde un rol de mando. Sale de la asignacion por tienda, no de un organigrama declarado."
        >
          <DataTable
            columns={[
              {
                key: 'name',
                label: 'Nombre',
                cellClass: 'name',
                render: (c) => <Link to={`/personal/${encodeURIComponent(c.personKey)}`}>{c.name}</Link>,
              },
              { key: 'roleLabel', label: 'Rol', cellClass: 'dim' },
              {
                key: 'stores',
                label: 'En cuantas de sus tiendas',
                numeric: true,
                sortValue: (c) => c.stores.length,
                render: (c) => `${n(c.stores.length)} de ${n(data.stores.length)}`,
              },
            ]}
            rows={data.chain}
            rowKey={(c) => c.personKey}
            initialSort={{ key: 'stores', dir: 'desc' }}
          />
        </Card>
      )}

      {data.stores.length > 0 && (
        <Card title={`Tiendas (${n(data.stores.length)})`} hint="Cada plaza que cubre, con el resto del equipo que la atiende.">
          <DataTable
            columns={[
              { key: 'store', label: 'Tienda', cellClass: 'name' },
              { key: 'channel', label: 'Canal', cellClass: 'dim' },
              { key: 'city', label: 'Ciudad', cellClass: 'dim' },
              {
                key: 'floor',
                label: 'Plaza',
                render: (s) => (s.floor === 'SUPPORT' ? <span className="tag tag--soft">apoyo</span> : s.floor === 'BASE' ? 'Base' : '—'),
              },
              {
                key: 'team',
                label: 'Equipo de la tienda',
                sortable: false,
                render: (s) =>
                  s.team.length ? (
                    <span className="small">
                      {s.team.map((t) => (
                        <span key={t.personKey} style={{ display: 'block' }}>
                          <span className="muted">{t.roleLabel}: </span>
                          {t.name}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  ),
              },
            ]}
            rows={data.stores}
            rowKey={(s) => s.storeId}
            initialSort={{ key: 'store', dir: 'asc' }}
          />
        </Card>
      )}
    </div>
  );
}
