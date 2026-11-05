import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from './AuthContext.jsx';
import { hasPermission } from './usePermission.js';
import { Spinner } from '../components/Spinner.jsx';
import { ErrorState } from '../components/ErrorState.jsx';

/**
 * Guards child routes. No session -> /login?redirect=<current path>.
 * With `permission` (and/or `role`), an authenticated user lacking it sees a 403 state (no data is fetched).
 */
export function ProtectedRoute({ permission, role, children }) {
  const { user, status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Restoring session…" />
      </div>
    );
  }
  if (!user) {
    const redirect = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?redirect=${redirect}`} replace />;
  }
  const roles = role ? [].concat(role) : null;
  if ((permission && !hasPermission(user, permission)) || (roles && !roles.includes(user.role_key))) {
    return <ErrorState title="Access denied" message="You do not have permission to view this page." />;
  }
  return children ?? <Outlet />;
}
