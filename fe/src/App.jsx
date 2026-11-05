// Route table for the data router (createBrowserRouter). Using a data router enables useBlocker
// (unsaved-changes guard that also catches browser Back/Forward).
import { Outlet } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext.jsx';
import { SettingsProvider } from './settings/SettingsContext.jsx';
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

/** AuthProvider needs router hooks (useNavigate), so it lives inside the router as the root element. */
function Root() {
  return (
    <AuthProvider>
      <SettingsProvider>
        <Outlet />
      </SettingsProvider>
    </AuthProvider>
  );
}

export const routes = [
  {
    element: <Root />,
    children: [
      { path: '/login', element: <LoginPage /> },
      {
        element: <ProtectedRoute />,
        children: [
          {
            element: <AppLayout />,
            children: [
              { index: true, element: <HomePage /> },
              { path: 'pids', element: guard('pids:read', <PidsPage />) },
              { path: 'pids/import', element: guard('pids:write', <PidImportPage />) },
              { path: 'routes', element: guard('routes:read', <RoutesPage />) },
              // One route for /routes/new and /routes/:id so the builder keeps its state after "create".
              { path: 'routes/:id', element: guard('routes:read', <RouteBuilderPage />) },
              { path: 'assignments', element: guard('assignments:read', <AssignmentsPage />) },
              { path: 'zones', element: guard('zones:read', <ZonesPage />) },
              { path: 'wards', element: guard('wards:read', <WardsPage />) },
              { path: 'agencies', element: guard('agencies:read', <AgenciesPage />) },
              { path: 'vehicles', element: guard('vehicles:read', <VehiclesPage />) },
              { path: 'users', element: guard('users:read', <UsersPage />) },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
];

export const ROUTER_FUTURE = {
  v7_relativeSplatPath: true,
  v7_fetcherPersist: true,
  v7_normalizeFormMethod: true,
  v7_partialHydration: true,
  v7_skipActionErrorRevalidation: true,
};
