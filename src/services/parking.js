'use strict';

const ctx = require('../db/context');
const audit = require('./audit');
const { AppError } = require('../utils/errors');
const { clean, collapse, toInt, oneOf } = require('../utils/validate');
const { parsePesoToCentavos } = require('../utils/money');
const { nowLocal } = require('../utils/time');

const SLOT_STATUSES = ['active', 'maintenance', 'inactive'];
// What an administrator can set: Active or Out of Service ('maintenance'). 'inactive' is kept only for slots retired
// from the lot plan (src/db/lotPlans.js).
const ADMIN_SLOT_STATUSES = ['active', 'maintenance'];
const VEHICLE_TYPES = ['car', 'motorcycle'];
const SLOT_TYPE_VEHICLES = ['car', 'motorcycle', 'any'];
const ICONS = ['bi-car-front', 'bi-person-wheelchair', 'bi-bicycle', 'bi-truck', 'bi-bus-front', 'bi-p-square'];

/** SQL fragment resolving a slot's effective hourly rate: override, else best matching rate row. */
const EFFECTIVE_RATE_SQL = `COALESCE(
  s.hourly_rate_override_centavos,
  (SELECT r.hourly_rate_centavos FROM parking_rates r
    WHERE r.is_active = 1
      AND (r.zone_id IS NULL OR r.zone_id = s.zone_id)
      AND (r.slot_type IS NULL OR r.slot_type = s.slot_type)
    ORDER BY (r.zone_id IS NOT NULL) * 2 + (r.slot_type IS NOT NULL) DESC, r.id DESC
    LIMIT 1),
  0)`;

const SLOT_SELECT = `
  SELECT s.*, z.name AS zone_name, z.code AS zone_code, z.is_active AS zone_active,
         t.label AS type_label, t.vehicle_type AS type_vehicle, t.icon AS type_icon,
         ${EFFECTIVE_RATE_SQL} AS hourly_rate_centavos
  FROM parking_slots s
  JOIN parking_zones z ON z.id = s.zone_id
  JOIN slot_types t ON t.code = s.slot_type`;

/** Whether a slot type accepts a given vehicle type. */
function vehicleFitsSlotType(slotVehicle, vehicleType) {
  if (!vehicleType) return true;
  if (slotVehicle === 'any') return true;
  if (slotVehicle === 'motorcycle') return vehicleType === 'motorcycle';
  return vehicleType === 'car';
}

// ---------------------------------------------------------------- zones

function listZones({ includeInactive = true } = {}) {
  return ctx
    .get()
    .prepare(
      `SELECT z.*,
         (SELECT COUNT(*) FROM parking_slots s WHERE s.zone_id = z.id AND s.retired_at IS NULL) AS slot_count,
         (SELECT COUNT(*) FROM parking_slots s WHERE s.zone_id = z.id AND s.status = 'active') AS active_slot_count
       FROM parking_zones z
       ${includeInactive ? '' : 'WHERE z.is_active = 1'}
       ORDER BY z.sort_order, z.name`,
    )
    .all();
}

const getZone = (id) => ctx.get().prepare('SELECT * FROM parking_zones WHERE id = ?').get(id);

function validateZone(input, { id = null } = {}) {
  const db = ctx.get();
  const fields = {};
  const code = clean(input.code).toUpperCase();
  const name = collapse(input.name);
  const description = clean(input.description);
  const mapColumns = toInt(input.map_columns, 6);
  const sortOrder = toInt(input.sort_order, 0);
  const isActive = input.is_active === '0' || input.is_active === 0 ? 0 : 1;

  if (!/^[A-Z0-9-]{1,8}$/.test(code)) fields.code = 'Use 1–8 letters, numbers or dashes.';
  if (!name || name.length > 60) fields.name = 'Enter a zone name (up to 60 characters).';
  if (description.length > 300) fields.description = 'Keep the description under 300 characters.';
  if (mapColumns < 2 || mapColumns > 12) fields.map_columns = 'Choose between 2 and 12 columns.';
  if (!fields.code && db.prepare('SELECT id FROM parking_zones WHERE code = ? COLLATE NOCASE AND id <> ?').get(code, id || 0)) {
    fields.code = 'That zone code is already in use.';
  }
  if (!fields.name && db.prepare('SELECT id FROM parking_zones WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, id || 0)) {
    fields.name = 'A zone with that name already exists.';
  }
  if (Object.keys(fields).length) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });
  return { code, name, description: description || null, map_columns: mapColumns, sort_order: sortOrder, is_active: isActive };
}

