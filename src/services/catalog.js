'use strict';
const { db } = require('../db');
const audit = require('./audit');
const { ValidationError, conflict, notFound } = require('../utils/errors');
const v = require('../utils/validate');
const { parsePesos } = require('../utils/money');
const { nowIso } = require('../utils/time');

const SLOT_TYPES = ['standard', 'compact', 'accessible', 'motorcycle'];
const SLOT_STATUSES = ['active', 'maintenance', 'inactive'];
const TYPE_LABEL = { standard: 'Standard', compact: 'Compact', accessible: 'Accessible', motorcycle: 'Motorcycle' };
/** Which slot types each vehicle type may use. */
const COMPATIBLE = { car: ['standard', 'compact', 'accessible'], motorcycle: ['motorcycle'] };

/* -------------------------------- rates -------------------------------- */
const listRates = () => db.prepare('SELECT * FROM parking_rates ORDER BY id').all();
function updateRates(input, actor) {
  const errors = {}; const next = {};
  for (const t of SLOT_TYPES) {
    const c = parsePesos(input[t]);
    if (c === null || c > 100000) errors[t] = 'Enter an amount in pesos, such as 20.00 (max 1,000.00).'; else next[t] = c;
  }
  v.assertNoErrors(errors);
  const up = db.prepare('INSERT INTO parking_rates (slot_type, hourly_rate_centavos, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(slot_type) DO UPDATE SET hourly_rate_centavos=excluded.hourly_rate_centavos, updated_at=excluded.updated_at, updated_by=excluded.updated_by');
  db.transaction(() => { for (const t of SLOT_TYPES) up.run(t, next[t], nowIso(), actor.id); audit.log(actor, 'rates.update', 'parking_rates', null, next); })();
}

/* -------------------------------- zones -------------------------------- */
function listZones({ includeInactive = true } = {}) {
  return db.prepare(`SELECT z.*,
      (SELECT COUNT(*) FROM parking_slots s WHERE s.zone_id = z.id) AS slot_count,
      (SELECT COUNT(*) FROM parking_slots s WHERE s.zone_id = z.id AND s.status = 'active') AS active_slot_count
    FROM parking_zones z ${includeInactive ? '' : 'WHERE z.is_active = 1'} ORDER BY z.name COLLATE NOCASE`).all();
}
const getZone = (id) => db.prepare('SELECT * FROM parking_zones WHERE id = ?').get(id);

function zoneInput(input) {
  const errors = {};
  const name = v.clean(input.name), description = v.clean(input.description);
  const cols = v.toInt(input.mapColumns, 6);
  if (name.length < 2 || name.length > 60) errors.name = 'Enter a zone name (2–60 characters).';
  if (description.length > 200) errors.description = 'Use 200 characters or fewer.';
  if (cols < 2 || cols > 12) errors.mapColumns = 'Choose 2 to 12 columns.';
  v.assertNoErrors(errors);
  return { name, description: description || null, cols };
}
function createZone(input, actor) {
  const d = zoneInput(input);
  if (db.prepare('SELECT 1 FROM parking_zones WHERE name = ?').get(d.name)) throw new ValidationError({ name: 'A zone with this name already exists.' });
  const info = db.prepare('INSERT INTO parking_zones (name, description, map_columns, created_at) VALUES (?,?,?,?)').run(d.name, d.description, d.cols, nowIso());
  audit.log(actor, 'zone.create', 'zone', info.lastInsertRowid, { name: d.name });
  return info.lastInsertRowid;
}

/** Throws if taking these slots out of service would strand a vehicle or silently break bookings. */
function assertCanRemoveFromService(whereSql, param, label) {
  const live = db.prepare(`SELECT s.code FROM parking_sessions ps JOIN parking_slots s ON s.id = ps.slot_id WHERE ps.status = 'active' AND ${whereSql}`).all(param);
  if (live.length) throw conflict(`${label} has a vehicle checked in (${live.map((r) => r.code).join(', ')}). Check the vehicle out first.`, 'ACTIVE_SESSION');
  const open = db.prepare(`SELECT COUNT(*) c FROM reservations r JOIN parking_slots s ON s.id = r.slot_id WHERE r.status = 'confirmed' AND r.end_at > ? AND ${whereSql.replace('ps.', 'r.')}`).get(nowIso(), param).c;
  if (open) throw conflict(`${label} has ${open} upcoming reservation${open > 1 ? 's' : ''}. Cancel or move them first so drivers are not left without a slot.`, 'HAS_RESERVATIONS');
}

