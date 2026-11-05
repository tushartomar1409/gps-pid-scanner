export class AppError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

export const badRequest = (msg = 'Bad request', errors) => new AppError(400, msg, errors);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, msg);
export const forbidden = (msg = 'You do not have permission to perform this action') => new AppError(403, msg);
export const notFound = (msg = 'Resource not found') => new AppError(404, msg);
export const conflict = (msg = 'Conflict', errors) => new AppError(409, msg, errors);
export const unprocessable = (msg = 'Unprocessable entity', errors) => new AppError(422, msg, errors);
