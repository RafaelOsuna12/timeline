/** Rutas de la aplicacion y control de acceso. */
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, DataProvider, useAuth } from './app/context.jsx';
import { Spinner } from './components/ui.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
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
import Reports from './pages/Reports.jsx';
import Personnel from './pages/Personnel.jsx';
import Packages from './pages/Packages.jsx';
import PackageDetail from './pages/PackageDetail.jsx';
import PersonDetail from './pages/PersonDetail.jsx';
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
  const location = useLocation();
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
      {/* La barrera envuelve las rutas y se reinicia al navegar: un error al
          dibujar una pantalla deja de tumbar la aplicacion entera. */}
      <ErrorBoundary resetKey={location.pathname + location.search}>
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
          <Route path="/reportes" element={<Reports />} />
          <Route path="/personal" element={<Personnel />} />
          <Route path="/personal/:key" element={<PersonDetail />} />
          <Route path="/paqueteria" element={<Packages />} />
          <Route path="/paqueteria/:id" element={<PackageDetail />} />
          <Route path="/cargar" element={<RoleRoute roles={['admin', 'editor']}><Upload /></RoleRoute>} />
          <Route path="/administracion" element={<RoleRoute roles={['admin']}><Admin /></RoleRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </DataProvider>
  );
}

function RoleRoute({ roles, children }) {
  const { user } = useAuth();
  if (!roles.includes(user?.role)) return <Navigate to="/" replace />;
  return children;
}