function updateZone(id, input, actor) {
  const zone = getZone(id);
  if (!zone) throw notFound('Zone');
  const d = zoneInput(input);
  const active = input.isActive === '1' || input.isActive === 'on' || input.isActive === true ? 1 : 0;
  if (db.prepare('SELECT 1 FROM parking_zones WHERE name = ? AND id <> ?').get(d.name, id)) throw new ValidationError({ name: 'A zone with this name already exists.' });
  if (zone.is_active && !active) assertCanRemoveFromService('s.zone_id = ?', id, `Zone "${zone.name}"`);
  db.prepare('UPDATE parking_zones SET name = ?, description = ?, map_columns = ?, is_active = ? WHERE id = ?').run(d.name, d.description, d.cols, active, id);
  audit.log(actor, 'zone.update', 'zone', id, { active });
}
function deleteZone(id, actor) {
  const zone = getZone(id);
  if (!zone) throw notFound('Zone');
  if (db.prepare('SELECT 1 FROM parking_slots WHERE zone_id = ?').get(id)) throw conflict('This zone still has slots. Remove them, or deactivate the zone to keep its history.');
  db.prepare('DELETE FROM parking_zones WHERE id = ?').run(id);
  audit.log(actor, 'zone.delete', 'zone', id, { name: zone.name });
}

/* -------------------------------- slots -------------------------------- */
const SLOT_SELECT = `SELECT s.*, z.name AS zone_name, z.is_active AS zone_active, r.hourly_rate_centavos
  FROM parking_slots s JOIN parking_zones z ON z.id = s.zone_id LEFT JOIN parking_rates r ON r.slot_type = s.slot_type`;
const getSlot = (id) => db.prepare(`${SLOT_SELECT} WHERE s.id = ?`).get(id);

