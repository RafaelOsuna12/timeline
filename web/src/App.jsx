/** Rutas de la aplicacion y control de acceso. */
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, DataProvider, useAuth } from './app/context.jsx';
import { Spinner } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Overview from './pages/Overview.jsx';
import Regions from './pages/Regions.jsx';
import Teams from './pages/Teams.jsx';
import Promoters from './pages/Promoters.jsx';
import PromoterDetail from './pages/PromoterDetail.jsx';
import Models from './pages/Models.jsx';
import Stores from './pages/Stores.jsx';
import Attendance from './pages/Attendance.jsx';
import Comparison from './pages/Comparison.jsx';
import Upload from './pages/Upload.jsx';
import Admin from './pages/Admin.jsx';

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

function Gate() {
  const { user, checking } = useAuth();
  if (checking) {
    return (
      <div className="login">
        <Spinner label="Verificando la sesion…" />
      </div>
    );
  }
  if (!user) return <Login />;

  return (
    <DataProvider>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/regiones" element={<Regions />} />
        <Route path="/equipos" element={<Teams />} />
        <Route path="/promotores" element={<Promoters />} />
        <Route path="/promotores/:id" element={<PromoterDetail />} />
        <Route path="/modelos" element={<Models />} />
        <Route path="/tiendas" element={<Stores />} />
        <Route path="/asistencia" element={<Attendance />} />
        <Route path="/comparativa" element={<Comparison />} />
        <Route path="/cargar" element={<RoleRoute roles={['admin', 'editor']}><Upload /></RoleRoute>} />
        <Route path="/administracion" element={<RoleRoute roles={['admin']}><Admin /></RoleRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </DataProvider>
  );
}

function RoleRoute({ roles, children }) {
  const { user } = useAuth();
  if (!roles.includes(user?.role)) return <Navigate to="/" replace />;
  return children;
}
