'use strict';

const ctx = require('../db/context');
const { nowLocal } = require('../utils/time');

/**
 * Record a consequential action. `actor` may be a user object, an id, or null
 * (system actions such as the automatic no-show sweep).
 */
function log(actor, action, entityType, entityId, details = null, ip = null) {
  const userId = actor && typeof actor === 'object' ? actor.id : actor || null;
  if (!ip && actor && typeof actor === 'object' && actor.ip) ip = actor.ip;
  const payload = details === null || details === undefined ? null : typeof details === 'string' ? details : JSON.stringify(details);
  ctx
    .get()
    .prepare(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, action, entityType || null, entityId || null, payload, ip, nowLocal());
}

function list({ action = '', userQuery = '', from = '', to = '', limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (action) {
    where.push('a.action LIKE ?');
    params.push(`%${action}%`);
  }
  if (userQuery) {
    where.push('(u.full_name LIKE ? OR u.email LIKE ?)');
    params.push(`%${userQuery}%`, `%${userQuery}%`);
  }
  if (from) {
    where.push('a.created_at >= ?');
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    where.push('a.created_at <= ?');
    params.push(`${to} 23:59:59`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = ctx.get();
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${whereSql}`)
    .get(...params).n;
  const rows = db
    .prepare(
      `SELECT a.*, u.full_name AS user_name, u.email AS user_email, su.full_name AS subject_driver
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN reservations sr ON a.entity_type = 'reservation' AND sr.id = a.entity_id
       LEFT JOIN payments sp ON a.entity_type = 'payment' AND sp.id = a.entity_id
       LEFT JOIN users su ON su.id = COALESCE(sr.user_id, sp.user_id)
       ${whereSql} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  return { rows, total };
}

module.exports = { log, list };
