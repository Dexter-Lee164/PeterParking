'use strict';

/**
 * Business-rule / validation failure that is safe to show to the user.
 * `fields` maps form field names to messages for inline feedback.
 */
class AppError extends Error {
  constructor(message, { code = 'APP_ERROR', status = 400, fields = null, details = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.fields = fields;
    this.details = details;
  }
}

module.exports = { AppError };
