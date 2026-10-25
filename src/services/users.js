'use strict';

const bcrypt = require('bcryptjs');
const ctx = require('../db/context');
const config = require('../config');
const audit = require('./audit');
const { AppError } = require('../utils/errors');
const { clean, collapse, isEmail, passwordProblem, toInt, normalizePlate, oneOf } = require('../utils/validate');
const emailRules = require('../../public/js/email-rules');
const nameRules = require('../../public/js/name-rules');
const vehicleCatalog = require('../../public/js/vehicle-catalog');
const { nowLocal } = require('../utils/time');
const { paginate } = require('../utils/paginate');

const VEHICLE_TYPES = ['car', 'motorcycle'];

// A dummy hash so login timing does not reveal whether an email exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 8);

const hashPassword = (pw) => bcrypt.hashSync(pw, config.bcryptRounds);

const PUBLIC_COLUMNS = 'id, university_id, full_name, email, phone, role, is_active, last_login_at, created_at, password_changed_at';

function getUser(id) {
  return ctx.get().prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(id);
}

function authenticate(email, password) {
  const row = ctx.get().prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(clean(email));
  const ok = bcrypt.compareSync(String(password || ''), row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) return { error: 'Invalid email or password.' };
  if (!row.is_active) return { error: 'This account has been deactivated. Please contact parking administration.' };
  ctx.get().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowLocal(), row.id);
  return { user: getUser(row.id) };
}

/**
 * `emailProblem` is an optional extra message for the e-mail field (the DNS "can this domain receive mail?" result,
 * which is asynchronous and therefore computed by the caller). It only applies when the address is otherwise fine
 * and not already taken.
 */
function validateProfile(input, { id = null, requireUniversityId = false, emailProblem = null } = {}) {
  const db = ctx.get();
  const fields = {};
  const nameCheck = nameRules.validate(input.full_name);
  const fullName = nameCheck.name;
  const checked = emailRules.validate(input.email);
  const email = checked.email; // trimmed + lower-case, whatever the verdict
  const phone = clean(input.phone);
  const universityId = clean(input.university_id);
  if (!nameCheck.ok) fields.full_name = nameCheck.message;
  // An administrator re-saving an existing account keeps an address that was valid under the older, looser rules.
  const unchanged = id && String((db.prepare('SELECT email FROM users WHERE id = ?').get(id) || { email: '' }).email).toLowerCase() === email;
  if (!checked.ok && !(unchanged && isEmail(email))) fields.email = checked.message;
  else if (db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id <> ?').get(email, id || 0)) fields.email = emailRules.MESSAGES.taken;
  else if (emailProblem) fields.email = emailProblem;
  if (phone && !/^[0-9+()\-\s]{7,20}$/.test(phone)) fields.phone = 'Enter a valid phone number.';
  if (requireUniversityId && !universityId) fields.university_id = 'Enter the university ID.';
  if (universityId.length > 30) fields.university_id = 'University ID is too long.';
  if (universityId && db.prepare('SELECT id FROM users WHERE university_id = ? AND id <> ?').get(universityId, id || 0)) {
    fields.university_id = 'That university ID is already registered.';
  }
  if (Object.keys(fields).length) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });
  return { full_name: fullName, email, phone: phone || null, university_id: universityId || null };
}

/**
 * Check a public sign-up form (profile + password). Throws a VALIDATION AppError; returns the normalised profile.
 * Nothing is written: the account is only created once the e-mailed code is verified (services/registration.js).
 */
function validateRegistration(input, { emailProblem = null } = {}) {
  let profileError = null;
  let v = null;
  try {
    v = validateProfile(input, { emailProblem });
  } catch (err) {
    if (!(err instanceof AppError) || !err.fields) throw err;
    profileError = err;
  }
  const fields = profileError ? Object.assign({}, profileError.fields) : {};
  const problem = passwordProblem(input.password);
  if (problem) fields.password = problem;
  else if (input.password !== input.confirm_password) fields.confirm_password = 'Passwords do not match.';
  if (Object.keys(fields).length) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });
  return v;
}

/**
 * Create a driver whose e-mail address is already proven (code verified). Public sign-up never creates any
 * other role. Returns null when the address was registered in the meantime. A university ID taken in the meantime is
 * dropped rather than blocking the account (it can be added later on the profile page).
 */
function createVerifiedDriver({ full_name, email, phone = null, university_id = null, password_hash }, ip, action = 'user.register') {
  const db = ctx.get();
  if (db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email)) return null;
  const uid = university_id && !db.prepare('SELECT id FROM users WHERE university_id = ?').get(university_id) ? university_id : null;
  const info = db
    .prepare(
      `INSERT INTO users (university_id, full_name, email, phone, password_hash, role, email_verified)
       VALUES (?, ?, ?, ?, ?, 'driver', 1)`,
    )
    .run(uid, full_name, String(email).toLowerCase(), phone || null, password_hash);
  audit.log(info.lastInsertRowid, action, 'user', info.lastInsertRowid, { email: String(email).toLowerCase() }, ip);
  return getUser(info.lastInsertRowid);
}

