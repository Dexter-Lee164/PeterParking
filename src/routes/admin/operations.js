'use strict';

const express = require('express');
const sessions = require('../../services/sessions');
const reservations = require('../../services/reservations');
const settingsService = require('../../services/settings');
const { AppError } = require('../../utils/errors');
const { toInt, clean } = require('../../utils/validate');
const { formatPeso } = require('../../utils/money');
const time = require('../../utils/time');

const router = express.Router();

/** Only ever send the admin back to one of two known pages. */
function backTo(req, id) {
  const back = clean(req.body && req.body.back);
  if (back === 'reservation') return `/admin/reservations/${id}`;
  const q = clean(req.body && req.body.q);
  return `/admin/operations${q ? `?q=${encodeURIComponent(q)}` : ''}`;
}

router.get('/', (req, res) => {
  const q = clean(req.query.q);
  res.view('admin/operations', {
    title: 'Check-in / Check-out',
    nav: 'operations',
    q,
    results: q ? sessions.search(q) : [],
    parked: sessions.activeSessions(),
    arrivals: sessions.expectedArrivals(),
    now: time.nowLocal(),
    settingsEarly: settingsService.getAll().checkin_early_minutes,
  });
});

router.post('/:id/check-in', (req, res) => {
  const id = toInt(req.params.id);
  try {
    const { reservation, lateMinutes } = sessions.checkIn(id, req.user, { notes: req.body.notes });
    req.flash(
      lateMinutes > 0 ? 'warning' : 'success',
      `${reservation.plate_number} checked in to slot ${reservation.slot_code}${lateMinutes > 0 ? ` (${time.fmtDuration(lateMinutes)} late)` : ''}.`,
    );
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(backTo(req, id));
});

router.post('/:id/check-out', (req, res) => {
  const id = toInt(req.params.id);
  try {
    const out = sessions.checkOut(id, req.user);
    const r = out.reservation;
    const base = `${r.plate_number} checked out of slot ${r.slot_code} after ${time.fmtDuration(out.durationMinutes)}.`;
    req.flash(
      out.overstayMinutes > 0 ? 'warning' : 'success',
      out.overstayMinutes > 0
        ? `${base} Overstayed by ${time.fmtDuration(out.overstayMinutes)} (+${formatPeso(out.overstayFee)}). Final fee: ${formatPeso(out.finalFee)}.`
        : `${base} Final fee: ${formatPeso(out.finalFee)}.`,
    );
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(backTo(req, id));
});

router.post('/:id/no-show', (req, res) => {
  const id = toInt(req.params.id);
  try {
    const r = reservations.markNoShow(id, req.user);
    req.flash('warning', `${r.booking_ref} was marked as a no-show. Fee assessed: ${formatPeso(r.fee_final_centavos)}.`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(backTo(req, id));
});

module.exports = router;
