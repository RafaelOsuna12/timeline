/** Administracion: usuarios y bitacora de actividad. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../app/context.jsx';
import AppShell from '../components/AppShell.jsx';
import { Card, DataTable, Empty, ErrorBox, Spinner } from '../components/ui.jsx';
import { dateLabel } from '../utils/format.js';

const ROLE_LABELS = {
  admin: 'Administrador — todo, incluidos usuarios',
  editor: 'Editor — consulta y carga de archivos',
  viewer: 'Consulta — solo lectura',
};

export default function Admin() {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [audit, setAudit] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.users(), api.audit()])
      .then(([u, a]) => {
        setUsers(u.users);
        setAudit(a.entries);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  return (
    <AppShell title="Administracion" subtitle="Usuarios y bitacora del sistema">
      <ErrorBox error={error} onRetry={load} />
      {loading && !users.length && <Spinner />}
      <div className="grid grid--wide-left">
        <UsersCard users={users} currentUser={user} onChange={load} />
        <NewUserCard onCreated={load} />
      </div>
      <Card title="Bitacora" hint="Ultimos movimientos: accesos, cargas y cambios de usuarios.">
        {audit.length === 0 ? (
          <Empty>Sin registros.</Empty>
        ) : (
          <DataTable
            columns={[
              { key: 'at', label: 'Fecha', render: (r) => dateLabel(r.at) },
              { key: 'actor', label: 'Usuario', cellClass: 'dim' },
              { key: 'action', label: 'Accion' },
              { key: 'detail', label: 'Detalle', cellClass: 'dim', sortable: false },
            ]}
            rows={audit}
            rowKey={(r) => r.id}
            initialSort={{ key: 'at', dir: 'desc' }}
          />
        )}
      </Card>
    </AppShell>
  );
}

function UsersCard({ users, currentUser, onChange }) {
  const [error, setError] = useState(null);

  async function changeRole(id, role) {
    setError(null);
    try {
      await api.updateUser(id, { role });
      onChange();
    } catch (e) {
      setError(e);
    }
  }

  async function resetPassword(id, username) {
    const password = window.prompt(`Nueva contrasena para ${username} (minimo 10 caracteres):`);
    if (!password) return;
    setError(null);
    try {
      await api.updateUser(id, { password });
      window.alert('Contrasena actualizada.');
    } catch (e) {
      setError(e);
    }
  }

  async function remove(id, username) {
    if (!window.confirm(`Eliminar al usuario ${username}?`)) return;
    setError(null);
    try {
      await api.deleteUser(id);
      onChange();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <Card title="Usuarios" hint="Los editores pueden cargar archivos; los usuarios de consulta solo ven el tablero.">
      {error && <div className="form-error" style={{ marginBottom: 10 }}>{error.message}</div>}
      <DataTable
        columns={[
          { key: 'username', label: 'Usuario', cellClass: 'name' },
          { key: 'display_name', label: 'Nombre' },
          {
            key: 'role',
            label: 'Rol',
            sortable: false,
            render: (u) => (
              <select
                className="control"
                style={{ minWidth: 110, minHeight: 28, padding: '2px 22px 2px 8px', fontSize: 12 }}
                value={u.role}
                disabled={u.username === currentUser?.username}
                onChange={(e) => changeRole(u.id, e.target.value)}
              >
                <option value="admin">Administrador</option>
                <option value="editor">Editor</option>
                <option value="viewer">Consulta</option>
              </select>
            ),
          },
          { key: 'last_login', label: 'Ultimo acceso', render: (u) => (u.last_login ? dateLabel(u.last_login) : 'Nunca') },
          {
            key: 'actions',
            label: '',
            sortable: false,
            render: (u) => (
              <div className="row">
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => resetPassword(u.id, u.username)}>
                  Cambiar contrasena
                </button>
                {u.username !== currentUser?.username && (
                  <button type="button" className="btn btn--sm btn--danger" onClick={() => remove(u.id, u.username)}>
                    Eliminar
                  </button>
                )}
              </div>
            ),
          },
        ]}
        rows={users}
        rowKey={(u) => u.id}
        initialSort={{ key: 'username', dir: 'asc' }}
      />
    </Card>
  );
}

function NewUserCard({ onCreated }) {
  const [form, setForm] = useState({ username: '', displayName: '', password: '', role: 'viewer' });
  const [error, setError] = useState(null);
  const [ok, setOk] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await api.createUser(form);
      setOk(`Usuario ${form.username} creado.`);
      setForm({ username: '', displayName: '', password: '', role: 'viewer' });
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Card title="Nuevo usuario">
      <form className="stack" style={{ gap: 10 }} onSubmit={submit}>
        <label className="field">
          <span className="field__label">Usuario</span>
          <input className="control" value={form.username} onChange={set('username')} autoComplete="off" required />
        </label>
        <label className="field">
          <span className="field__label">Nombre completo</span>
          <input className="control" value={form.displayName} onChange={set('displayName')} autoComplete="off" />
        </label>
        <label className="field">
          <span className="field__label">Contrasena (minimo 10 caracteres)</span>
          <input className="control" type="password" value={form.password} onChange={set('password')} autoComplete="new-password" required minLength={10} />
        </label>
        <label className="field">
          <span className="field__label">Rol</span>
          <select className="control" value={form.role} onChange={set('role')}>
            {Object.entries(ROLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {error && <div className="form-error">{error.message}</div>}
        {ok && <div className="form-ok">{ok}</div>}
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'Creando…' : 'Crear usuario'}
        </button>
      </form>
    </Card>
  );
}
