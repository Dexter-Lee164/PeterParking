'use strict';

/**
 * Server side of the e-mail rules.
 *
 *   rules                     the SAME file the browser loads (public/js/email-rules.js). Format, typo guard and messages.
 *   createDomainChecker()     "can this domain receive mail?" via DNS, with a 3 s limit and a 10 minute cache.
 *   deliverabilityProblem()   the message to show when a syntactically valid address cannot receive mail, else null.
 *
 * DNS policy (server only):
 *   reject    the domain does not exist, has no mail route (no MX and no A/AAAA), or publishes a "null MX" (RFC 7505)
 *   allow     anything else, INCLUDING timeouts and resolver errors. A flaky network must never lock people out;
 *             the verification code e-mailed in the next step is the final check.
 *
 * A "does not exist" answer is only believed when the resolver demonstrably works: before rejecting, a control lookup
 * of a domain that certainly has mail (gmail.com) must succeed. A firewalled or captive network that answers
 * "not found" to everything would otherwise reject every sign-up (this very sandbox does exactly that).
 */

const dns = require('dns');
const rules = require('../../public/js/email-rules');
const config = require('../config');

const DEFINITIVE = new Set(['ENOTFOUND', 'ENODATA']); // "no such name" / "name exists, no records of this type"

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param resolver  object with resolveMx / resolve4 / resolve6 returning promises (default: dns.promises.Resolver)
 * @returns { check(domain) -> 'ok' | 'none' | 'unknown', clear() }
 */
function createDomainChecker({ resolver, timeoutMs = 3000, ttlMs = 10 * 60 * 1000, unknownTtlMs = 60 * 1000, maxEntries = 1000, now = () => Date.now(), controlDomain = 'gmail.com' } = {}) {
  const dnsResolver = resolver || new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 });
  const cache = new Map(); // domain -> { status, expires }
  const inflight = new Map(); // domain -> Promise
  let control = null; // { ok, expires, pending } — does the resolver answer a question whose answer we know?

  async function resolverWorks() {
    if (!controlDomain) return true;
    if (control && control.expires > now()) return control.ok;
    if (control && control.pending) return control.pending;
    const pending = dnsResolver
      .resolveMx(controlDomain)
      .then((mx) => Array.isArray(mx) && mx.length > 0, () => false)
      .then((ok) => {
        control = { ok, expires: now() + (ok ? ttlMs : unknownTtlMs) };
        return ok;
      });
    control = { ok: false, expires: 0, pending };
    return pending;
  }

  async function lookup(domain) {
    const status = await rawLookup(domain);
    if (status !== 'none') return status;
    return (await resolverWorks()) ? 'none' : 'unknown';
  }

  async function rawLookup(domain) {
    let mx = null;
    try {
      mx = await dnsResolver.resolveMx(domain);
    } catch (err) {
      if (!DEFINITIVE.has(err && err.code)) return 'unknown';
    }
    if (Array.isArray(mx) && mx.length) {
      const real = mx.filter((r) => r && r.exchange && r.exchange !== '.');
      return real.length ? 'ok' : 'none'; // only a null MX: the domain says it receives no mail
    }
    // No MX records: mail falls back to the domain's own address (RFC 5321 "implicit MX").
    const answers = await Promise.allSettled([dnsResolver.resolve4(domain), dnsResolver.resolve6(domain)]);
    if (answers.some((a) => a.status === 'fulfilled' && Array.isArray(a.value) && a.value.length)) return 'ok';
    if (answers.some((a) => a.status === 'rejected' && !DEFINITIVE.has(a.reason && a.reason.code))) return 'unknown';
    return 'none';
  }

  async function check(domain) {
    const key = String(domain || '').toLowerCase();
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return hit.status;
    if (inflight.has(key)) return inflight.get(key);

    const run = withTimeout(lookup(key), timeoutMs)
      .catch(() => 'unknown')
      .then((status) => {
        if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
        cache.set(key, { status, expires: now() + (status === 'unknown' ? unknownTtlMs : ttlMs) });
        return status;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
  }

  return { check, clear: () => cache.clear() };
}

let checker = null;
const getChecker = () => checker || (checker = createDomainChecker());

/** Tests: swap the checker (an object with async check(domain)), or pass null to restore the real one. */
function setDomainChecker(replacement) {
  checker = replacement;
}

/**
 * The message to show when `email` is well-formed but its domain cannot receive mail; null otherwise
 * (also null when the address is malformed — the format rules report that — or when DNS checking is switched off).
 */
async function deliverabilityProblem(email, { enabled = config.emailDnsCheck } = {}) {
  if (!enabled) return null;
  const result = rules.validate(email);
  if (!result.ok) return null;
  const domain = rules.domainOf(result.email);
  const status = await getChecker().check(domain);
  return status === 'none' ? rules.MESSAGES.noMailServer(domain) : null;
}

module.exports = { rules, createDomainChecker, deliverabilityProblem, setDomainChecker };
