'use strict';
class AppError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}
class ValidationError extends AppError {
  constructor(fields, message = 'Please fix the highlighted fields.') {
    super(message, 422, 'VALIDATION');
    this.fields = fields;
  }
}
const notFound = (what = 'Page') => new AppError(`${what} not found.`, 404, 'NOT_FOUND');
const forbidden = (msg = 'You do not have access to this resource.') => new AppError(msg, 403, 'FORBIDDEN');
const conflict = (msg, code = 'CONFLICT') => new AppError(msg, 409, code);
module.exports = { AppError, ValidationError, notFound, forbidden, conflict };
