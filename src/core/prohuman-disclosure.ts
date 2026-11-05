/**
 * Disclosure: who this session is, what it is allowed to do, and what the site said.
 *
 * ## Why this is in the core and not in a README paragraph
 *
 * ProHuman makes automation move like a person. The same mechanism can serve a person testing their own
 * product and a person ignoring someone else's decision. The difference is not in the mouse path — it is
 * whether the session says who it is and whether the site agreed to be touched. So identity and consent are
 * validated inputs that every writing action checks, not a policy note a caller can skip.
 *
 * ## The three consent levels
 *
 * - `own-site` — you operate a site you control. Everything is allowed.
 * - `authorized` — you have permission from the site owner. Everything is allowed.
 * - `public-read-only` — nobody said yes. The session may look, measure and report; it may not click, type,
 *   press, scroll a page it does not own, or switch its tabs. Refusing is the default, and refusing loudly.
 *
 * `robots.txt` is read before a session starts and a `Disallow` is obeyed rather than worked around. A site
 * that asked not to be crawled is not a site that asked to be humanised.
 */

export type Consent = 'own-site' | 'authorized' | 'public-read-only';

const CONSENTS: readonly string[] = ['own-site', 'authorized', 'public-read-only'];

export interface Identity {
  name: string;
  contact_url: string;
  purpose: string;
}

export interface RobotsDecision {
  allowed: boolean;
  reason: string;
  /** Where the answer came from, so a refusal can be checked rather than trusted. */
  source: string;
  crawl_delay_ms?: number;
}

export interface Disclosure {
  identity: Identity;
  consent: Consent;
  robots?: RobotsDecision;
}

export class DisclosureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisclosureError';
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validate the disclosure a caller supplied.
 *
 * Nothing here is optional except `robots`, which the caller fetches separately and may legitimately not
 * find: a site with no robots.txt is not a site that said yes, so an absent file is recorded as such rather
 * than treated as permission.
 */
export function parseDisclosure(input: Record<string, unknown>): Disclosure {
  const raw = (input.identity ?? input) as Record<string, unknown>;
  const identity: Identity = {
    name: str(raw.name).slice(0, 120),
    contact_url: str(raw.contact_url).slice(0, 400),
    purpose: str(raw.purpose).slice(0, 400),
  };
  if (!identity.name) {
    throw new DisclosureError(
      'identity.name is required: a session that moves like a person must say which program it is running',
    );
  }
  if (!identity.purpose) {
    throw new DisclosureError('identity.purpose is required, in one sentence, in the answer as well as the input');
  }
  let url: URL;
  try {
    url = new URL(identity.contact_url);
  } catch {
    throw new DisclosureError(`identity.contact_url must be an absolute http(s) URL, got "${identity.contact_url}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DisclosureError(`identity.contact_url must be http(s), got ${url.protocol}`);
  }

  const consent = str(input.consent) || 'public-read-only';
  if (!CONSENTS.includes(consent)) {
    throw new DisclosureError(`consent must be one of ${CONSENTS.join(', ')} — got "${consent}"`);
  }

  let robots: RobotsDecision | undefined;
  if (input.robots && typeof input.robots === 'object') {
    const r = input.robots as Record<string, unknown>;
    robots = {
      allowed: r.allowed === true,
      reason: str(r.reason) || 'no reason given',
      source: str(r.source) || 'unknown',
      ...(typeof r.crawl_delay_ms === 'number' ? { crawl_delay_ms: Math.max(0, Math.round(r.crawl_delay_ms)) } : {}),
    };
  }

  return { identity, consent: consent as Consent, ...(robots ? { robots } : {}) };
}

/**
 * May this session change a page?
 *
 * A `Disallow` overrides a claimed consent: if the caller says it is authorised but the site's own file says
 * no, the file wins and the answer says why. That ordering is deliberate — consent is a claim, robots.txt is
 * the site's statement.
 */
export function writingAllowed(d: Disclosure): { ok: boolean; reason?: string } {
  if (d.robots && !d.robots.allowed) {
    return {
      ok: false,
      reason: `robots.txt at ${d.robots.source} does not allow this path (${d.robots.reason}); reading is still available, acting is not`,
    };
  }
  if (d.consent === 'public-read-only') {
    return {
      ok: false,
      reason:
        'consent is "public-read-only": nobody with authority over this site said yes, so the session may observe and measure but not click, type, press or switch tabs',
    };
  }
  return { ok: true };
}

/** What every answer repeats: the session is not anonymous, and the caller can see that. */
export function disclosureEcho(d: Disclosure): Record<string, unknown> {
  const write = writingAllowed(d);
  return {
    identity: d.identity,
    consent: d.consent,
    can_write: write.ok,
    ...(write.reason ? { cannot_write_reason: write.reason } : {}),
    ...(d.robots ? { robots: d.robots } : { robots: { allowed: true, reason: 'not checked', source: 'not fetched' } }),
    note: 'ProHuman discloses who it is; it does not conceal anything about the automation',
  };
}
