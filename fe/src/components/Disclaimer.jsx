import { GPS_DISCLAIMER } from '../utils/disclaimer.js';

/** Footnote (default) or compact info icon with the GPS disclaimer as tooltip + accessible label. */
export function Disclaimer({ variant = 'footnote', className = '' }) {
  if (variant === 'icon') {
    return (
      <span
        className={`inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-slate-400 text-[10px] font-bold text-slate-500 ${className}`}
        title={GPS_DISCLAIMER}
        aria-label={GPS_DISCLAIMER}
        role="img"
      >
        i
      </span>
    );
  }
  return (
    <p className={`flex items-start gap-1.5 text-xs text-slate-500 ${className}`} data-testid="gps-disclaimer">
      <span aria-hidden="true">ⓘ</span>
      <span>{GPS_DISCLAIMER}</span>
    </p>
  );
}
