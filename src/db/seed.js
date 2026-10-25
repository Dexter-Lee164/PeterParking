'use strict';

const bcrypt = require('bcryptjs');
const config = require('../config');
const ctx = require('./context');
const settingsService = require('../services/settings');
const fees = require('../services/fees');
const time = require('../utils/time');
const { PLANS } = require('./lotPlans');

/** Development credentials created by the demo seed. Change them before any real use. */
const DEMO_CREDENTIALS = {
  admin: { email: 'admin@university.local', password: 'Admin@12345' },
  driver: { email: 'driver@university.local', password: 'Driver@12345' },
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function refSuffix(n) {
  let out = '';
  let v = n;
  for (let i = 0; i < 5; i += 1) {
    out = REF_ALPHABET[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}


const DRIVERS = [
  { name: 'Juan Dela Cruz', email: DEMO_CREDENTIALS.driver.email, uid: '2022-00101', phone: '0917 555 0101', plate: 'ABC 1234', type: 'car', make: 'Toyota', model: 'Vios', color: 'Silver' },
  { name: 'Maria Santos', email: 'maria.santos@university.local', uid: '2021-00457', phone: '0917 555 0102', plate: 'NBD 5521', type: 'car', make: 'Honda', model: 'City', color: 'White' },
  { name: 'Paolo Reyes', email: 'paolo.reyes@university.local', uid: '2023-00812', phone: '0917 555 0103', plate: '321 XYZ', type: 'motorcycle', make: 'Yamaha', model: 'NMAX', color: 'Black' },
  { name: 'Angela Cruz', email: 'angela.cruz@university.local', uid: 'EMP-0233', phone: '0917 555 0104', plate: 'DAM 7788', type: 'car', make: 'Mitsubishi', model: 'Xpander', color: 'Gray' },
  { name: 'Carlo Mendoza', email: 'carlo.mendoza@university.local', uid: '2020-01993', phone: '0917 555 0105', plate: 'GHT 4410', type: 'car', make: 'Suzuki', model: 'Dzire', color: 'Red' },
  { name: 'Liza Fernandez', email: 'liza.fernandez@university.local', uid: 'EMP-0412', phone: '0917 555 0106', plate: 'PQR 9023', type: 'car', make: 'Toyota', model: 'Hiace', color: 'White' },
];

function isEmpty(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
}

/** Create the first administrator from environment variables when none exists. */
function ensureAdminFromEnv(db) {
  if (!config.adminEmail || !config.adminPassword) return false;
  if (db.prepare(`SELECT 1 FROM users WHERE role = 'admin'`).get()) return false;
  db.prepare(`INSERT INTO users (full_name, email, password_hash, role, email_verified) VALUES (?, ?, ?, 'admin', 1)`).run(
    'Parking Administrator',
    config.adminEmail.toLowerCase(),
    bcrypt.hashSync(config.adminPassword, config.bcryptRounds),
  );
  return true;
}

function seedDemoData(db) {
  const rand = mulberry32(20261018);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const now = time.nowLocal();
  const today = now.slice(0, 10);
  const settings = settingsService.getAll();
  const adminHash = bcrypt.hashSync(DEMO_CREDENTIALS.admin.password, config.bcryptRounds);
  const driverHash = bcrypt.hashSync(DEMO_CREDENTIALS.driver.password, config.bcryptRounds);

  db.transaction(() => {
    // --- users & vehicles
    const adminId = db
      .prepare(`INSERT INTO users (full_name, email, phone, password_hash, role, email_verified) VALUES (?, ?, ?, ?, 'admin', 1)`)
      .run('Parking Administrator', DEMO_CREDENTIALS.admin.email, '0917 555 0100', adminHash).lastInsertRowid;

    const drivers = DRIVERS.map((d) => {
      const userId = db
        .prepare(`INSERT INTO users (university_id, full_name, email, phone, password_hash, role, email_verified) VALUES (?, ?, ?, ?, ?, 'driver', 1)`)
        .run(d.uid, d.name, d.email, d.phone, driverHash).lastInsertRowid;
      const vehicleId = db
        .prepare('INSERT INTO vehicles (user_id, plate_number, vehicle_type, make, model, color) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, d.plate, d.type, d.make, d.model, d.color).lastInsertRowid;
      return { userId, vehicleId, type: d.type };
    });

    // --- zones & slots
    const insZone = db.prepare('INSERT INTO parking_zones (code, name, description, map_columns, sort_order) VALUES (?, ?, ?, ?, ?)');
    const insSlot = db.prepare('INSERT INTO parking_slots (zone_id, slot_code, slot_type, status, sort_order) VALUES (?, ?, ?, ?, ?)');
    PLANS.forEach((z, zi) => {
      const zoneId = insZone.run(z.code, z.name, z.description, z.columns, zi + 1).lastInsertRowid;
      z.slots.forEach((s, i) => insSlot.run(zoneId, s.code, s.type, s.status, i + 1));
    });

    const slots = db
      .prepare(
        `SELECT s.id, s.zone_id, s.slot_type, t.vehicle_type AS slot_vehicle,
           COALESCE(s.hourly_rate_override_centavos,
             (SELECT r.hourly_rate_centavos FROM parking_rates r WHERE r.is_active = 1
               AND (r.zone_id IS NULL OR r.zone_id = s.zone_id) AND (r.slot_type IS NULL OR r.slot_type = s.slot_type)
              ORDER BY (r.zone_id IS NOT NULL) * 2 + (r.slot_type IS NOT NULL) DESC LIMIT 1), 0) AS rate
         FROM parking_slots s JOIN slot_types t ON t.code = s.slot_type WHERE s.status = 'active'`,
      )
      .all();

    // --- reservations
    let refCounter = 0;
    const receiptCounters = {};
    const insRes = db.prepare(
      `INSERT INTO reservations (booking_ref, user_id, vehicle_id, slot_id, start_at, end_at, duration_minutes, hourly_rate_centavos,
         fee_estimated_centavos, fee_final_centavos, status, cancelled_at, cancelled_by, cancel_reason, no_show_at, created_at, updated_at)
       VALUES (@ref, @user, @vehicle, @slot, @start, @end, @duration, @rate, @estimated, @final, @status, @cancelledAt, @cancelledBy, @cancelReason, @noShowAt, @created, @created)`,
    );
    const insSession = db.prepare(
      `INSERT INTO parking_sessions (reservation_id, slot_id, vehicle_id, check_in_at, check_out_at, checked_in_by, checked_out_by,
         late_arrival_minutes, overstay_minutes, overstay_fee_centavos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insPayment = db.prepare(
      `INSERT INTO payments (receipt_no, reservation_id, user_id, amount_centavos, method, reference, status, paid_at, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, 'valid', ?, ?)`,
    );
    const overlaps = db.prepare(
      `SELECT 1 FROM reservations WHERE slot_id = ? AND status IN ('confirmed','checked_in') AND start_at < ? AND end_at > ?`,
    );
    const vehicleBusy = db.prepare(
      `SELECT 1 FROM reservations WHERE vehicle_id = ? AND status IN ('confirmed','checked_in') AND start_at < ? AND end_at > ?`,
    );

    const hhmm = (h) => `${String(h).padStart(2, '0')}:00:00`;

    function addReservation({ driver, date, startHour, hours, status, slot = null, lateMin = 0, overstayMin = 0, payment = 'full' }) {
      const candidates = slots.filter((s) => (!slot || s.id === slot) && fitsSlot(s, driver.type));
      const chosen = pick(candidates);
      const start = `${date} ${hhmm(startHour)}`;
      const end = `${date} ${hhmm(startHour + hours)}`;
      const active = status === 'confirmed' || status === 'checked_in';
      if (active && (overlaps.get(chosen.id, end, start) || vehicleBusy.get(driver.vehicleId, end, start))) return null;
      const estimated = fees.estimatedFee(chosen.rate, hours * 60, settings);
      refCounter += 1;
      const ref = `UP-${date.slice(2).replace(/-/g, '')}-${refSuffix(refCounter)}`;
      let final = null;
      let over = { minutes: 0, feeCentavos: 0 };
      if (status === 'completed') {
        over = overstayMin ? fees.overstay(end, time.addMinutes(end, overstayMin), chosen.rate, settings) : over;
        final = estimated + over.feeCentavos;
      } else if (status === 'cancelled') {
        final = lateMin ? fees.cancellationFee(estimated, start, time.addMinutes(start, -30), settings) : 0;
      } else if (status === 'no_show') final = fees.noShowFee(estimated, settings);

      const created = time.addMinutes(start, -(60 * (4 + Math.floor(rand() * 40))));
      const id = insRes.run({
        ref, user: driver.userId, vehicle: driver.vehicleId, slot: chosen.id, start, end, duration: hours * 60, rate: chosen.rate,
        estimated, final, status,
        cancelledAt: status === 'cancelled' ? time.addMinutes(start, -90) : null,
        cancelledBy: status === 'cancelled' ? driver.userId : null,
        cancelReason: status === 'cancelled' ? 'Cancelled by driver' : null,
        noShowAt: status === 'no_show' ? end : null,
        created,
      }).lastInsertRowid;

      if (status === 'completed' || status === 'checked_in') {
        const checkIn = time.addMinutes(start, Math.max(0, lateMin ? lateMin : Math.floor(rand() * 10)));
        const checkOut = status === 'completed' ? time.addMinutes(end, overstayMin ? overstayMin : -Math.floor(rand() * 20)) : null;
        insSession.run(id, chosen.id, driver.vehicleId, checkIn, checkOut, adminId, checkOut ? adminId : null, lateMin > settings.late_arrival_grace_minutes ? lateMin : 0, over.minutes, over.feeCentavos);
      }
      if (final && final > 0 && (status === 'completed' || status === 'cancelled' || status === 'no_show') && payment !== 'none') {
        const amount = final;
        const paidAt = status === 'completed' ? time.addMinutes(end, 15) : time.addMinutes(end, 60);
        const day = paidAt.slice(0, 10).replace(/-/g, '');
        receiptCounters[day] = (receiptCounters[day] || 0) + 1;
        insPayment.run(`RCT-${day}-${String(receiptCounters[day]).padStart(4, '0')}`, id, driver.userId, amount, 'cash', null, paidAt, adminId);
      }
      return id;
    }

    function fitsSlot(slot, vehicleType) {
      if (slot.slot_vehicle === 'any') return true;
      if (slot.slot_vehicle === 'motorcycle') return vehicleType === 'motorcycle';
      return vehicleType === 'car';
    }

    // History: the previous 12 days.
    for (let back = 12; back >= 1; back -= 1) {
      const date = time.addDays(`${today} 00:00:00`, -back).slice(0, 10);
      const perDay = 3 + Math.floor(rand() * 4);
      for (let i = 0; i < perDay; i += 1) {
        const roll = rand();
        const status = roll < 0.74 ? 'completed' : roll < 0.88 ? 'cancelled' : 'no_show';
        const payRoll = rand();
        addReservation({
          driver: pick(drivers),
          date,
          startHour: 7 + Math.floor(rand() * 9),
          hours: 1 + Math.floor(rand() * 4),
          status,
          lateMin: status === 'completed' && rand() < 0.15 ? 25 : status === 'cancelled' && rand() < 0.3 ? 1 : 0,
          overstayMin: status === 'completed' && rand() < 0.1 ? 40 : 0,
          payment: payRoll < 0.88 ? 'full' : 'none',
        });
      }
    }

    // Live demo data around "now". Only while the facility is open, so nothing is "parked" at 3 a.m. and the
    // expected arrival is always still in the future (otherwise the no-show sweep would close it on first start).
    const hourNow = parseInt(now.slice(11, 13), 10);
    const demoDriver = drivers[0];
    const openHour = parseInt(String(settings.open_time).slice(0, 2), 10);
    const closeHour = parseInt(String(settings.close_time).slice(0, 2), 10);
    if (hourNow > openHour && hourNow < closeHour) {
      const startedHour = hourNow - 1;
      addReservation({ driver: drivers[1], date: today, startHour: startedHour, hours: Math.min(3, closeHour - startedHour), status: 'checked_in', lateMin: 0 });
      if (hourNow + 1 < closeHour) {
        addReservation({ driver: drivers[3], date: today, startHour: hourNow + 1, hours: Math.min(2, closeHour - hourNow - 1), status: 'confirmed' });
      }
    }
    addReservation({ driver: demoDriver, date: time.addDays(`${today} 00:00:00`, 1).slice(0, 10), startHour: 9, hours: 4, status: 'confirmed' });
    addReservation({ driver: drivers[4], date: time.addDays(`${today} 00:00:00`, 1).slice(0, 10), startHour: 13, hours: 2, status: 'confirmed' });
    addReservation({ driver: drivers[2], date: time.addDays(`${today} 00:00:00`, 2).slice(0, 10), startHour: 8, hours: 3, status: 'confirmed' });
    addReservation({ driver: drivers[5], date: time.addDays(`${today} 00:00:00`, 3).slice(0, 10), startHour: 10, hours: 5, status: 'confirmed' });
    addReservation({ driver: demoDriver, date: time.addDays(`${today} 00:00:00`, -2).slice(0, 10), startHour: 8, hours: 2, status: 'completed', payment: 'none' });
    addReservation({ driver: demoDriver, date: time.addDays(`${today} 00:00:00`, -5).slice(0, 10), startHour: 14, hours: 3, status: 'completed' });
  })();
}

module.exports = { DEMO_CREDENTIALS, isEmpty, seedDemoData, ensureAdminFromEnv };
