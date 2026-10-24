/* University Parking — the ONE set of full-name rules.
 *
 * The browser loads this file (window.NameRules) for instant feedback; Node require()s the very same file
 * (src/services/users.js) and stays the authority. Sign-up, the driver's profile and the administrator's driver form
 * all use it, so the rules and messages cannot drift.
 *
 *   - leading / trailing spaces are trimmed and runs of spaces collapse to one
 *   - letters from any alphabet (accents and other combining marks included), spaces and hyphens only
 *   - no digits, no other symbols (@ # $ % ! . ' ...)
 *   - a hyphen joins two parts of a name (Mary-Ann), so it cannot start, end or be doubled
 *   - 2 to 80 characters
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NameRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX = 80;

  var MESSAGES = {
    empty: 'Enter your full name.',
    short: 'Enter your full name.',
    long: 'Full name is too long (80 characters at most).',
    digits: 'Full name cannot contain numbers.',
    chars: 'Full name can only contain letters, spaces and hyphens (-).',
    hyphen: 'A hyphen must join two parts of a name, as in Mary-Ann.',
  };

  var LETTER = /\p{L}/u;
  var ALLOWED = /^[\p{L}\p{M} -]+$/u;
  var SHAPE = /^\p{L}[\p{L}\p{M}]*(?:(?: |-)\p{L}[\p{L}\p{M}]*)*$/u;

  function normalize(value) {
    return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  /** { ok, name (normalised), message } */
  function validate(value) {
    var name = normalize(value);
    var message = '';
    if (!name) message = MESSAGES.empty;
    else if (/\p{N}/u.test(name)) message = MESSAGES.digits;
    else if (!ALLOWED.test(name)) message = MESSAGES.chars;
    else if (!SHAPE.test(name)) message = MESSAGES.hyphen;
    else if (name.replace(/[^\p{L}]/gu, '').length < 2 || !LETTER.test(name)) message = MESSAGES.short;
    else if (name.length > MAX) message = MESSAGES.long;
    return { ok: !message, name: name, message: message };
  }

  return { validate: validate, normalize: normalize, MESSAGES: MESSAGES, MAX: MAX };
});
