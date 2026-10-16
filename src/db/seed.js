'use strict';
const bcrypt = require('bcryptjs');
const config = require('../config/env');
const T = require('../utils/time');
const settingsSvc = require('../services/settings');

/** Development seed data. Safe to run once; it skips when an administrator already exists. */
function seed(db) {
  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) return { skipped: true };
  const adminHash = bcrypt.hashSync(config.seed.adminPassword, config.bcryptRounds);
  const driverHash = bcrypt.hashSync(config.seed.driverPassword, config.bcryptRounds);
  const now = T.nowIso();
  const settings = settingsSvc.getAll();
  const out = { admin: config.seed.adminEmail, drivers: [] };

  db.transaction(() => {
    db.prepare("INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Parking Administrator', ?, ?, 'admin', ?)").run(config.seed.adminEmail, adminHash, now);
    const insUser = db.prepare('INSERT INTO users (name, email, university_id, phone, password_hash, role, driver_type, created_at) VALUES (?,?,?,?,?,?,?,?)');
    const insVeh = db.prepare('INSERT INTO vehicles (user_id, plate_number, vehicle_type, make_model, color, created_at) VALUES (?,?,?,?,?,?)');
    const people = [
      ['Maria Santos', 'maria@university.test', '2022-01234', 'student', ['NBC1234', 'car', 'Toyota Vios', 'White']],
      ['Juan Dela Cruz', 'juan@university.test', 'FAC-0045', 'faculty', ['ABC5678', 'car', 'Honda City', 'Gray']],
      ['Ana Reyes', 'ana@university.test', '2021-05521', 'student', ['MC12345', 'motorcycle', 'Honda Click', 'Red']],
    ];
    const ids = [];
    for (const [name, email, uid, type, veh] of people) {
      const u = insUser.run(name, email, uid, null, driverHash, 'driver', type, now).lastInsertRowid;
      const vid = insVeh.run(u, veh[0], veh[1], veh[2], veh[3], now).lastInsertRowid;
      ids.push({ u, vid }); out.drivers.push(email);
    }

    const rate = db.prepare('INSERT INTO parking_rates (slot_type, hourly_rate_centavos, updated_at) VALUES (?,?,?)');
    for (const [t, c] of [['standard', 2000], ['compact', 1500], ['accessible', 2000], ['motorcycle', 1000]]) rate.run(t, c, now);

    const zone = db.prepare('INSERT INTO parking_zones (name, description, map_columns, created_at) VALUES (?,?,?,?)');
    const slot = db.prepare('INSERT INTO parking_slots (zone_id, code, slot_type, status, created_at) VALUES (?,?,?,?,?)');
    const layout = [
      ['Main Building', 'Front lot beside the main entrance', 6, 'MB', 12, { 1: 'accessible', 2: 'accessible', 11: 'compact', 12: 'compact', 8: 'maintenance' }],
      ['Engineering', 'Engineering and laboratory buildings', 6, 'EN', 12, { 11: 'compact', 12: 'compact' }],
      ['Science', 'Science complex rear lot', 5, 'SC', 10, { 9: 'compact', 10: 'compact' }],
      ['Administration', 'Registrar and administration offices, with a motorcycle bay', 6, 'AD', 12, { 9: 'motorcycle', 10: 'motorcycle', 11: 'motorcycle', 12: 'motorcycle' }],
    ];
    const zoneIds = [];
    for (const [name, desc, cols, prefix, n, special] of layout) {
      const zid = zone.run(name, desc, cols, now).lastInsertRowid; zoneIds.push(zid);
      for (let i = 1; i <= n; i++) {
        const sp = special[i];
        slot.run(zid, `${prefix}-${String(i).padStart(2, '0')}`, sp === 'maintenance' ? 'standard' : (sp || 'standard'), sp === 'maintenance' ? 'maintenance' : 'active', now);
      }
    }
    const slotId = (code) => db.prepare('SELECT id FROM parking_slots WHERE code = ?').get(code).id;

    const res = db.prepare(`INSERT INTO reservations (reference, user_id, vehicle_id, slot_id, start_at, end_at, status, hourly_rate_centavos, estimated_fee_centavos, final_fee_centavos, finalized_at, cancel_reason, cancelled_by, cancelled_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const sess = db.prepare(`INSERT INTO parking_sessions (reservation_id, slot_id, vehicle_id, status, checked_in_at, checked_in_by, checked_out_at, checked_out_by, is_late, late_minutes, rate_centavos, final_fee_centavos)
      VALUES (?,?,?,?,?,?,?,?,0,0,?,?)`);
    const pay = db.prepare("INSERT INTO payments (receipt_number, reservation_id, amount_centavos, method, reference, status, recorded_by, recorded_at) VALUES (?,?,?,?,?, 'valid', 1, ?)");
    const today = T.todayLocal(); let n = 0; let rc = 0;
    const mk = (offsetDays, sH, eH, who, code, status, opts = {}) => {
      const d = T.addDays(today, offsetDays); const s = T.localToIso(d, `${String(sH).padStart(2, '0')}:00`); const e = T.localToIso(d, `${String(eH).padStart(2, '0')}:00`);
      const slotRow = db.prepare('SELECT s.id, r.hourly_rate_centavos AS rate FROM parking_slots s JOIN parking_rates r ON r.slot_type = s.slot_type WHERE s.code = ?').get(code);
      const hrs = eH - sH; const est = slotRow.rate * hrs; const person = ids[who];
      const final = status === 'completed' ? est : (status === 'cancelled' || status === 'no_show' ? 0 : null);
      const ref = `UP-${d.replaceAll('-', '')}-S${String(++rc).padStart(4, '0')}`;
      const info = res.run(ref, person.u, person.vid, slotRow.id, s, e, status, slotRow.rate, est, final, final == null ? null : e,
        status === 'cancelled' ? 'Change of plans' : null, status === 'cancelled' ? person.u : null, status === 'cancelled' ? s : null, T.addMinutesIso(s, -2880), e);
      const rid = info.lastInsertRowid;
      if (status === 'completed') {
        sess.run(rid, slotRow.id, person.vid, 'completed', s, 1, e, 1, slotRow.rate, final);
        if (opts.paid) pay.run(`OR-${d.replaceAll('-', '')}-${String(++n).padStart(5, '0')}`, rid, opts.paid, opts.method || 'cash', null, e);
      }
      if (status === 'active') sess.run(rid, slotRow.id, person.vid, 'active', s, 1, null, null, slotRow.rate, null);
      return rid;
    };
    // Past activity (spread over the last two weeks so the charts have shape).
    const past = [[-1, 8, 10, 0, 'MB-03'], [-1, 9, 12, 1, 'EN-02'], [-2, 13, 16, 0, 'MB-04'], [-2, 8, 9, 2, 'AD-10'], [-3, 10, 12, 1, 'EN-05'], [-4, 7, 9, 0, 'SC-01'],
      [-5, 14, 17, 1, 'MB-06'], [-6, 8, 11, 0, 'EN-07'], [-7, 9, 11, 2, 'AD-11'], [-8, 12, 14, 1, 'SC-03'], [-9, 8, 10, 0, 'MB-02'], [-10, 15, 18, 1, 'EN-09']];
    past.forEach(([d, s, e, w, c], i) => {
      const rid = mk(d, s, e, w, c, 'completed', { paid: i % 4 === 3 ? undefined : (e - s) * 2000 > 0 ? (db.prepare('SELECT hourly_rate_centavos r FROM parking_rates r JOIN parking_slots s ON s.slot_type = r.slot_type WHERE s.code = ?').get(c).r) * (e - s) : 0, method: i % 3 === 0 ? 'gcash' : 'cash' });
      if (i % 3 === 0) db.prepare("UPDATE payments SET reference = ? WHERE reservation_id = ?").run(`GC${100200 + i}`, rid);
    });
    mk(-3, 8, 10, 2, 'AD-12', 'cancelled'); mk(-6, 9, 11, 1, 'SC-05', 'no_show');
    // Current activity.
    const hourNow = T.localParts(now).hour;
    const open = settingsSvc.hmToMin(settings.operating_start) / 60, close = settingsSvc.hmToMin(settings.operating_end) / 60;
    if (hourNow >= open && hourNow + 2 <= close) mk(0, hourNow, hourNow + 2, 0, 'MB-05', 'active');
    // Upcoming bookings (tomorrow and later).
    mk(1, 9, 11, 1, 'EN-03', 'confirmed'); mk(1, 13, 15, 0, 'MB-07', 'confirmed'); mk(2, 8, 10, 2, 'AD-09', 'confirmed');
    db.prepare("INSERT INTO audit_logs (user_id, action, entity_type, details, created_at) VALUES (1, 'system.seed', 'system', '{\"note\":\"Development seed data created\"}', ?)").run(now);
  })();
  return out;
}
module.exports = { seed };