function createZone(input, actor) {
  const v = validateZone(input);
  const info = ctx
    .get()
    .prepare('INSERT INTO parking_zones (code, name, description, map_columns, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?)')
    .run(v.code, v.name, v.description, v.map_columns, v.sort_order, v.is_active);
  audit.log(actor, 'zone.create', 'parking_zone', info.lastInsertRowid, v);
  return getZone(info.lastInsertRowid);
}

function updateZone(id, input, actor) {
  const existing = getZone(id);
  if (!existing) throw new AppError('Zone not found.', { status: 404, code: 'NOT_FOUND' });
  const v = validateZone(input, { id });
  if (existing.is_active && !v.is_active) {
    const b = zoneBlockers(id);
    if (b.openSessions || b.upcoming) {
      throw new AppError(
        `Cannot deactivate ${existing.name}: ${b.openSessions} vehicle(s) currently parked and ${b.upcoming} upcoming reservation(s) in this zone. Resolve them first.`,
        { code: 'ZONE_BUSY', status: 409 },
      );
    }
  }
  ctx
    .get()
    .prepare(
      `UPDATE parking_zones SET code = ?, name = ?, description = ?, map_columns = ?, sort_order = ?, is_active = ?,
         updated_at = datetime('now', 'localtime') WHERE id = ?`,
    )
    .run(v.code, v.name, v.description, v.map_columns, v.sort_order, v.is_active, id);
  audit.log(actor, 'zone.update', 'parking_zone', id, v);
  return getZone(id);
}

function deleteZone(id, actor) {
  const zone = getZone(id);
  if (!zone) throw new AppError('Zone not found.', { status: 404, code: 'NOT_FOUND' });
  const slots = ctx.get().prepare('SELECT COUNT(*) AS n FROM parking_slots WHERE zone_id = ?').get(id).n;
  if (slots) {
    throw new AppError(`${zone.name} still has ${slots} slot(s). Delete or move them first, or deactivate the zone instead.`, {
      code: 'ZONE_HAS_SLOTS',
      status: 409,
    });
  }
  const rates = ctx.get().prepare('SELECT COUNT(*) AS n FROM parking_rates WHERE zone_id = ?').get(id).n;
  if (rates) throw new AppError('This zone is used by a parking rate. Remove that rate first.', { code: 'ZONE_HAS_RATES', status: 409 });
  ctx.get().prepare('DELETE FROM parking_zones WHERE id = ?').run(id);
  audit.log(actor, 'zone.delete', 'parking_zone', id, { name: zone.name });
}

function zoneBlockers(zoneId) {
  const db = ctx.get();
  const now = nowLocal();
  const openSessions = db
    .prepare('SELECT COUNT(*) AS n FROM parking_sessions ps JOIN parking_slots s ON s.id = ps.slot_id WHERE s.zone_id = ? AND ps.check_out_at IS NULL')
    .get(zoneId).n;
  const upcoming = db
    .prepare(
      `SELECT COUNT(*) AS n FROM reservations r JOIN parking_slots s ON s.id = r.slot_id
       WHERE s.zone_id = ? AND r.status = 'confirmed' AND r.end_at > ?`,
    )
    .get(zoneId, now).n;
  return { openSessions, upcoming };
}

// ---------------------------------------------------------------- slots

