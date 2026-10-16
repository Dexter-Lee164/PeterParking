'use strict';
// Single source of "now" so tests can move time without touching the system clock.
let offsetMs = 0;
module.exports = {
  now: () => new Date(Date.now() + offsetMs),
  setOffset: (ms) => { offsetMs = ms; },
  reset: () => { offsetMs = 0; },
};
