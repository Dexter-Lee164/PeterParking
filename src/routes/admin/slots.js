'use strict';

const express = require('express');
const parking = require('../../services/parking');
const { AppError } = require('../../utils/errors');
const { toInt, clean } = require('../../utils/validate');

/**
 * Parking Slots for administrators. The campus layout is fixed (zones, slot codes, types and positions come from
 * src/db/lotPlans.js and are drawn by src/utils/lotLayout.js): nothing here creates, deletes, moves or re-types a zone
 * or slot. Administrators manage how existing slots operate: status (active / maintenance / inactive), notes and an
 * hourly rate override.
 */
const router = express.Router();

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'inactive', label: 'Inactive' },
];

// ------------------------------------------------------------------ overview

router.get('/', (req, res) => {
  const zones = parking.listZones();
  // There is no all-zones view: an unknown or missing zone falls back to the first one.
  const requested = toInt(req.query.zone);
  const zoneId = zones.some((z) => z.id === requested) ? requested : (zones[0] && zones[0].id) || null;
  const status = clean(req.query.status);
  const slotType = clean(req.query.type);
  const q = clean(req.query.q);
  const slots = parking.listSlots({ zoneId, status, slotType, q });
  const counts = {
    total: slots.length,
    available: slots.filter((s) => s.live_state === 'available').length,
    reserved: slots.filter((s) => s.live_state === 'reserved').length,
    occupied: slots.filter((s) => s.live_state === 'occupied').length,
    unavailable: slots.filter((s) => s.live_state === 'unavailable').length,
  };
  // The selected zone's fixed lot drawing with every slot's state right now (read-only; a stall opens its slot).
  // The page is the map only: slots that do not match the search / status / type filters are set back on it.
  const zone = zoneId ? zones.find((z) => z.id === zoneId) : null;
  const filtering = !!(status || slotType || q);
  const matching = new Set(slots.map((s) => s.id));
  const mapSlots = zone
    ? parking.listSlots({ zoneId }).map((s) => ({
      id: s.id, code: s.slot_code, zone_name: s.zone_name, slot_type: s.slot_type, type_vehicle: s.type_vehicle, type_label: s.type_label,
      type_icon: s.type_icon, operational_status: s.status, hourly_rate_centavos: s.hourly_rate_centavos, est_fee_centavos: 0,
      state: s.live_state, reason: s.status !== 'active' ? `Status: ${s.status}` : `Right now: ${s.live_state}`,
      notes: s.notes || '', filtered_out: filtering && !matching.has(s.id),
    }))
    : [];
  // Zone tab counts follow the filters: every zone's slots in brief, so the page can recount as the filters change.
  const zoneSlots = {};
  for (const s of parking.listSlots()) {
    (zoneSlots[s.zone_id] = zoneSlots[s.zone_id] || []).push([s.slot_code, s.notes || '', s.slot_type, s.status]);
  }
  const zoneMatches = {};
  for (const s of filtering ? parking.listSlots({ status, slotType, q }) : []) zoneMatches[s.zone_id] = (zoneMatches[s.zone_id] || 0) + 1;
  for (const z of zones) z.shown_count = filtering ? zoneMatches[z.id] || 0 : z.slot_count;
  res.view('admin/slots', {
    title: 'Parking Slots',
    nav: 'slots',
    zones,
    zone,
    zoneSlots,
    mapSlots,
    slots,
    counts,
    filtering,
    extraScripts: zone ? ['/js/admin-slot-map.js'] : [],
    slotTypes: parking.listSlotTypes(),
    filters: { zone: zoneId || '', status, type: slotType, q },
    baseQuery: { zone: zoneId || '', status, type: slotType, q },
    statusOptions: STATUS_OPTIONS,
  });
});

// --------------------------------------------------------------------- slots

function slotPage(slot, extra) {
  return Object.assign({
    title: `Slot ${slot.slot_code}`, nav: 'slots', slot, blockers: parking.slotBlockers(slot.id), statusOptions: STATUS_OPTIONS, formError: null, errors: {},
    breadcrumbs: [{ label: 'Parking Slots', href: `/admin/slots?zone=${slot.zone_id}` }, { label: slot.slot_code }],
  }, extra);
}

router.get('/:id/edit', (req, res) => {
  const slot = parking.getSlot(toInt(req.params.id));
  if (!slot || slot.retired_at) throw new AppError('Slot not found.', { status: 404 });
  const values = Object.assign({}, slot, {
    hourly_rate_override: slot.hourly_rate_override_centavos === null ? '' : String(slot.hourly_rate_override_centavos / 100),
  });
  res.view('admin/slot-form', slotPage(slot, { values }));
});

router.post('/:id', (req, res) => {
  const id = toInt(req.params.id);
  try {
    const slot = parking.updateSlotOperations(id, req.body || {}, req.actor);
    req.flash('success', `Slot ${slot.slot_code} was updated.`);
    return res.redirect(`/admin/slots?zone=${slot.zone_id}`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    const slot = parking.getSlot(id);
    if (!slot) throw err;
    return res.status(err.fields ? 422 : 409).view('admin/slot-form', slotPage(slot, { values: req.body, errors: err.fields || {}, formError: err.message }));
  }
});

router.post('/:id/status', (req, res) => {
  const id = toInt(req.params.id);
  try {
    const slot = parking.setSlotStatus(id, clean(req.body.status), req.actor);
    req.flash('success', `Slot ${slot.slot_code} is now ${slot.status}.`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    req.flash('error', err.message);
  }
  const slot = parking.getSlot(id);
  return res.redirect(`/admin/slots${slot ? `?zone=${slot.zone_id}` : ''}`);
});

module.exports = router;
