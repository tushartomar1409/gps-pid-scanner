import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <p className="text-sm font-semibold text-emerald-700">404</p>
      <h1 className="text-xl font-semibold text-slate-900">Page not found</h1>
      <Link to="/" className="text-sm font-medium text-emerald-700 hover:underline">
        Back to home
      </Link>
    </div>
  );
}
