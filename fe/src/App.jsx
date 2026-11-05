import { Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './auth/ProtectedRoute.jsx';
import { AppLayout } from './layouts/AppLayout.jsx';
import LoginPage from './pages/LoginPage.jsx';
import HomePage from './pages/HomePage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import ZonesPage from './pages/masters/ZonesPage.jsx';
import WardsPage from './pages/masters/WardsPage.jsx';
import AgenciesPage from './pages/masters/AgenciesPage.jsx';
import VehiclesPage from './pages/masters/VehiclesPage.jsx';
import UsersPage from './pages/masters/UsersPage.jsx';
import PidsPage from './pages/pids/PidsPage.jsx';
import PidImportPage from './pages/pids/PidImportPage.jsx';
import RoutesPage from './pages/routes/RoutesPage.jsx';
import RouteBuilderPage from './pages/routes/RouteBuilderPage.jsx';
import AssignmentsPage from './pages/assignments/AssignmentsPage.jsx';

const guard = (permission, element) => <ProtectedRoute permission={permission}>{element}</ProtectedRoute>;

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route index element={<HomePage />} />
          <Route path="pids" element={guard('pids:read', <PidsPage />)} />
          <Route path="pids/import" element={guard('pids:write', <PidImportPage />)} />
          <Route path="routes" element={guard('routes:read', <RoutesPage />)} />
          {/* One route for /routes/new and /routes/:id so the builder keeps its state after "create". */}
          <Route path="routes/:id" element={guard('routes:read', <RouteBuilderPage />)} />
          <Route path="assignments" element={guard('assignments:read', <AssignmentsPage />)} />
          <Route path="zones" element={guard('zones:read', <ZonesPage />)} />
          <Route path="wards" element={guard('wards:read', <WardsPage />)} />
          <Route path="agencies" element={guard('agencies:read', <AgenciesPage />)} />
          <Route path="vehicles" element={guard('vehicles:read', <VehiclesPage />)} />
          <Route path="users" element={guard('users:read', <UsersPage />)} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
