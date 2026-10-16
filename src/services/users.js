'use strict';
const bcrypt = require('bcryptjs');
const config = require('../config/env');
const { db } = require('../db');
const audit = require('./audit');
const { AppError, ValidationError, conflict, notFound } = require('../utils/errors');
const v = require('../utils/validate');
const { nowIso } = require('../utils/time');

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-1', config.bcryptRounds);
const COLS = 'id, name, email, university_id, phone, role, driver_type, is_active, created_at, last_login_at';
const DRIVER_TYPES = ['student', 'faculty', 'personnel'];

const hash = (pw) => bcrypt.hashSync(pw, config.bcryptRounds);
const getById = (id) => db.prepare(`SELECT ${COLS} FROM users WHERE id = ?`).get(id);

function normalize(input, { requirePassword, allowRole }) {
  const errors = {};
  const out = {
    name: v.clean(input.name), email: v.clean(input.email).toLowerCase(), universityId: v.clean(input.universityId || input.university_id),
    phone: v.clean(input.phone), role: 'driver', driverType: v.clean(input.driverType || input.driver_type) || 'student',
  };
  if (out.name.length < 2 || out.name.length > 100) errors.name = 'Enter your full name (2–100 characters).';
  if (!v.EMAIL_RE.test(out.email) || out.email.length > 120) errors.email = 'Enter a valid email address.';
  if (out.universityId.length > 30) errors.universityId = 'Use 30 characters or fewer.';
  if (out.phone && !/^[0-9+()\-\s]{7,20}$/.test(out.phone)) errors.phone = 'Enter a valid phone number.';
  if (allowRole && v.oneOf(input.role, ['driver', 'admin'])) out.role = input.role;
  if (out.role === 'driver' && !v.oneOf(out.driverType, DRIVER_TYPES)) errors.driverType = 'Choose student, faculty or personnel.';
  if (out.role === 'admin') out.driverType = null;
  if (requirePassword) {
    const pe = v.passwordProblem(input.password);
    if (pe) errors.password = pe;
    else if (input.confirmPassword !== undefined && input.password !== input.confirmPassword) errors.confirmPassword = 'Passwords do not match.';
  }
  v.assertNoErrors(errors);
  return out;
}

function createUser(input, { allowRole = false, actor = null } = {}) {
  const d = normalize(input, { requirePassword: true, allowRole });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(d.email)) throw new ValidationError({ email: 'An account with this email already exists.' });
  const info = db.prepare('INSERT INTO users (name, email, university_id, phone, password_hash, role, driver_type, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(d.name, d.email, d.universityId || null, d.phone || null, hash(input.password), d.role, d.driverType, nowIso());
  audit.log(actor || { id: info.lastInsertRowid }, actor ? 'user.create' : 'user.register', 'user', info.lastInsertRowid, { role: d.role });
  return getById(info.lastInsertRowid);
}

async function authenticate(email, password) {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(v.clean(email).toLowerCase());
  const ok = await bcrypt.compare(String(password || ''), u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) return { user: null, reason: 'invalid' };
  if (!u.is_active) return { user: null, reason: 'inactive' };
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), u.id);
  return { user: getById(u.id) };
}

function updateProfile(userId, input, actor) {
  const errors = {};
  const name = v.clean(input.name), phone = v.clean(input.phone), universityId = v.clean(input.universityId);
  if (name.length < 2 || name.length > 100) errors.name = 'Enter your full name (2–100 characters).';
  if (phone && !/^[0-9+()\-\s]{7,20}$/.test(phone)) errors.phone = 'Enter a valid phone number.';
  if (universityId.length > 30) errors.universityId = 'Use 30 characters or fewer.';
  v.assertNoErrors(errors);
  db.prepare('UPDATE users SET name = ?, phone = ?, university_id = ? WHERE id = ?').run(name, phone || null, universityId || null, userId);
  audit.log(actor, 'user.profile_update', 'user', userId);
  return getById(userId);
}

async function changePassword(userId, current, next, confirm, actor) {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  const errors = {};
  if (!(await bcrypt.compare(String(current || ''), row.password_hash))) errors.currentPassword = 'Current password is incorrect.';
  const pe = v.passwordProblem(next);
  if (pe) errors.newPassword = pe; else if (next !== confirm) errors.confirmPassword = 'Passwords do not match.';
  v.assertNoErrors(errors);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash(next), userId);
  audit.log(actor, 'user.password_change', 'user', userId);
}

