import { useState } from 'react';

/**
 * Minimal form state: values, per-field client errors, and server errors (shown until the field changes).
 * validate(values) -> { field: message }. toPayload(values) -> request body.
 */
export function useFormState(initialValues, { validate, toPayload, onSubmit, serverErrors = {} }) {
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState({});
  const [touchedSinceServer, setTouchedSinceServer] = useState({});
  const [lastServerErrors, setLastServerErrors] = useState(serverErrors);

  // New server errors -> show them again for every field.
  if (serverErrors !== lastServerErrors) {
    setLastServerErrors(serverErrors);
    setTouchedSinceServer({});
  }

  const setField = (name, value) => {
    setValues((v) => ({ ...v, [name]: value }));
    setErrors((e) => (e[name] ? { ...e, [name]: undefined } : e));
    setTouchedSinceServer((t) => ({ ...t, [name]: true }));
  };

  const errorFor = (name) => errors[name] || (!touchedSinceServer[name] ? serverErrors[name] : undefined);

  const handleSubmit = (e) => {
    e.preventDefault();
    const found = validate ? validate(values) : {};
    const clean = Object.fromEntries(Object.entries(found).filter(([, m]) => m));
    setErrors(clean);
    if (Object.keys(clean).length) return;
    onSubmit(toPayload ? toPayload(values) : values);
  };

  return { values, setField, setValues, errorFor, handleSubmit };
}

/** '' -> null, otherwise Number. For optional id selects. */
export const idOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
/** '' / whitespace -> null, otherwise trimmed string. */
export const textOrNull = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
export const str = (v) => (v === null || v === undefined ? '' : String(v));