function listSlots({ q = '', zoneId = '', status = '', type = '', page = 1, size = 20 } = {}) {
  const where = []; const p = [];
  if (q) { where.push('(s.code LIKE ? OR z.name LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
  if (zoneId) { where.push('s.zone_id = ?'); p.push(zoneId); }
  if (v.oneOf(status, SLOT_STATUSES)) { where.push('s.status = ?'); p.push(status); }
  if (v.oneOf(type, SLOT_TYPES)) { where.push('s.slot_type = ?'); p.push(type); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM parking_slots s JOIN parking_zones z ON z.id = s.zone_id ${w}`).get(...p).c;
  const rows = db.prepare(`${SLOT_SELECT} ${w} ORDER BY z.name COLLATE NOCASE, length(s.code), s.code LIMIT ? OFFSET ?`).all(...p, size, (page - 1) * size);
  return { rows, total };
}

function slotInput(input, { partial = false } = {}) {
  const errors = {};
  const code = v.clean(input.code).toUpperCase();
  const type = v.clean(input.slotType), status = v.clean(input.status) || 'active';
  if (!partial && !/^[A-Z0-9-]{1,12}$/.test(code)) errors.code = 'Use 1–12 letters, numbers or dashes (for example A-01).';
  if (!v.oneOf(type, SLOT_TYPES)) errors.slotType = 'Choose a slot type.';
  if (!v.oneOf(status, SLOT_STATUSES)) errors.status = 'Choose a status.';
  v.assertNoErrors(errors);
  return { code, type, status, notes: v.clean(input.notes).slice(0, 200) || null };
}
function createSlot(input, actor) {
  const zoneId = v.toInt(input.zoneId);
  if (!getZone(zoneId)) throw new ValidationError({ zoneId: 'Choose a zone.' });
  const d = slotInput(input);
  if (db.prepare('SELECT 1 FROM parking_slots WHERE zone_id = ? AND code = ?').get(zoneId, d.code)) throw new ValidationError({ code: 'This code is already used in the zone.' });
  const info = db.prepare('INSERT INTO parking_slots (zone_id, code, slot_type, status, notes, created_at) VALUES (?,?,?,?,?,?)').run(zoneId, d.code, d.type, d.status, d.notes, nowIso());
  audit.log(actor, 'slot.create', 'slot', info.lastInsertRowid, { zoneId, code: d.code });
  return info.lastInsertRowid;
}
function bulkCreateSlots(input, actor) {
  const zoneId = v.toInt(input.zoneId);
  const errors = {};
  if (!getZone(zoneId)) errors.zoneId = 'Choose a zone.';
  const prefix = v.clean(input.prefix).toUpperCase();
  const start = v.toInt(input.startNumber, 1), count = v.toInt(input.count, 0);
  if (!/^[A-Z0-9]{0,8}-?$/.test(prefix)) errors.prefix = 'Use up to 8 letters or numbers.';
  if (count < 1 || count > 60) errors.count = 'Create between 1 and 60 slots at a time.';
  if (start < 0 || start > 9999) errors.startNumber = 'Use a number from 0 to 9999.';
  if (!v.oneOf(input.slotType, SLOT_TYPES)) errors.slotType = 'Choose a slot type.';
  v.assertNoErrors(errors);
  const ins = db.prepare('INSERT INTO parking_slots (zone_id, code, slot_type, status, created_at) VALUES (?,?,?,?,?)');
  const exists = db.prepare('SELECT 1 FROM parking_slots WHERE zone_id = ? AND code = ?');
  let created = 0;
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const code = `${prefix}${String(start + i).padStart(2, '0')}`;
      if (code.length > 12) throw new ValidationError({ prefix: 'Resulting codes are too long.' });
      if (exists.get(zoneId, code)) throw new ValidationError({ startNumber: `Slot ${code} already exists in this zone.` });
      ins.run(zoneId, code, input.slotType, 'active', nowIso()); created++;
    }
    audit.log(actor, 'slot.bulk_create', 'zone', zoneId, { prefix, start, count });
  })();
  return created;
}
function updateSlot(id, input, actor) {
  const slot = getSlot(id);
  if (!slot) throw notFound('Slot');
  const d = slotInput({ ...input, code: input.code || slot.code });
  if (db.prepare('SELECT 1 FROM parking_slots WHERE zone_id = ? AND code = ? AND id <> ?').get(slot.zone_id, d.code, id)) throw new ValidationError({ code: 'This code is already used in the zone.' });
  if (slot.status === 'active' && d.status !== 'active') assertCanRemoveFromService('s.id = ?', id, `Slot ${slot.code}`);
  if (d.type !== slot.slot_type) assertCanRemoveFromService('s.id = ?', id, `Slot ${slot.code} (type change)`);
  db.prepare('UPDATE parking_slots SET code = ?, slot_type = ?, status = ?, notes = ? WHERE id = ?').run(d.code, d.type, d.status, d.notes, id);
  audit.log(actor, 'slot.update', 'slot', id, { status: d.status, type: d.type });
}
function deleteSlot(id, actor) {
  const slot = getSlot(id);
  if (!slot) throw notFound('Slot');
  if (db.prepare('SELECT 1 FROM reservations WHERE slot_id = ?').get(id)) throw conflict('This slot has booking history. Set it to inactive instead of deleting it.');
  db.prepare('DELETE FROM parking_slots WHERE id = ?').run(id);
  audit.log(actor, 'slot.delete', 'slot', id, { code: slot.code });
}

module.exports = { SLOT_TYPES, SLOT_STATUSES, TYPE_LABEL, COMPATIBLE, listRates, updateRates, listZones, getZone, createZone, updateZone, deleteZone,
  getSlot, listSlots, createSlot, bulkCreateSlots, updateSlot, deleteSlot };
