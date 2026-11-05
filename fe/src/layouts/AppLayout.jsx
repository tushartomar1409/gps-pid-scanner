import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import { Sidebar } from './Sidebar.jsx';
import { Button } from '../components/Button.jsx';
import { scopeLabel } from '../utils/format.js';
import { usePermission } from '../auth/usePermission.js';
import { GpsStatusBadge } from '../components/GpsStatusBadge.jsx';
import { ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { LiveIndicator } from '../components/LiveIndicator.jsx';

function Brand() {
  return (
    <div className="flex items-center gap-2 px-5 py-4">
      <span className="flex h-8 w-8 items-center justify-center rounded-md bg-white/15 text-sm font-bold text-white">GP</span>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-white">GPS PID Portal</p>
        <p className="text-xs text-emerald-100/70">GPS Visit Monitoring</p>
      </div>
    </div>
  );
}

export function AppLayout() {
  const { user, logout, logoutAll } = useAuth();
  const can = usePermission();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const location = useLocation();

  useEffect(() => setDrawerOpen(false), [location.pathname]);

  const handleLogout = async () => {
    setLoggingOut(true);
    await logout();
  };

  const [confirmAll, setConfirmAll] = useState(false);
  const [loggingOutAll, setLoggingOutAll] = useState(false);
  const [allError, setAllError] = useState(null);
  const handleLogoutAll = async () => {
    setLoggingOutAll(true);
    try {
      await logoutAll();
    } catch {
      setAllError('Could not reach the server; your other sessions are still active. Please try again.');
      setLoggingOutAll(false);
    }
  };

  return (
    <div className="flex h-full">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col bg-emerald-900 md:flex">
        <Brand />
        <div className="flex-1 overflow-y-auto">
          <Sidebar user={user} />
        </div>
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
          <aside className="relative flex h-full w-64 flex-col bg-emerald-900 shadow-xl">
            <Brand />
            <div className="flex-1 overflow-y-auto">
              <Sidebar user={user} onNavigate={() => setDrawerOpen(false)} />
            </div>
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          <button
            type="button"
            className="rounded-md p-2 text-slate-600 hover:bg-slate-100 md:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
          >
            ☰
          </button>
          <div className="min-w-0 flex-1" />
          <div className="flex items-center gap-3">
            <LiveIndicator />
            {can('gps:read') && <GpsStatusBadge />}
            <div className="min-w-0 text-right leading-tight">
              <p className="truncate text-sm font-semibold text-slate-900">{user?.name}</p>
              <p className="truncate text-xs text-slate-500">
                {user?.role_name} · {scopeLabel(user)}
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={handleLogout} loading={loggingOut}>
              Logout
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmAll(true)} title="Sign out on every device (e.g. a lost phone)">
              <span className="hidden lg:inline">Log out all sessions</span>
              <span className="lg:hidden" aria-label="Log out all sessions">⏻</span>
            </Button>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <Outlet />
        </main>
        <ConfirmDialog
          open={confirmAll}
          title="Log out all sessions?"
          message={allError || 'You will be signed out on every device and browser where you are logged in, including this one.'}
          confirmLabel="Log out everywhere"
          busy={loggingOutAll}
          onConfirm={handleLogoutAll}
          onCancel={() => { setConfirmAll(false); setAllError(null); }}
        />
      </div>
    </div>
  );
}
