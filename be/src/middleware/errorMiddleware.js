import { AppError } from '../utils/errors.js';
import { sendError } from '../utils/responseHandler.js';
import { logger } from '../utils/logger.js';

// PostgreSQL error code -> HTTP mapping (GUIDE #2 task 4).
function mapPgError(err) {
  switch (err.code) {
    case '23505': // unique_violation
      return { status: 409, message: 'A record with the same unique value already exists', errors: pgDetail(err) };
    case '23503': // foreign_key_violation
      // Insert/update referencing a missing row -> 422; delete/update of a still-referenced row -> 409.
      return /is not present in table/.test(err.detail || '')
        ? { status: 422, message: 'Referenced record does not exist or does not match', errors: pgDetail(err) }
        : { status: 409, message: 'Record is still referenced by other records', errors: pgDetail(err) };
    case '23514': // check_violation
      return { status: 422, message: 'Value violates a data rule', errors: pgDetail(err) };
    case '23502': // not_null_violation
      return { status: 422, message: `Missing required value: ${err.column}`, errors: pgDetail(err) };
    case '22P02': // invalid_text_representation
    case '22003': // numeric_value_out_of_range
      return { status: 400, message: 'Invalid value format' };
    default:
      return null;
  }
}

function pgDetail(err) {
  return [{ constraint: err.constraint, detail: err.detail }].filter((e) => e.constraint || e.detail);
}

export function notFoundHandler(req, res) {
  sendError(res, { status: 404, message: `Route not found: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return sendError(res, { status: err.status, message: err.message, errors: err.errors });
  }
  if (err?.type === 'entity.parse.failed') {
    return sendError(res, { status: 400, message: 'Malformed JSON body' });
  }
  if (err?.type === 'entity.too.large') {
    return sendError(res, { status: 413, message: 'Request body too large' });
  }
  if (err?.name === 'MulterError') {
    return err.code === 'LIMIT_FILE_SIZE'
      ? sendError(res, { status: 413, message: 'Uploaded file is too large' })
      : sendError(res, { status: 400, message: `Upload error: ${err.message}` });
  }
  const pg = err?.code ? mapPgError(err) : null;
  if (pg) return sendError(res, pg);

  (req.log || logger).error({ err }, 'Unhandled error');
  return sendError(res, { status: 500, message: 'Internal server error' });
}
