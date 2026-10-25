'use strict';

/**
 * 010 — kept as a no-op.
 *
 * This migration used to retire parking etiquette reports and plate penalties by dropping etiquette_evidence,
 * plate_penalties and etiquette_reports with their rows. The feature is back (migration 011, Etiquette Reports &
 * Penalty Management), so nothing is dropped any more: a database that has not reached 010 yet keeps its reports,
 * evidence and penalties, and 011 carries them forward. A database that already ran the old version simply gets the
 * tables created again by 011.
 *
 * The version number stays taken so the migration history keeps its order.
 */

function up() {}

module.exports = { up };