/** Slots in service or on hold; retired ones (removed from their zone, kept only for booking history) are left out. */
function listSlots({ zoneId = null, status = '', slotType = '', q = '' } = {}) {
  const where = ['s.retired_at IS NULL'];
  const params = [];
  if (zoneId) {
    where.push('s.zone_id = ?');
    params.push(zoneId);
  }
  if (status) {
    where.push('s.status = ?');
    params.push(status);
  }
  if (slotType) {
    where.push('s.slot_type = ?');
    params.push(slotType);
  }
  if (q) {
    where.push('(s.slot_code LIKE ? OR s.notes LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const rows = ctx
    .get()
    .prepare(`${SLOT_SELECT} WHERE ${where.join(' AND ')} ORDER BY z.sort_order, z.name, s.sort_order, s.slot_code`)
    .all(...params);
  return decorateSlotsWithLiveState(rows);
}

/** Adds `live_state` (occupied / reserved / free) as of right now. */
function decorateSlotsWithLiveState(rows) {
  if (!rows.length) return rows;
  const db = ctx.get();
  const now = nowLocal();
  const open = new Set(db.prepare('SELECT slot_id FROM parking_sessions WHERE check_out_at IS NULL').all().map((r) => r.slot_id));
  const reserved = new Set(
    db
      .prepare(`SELECT slot_id FROM reservations WHERE status = 'confirmed' AND start_at <= ? AND end_at > ?`)
      .all(now, now)
      .map((r) => r.slot_id),
  );
  return rows.map((r) => ({
    ...r,
    live_state: r.status !== 'active' ? 'unavailable' : open.has(r.id) ? 'occupied' : reserved.has(r.id) ? 'reserved' : 'available',
  }));
}

const getSlot = (id) => ctx.get().prepare(`${SLOT_SELECT} WHERE s.id = ?`).get(id);

/** { slot_id: vehicle } for every vehicle checked in right now (optionally in one zone), to draw on the admin map. */
function parkedVehicles(zoneId = null) {
  const rows = ctx
    .get()
    .prepare(
      `SELECT ps.slot_id, v.id, v.vehicle_type, v.make, v.model, v.color, v.plate_number
       FROM parking_sessions ps JOIN vehicles v ON v.id = ps.vehicle_id JOIN parking_slots s ON s.id = ps.slot_id
       WHERE ps.check_out_at IS NULL ${zoneId ? 'AND s.zone_id = ?' : ''}`,
    )
    .all(...(zoneId ? [zoneId] : []));
  const out = {};
  for (const { slot_id: slotId, ...v } of rows) out[slotId] = v;
  return out;
}

function assertNotRetired(slot) {
  if (slot.retired_at) {
    throw new AppError(`Slot ${slot.slot_code} was retired from ${slot.zone_name}; it is kept only for its booking history.`, { code: 'SLOT_RETIRED', status: 409 });
  }
}

function validateSlot(input, { id = null } = {}) {
  const db = ctx.get();
  const fields = {};
  const zoneId = toInt(input.zone_id);
  const slotCode = clean(input.slot_code).toUpperCase();
  const slotType = clean(input.slot_type);
  const status = oneOf(clean(input.status) || 'active', SLOT_STATUSES);
  const notes = clean(input.notes);
  const sortOrder = toInt(input.sort_order, 0);
  let override = null;

  if (!zoneId || !getZone(zoneId)) fields.zone_id = 'Choose a parking zone.';
  if (!/^[A-Z0-9][A-Z0-9 _-]{0,15}$/.test(slotCode)) fields.slot_code = 'Use up to 16 letters, numbers, spaces, dashes or underscores.';
  if (!db.prepare('SELECT 1 FROM slot_types WHERE code = ?').get(slotType)) fields.slot_type = 'Choose a slot type.';
  if (!status) fields.status = 'Choose a valid status.';
  if (notes.length > 300) fields.notes = 'Keep notes under 300 characters.';
  if (clean(input.hourly_rate_override) !== '') {
    override = parsePesoToCentavos(input.hourly_rate_override);
    if (override === null) fields.hourly_rate_override = 'Enter a valid peso amount (e.g. 35 or 35.50).';
  }
  if (!fields.zone_id && !fields.slot_code) {
    const dupe = db.prepare('SELECT id FROM parking_slots WHERE zone_id = ? AND slot_code = ? AND id <> ?').get(zoneId, slotCode, id || 0);
    if (dupe) fields.slot_code = 'That slot code already exists in this zone.';
  }
  if (Object.keys(fields).length) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });
  return { zone_id: zoneId, slot_code: slotCode, slot_type: slotType, status, hourly_rate_override_centavos: override, notes: notes || null, sort_order: sortOrder };
}

/** What stops a slot from being taken out of service (status 'maintenance'), deactivated or moved? */
function slotBlockers(slotId) {
  const db = ctx.get();
  const now = nowLocal();
  const openSession = db.prepare('SELECT id FROM parking_sessions WHERE slot_id = ? AND check_out_at IS NULL').get(slotId);
  const upcoming = db
    .prepare(
      `SELECT booking_ref, start_at FROM reservations
       WHERE slot_id = ? AND status = 'confirmed' AND end_at > ? ORDER BY start_at`,
    )
    .all(slotId, now);
  return { openSession: !!openSession, upcoming };
}