function listUsers({ q = '', role = '', status = '', page = 1, size = 15 } = {}) {
  const where = []; const p = [];
  if (q) { where.push('(u.name LIKE ? OR u.email LIKE ? OR u.university_id LIKE ? OR EXISTS (SELECT 1 FROM vehicles v WHERE v.user_id = u.id AND v.plate_number LIKE ?))'); p.push(...Array(4).fill(`%${q}%`)); }
  if (role) { where.push('u.role = ?'); p.push(role); }
  if (status === 'active') where.push('u.is_active = 1'); else if (status === 'inactive') where.push('u.is_active = 0');
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM users u ${w}`).get(...p).c;
  const rows = db.prepare(`SELECT u.id, u.name, u.email, u.university_id, u.role, u.driver_type, u.is_active, u.last_login_at,
      (SELECT COUNT(*) FROM vehicles v WHERE v.user_id = u.id AND v.is_active = 1) AS vehicle_count,
      (SELECT COUNT(*) FROM reservations r WHERE r.user_id = u.id) AS reservation_count
    FROM users u ${w} ORDER BY u.name COLLATE NOCASE LIMIT ? OFFSET ?`).all(...p, size, (page - 1) * size);
  return { rows, total };
}

function setActive(userId, active, actor) {
  const u = getById(userId);
  if (!u) throw notFound('User');
  if (!active && userId === actor.id) throw conflict('You cannot deactivate your own account.');
  if (!active) {
    const live = db.prepare("SELECT COUNT(*) c FROM parking_sessions s JOIN reservations r ON r.id = s.reservation_id WHERE r.user_id = ? AND s.status = 'active'").get(userId).c;
    if (live) throw conflict('This driver has a vehicle checked in. Check it out before deactivating the account.');
  }
  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(active ? 1 : 0, userId);
  audit.log(actor, active ? 'user.activate' : 'user.deactivate', 'user', userId);
}

function resetPassword(userId, password, actor) {
  const pe = v.passwordProblem(password);
  if (pe) throw new ValidationError({ password: pe });
  if (!getById(userId)) throw notFound('User');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash(password), userId);
  audit.log(actor, 'user.password_reset', 'user', userId);
}

/* ------------------------------ vehicles ------------------------------ */
const listVehicles = (userId, { includeInactive = false } = {}) =>
  db.prepare(`SELECT * FROM vehicles WHERE user_id = ? ${includeInactive ? '' : 'AND is_active = 1'} ORDER BY created_at DESC, id DESC`).all(userId);

function vehicleInput(input) {
  const errors = {};
  const plate = v.normalizePlate(input.plateNumber);
  const type = v.clean(input.vehicleType);
  const makeModel = v.clean(input.makeModel), color = v.clean(input.color);
  if (!v.PLATE_RE.test(plate)) errors.plateNumber = 'Enter a plate number of 4–10 letters, numbers or dashes.';
  if (!v.oneOf(type, ['car', 'motorcycle'])) errors.vehicleType = 'Choose car or motorcycle.';
  if (makeModel.length > 60) errors.makeModel = 'Use 60 characters or fewer.';
  if (color.length > 30) errors.color = 'Use 30 characters or fewer.';
  v.assertNoErrors(errors);
  return { plate, type, makeModel: makeModel || null, color: color || null };
}

function addVehicle(userId, input, actor) {
  const d = vehicleInput(input);
  if (db.prepare('SELECT 1 FROM vehicles WHERE plate_number = ?').get(d.plate)) throw new ValidationError({ plateNumber: 'This plate number is already registered.' });
  const info = db.prepare('INSERT INTO vehicles (user_id, plate_number, vehicle_type, make_model, color, created_at) VALUES (?,?,?,?,?,?)')
    .run(userId, d.plate, d.type, d.makeModel, d.color, nowIso());
  audit.log(actor, 'vehicle.create', 'vehicle', info.lastInsertRowid, { plate: d.plate });
  return info.lastInsertRowid;
}

function updateVehicle(userId, vehicleId, input, actor) {
  const cur = db.prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ?').get(vehicleId, userId);
  if (!cur) throw notFound('Vehicle');
  const d = vehicleInput(input);
  if (db.prepare('SELECT 1 FROM vehicles WHERE plate_number = ? AND id <> ?').get(d.plate, vehicleId)) throw new ValidationError({ plateNumber: 'This plate number is already registered.' });
  if (d.type !== cur.vehicle_type && db.prepare("SELECT 1 FROM reservations WHERE vehicle_id = ? AND status IN ('confirmed','active')").get(vehicleId)) {
    throw conflict('This vehicle has open reservations. Cancel them before changing its type.');
  }
  db.prepare('UPDATE vehicles SET plate_number = ?, vehicle_type = ?, make_model = ?, color = ? WHERE id = ?').run(d.plate, d.type, d.makeModel, d.color, vehicleId);
  audit.log(actor, 'vehicle.update', 'vehicle', vehicleId);
}

/** Deletes a vehicle with no history; otherwise retires it so past records stay intact. */
function removeVehicle(userId, vehicleId, actor) {
  const cur = db.prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ?').get(vehicleId, userId);
  if (!cur) throw notFound('Vehicle');
  if (db.prepare("SELECT 1 FROM reservations WHERE vehicle_id = ? AND status IN ('confirmed','active')").get(vehicleId)) {
    throw conflict('This vehicle has open reservations. Cancel them first.');
  }
  if (db.prepare('SELECT 1 FROM reservations WHERE vehicle_id = ?').get(vehicleId)) {
    db.prepare('UPDATE vehicles SET is_active = 0 WHERE id = ?').run(vehicleId);
    audit.log(actor, 'vehicle.retire', 'vehicle', vehicleId);
    return 'retired';
  }
  db.prepare('DELETE FROM vehicles WHERE id = ?').run(vehicleId);
  audit.log(actor, 'vehicle.delete', 'vehicle', vehicleId);
  return 'deleted';
}

module.exports = { DRIVER_TYPES, getById, createUser, authenticate, updateProfile, changePassword, listUsers, setActive, resetPassword,
  listVehicles, addVehicle, updateVehicle, removeVehicle, hash };
