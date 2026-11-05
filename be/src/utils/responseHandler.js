// Standard API envelope (flow.txt §16).
export function sendSuccess(res, { status = 200, message = 'OK', data = null, pagination } = {}) {
  const body = { success: true, message, data };
  if (pagination) body.pagination = pagination;
  return res.status(status).json(body);
}

export function sendError(res, { status = 500, message = 'Internal server error', errors } = {}) {
  const body = { success: false, message };
  if (errors) body.errors = errors;
  return res.status(status).json(body);
}