function assertSlotCanLeaveService(slot, newStatus) {
  if (slot.status === 'active' && newStatus !== 'active') {
    const b = slotBlockers(slot.id);
    if (b.openSession) {
      throw new AppError(`Slot ${slot.slot_code} has a vehicle parked. Check the vehicle out before changing its status.`, {
        code: 'SLOT_OCCUPIED',
        status: 409,
      });
    }
    if (b.upcoming.length) {
      const refs = b.upcoming.slice(0, 5).map((r) => r.booking_ref).join(', ');
      throw new AppError(
        `Slot ${slot.slot_code} has ${b.upcoming.length} upcoming reservation(s) (${refs}${b.upcoming.length > 5 ? ', …' : ''}). ` +
          'Cancel them with a reason first — bookings are never overridden silently.',
        { code: 'SLOT_HAS_RESERVATIONS', status: 409, details: b.upcoming },
      );
    }
  }
}

function createSlot(input, actor) {
  const v = validateSlot(input);
  const info = ctx
    .get()
    .prepare(
      `INSERT INTO parking_slots (zone_id, slot_code, slot_type, status, hourly_rate_override_centavos, notes, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(v.zone_id, v.slot_code, v.slot_type, v.status, v.hourly_rate_override_centavos, v.notes, v.sort_order);
  audit.log(actor, 'slot.create', 'parking_slot', info.lastInsertRowid, v);
  return getSlot(info.lastInsertRowid);
}

/** Create a numbered run of slots, e.g. prefix "A-" from 1 to 12 → A-01 … A-12. */
function createSlotsBulk(input, actor) {
  const db = ctx.get();
  const prefix = clean(input.prefix).toUpperCase();
  const from = toInt(input.from);
  const to = toInt(input.to);
  const fields = {};
  if (!/^[A-Z0-9 _-]{0,10}$/.test(prefix)) fields.prefix = 'Use up to 10 letters, numbers or dashes.';
  if (from === null || from < 1 || from > 999) fields.from = 'Enter a start number between 1 and 999.';
  if (to === null || to < (from || 1) || to > 999 || (from && to - from >= 100)) fields.to = 'End number must be ≥ start (max 100 slots at a time).';
  if (Object.keys(fields).length) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });
  const created = [];
  db.transaction(() => {
    for (let n = from; n <= to; n += 1) {
      const code = `${prefix}${String(n).padStart(2, '0')}`;
      const slot = createSlot({ zone_id: input.zone_id, slot_code: code, slot_type: input.slot_type, status: 'active', sort_order: n }, actor);
      created.push(slot);
    }
  })();
  return created;
}

function updateSlot(id, input, actor) {
  const existing = getSlot(id);
  if (!existing) throw new AppError('Slot not found.', { status: 404, code: 'NOT_FOUND' });
  assertNotRetired(existing);
  const v = validateSlot(input, { id });
  assertSlotCanLeaveService(existing, v.status);
  if (existing.zone_id !== v.zone_id || existing.slot_code !== v.slot_code) {
    const used = ctx.get().prepare(`SELECT COUNT(*) AS n FROM reservations WHERE slot_id = ? AND status IN ('confirmed','checked_in')`).get(id).n;
    if (used && existing.zone_id !== v.zone_id) {
      throw new AppError('This slot has active reservations, so it cannot be moved to another zone.', { code: 'SLOT_HAS_RESERVATIONS', status: 409 });
    }
  }
  ctx
    .get()
    .prepare(
      `UPDATE parking_slots SET zone_id = ?, slot_code = ?, slot_type = ?, status = ?, hourly_rate_override_centavos = ?,
         notes = ?, sort_order = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
    )
    .run(v.zone_id, v.slot_code, v.slot_type, v.status, v.hourly_rate_override_centavos, v.notes, v.sort_order, id);
  audit.log(actor, 'slot.update', 'parking_slot', id, { before: { status: existing.status, rate: existing.hourly_rate_override_centavos }, after: v });
  return getSlot(id);
}

/**
 * What an administrator may change on a slot: its operational status, notes and hourly rate override. The zones, slot
 * codes, types and positions are the fixed campus layout (src/db/lotPlans.js) and are not edited from the admin pages.
 */
function updateSlotOperations(id, input, actor) {
  const existing = getSlot(id);
  if (!existing) throw new AppError('Slot not found.', { status: 404, code: 'NOT_FOUND' });
  assertNotRetired(existing);
  const fields = {};
  const status = oneOf(clean(input.status), ADMIN_SLOT_STATUSES);
  const notes = clean(input.notes);
  let override = null;
  if (!status) fields.status = 'Choose Active or Out of Service.';
  if (notes.length > 300) fields.notes = 'Keep notes under 300 characters.';
  if (clean(input.hourly_rate_override) !== '') {
    override = parsePesoToCentavos(input.hourly_rate_override);
    if (override === null) fields.hourly_rate_override = 'Enter a valid peso amount (e.g. 35 or 35.50).';
  }
  if (Object.keys(fields).length) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });
  assertSlotCanLeaveService(existing, status);
  ctx
    .get()
    .prepare(`UPDATE parking_slots SET status = ?, hourly_rate_override_centavos = ?, notes = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`)
    .run(status, override, notes || null, id);
  audit.log(actor, 'slot.update', 'parking_slot', id, {
    slot: existing.slot_code,
    before: { status: existing.status, rate: existing.hourly_rate_override_centavos, notes: existing.notes },
    after: { status, rate: override, notes: notes || null },
  });
  return getSlot(id);
}

