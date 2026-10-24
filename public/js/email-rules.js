/* University Parking — the ONE set of e-mail address rules.
 *
 * The browser loads this file (window.EmailRules) for instant feedback on blur; Node require()s the very same file
 * (src/utils/email.js) and stays the authority. Because both run identical code, the rules and the messages cannot drift.
 * No dependencies, no DOM, no network: the DNS check lives only on the server.
 *
 * Layers, in the order they are applied:
 *   1. normalise     trim + lower-case; at most 254 characters; exactly one "@"
 *   2. domain        valid labels, at least one dot, alphabetic TLD of 2+ letters (or xn-- punycode)
 *   3. typo guard    well-known providers (gmail.com, yahoo.com, ...): "gmail.com.com", "gmial.com", "gmail.con"
 *                    are rejected with a "Did you mean ...?" fix, unless the domain is a known real variant
 *   4. local part    letters, digits and . _ + -  only (stricter than the RFC on purpose); at most 64 characters;
 *                    no leading, trailing or consecutive dots
 *   5. Gmail         gmail.com / googlemail.com: letters, digits and periods (+ an optional +tag), at most 30 characters
 *                    before the tag; no _ or -. No minimum length is enforced.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmailRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = { email: 254, local: 64, domain: 253, gmailBase: 30 };

  var MESSAGES = {
    invalid: 'Enter a valid email address.',
    noAt: 'Enter a valid email address, like name@example.com.',
    atSign: 'An email address has exactly one @, like name@example.com.',
    tooLong: 'That email address is too long (254 characters at most).',
    localLong: 'The part before the @ is too long (64 characters at most).',
    localChars: 'Before the @ use only the letters a-z, numbers and . _ + - (no spaces, accents or other symbols).',
    localDots: "Before the @, a dot can't be first, last or doubled.",
    gmailChars: 'Gmail addresses use only letters, numbers and periods (an optional +tag may follow).',
    gmailLong: 'Gmail addresses have at most 30 characters before any +tag.',
    domain: 'The part after the @ is not a valid domain, for example gmail.com.',
    typo: function (domain) {
      return 'Check the part after the @: "' + domain + '" looks mistyped.';
    },
    // Used by the server after a DNS lookup (the browser never does one).
    noMailServer: function (domain) {
      return 'We could not find a mail server for "' + domain + '". Check the spelling after the @.';
    },
    taken: 'That email is already registered.',
  };

  // Providers whose typos are worth catching. live.com is checked for "extra characters" only: its name is so short
  // that fuzzy matching would reject real domains (love.com, life.com, ...).
  var PROVIDERS = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'live.com'];

  // Real regional variants that look like "a provider plus extra characters". Extend as needed.
  var ALLOWED_DOMAINS = [
    'yahoo.com.ph', 'yahoo.com.sg', 'yahoo.com.au', 'yahoo.com.br', 'yahoo.com.mx', 'yahoo.com.ar', 'yahoo.com.hk',
    'yahoo.com.tw', 'yahoo.com.vn', 'yahoo.com.my', 'yahoo.co.uk', 'yahoo.co.jp', 'yahoo.co.in', 'yahoo.co.id',
    'yahoo.co.nz', 'yahoo.co.za', 'yahoo.co.kr', 'yahoo.co.th', 'yahoo.ca',
    'hotmail.co.uk', 'hotmail.co.jp', 'hotmail.co.th', 'hotmail.com.au', 'hotmail.com.ar', 'hotmail.com.br',
    'hotmail.com.tr', 'hotmail.com.mx',
    'live.co.uk', 'live.com.au', 'live.com.mx', 'live.com.ar', 'live.com.pt',
    'outlook.com.br', 'outlook.com.au', 'outlook.com.ar', 'outlook.com.tr', 'outlook.co.th', 'outlook.co.id',
    'icloud.com.cn',
  ];
  var ALLOWED = {};
  ALLOWED_DOMAINS.forEach(function (d) {
    ALLOWED[d] = true;
  });
  PROVIDERS.forEach(function (d) {
    ALLOWED[d] = true;
  });

  function normalize(value) {
    return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  }

  /** Edit distance where swapping two neighbouring letters counts as ONE edit ("gmial" -> "gmail"). */
  function distance(a, b) {
    var i, j, cost;
    var d = [];
    for (i = 0; i <= a.length; i += 1) {
      d[i] = [i];
    }
    for (j = 1; j <= b.length; j += 1) {
      d[0][j] = j;
    }
    for (i = 1; i <= a.length; i += 1) {
      for (j = 1; j <= b.length; j += 1) {
        cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[a.length][b.length];
  }

  function isGmail(domain) {
    return domain === 'gmail.com' || domain === 'googlemail.com';
  }

  /** Message when `domain` is not a syntactically valid domain, otherwise ''. */
  function domainProblem(domain) {
    if (!domain || domain.length > LIMITS.domain) return MESSAGES.domain;
    var labels = domain.split('.');
    if (labels.length < 2) return MESSAGES.domain;
    for (var i = 0; i < labels.length; i += 1) {
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(labels[i])) return MESSAGES.domain;
    }
    var tld = labels[labels.length - 1];
    if (!/^[a-z]{2,}$/.test(tld) && !/^xn--[a-z0-9-]{2,59}$/.test(tld)) return MESSAGES.domain;
    return '';
  }

  /**
   * If `domain` is a well-known provider with a slip in it, return that provider, otherwise null.
   *   - provider + extra characters:  gmail.com.com, gmail.comm, hotmail.com.xx   (unless a known real variant)
   *   - one slip in the name and/or the ".com" (two edits at most overall), same first letter:
   *     gmial.com, gmail.con, gmaill.com, hotmial.com, outlok.com, yahho.com.con ...
   * Real look-alikes such as mail.com or email.com differ in the first letter and are left alone.
   */
  function typoTarget(domain) {
    if (ALLOWED[domain]) return null;
    var i, p;
    for (i = 0; i < PROVIDERS.length; i += 1) {
      p = PROVIDERS[i];
      if (domain.indexOf(p) === 0) {
        var rest = domain.slice(p.length);
        if (rest.charAt(0) === '.' || rest.length <= 3) return p;
      }
    }
    var parts = domain.split('.');
    if (parts.length !== 2) return null;
    for (i = 0; i < PROVIDERS.length; i += 1) {
      p = PROVIDERS[i];
      var name = p.split('.')[0];
      if (name.length < 5 || parts[0].charAt(0) !== name.charAt(0)) continue;
      var dName = distance(parts[0], name);
      var dTld = distance(parts[1], 'com');
      var maxName = name.length >= 7 ? 2 : 1;
      if (dName <= maxName && dTld <= 1 && dName + dTld >= 1 && dName + dTld <= 2) return p;
    }
    return null;
  }

  function split(email) {
    var at = email.indexOf('@');
    if (at < 1 || at !== email.lastIndexOf('@') || at === email.length - 1) return null;
    return { local: email.slice(0, at), domain: email.slice(at + 1) };
  }

  /** Keep only what an address may contain, so a suggestion is itself valid ("hehe!" -> "hehe"). */
  function sanitizeLocal(local, gmail) {
    var s = String(local).toLowerCase().replace(gmail ? /[^a-z0-9.+]/g : /[^a-z0-9._+-]/g, '');
    s = s.replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '');
    return s.slice(0, LIMITS.local);
  }

  /** A corrected address for a mistyped provider domain ("hehe@gmail.com"), or null. */
  function suggest(value) {
    var email = normalize(value);
    var parts = split(email);
    if (!parts || domainProblem(parts.domain)) return null;
    var target = typoTarget(parts.domain);
    if (!target) return null;
    var local = sanitizeLocal(parts.local, isGmail(target));
    if (!local) return null;
    var candidate = local + '@' + target;
    return validate(candidate).ok ? candidate : null;
  }

  /**
   * Check an address. Always returns an object:
   *   { ok: true,  email }                                    email is the normalised (lower-case) form to store
   *   { ok: false, email, code, message, suggestion }         suggestion is a corrected address or null
   * `code` is one of: invalid, at, length, domain, typo, local-length, local-chars, local-dots, gmail-chars, gmail-length
   */
  function validate(value) {
    var email = normalize(value);
    function fail(code, message, suggestion) {
      return { ok: false, email: email, code: code, message: message, suggestion: suggestion || null };
    }

    if (!email || /\s/.test(email)) return fail('invalid', MESSAGES.invalid);
    if (email.indexOf('@') === -1) return fail('invalid', MESSAGES.noAt);
    if (email.indexOf('@') !== email.lastIndexOf('@')) return fail('at', MESSAGES.atSign);
    if (email.length > LIMITS.email) return fail('length', MESSAGES.tooLong);
    var parts = split(email);
    if (!parts) return fail('invalid', MESSAGES.invalid);
    var local = parts.local;
    var domain = parts.domain;

    var dProblem = domainProblem(domain);
    if (dProblem) return fail('domain', dProblem);

    if (typoTarget(domain)) return fail('typo', MESSAGES.typo(domain), suggest(email));

    if (local.length > LIMITS.local) return fail('local-length', MESSAGES.localLong);
    if (!/^[a-z0-9._+-]+$/.test(local)) return fail('local-chars', MESSAGES.localChars);
    if (local.charAt(0) === '.' || local.charAt(local.length - 1) === '.' || local.indexOf('..') !== -1) {
      return fail('local-dots', MESSAGES.localDots);
    }

    if (isGmail(domain)) {
      var base = local.split('+')[0];
      if (!base || /[^a-z0-9.]/.test(base)) return fail('gmail-chars', MESSAGES.gmailChars);
      // Gmail ignores periods, so they do not count towards the 30 characters.
      if (base.replace(/\./g, '').length > LIMITS.gmailBase) return fail('gmail-length', MESSAGES.gmailLong);
    }

    return { ok: true, email: email };
  }

  function domainOf(email) {
    var parts = split(normalize(email));
    return parts ? parts.domain : '';
  }

  return {
    validate: validate,
    suggest: suggest,
    normalize: normalize,
    domainOf: domainOf,
    isGmail: isGmail,
    MESSAGES: MESSAGES,
    LIMITS: LIMITS,
    PROVIDERS: PROVIDERS,
    ALLOWED_DOMAINS: ALLOWED_DOMAINS,
  };
});
