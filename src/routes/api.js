'use strict';
const express = require('express');
const { searchAvailability } = require('../services/search');

const router = express.Router();
/** JSON availability for the requested window (same data that drives the map and list). */
router.get('/availability', (req, res) => {
  const d = searchAvailability(req.query);
  res.status(d.valid ? 200 : 422).json({
    valid: d.valid, errors: d.errors, form: d.form,
    range: d.valid ? { startAt: d.range.startAt, endAt: d.range.endAt, minutes: d.range.minutes, hours: d.range.hours } : null,
    zones: d.zones.map((z) => ({ id: z.id, name: z.name, total: z.total, available: z.available,
      slots: z.slots.map((s) => ({ id: s.id, code: s.code, type: s.slot_type, state: s.state, rateCentavos: s.rate })) })),
  });
});
module.exports = router;