function setSlotStatus(id, status, actor) {
  const existing = getSlot(id);
  if (!existing) throw new AppError('Slot not found.', { status: 404, code: 'NOT_FOUND' });
  assertNotRetired(existing);
  if (!ADMIN_SLOT_STATUSES.includes(status)) throw new AppError('Choose Active or Out of Service.');
  assertSlotCanLeaveService(existing, status);
  ctx.get().prepare(`UPDATE parking_slots SET status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`).run(status, id);
  audit.log(actor, 'slot.status', 'parking_slot', id, { from: existing.status, to: status });
  return getSlot(id);
}

function deleteSlot(id, actor) {
  const existing = getSlot(id);
  if (!existing) throw new AppError('Slot not found.', { status: 404, code: 'NOT_FOUND' });
  const used = ctx.get().prepare('SELECT COUNT(*) AS n FROM reservations WHERE slot_id = ?').get(id).n;
  if (used) {
    throw new AppError(
      `Slot ${existing.slot_code} has ${used} reservation record(s) and cannot be deleted. Set it to Inactive instead to keep the history.`,
      { code: 'SLOT_HAS_HISTORY', status: 409 },
    );
  }
  ctx.get().prepare('DELETE FROM parking_slots WHERE id = ?').run(id);
  audit.log(actor, 'slot.delete', 'parking_slot', id, { slot: `${existing.slot_code}` });
}

// ---------------------------------------------------------------- slot types

