// "/" — the monitoring dashboard for users with dashboard:read, the welcome page for everyone else.
import { lazy } from 'react';
import { usePermission } from '../auth/usePermission.js';
import HomePage from './HomePage.jsx';

const DashboardPage = lazy(() => import('./dashboard/DashboardPage.jsx'));

export default function IndexPage() {
  const can = usePermission();
  return can('dashboard:read') ? <DashboardPage /> : <HomePage />;
}