const touchLastLogin = (id) => ctx.get().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowLocal(), id);

function updateOwnProfile(userId, input, actor) {
  const v = validateProfile(input, { id: userId });
  ctx
    .get()
    .prepare(`UPDATE users SET full_name = ?, email = ?, phone = ?, university_id = ?, updated_at = datetime('now','localtime') WHERE id = ?`)
    .run(v.full_name, v.email, v.phone, v.university_id, userId);
  audit.log(actor, 'user.update_profile', 'user', userId);
  return getUser(userId);
}

function changePassword(userId, { current_password, new_password, confirm_password }, actor) {
  const row = ctx.get().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!row) throw new AppError('User not found.', { status: 404, code: 'NOT_FOUND' });
  const fields = {};
  const currentOk = bcrypt.compareSync(String(current_password || ''), row.password_hash);
  if (!currentOk) fields.current_password = 'Current password is incorrect.';
  const problem = passwordProblem(new_password);
  if (problem) fields.new_password = problem;
  // Checked against the stored hash (not just the typed text), and only once the current password is proven.
  else if (currentOk && bcrypt.compareSync(new_password, row.password_hash)) fields.new_password = 'Your new password must be different from your current password.';
  else if (new_password !== confirm_password) fields.confirm_password = 'Passwords do not match.';
  if (Object.keys(fields).length) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });
  // Only now, with every check passed, is the hash replaced.
  ctx.get().prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now','localtime') WHERE id = ?`).run(hashPassword(new_password), userId);
  audit.log(actor, 'user.change_password', 'user', userId);
}

// ------------------------------------------------------------- admin: users

function listUsers({ q = '', role = '', status = '' } = {}, { page = 1, perPage = 15 } = {}) {
  const where = [];
  const params = [];
  if (q) {
    where.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.university_id LIKE ? OR EXISTS (SELECT 1 FROM vehicles v WHERE v.user_id = u.id AND replace(v.plate_number, \' \', \'\') LIKE ?))');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q.replace(/\s/g, '').toUpperCase()}%`);
  }
  if (role === 'driver' || role === 'admin') {
    where.push('u.role = ?');
    params.push(role);
  }
  if (status === 'active' || status === 'inactive') {
    where.push('u.is_active = ?');
    params.push(status === 'active' ? 1 : 0);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = ctx.get();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM users u ${whereSql}`).get(...params).n;
  const pager = paginate(total, page, perPage);
  const rows = db
    .prepare(
      `SELECT u.id, u.university_id, u.full_name, u.email, u.phone, u.role, u.is_active, u.last_login_at, u.created_at,
         (SELECT COUNT(*) FROM vehicles v WHERE v.user_id = u.id AND v.is_active = 1) AS vehicle_count,
         (SELECT COUNT(*) FROM reservations r WHERE r.user_id = u.id) AS reservation_count
       FROM users u ${whereSql} ORDER BY u.role, u.full_name LIMIT ? OFFSET ?`,
    )
    .all(...params, perPage, pager.offset);
  return { rows, pager };
}

function adminCreateUser(input, actor) {
  const v = validateProfile(input);
  const role = oneOf(clean(input.role), ['driver', 'admin']);
  const fields = {};
  if (!role) fields.role = 'Choose a role.';
  const problem = passwordProblem(input.password);
  if (problem) fields.password = problem;
  if (Object.keys(fields).length) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });
  const info = ctx
    .get()
    .prepare('INSERT INTO users (university_id, full_name, email, phone, password_hash, role, email_verified) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .run(v.university_id, v.full_name, v.email, v.phone, hashPassword(input.password), role);
  audit.log(actor, 'user.create', 'user', info.lastInsertRowid, { email: v.email, role });
  return getUser(info.lastInsertRowid);
}

function adminUpdateUser(id, input, actor) {
  const existing = getUser(id);
  if (!existing) throw new AppError('User not found.', { status: 404, code: 'NOT_FOUND' });
  // The email address is the sign-in identity and cannot be changed here: whatever the form sends, it is kept as is.
  const v = validateProfile(Object.assign({}, input, { email: existing.email }), { id });
  const role = oneOf(clean(input.role), ['driver', 'admin'], existing.role);
  const isActive = input.is_active === '0' ? 0 : 1;
  guardLastAdmin(existing, role, isActive, actor);
  if (!isActive && existing.is_active) assertNoActiveParking(id);
  ctx
    .get()
    .prepare(
      `UPDATE users SET university_id = ?, full_name = ?, phone = ?, role = ?, is_active = ?,
         updated_at = datetime('now','localtime') WHERE id = ?`,
    )
    .run(v.university_id, v.full_name, v.phone, role, isActive, id);
  if (clean(input.new_password)) {
    const problem = passwordProblem(input.new_password);
    if (problem) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields: { new_password: problem } });
    ctx.get().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(input.new_password), id);
    audit.log(actor, 'user.reset_password', 'user', id);
  }
  audit.log(actor, 'user.update', 'user', id, { role, is_active: isActive });
  return getUser(id);
}

