import { useId } from 'react';

export function FieldWrapper({ id, label, error, hint, required, children }) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-slate-700">
          {label}
          {required && <span className="ml-0.5 text-red-600" aria-hidden="true">*</span>}
        </label>
      )}
      {children}
      {hint && !error && <p className="text-xs text-slate-500">{hint}</p>}
      {error && (
        <p id={`${id}-error`} className="text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export const controlClass = (error) =>
  `block w-full rounded-md border bg-white px-3 py-2 text-sm shadow-sm outline-none transition focus:ring-2 disabled:bg-slate-100 ${
    error ? 'border-red-400 focus:border-red-500 focus:ring-red-200' : 'border-slate-300 focus:border-emerald-600 focus:ring-emerald-100'
  }`;

export function Input({ label, error, hint, required, id: idProp, className = '', ...rest }) {
  const autoId = useId();
  const id = idProp || autoId;
  return (
    <FieldWrapper id={id} label={label} error={error} hint={hint} required={required}>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`${controlClass(error)} ${className}`}
        {...rest}
      />
    </FieldWrapper>
  );
}
