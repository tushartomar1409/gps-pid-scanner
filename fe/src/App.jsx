// Route table for the data router (createBrowserRouter). Using a data router enables useBlocker
// (unsaved-changes guard that also catches browser Back/Forward).
// Every page is a lazy chunk (GUIDE #9 A1): the initial bundle is only the shell + login.
import { lazy, Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext.jsx';
import { SettingsProvider } from './settings/SettingsContext.jsx';
import { ProtectedRoute } from './auth/ProtectedRoute.jsx';
import { AppLayout } from './layouts/AppLayout.jsx';
import { PageSkeleton } from './components/Skeleton.jsx';
import LoginPage from './pages/LoginPage.jsx';

const IndexPage = lazy(() => import('./pages/IndexPage.jsx'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage.jsx'));
const ZonesPage = lazy(() => import('./pages/masters/ZonesPage.jsx'));
const WardsPage = lazy(() => import('./pages/masters/WardsPage.jsx'));
const AgenciesPage = lazy(() => import('./pages/masters/AgenciesPage.jsx'));
const VehiclesPage = lazy(() => import('./pages/masters/VehiclesPage.jsx'));
const UsersPage = lazy(() => import('./pages/masters/UsersPage.jsx'));
const PidsPage = lazy(() => import('./pages/pids/PidsPage.jsx'));
const PidImportPage = lazy(() => import('./pages/pids/PidImportPage.jsx'));
const RoutesPage = lazy(() => import('./pages/routes/RoutesPage.jsx'));
const RouteBuilderPage = lazy(() => import('./pages/routes/RouteBuilderPage.jsx'));
const AssignmentsPage = lazy(() => import('./pages/assignments/AssignmentsPage.jsx'));
const LiveTrackingPage = lazy(() => import('./pages/live/LiveTrackingPage.jsx'));
const CoverageMapPage = lazy(() => import('./pages/coverage/CoverageMapPage.jsx'));
const HistoryPage = lazy(() => import('./pages/history/HistoryPage.jsx'));
const DetectionSettingsPage = lazy(() => import('./pages/settings/DetectionSettingsPage.jsx'));
const GpsIntegrationPage = lazy(() => import('./pages/settings/GpsIntegrationPage.jsx'));
const ActivityLogsPage = lazy(() => import('./pages/settings/ActivityLogsPage.jsx'));

const page = (el) => <Suspense fallback={<PageSkeleton />}>{el}</Suspense>;
const guard = (permission, element, role) => <ProtectedRoute permission={permission} role={role}>{page(element)}</ProtectedRoute>;

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
              { index: true, element: page(<IndexPage />) },
              { path: 'live', element: guard('gps:read', <LiveTrackingPage />) },
              { path: 'coverage', element: guard('assignments:read', <CoverageMapPage />) },
              { path: 'history', element: guard('gps:read', <HistoryPage />) },
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
              { path: 'settings/detection', element: guard(null, <DetectionSettingsPage />, 'SUPER_ADMIN') },
              { path: 'settings/gps', element: guard('gps:read', <GpsIntegrationPage />) },
              { path: 'settings/activity-logs', element: guard(null, <ActivityLogsPage />, 'SUPER_ADMIN') },
              { path: '*', element: page(<NotFoundPage />) },
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