function setUserActive(id, active, actor) {
  const existing = getUser(id);
  if (!existing) throw new AppError('User not found.', { status: 404, code: 'NOT_FOUND' });
  guardLastAdmin(existing, existing.role, active ? 1 : 0, actor);
  if (!active) assertNoActiveParking(id);
  ctx.get().prepare(`UPDATE users SET is_active = ?, updated_at = datetime('now','localtime') WHERE id = ?`).run(active ? 1 : 0, id);
  audit.log(actor, active ? 'user.activate' : 'user.deactivate', 'user', id);
}

function guardLastAdmin(existing, newRole, newActive, actor) {
  if (existing.role === 'admin' && (newRole !== 'admin' || !newActive)) {
    const others = ctx.get().prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1 AND id <> ?`).get(existing.id).n;
    if (!others) throw new AppError('You cannot deactivate or demote the last active administrator.', { code: 'LAST_ADMIN', status: 409 });
  }
  if (actor && actor.id === existing.id && (!newActive || newRole !== 'admin') && existing.role === 'admin') {
    throw new AppError('You cannot deactivate or demote your own administrator account.', { code: 'SELF_LOCKOUT', status: 409 });
  }
}

function assertNoActiveParking(userId) {
  const n = ctx.get().prepare(`SELECT COUNT(*) AS n FROM reservations WHERE user_id = ? AND status = 'checked_in'`).get(userId).n;
  if (n) throw new AppError('This driver currently has a vehicle parked. Check it out before deactivating the account.', { code: 'USER_PARKED', status: 409 });
}

// ------------------------------------------------------------- vehicles

const listVehicles = (userId, { includeInactive = false } = {}) =>
  ctx
    .get()
    .prepare(`SELECT * FROM vehicles WHERE user_id = ? ${includeInactive ? '' : 'AND is_active = 1'} ORDER BY is_active DESC, plate_number`)
    .all(userId);

const getVehicle = (id) => ctx.get().prepare('SELECT * FROM vehicles WHERE id = ?').get(id);

const CUSTOM_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .&'/+-]*$/u;

/** A manufacturer or model typed in after choosing Other: null when fine, else the problem. */
function customNameProblem(value, what) {
  if (!value) return `Enter the ${what}.`;
  if (value.length > 40) return `Keep the ${what} under 40 characters.`;
  if (!CUSTOM_NAME.test(value)) return `Use letters, numbers, spaces and . & ' / + - only.`;
  return null;
}

/**
 * Manufacturer (stored in the `make` column) and model come from public/js/vehicle-catalog.js and must suit the vehicle
 * type, or are typed in after choosing Other (`make` / `model` = vehicleCatalog.OTHER, text in `make_other` /
 * `model_other`). A typed name that matches the catalogue takes the catalogue spelling. A manufacturer typed in has no
 * catalogue models, so its model is typed in too. A vehicle saved before the catalogue existed keeps its stored
 * manufacturer/model while its type is unchanged, so it can still be edited without retyping them.
 */
function catalogMakeModel(type, input, current, fields) {
  const { key, OTHER } = vehicleCatalog;
  const makeIn = collapse(input.make);
  const modelIn = collapse(input.model);
  const sameType = !!current && current.vehicle_type === type;
  let make = null;
  let model = null;
  let customMake = false;
  if (makeIn === OTHER) {
    const typed = collapse(input.make_other);
    const problem = customNameProblem(typed, 'manufacturer');
    if (problem) fields.make_other = problem;
    else {
      make = vehicleCatalog.findManufacturer(type, typed) || typed;
      customMake = !vehicleCatalog.findManufacturer(type, typed);
    }
  } else if (makeIn) {
    make = vehicleCatalog.findManufacturer(type, makeIn);
    if (!make && sameType && key(current.make) === key(makeIn)) make = current.make;
    if (!make) fields.make = 'Choose a manufacturer from the list for this vehicle type.';
  }
  if (modelIn === OTHER || (customMake && modelIn)) {
    const typed = collapse(modelIn === OTHER ? input.model_other : modelIn);
    if (!makeIn) fields.model = 'Choose the manufacturer first.';
    else if (make) {
      const problem = customNameProblem(typed, 'model');
      if (problem) fields.model_other = problem;
      else model = vehicleCatalog.findModel(type, make, typed) || typed;
    }
  } else if (modelIn) {
    if (!makeIn) fields.model = 'Choose the manufacturer first.';
    else if (make) {
      model = vehicleCatalog.findModel(type, make, modelIn);
      if (!model && sameType && key(current.make) === key(make) && key(current.model) === key(modelIn)) model = current.model;
      if (!model) fields.model = `Choose a ${make} model from the list.`;
    }
  }
  return { make, model };
}

function validateVehicle(input, { id = null } = {}) {
  const db = ctx.get();
  const fields = {};
  const plate = normalizePlate(input.plate_number);
  const type = oneOf(clean(input.vehicle_type), VEHICLE_TYPES);
  const color = collapse(input.color);
  if (!/^[A-Z0-9][A-Z0-9 -]{2,11}$/.test(plate)) fields.plate_number = 'Enter a valid plate number (3–12 letters/numbers, e.g. ABC 1234).';
  else if (db.prepare(`SELECT id FROM vehicles WHERE replace(plate_number, ' ', '') = ? AND is_active = 1 AND id <> ?`).get(plate.replace(/\s/g, ''), id || 0)) {
    fields.plate_number = 'That plate number is already registered.';
  }
  if (!type) fields.vehicle_type = 'Choose a vehicle type.';
  const picked = type ? catalogMakeModel(type, input, id ? getVehicle(id) : null, fields) : { make: null, model: null };
  const make = picked.make || '';
  const model = picked.model || '';
  if (color.length > 30) fields.color = 'Too long.';
  if (Object.keys(fields).length) throw new AppError('Please correct the highlighted fields.', { code: 'VALIDATION', fields });
  return { plate_number: plate, vehicle_type: type, make: make || null, model: model || null, color: color || null };
}

function addVehicle(userId, input, actor) {
  const v = validateVehicle(input);
  const info = ctx
    .get()
    .prepare('INSERT INTO vehicles (user_id, plate_number, vehicle_type, make, model, color) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, v.plate_number, v.vehicle_type, v.make, v.model, v.color);
  audit.log(actor, 'vehicle.add', 'vehicle', info.lastInsertRowid, v);
  return getVehicle(info.lastInsertRowid);
}

function ownVehicle(userId, id) {
  const v = getVehicle(id);
  if (!v || v.user_id !== userId) throw new AppError('Vehicle not found.', { status: 404, code: 'NOT_FOUND' });
  return v;
}

function updateVehicle(userId, id, input, actor) {
  ownVehicle(userId, id);
  const v = validateVehicle(input, { id });
  const active = ctx.get().prepare(`SELECT COUNT(*) AS n FROM reservations WHERE vehicle_id = ? AND status IN ('confirmed','checked_in')`).get(id).n;
  const current = getVehicle(id);
  if (active && (current.plate_number !== v.plate_number || current.vehicle_type !== v.vehicle_type)) {
    throw new AppError('This vehicle has active reservations, so its plate number and type cannot be changed.', { code: 'VEHICLE_IN_USE', status: 409 });
  }
  ctx
    .get()
    .prepare(`UPDATE vehicles SET plate_number = ?, vehicle_type = ?, make = ?, model = ?, color = ?, updated_at = datetime('now','localtime') WHERE id = ?`)
    .run(v.plate_number, v.vehicle_type, v.make, v.model, v.color, id);
  audit.log(actor, 'vehicle.update', 'vehicle', id, v);
}

/** Remove a vehicle: hard-delete if it has no history, otherwise deactivate to keep records. */
function removeVehicle(userId, id, actor) {
  ownVehicle(userId, id);
  const db = ctx.get();
  const active = db.prepare(`SELECT COUNT(*) AS n FROM reservations WHERE vehicle_id = ? AND status IN ('confirmed','checked_in')`).get(id).n;
  if (active) throw new AppError('This vehicle has active reservations. Cancel them before removing the vehicle.', { code: 'VEHICLE_IN_USE', status: 409 });
  const history = db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE vehicle_id = ?').get(id).n;
  if (history) db.prepare(`UPDATE vehicles SET is_active = 0, updated_at = datetime('now','localtime') WHERE id = ?`).run(id);
  else db.prepare('DELETE FROM vehicles WHERE id = ?').run(id);
  audit.log(actor, 'vehicle.remove', 'vehicle', id, { archived: !!history });
  return { archived: !!history };
}

module.exports = {
  VEHICLE_TYPES,
  hashPassword,
  getUser,
  authenticate,
  validateRegistration,
  createVerifiedDriver,
  touchLastLogin,
  updateOwnProfile,
  changePassword,
  listUsers,
  adminCreateUser,
  adminUpdateUser,
  setUserActive,
  listVehicles,
  getVehicle,
  addVehicle,
  updateVehicle,
  removeVehicle,
};
