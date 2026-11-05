import { Button } from './Button.jsx';

export function ErrorState({ title = 'Something went wrong', message, onRetry }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center" role="alert">
      <p className="text-sm font-semibold text-red-700">{title}</p>
      {message && <p className="max-w-md text-sm text-slate-600">{message}</p>}
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