const listSlotTypes = ({ activeOnly = false } = {}) =>
  ctx
    .get()
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM parking_slots s WHERE s.slot_type = t.code) AS slot_count
       FROM slot_types t ${activeOnly ? 'WHERE t.is_active = 1' : ''} ORDER BY t.sort_order, t.label`,
    )
    .all();

function validateSlotType(input, { isNew }) {
  const fields = {};
  const code = clean(input.code).toLowerCase();
  const label = collapse(input.label);
  const vehicle = oneOf(clean(input.vehicle_type), SLOT_TYPE_VEHICLES);
  const icon = oneOf(clean(input.icon) || 'bi-car-front', ICONS);
  const sortOrder = toInt(input.sort_order, 0);
  const isActive = input.is_active === '0' ? 0 : 1;
  if (isNew && !/^[a-z0-9_]{2,20}$/.test(code)) fields.code = 'Use 2–20 lowercase letters, numbers or underscores.';
  if (isNew && !fields.code && ctx.get().prepare('SELECT 1 FROM slot_types WHERE code = ?').get(code)) fields.code = 'That code already exists.';
  if (!label || label.length > 40) fields.label = 'Enter a label (up to 40 characters).';
  if (!vehicle) fields.vehicle_type = 'Choose which vehicles fit.';
  if (Object.keys(fields).length) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });
  return { code, label, vehicle_type: vehicle, icon, sort_order: sortOrder, is_active: isActive };
}

function createSlotType(input, actor) {
  const v = validateSlotType(input, { isNew: true });
  ctx
    .get()
    .prepare('INSERT INTO slot_types (code, label, vehicle_type, icon, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?)')
    .run(v.code, v.label, v.vehicle_type, v.icon, v.sort_order, v.is_active);
  audit.log(actor, 'slot_type.create', 'slot_type', null, v);
}

function updateSlotType(code, input, actor) {
  if (!ctx.get().prepare('SELECT 1 FROM slot_types WHERE code = ?').get(code)) throw new AppError('Slot type not found.', { status: 404 });
  const v = validateSlotType({ ...input, code }, { isNew: false });
  ctx
    .get()
    .prepare('UPDATE slot_types SET label = ?, vehicle_type = ?, icon = ?, sort_order = ?, is_active = ? WHERE code = ?')
    .run(v.label, v.vehicle_type, v.icon, v.sort_order, v.is_active, code);
  audit.log(actor, 'slot_type.update', 'slot_type', null, { code, ...v });
}

function deleteSlotType(code, actor) {
  const db = ctx.get();
  const used = db.prepare('SELECT COUNT(*) AS n FROM parking_slots WHERE slot_type = ?').get(code).n;
  const rated = db.prepare('SELECT COUNT(*) AS n FROM parking_rates WHERE slot_type = ?').get(code).n;
  if (used || rated) {
    throw new AppError('This slot type is still used by slots or rates. Deactivate it instead of deleting.', { code: 'TYPE_IN_USE', status: 409 });
  }
  db.prepare('DELETE FROM slot_types WHERE code = ?').run(code);
  audit.log(actor, 'slot_type.delete', 'slot_type', null, { code });
}

// ---------------------------------------------------------------- rates

const listRates = () =>
  ctx
    .get()
    .prepare(
      `SELECT r.*, z.name AS zone_name, t.label AS type_label
       FROM parking_rates r
       LEFT JOIN parking_zones z ON z.id = r.zone_id
       LEFT JOIN slot_types t ON t.code = r.slot_type
       ORDER BY r.is_active DESC, (r.zone_id IS NULL) , (r.slot_type IS NULL), r.name`,
    )
    .all();

function validateRate(input) {
  const db = ctx.get();
  const fields = {};
  const name = collapse(input.name);
  const zoneId = clean(input.zone_id) === '' ? null : toInt(input.zone_id);
  const slotType = clean(input.slot_type) === '' ? null : clean(input.slot_type);
  const cents = parsePesoToCentavos(input.hourly_rate);
  const isActive = input.is_active === '0' ? 0 : 1;
  if (!name || name.length > 60) fields.name = 'Enter a rate name (up to 60 characters).';
  if (zoneId !== null && !getZone(zoneId)) fields.zone_id = 'Choose a valid zone or leave blank for all zones.';
  if (slotType !== null && !db.prepare('SELECT 1 FROM slot_types WHERE code = ?').get(slotType)) fields.slot_type = 'Choose a valid slot type or leave blank.';
  if (cents === null) fields.hourly_rate = 'Enter a valid peso amount (e.g. 30 or 30.50).';
  if (Object.keys(fields).length) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });
  return { name, zone_id: zoneId, slot_type: slotType, hourly_rate_centavos: cents, is_active: isActive };
}

function createRate(input, actor) {
  const v = validateRate(input);
  const info = ctx
    .get()
    .prepare('INSERT INTO parking_rates (name, zone_id, slot_type, hourly_rate_centavos, is_active) VALUES (?, ?, ?, ?, ?)')
    .run(v.name, v.zone_id, v.slot_type, v.hourly_rate_centavos, v.is_active);
  audit.log(actor, 'rate.create', 'parking_rate', info.lastInsertRowid, v);
}

function updateRate(id, input, actor) {
  if (!ctx.get().prepare('SELECT 1 FROM parking_rates WHERE id = ?').get(id)) throw new AppError('Rate not found.', { status: 404 });
  const v = validateRate(input);
  ctx
    .get()
    .prepare(
      `UPDATE parking_rates SET name = ?, zone_id = ?, slot_type = ?, hourly_rate_centavos = ?, is_active = ?,
         updated_at = datetime('now', 'localtime') WHERE id = ?`,
    )
    .run(v.name, v.zone_id, v.slot_type, v.hourly_rate_centavos, v.is_active, id);
  audit.log(actor, 'rate.update', 'parking_rate', id, v);
}

function deleteRate(id, actor) {
  ctx.get().prepare('DELETE FROM parking_rates WHERE id = ?').run(id);
  audit.log(actor, 'rate.delete', 'parking_rate', id);
}

module.exports = {
  SLOT_STATUSES,
  ADMIN_SLOT_STATUSES,
  VEHICLE_TYPES,
  SLOT_TYPE_VEHICLES,
  ICONS,
  EFFECTIVE_RATE_SQL,
  SLOT_SELECT,
  vehicleFitsSlotType,
  listZones,
  getZone,
  parkedVehicles,
  createZone,
  updateZone,
  deleteZone,
  zoneBlockers,
  listSlots,
  getSlot,
  createSlot,
  createSlotsBulk,
  updateSlot,
  updateSlotOperations,
  setSlotStatus,
  deleteSlot,
  slotBlockers,
  listSlotTypes,
  createSlotType,
  updateSlotType,
  deleteSlotType,
  listRates,
  createRate,
  updateRate,
  deleteRate,
};
