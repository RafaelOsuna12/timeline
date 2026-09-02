/** Marco de la aplicacion: navegacion lateral, encabezado y area de contenido. */
import { NavLink } from 'react-router-dom';
import { useAuth, useData } from '../app/context.jsx';
import { dateLabel, periodLabel } from '../utils/format.js';

const Icon = ({ path }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

const ICONS = {
  overview: <Icon path={<><path d="M3 12h4l3 8 4-16 3 8h4" /></>} />,
  regions: <Icon path={<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18" /></>} />,
  teams: <Icon path={<><path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="3" /><path d="M22 20v-2a4 4 0 0 0-3-3.87" /></>} />,
  promoters: <Icon path={<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10" /></>} />,
  models: <Icon path={<><rect x="6" y="2" width="12" height="20" rx="2" /><path d="M11 18h2" /></>} />,
  stores: <Icon path={<><path d="M3 9l1.5-5h15L21 9M3 9h18M3 9v11h18V9M9 20v-6h6v6" /></>} />,
  attendance: <Icon path={<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4" /></>} />,
  comparison: <Icon path={<><path d="M12 3v18M7 8l-4 4 4 4M17 8l4 4-4 4" /></>} />,
  upload: <Icon path={<><path d="M12 16V4M7 9l5-5 5 5" /><path d="M3 16v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3" /></>} />,
  admin: <Icon path={<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 15a2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 5V4.9a2 2 0 1 1 4 0V5a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 19 12" /></>} />,
};

const NAV = [
  { group: 'Analisis', items: [
    { to: '/', label: 'Resumen ejecutivo', icon: 'overview', end: true },
    { to: '/regiones', label: 'Regiones y canales', icon: 'regions' },
    { to: '/equipos', label: 'CM y supervisores', icon: 'teams' },
    { to: '/promotores', label: 'Promotores', icon: 'promoters' },
    { to: '/modelos', label: 'Modelos y mezcla', icon: 'models' },
    { to: '/tiendas', label: 'Tiendas', icon: 'stores' },
    { to: '/asistencia', label: 'Asistencia y cero venta', icon: 'attendance' },
    { to: '/comparativa', label: 'Avance entre cargas', icon: 'comparison' },
  ] },
  { group: 'Sistema', items: [
    { to: '/cargar', label: 'Cargar archivo', icon: 'upload', roles: ['admin', 'editor'] },
    { to: '/administracion', label: 'Administracion', icon: 'admin', roles: ['admin'] },
  ] },
];

export function AppShell({ title, subtitle, actions, filterBar, children }) {
  const { user, logout } = useAuth();
  const { activeSnapshot } = useData();

  return (
    <div className="shell">
      <aside className="sidebar no-print">
        <div className="sidebar__brand">
          <h1 className="sidebar__title">Avance de ventas</h1>
          <p className="sidebar__subtitle">Sell-out retail · R1–R3</p>
        </div>
        <nav className="sidebar__nav">
          {NAV.map((section) => (
            <div key={section.group}>
              <div className="sidebar__group">{section.group}</div>
              {section.items
                .filter((item) => !item.roles || item.roles.includes(user?.role))
                .map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) => `navlink${isActive ? ' is-active' : ''}`}
                  >
                    {ICONS[item.icon]}
                    {item.label}
                  </NavLink>
                ))}
            </div>
          ))}
        </nav>
        <div className="sidebar__footer">
          <div style={{ fontWeight: 560, color: '#e8e8e4' }}>{user?.name || user?.username}</div>
          <div style={{ textTransform: 'capitalize' }}>{user?.role}</div>
          <button type="button" className="btn btn--sm btn--ghost" style={{ padding: 0, marginTop: 6 }} onClick={logout}>
            Cerrar sesion
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar__head">
            <div>
              <h1 className="page-title">{title}</h1>
              <p className="page-subtitle">
                {subtitle}
                {activeSnapshot && (
                  <>
                    {subtitle ? ' · ' : ''}
                    {periodLabel(activeSnapshot.periodKey)}, informacion al dia {activeSnapshot.cutoffDay} de{' '}
                    {activeSnapshot.daysInMonth} · cargado {dateLabel(activeSnapshot.createdAt)}
                  </>
                )}
              </p>
            </div>
            {actions && <div className="row no-print">{actions}</div>}
          </div>
          {filterBar}
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

export default AppShell;
