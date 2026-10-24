'use strict';

const config = require('../config');
const { AppError } = require('../utils/errors');
const { homeFor } = require('../utils/navigation');

function notFound(req, res) {
  res.status(404);
  if (req.accepts(['html', 'json']) === 'json') return res.json({ error: 'Not found' });
  return res.view('errors/error', {
    layout: req.user ? 'main' : 'auth',
    title: 'Page not found',
    status: 404,
    heading: 'Page not found',
    message: 'The page you are looking for does not exist or has moved.',
    homeHref: req.user ? homeFor(req.user.role) : '/login',
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let status = err.status || err.statusCode || 500;
  let message = err.message;
  if (err instanceof AppError) status = err.status || 400;
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') status = 400;

  // Unexpected failures: log server-side, show a safe message to the user.
  if (status >= 500) {
    if (!config.isTest || process.env.LOG_TEST_ERRORS) console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    message = 'Something went wrong on our side. Please try again, and contact parking administration if it keeps happening.';
  }

  if (req.accepts(['html', 'json']) === 'json') {
    return res.status(status).json({ error: message, code: err.code || undefined, fields: err.fields || undefined });
  }
  const headings = { 400: 'Request not accepted', 403: 'Access denied', 404: 'Not found', 409: 'Conflict', 429: 'Too many requests' };
  return res.status(status).view('errors/error', {
    layout: req.user ? 'main' : 'auth',
    title: headings[status] || 'Something went wrong',
    status,
    heading: headings[status] || 'Something went wrong',
    message,
    homeHref: req.user ? homeFor(req.user.role) : '/login',
  });
}

module.exports = { notFound, errorHandler };
