'use strict';
const { db } = require('../db');

const insert = db.prepare('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address, created_at) VALUES (?,?,?,?,?,?,?)');

/** Record a consequential action. `actor` is { id, ip } (or null for system actions). */
function log(actor, action, entityType = null, entityId = null, details = null) {
  const { nowIso } = require('../utils/time');
  insert.run(actor?.id ?? null, action, entityType, entityId == null ? null : String(entityId),
    details ? JSON.stringify(details) : null, actor?.ip ?? null, nowIso());
}

function list({ q = '', action = '', page = 1, size = 20 } = {}) {
  const where = []; const p = [];
  if (action) { where.push('a.action = ?'); p.push(action); }
  if (q) { where.push('(a.action LIKE ? OR a.entity_id LIKE ? OR a.details LIKE ? OR u.name LIKE ?)'); p.push(...Array(4).fill(`%${q}%`)); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${w}`).get(...p).c;
  const rows = db.prepare(`SELECT a.*, u.name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${w}
    ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...p, size, (page - 1) * size);
  return { rows, total };
}
const actions = () => db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all().map((r) => r.action);

module.exports = { log, list, actions };
