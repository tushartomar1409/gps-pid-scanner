// Normalises axios errors from the standard backend envelope { success:false, message, errors? }.
export function parseApiError(err) {
  if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return { canceled: true };
  const res = err?.response;
  if (!res) {
    return { status: 0, message: 'Unable to reach the server. Check your connection and try again.', fieldErrors: {}, constraint: null };
  }
  const body = res.data || {};
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const fieldErrors = {};
  for (const e of errors) {
    if (e.field && !fieldErrors[e.field]) fieldErrors[e.field] = e.message;
  }
  return {
    status: res.status,
    message: body.message || `Request failed (${res.status})`,
    fieldErrors,
    constraint: errors.find((e) => e.constraint)?.constraint ?? null,
  };
}
