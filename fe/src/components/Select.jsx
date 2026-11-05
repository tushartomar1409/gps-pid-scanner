import { useId } from 'react';
import { FieldWrapper, controlClass } from './Input.jsx';

/**
 * options: [{ value, label }]. `placeholder` renders an empty first option.
 * If `value` is not among options (e.g. a record linked to a now-inactive zone), a fallback option
 * labelled `fallbackLabel` is added so the current value is still visible.
 */
export function Select({ label, error, hint, required, options = [], placeholder, value, fallbackLabel, id: idProp, ...rest }) {
  const autoId = useId();
  const id = idProp || autoId;
  const v = value ?? '';
  const hasValue = v === '' || options.some((o) => String(o.value) === String(v));
  return (
    <FieldWrapper id={id} label={label} error={error} hint={hint} required={required}>
      <select
        id={id}
        value={v}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={controlClass(error)}
        {...rest}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {!hasValue && <option value={v}>{fallbackLabel || `#${v}`}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldWrapper>
  );
}
