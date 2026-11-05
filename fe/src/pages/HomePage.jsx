import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { visibleSections } from '../layouts/Sidebar.jsx';
import { scopeLabel } from '../utils/format.js';

// Welcome page for users without dashboard:read (IndexPage shows the dashboard to everyone else).
export default function HomePage() {
  const { user } = useAuth();
  const shortcuts = visibleSections(user).flatMap((s) => s.items).filter((i) => i.to !== '/');

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Welcome, {user.name}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {user.role_name} · scope: {scopeLabel(user)}
        </p>
      </div>
      {shortcuts.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Quick links</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {shortcuts.map((s) => (
              <Link key={s.to} to={s.to} className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 shadow-sm hover:border-emerald-300 hover:text-emerald-800">
                {s.label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
