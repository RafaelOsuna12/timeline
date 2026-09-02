/** Pantalla de acceso. */
import { useState } from 'react';
import { useAuth } from '../app/context.jsx';

export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <div className="login__logo" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round">
            <path d="M4 20V12M10 20V6M16 20v-5M22 20V9" />
          </svg>
        </div>
        <h1 style={{ margin: '0 0 4px', fontSize: 19, fontWeight: 640, letterSpacing: '-0.015em' }}>
          Avance de ventas
        </h1>
        <p className="muted small" style={{ margin: '0 0 20px' }}>
          Tablero de sell-out y proyeccion de cierre mensual.
        </p>

        <div className="stack" style={{ gap: 12 }}>
          <label className="field">
            <span className="field__label">Usuario</span>
            <input
              className="control"
              style={{ width: '100%' }}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </label>
          <label className="field">
            <span className="field__label">Contrasena</span>
            <input
              className="control"
              style={{ width: '100%' }}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error && <div className="form-error">{error.message}</div>}
          <button type="submit" className="btn btn--primary" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Entrando…' : 'Entrar'}
          </button>
        </div>
      </form>
    </div>
  );
}
