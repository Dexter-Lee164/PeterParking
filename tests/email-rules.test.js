'use strict';

/**
 * E-mail address rules: the shared validator (the file the browser also loads), the provider-typo guard and its
 * "Did you mean ...?" suggestion, and the server-only DNS deliverability check (with a fake resolver — no network).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers'); // sets NODE_ENV=test before the config is loaded
const rules = require('../public/js/email-rules');
const { createDomainChecker, deliverabilityProblem, setDomainChecker } = require('../src/utils/email');

const bad = (value) => rules.validate(value);

describe('email rules: the acceptance examples', () => {
  test('hehe!@gmail.com.com is rejected as a typo and suggests hehe@gmail.com', () => {
    const r = bad('hehe!@gmail.com.com');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'typo');
    assert.match(r.message, /gmail\.com\.com/);
    assert.equal(r.suggestion, 'hehe@gmail.com');
  });

  test('gmail.com.com and gmial.com (no @) are rejected with a helpful message', () => {
    for (const value of ['gmail.com.com', 'gmial.com']) {
      const r = bad(value);
      assert.equal(r.ok, false, value);
      assert.match(r.message, /Enter a valid email address, like name@example\.com/);
    }
  });

  test('a..b@gmail.com is rejected for the doubled dot', () => {
    const r = bad('a..b@gmail.com');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'local-dots');
  });

  test('my_name@gmail.com is rejected: Gmail has no underscores', () => {
    const r = bad('my_name@gmail.com');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'gmail-chars');
    assert.match(r.message, /Gmail/);
  });

  test('user@@x.com is rejected: exactly one @', () => {
    const r = bad('user@@x.com');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'at');
  });

  test('mixed-case addresses are accepted and normalised to lower case', () => {
    const r = bad('  Hehe.Name@GMAIL.com ');
    assert.deepEqual(r, { ok: true, email: 'hehe.name@gmail.com' });
    assert.equal(bad('First.Last+Tag@Example.CO.UK').email, 'first.last+tag@example.co.uk');
  });
});

describe('email rules: format', () => {
  test('length limits: 254 in total, 64 before the @', () => {
    const local64 = 'a'.repeat(64);
    assert.equal(bad(`${local64}@example.com`).ok, true);
    assert.equal(bad(`${local64}a@example.com`).code, 'local-length');
    const long = `${'a'.repeat(60)}@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(30)}.com`;
    assert.ok(long.length > 254);
    assert.equal(bad(long).code, 'length');
  });

  test('local part: only letters, digits and . _ + -, no leading, trailing or doubled dots', () => {
    for (const ok of ['a@example.com', 'a.b@example.com', 'a_b@example.com', 'a+b@example.com', 'a-b@example.com', '1@example.com']) {
      assert.equal(bad(ok).ok, true, ok);
    }
    assert.equal(bad('a b@example.com').ok, false);
    assert.equal(bad('a!b@example.com').code, 'local-chars');
    assert.equal(bad('é@example.com').code, 'local-chars');
    assert.equal(bad('.a@example.com').code, 'local-dots');
    assert.equal(bad('a.@example.com').code, 'local-dots');
    assert.equal(bad('a..b@example.com').code, 'local-dots');
  });

  test('domain: valid labels, a dot, and an alphabetic TLD (or xn--)', () => {
    for (const value of ['x@localhost', 'x@example', 'x@example.c', 'x@example.123', 'x@-example.com', 'x@example-.com', 'x@exa_mple.com', 'x@example..com', 'x@.example.com', 'x@example.com.']) {
      assert.equal(bad(value).ok, false, value);
      assert.equal(bad(value).code, 'domain', value);
    }
    assert.equal(bad('x@sub.example.org').ok, true);
    assert.equal(bad('x@example.xn--p1ai').ok, true);
  });

  test('empty, whitespace and a missing local part or domain are rejected', () => {
    for (const value of ['', '   ', null, undefined, '@example.com', 'name@', 'name @example.com']) {
      assert.equal(bad(value).ok, false, String(value));
    }
  });
});

describe('email rules: Gmail', () => {
  test('letters, digits and periods only; an optional +tag; no minimum length', () => {
    assert.equal(bad('a@gmail.com').ok, true);
    assert.equal(bad('john.smith.99@gmail.com').ok, true);
    assert.equal(bad('john+parking@gmail.com').ok, true);
    assert.equal(bad('john@googlemail.com').ok, true);
    assert.equal(bad('john-smith@gmail.com').code, 'gmail-chars');
    assert.equal(bad('john_smith@gmail.com').code, 'gmail-chars');
    assert.equal(bad('+tag@gmail.com').code, 'gmail-chars');
    assert.equal(bad('john_smith@googlemail.com').code, 'gmail-chars');
    // the same characters are fine at other providers
    assert.equal(bad('john_smith@example.com').ok, true);
  });

  test('at most 30 characters before the tag (periods are not counted); the tag itself is free', () => {
    assert.equal(bad(`${'a'.repeat(30)}@gmail.com`).ok, true);
    assert.equal(bad(`${'a'.repeat(31)}@gmail.com`).code, 'gmail-length');
    assert.equal(bad(`${'a.'.repeat(30)}a@gmail.com`).code, 'gmail-length', '31 letters with periods in between');
    assert.equal(bad(`${'a.'.repeat(29)}a@gmail.com`).ok, true, '30 letters with periods in between');
    assert.equal(bad(`${'a'.repeat(30)}+${'t'.repeat(20)}@gmail.com`).ok, true);
  });
});

describe('email rules: provider typo guard', () => {
  test('misspelled providers are rejected, with a corrected suggestion', () => {
    const cases = {
      'hehe@gmail.con': 'hehe@gmail.com',
      'hehe@gmial.com': 'hehe@gmail.com',
      'hehe@gmaill.com': 'hehe@gmail.com',
      'hehe@gmail.comm': 'hehe@gmail.com',
      'hehe@gmail.com.com': 'hehe@gmail.com',
      'hehe@hotmial.com': 'hehe@hotmail.com',
      'hehe@outlok.com': 'hehe@outlook.com',
      'hehe@yaho.com': 'hehe@yahoo.com',
      'hehe@icloud.con': 'hehe@icloud.com',
      'hehe@live.com.com': 'hehe@live.com',
    };
    for (const [value, fix] of Object.entries(cases)) {
      const r = bad(value);
      assert.equal(r.ok, false, value);
      assert.equal(r.code, 'typo', value);
      assert.equal(r.suggestion, fix, value);
    }
  });

  test('the suggestion is itself a valid address (invalid characters are dropped)', () => {
    assert.equal(rules.suggest('he_he!@gmail.com.com'), 'hehe@gmail.com'); // Gmail has no underscore
    assert.equal(rules.validate(rules.suggest('he_he!@gmail.com.com')).ok, true);
    assert.equal(rules.suggest('he_he@yahoo.con'), 'he_he@yahoo.com'); // other providers keep it
    assert.equal(rules.suggest('!!!@gmail.con'), null, 'nothing usable is left, so no suggestion');
    assert.equal(rules.suggest('hehe@example.com'), null);
    assert.equal(rules.suggest('nonsense'), null);
  });

  test('real providers and look-alikes are NOT flagged', () => {
    const fine = [
      'x@gmail.com', 'x@googlemail.com', 'x@yahoo.com', 'x@outlook.com', 'x@hotmail.com', 'x@icloud.com', 'x@live.com',
      'x@yahoo.com.ph', 'x@yahoo.co.uk', 'x@hotmail.co.uk', 'x@outlook.com.au', 'x@live.co.uk',
      'x@mail.com', 'x@email.com', 'x@love.com', 'x@life.com', 'x@gmx.com', 'x@proton.me', 'x@up.edu.ph', 'x@students.example.edu',
    ];
    for (const value of fine) assert.equal(bad(value).ok, true, value);
  });

  test('a provider name inside a longer domain is left alone', () => {
    assert.equal(bad('x@mygmail.com').ok, true);
    assert.equal(bad('x@gmail-support.com').ok, true);
    assert.equal(bad('x@gmail.example.org').ok, true, 'a subdomain of another site is not "gmail.com plus extra"');
  });
});

describe('email DNS check (fake resolver, no network)', () => {
  const notFound = () => Object.assign(new Error('queryMx ENOTFOUND'), { code: 'ENOTFOUND' });
  const noData = () => Object.assign(new Error('queryA ENODATA'), { code: 'ENODATA' });
  const servfail = () => Object.assign(new Error('queryMx ESERVFAIL'), { code: 'ESERVFAIL' });

  // `calls` counts lookups of the domain under test. The control domain (gmail.com) always answers like a healthy
  // resolver unless a test says otherwise, and is counted separately in `calls.control`.
  function fake(overrides = {}, { controlWorks = true } = {}) {
    const calls = { mx: 0, a: 0, aaaa: 0, control: 0 };
    const healthy = [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }];
    const resolver = {
      resolveMx: async (domain) => {
        if (domain === 'gmail.com') {
          calls.control += 1;
          if (!controlWorks) throw notFound();
          return healthy;
        }
        calls.mx += 1;
        return overrides.resolveMx ? overrides.resolveMx(domain) : [{ exchange: 'mx.example.com', priority: 10 }];
      },
      resolve4: async (domain) => { calls.a += 1; if (overrides.resolve4) return overrides.resolve4(domain); throw noData(); },
      resolve6: async (domain) => { calls.aaaa += 1; if (overrides.resolve6) return overrides.resolve6(domain); throw noData(); },
    };
    return { resolver, calls };
  }

  test('a domain with MX records is ok; the answer is cached', async () => {
    const { resolver, calls } = fake();
    const checker = createDomainChecker({ resolver });
    assert.equal(await checker.check('example.com'), 'ok');
    assert.equal(await checker.check('EXAMPLE.com'), 'ok');
    assert.equal(calls.mx, 1);
  });

  test('a domain that does not exist has no mail route', async () => {
    const { resolver } = fake({ resolveMx: () => { throw notFound(); }, resolve4: () => { throw notFound(); }, resolve6: () => { throw notFound(); } });
    assert.equal(await createDomainChecker({ resolver }).check('nope.invalid'), 'none');
  });

  test('no MX but an A or AAAA record: mail goes to the domain itself (implicit MX), so ok', async () => {
    const onlyA = fake({ resolveMx: () => { throw noData(); }, resolve4: () => ['203.0.113.7'] });
    assert.equal(await createDomainChecker({ resolver: onlyA.resolver }).check('a-only.example'), 'ok');
    const only6 = fake({ resolveMx: () => [], resolve4: () => { throw noData(); }, resolve6: () => ['2001:db8::1'] });
    assert.equal(await createDomainChecker({ resolver: only6.resolver }).check('v6-only.example'), 'ok');
  });

  test('no MX, no A, no AAAA: none', async () => {
    const { resolver } = fake({ resolveMx: () => { throw noData(); } });
    assert.equal(await createDomainChecker({ resolver }).check('empty.example'), 'none');
  });

  test('a null MX (RFC 7505) means the domain accepts no mail', async () => {
    const { resolver, calls } = fake({ resolveMx: () => [{ exchange: '.', priority: 0 }] });
    assert.equal(await createDomainChecker({ resolver }).check('nomail.example'), 'none');
    assert.equal(calls.a, 0, 'a null MX is final: the A record fallback must not rescue it');
  });

  test('resolver errors are "unknown", never "none" (a flaky network must not lock anyone out)', async () => {
    const mxFail = fake({ resolveMx: () => { throw servfail(); } });
    assert.equal(await createDomainChecker({ resolver: mxFail.resolver }).check('x.example'), 'unknown');
    const aFail = fake({ resolveMx: () => { throw noData(); }, resolve4: () => { throw servfail(); } });
    assert.equal(await createDomainChecker({ resolver: aFail.resolver }).check('y.example'), 'unknown');
  });

  test('"does not exist" is only believed when a control lookup proves the resolver works (firewalled/captive networks)', async () => {
    const gone = { resolveMx: () => { throw notFound(); }, resolve4: () => { throw notFound(); }, resolve6: () => { throw notFound(); } };

    // a resolver that answers "not found" to EVERYTHING, gmail.com included (this is what the offline sandbox does)
    const broken = fake(gone, { controlWorks: false });
    const checker = createDomainChecker({ resolver: broken.resolver });
    assert.equal(await checker.check('anything.example'), 'unknown');
    assert.equal(await checker.check('gmail.com'), 'unknown', 'even a real provider is never rejected on a broken resolver');
    assert.equal(broken.calls.control >= 1, true);
    // through the real entry point, but on the broken resolver (no live DNS, so the result is the same online or off)
    setDomainChecker(createDomainChecker({ resolver: fake(gone, { controlWorks: false }).resolver }));
    try {
      assert.equal(await deliverabilityProblem('someone@anything.example', { enabled: true }), null);
    } finally {
      setDomainChecker(null);
    }

    // a healthy resolver: the verdict stands, and the control answer is reused for other domains
    const healthy = fake(gone);
    const c2 = createDomainChecker({ resolver: healthy.resolver });
    assert.equal(await c2.check('ghost-one.example'), 'none');
    assert.equal(await c2.check('ghost-two.example'), 'none');
    assert.equal(healthy.calls.control, 1, 'one control lookup serves both');
  });

  test('a null MX is also double-checked against the control, and the control can be switched off', async () => {
    const nullMx = { resolveMx: () => [{ exchange: '.', priority: 0 }] };
    assert.equal(await createDomainChecker({ resolver: fake(nullMx, { controlWorks: false }).resolver }).check('nomail.example'), 'unknown');
    const off = fake({ resolveMx: () => { throw notFound(); }, resolve4: () => { throw notFound(); }, resolve6: () => { throw notFound(); } }, { controlWorks: false });
    assert.equal(await createDomainChecker({ resolver: off.resolver, controlDomain: null }).check('ghost.example'), 'none');
    assert.equal(off.calls.control, 0);
  });

  test('a lookup that takes longer than the limit is "unknown"', async () => {
    const { resolver } = fake({ resolveMx: () => new Promise(() => {}) });
    const started = Date.now();
    assert.equal(await createDomainChecker({ resolver, timeoutMs: 40 }).check('slow.example'), 'unknown');
    assert.ok(Date.now() - started < 1000);
  });

  test('answers expire after 10 minutes; unknown answers are retried after a minute', async () => {
    let clock = 0;
    const good = fake();
    const checker = createDomainChecker({ resolver: good.resolver, now: () => clock });
    await checker.check('example.com');
    clock = 9 * 60 * 1000;
    await checker.check('example.com');
    assert.equal(good.calls.mx, 1, 'still cached at 9 minutes');
    clock = 10 * 60 * 1000 + 1;
    await checker.check('example.com');
    assert.equal(good.calls.mx, 2, 'looked up again after 10 minutes');

    let clock2 = 0;
    const flaky = fake({ resolveMx: () => { throw servfail(); } });
    const c2 = createDomainChecker({ resolver: flaky.resolver, now: () => clock2 });
    await c2.check('flaky.example');
    clock2 = 30 * 1000;
    await c2.check('flaky.example');
    assert.equal(flaky.calls.mx, 1);
    clock2 = 61 * 1000;
    await c2.check('flaky.example');
    assert.equal(flaky.calls.mx, 2);
  });

  test('simultaneous checks of one domain share a single lookup', async () => {
    const { resolver, calls } = fake({ resolveMx: () => new Promise((resolve) => setTimeout(() => resolve([{ exchange: 'mx.example.com', priority: 1 }]), 20)) });
    const checker = createDomainChecker({ resolver });
    const results = await Promise.all([checker.check('same.example'), checker.check('same.example'), checker.check('same.example')]);
    assert.deepEqual(results, ['ok', 'ok', 'ok']);
    assert.equal(calls.mx, 1);
  });

  test('deliverabilityProblem: message only for "none"; off switch, bad format and "unknown" all pass', async () => {
    const asked = [];
    const stub = (answer) => ({ check: async (domain) => { asked.push(domain); return answer; } });
    try {
      setDomainChecker(stub('none'));
      const message = await deliverabilityProblem('Someone@No-Such-Domain.example', { enabled: true });
      assert.match(message, /could not find a mail server for "no-such-domain\.example"/);
      assert.deepEqual(asked, ['no-such-domain.example']);

      assert.equal(await deliverabilityProblem('someone@no-such-domain.example', { enabled: false }), null);
      assert.equal(await deliverabilityProblem('not an address', { enabled: true }), null, 'the format rules report that, not DNS');
      assert.equal(asked.length, 1, 'no lookups for the last two');

      setDomainChecker(stub('unknown'));
      assert.equal(await deliverabilityProblem('someone@slow.example', { enabled: true }), null);
      setDomainChecker(stub('ok'));
      assert.equal(await deliverabilityProblem('someone@fine.example', { enabled: true }), null);
    } finally {
      setDomainChecker(null);
    }
  });
});
