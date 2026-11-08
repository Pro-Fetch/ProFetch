/**
 * A block page is not content.
 *
 * Measured on 2026-11-05 against the three hosts that were reported as weak points:
 *
 *   https://www.akamai.com/            our user-agent → 403 (364 b), browser-shaped UA → 200 (219 KB)
 *   nsa.gov …/CSI_MCP_SECURITY.pdf     our user-agent → 403 (446 b), browser-shaped UA → 200 (305 KB)
 *   https://www.researchgate.net/      every user-agent → 403, identical 21,289 b Cloudflare page
 *
 * Before this file, all three came back through `pro_fetch_fetch_url` as `ok`, with the block page as the
 * "page". A caller asking for a paper got "Access Denied" in the shape of an answer — the worst possible
 * failure for a product whose whole claim is that it reports what actually happened.
 *
 * So: recognise the refusal, name which kind it is, and say what would get past it. Two of the three are
 * a user-agent filter (fixable, and honestly labelled when fixed). One is a network-reputation challenge
 * (not fixable from here, and pretending otherwise is the bug).
 */

export type BlockKind =
  | 'cloudflare_challenge'
  | 'edge_denied'
  | 'waf_blocked'
  | 'rate_limited'
  | 'legal_block'
  /** The host serves a sign-in or subscribe page instead of the document: the content is behind credentials. */
  | 'auth_wall';

export interface BlockPage {
  kind: BlockKind;
  /** The text or header that gave it away, kept short so it fits in an answer. */
  marker: string;
  /** Whether a different user-agent is a reasonable next try. */
  ua_sensitive: boolean;
  /** What the caller can actually do about it. */
  hint: string;
}

const MARKERS: { kind: BlockKind; pattern: RegExp; marker: string; ua_sensitive: boolean; hint: string }[] = [
  {
    kind: 'cloudflare_challenge',
    // Typographic apostrophes are the reason this was missed in a live run: the page says "We’ve
    // detected…", the pattern said "We've…", and a 21 KB Cloudflare page fell through to the generic
    // branch and was reported as a user-agent filter.
    pattern:
      /we[’']ve detected unusual activity from your network|access restricted|Attention Required! ?\| ?Cloudflare|Cloudflare Ray ID|Just a moment|challenge-platform/i,
    marker: 'cloudflare challenge',
    ua_sensitive: false,
    hint: "Tarmoq reputatsiyasi yoki JS challenge. Header o'zgartirish ishlatmaydi — brauzer dvigateli (pro_browser_use_session_open) yoki boshqa manba (DOI, arXiv, publisher) kerak.",
  },
  {
    kind: 'edge_denied',
    pattern: /You don't have permission to access|Access Denied\s+Reference #|Reference #\d+\.[0-9a-f]+/i,
    marker: 'edge access denied',
    ua_sensitive: true,
    hint: "Akamai/CDN user-agent filtrini ko'rinadi. PRO_FETCH_HTTP_COMPAT_UA=1 bilan bir marta brauzer UA'da urinib ko'riladi, yoki pro_browser_use_session_open orqali haqiqiy brauzer.",
  },
  {
    kind: 'waf_blocked',
    pattern:
      /The requested URL was blocked by a security policy|X-Amzn-Errortype|Request blocked|An error occurred with your request that has been logged/i,
    marker: 'WAF block',
    ua_sensitive: true,
    hint: "WAF to'sagi. So'rov shaklini soddalashtirish yoki brauzer dvigateli kerak bo'lishi mumkin.",
  },
  {
    kind: 'rate_limited',
    pattern: /Too Many Requests|rate limit/i,
    marker: 'rate limited',
    hint: 'Orqaga chekinib qayta urinish (backoff). Bir necha soniya yoki daqiqa keyin.',
    ua_sensitive: false,
  },
  {
    kind: 'legal_block',
    pattern: /Unavailable For Legal Reasons/i,
    marker: 'legal block',
    hint: 'Huquqiy blok — qayta urinish foydasiz.',
    ua_sensitive: false,
  },
];

/**
 * `null` means "this looks like the real answer". Only ever called for a status that is already a
 * refusal (403/406/429/451), so a site that publishes its own 403 page is still judged by its body.
 */
export function classifyBlockPage(status: number, headers: Record<string, string>, text: string): BlockPage | null {
  if (![403, 406, 429, 451].includes(status)) return null;
  const entries = Object.entries(headers);
  const servedByCloudflare = entries.some(
    ([name, value]) => /^(server|cf-ray|cf-mitigated)$/i.test(name) && /cloudflare|challenge/i.test(value),
  );
  if (servedByCloudflare && status !== 429 && status !== 451) {
    const entry = MARKERS.find((m) => m.kind === 'cloudflare_challenge')!;
    return { kind: entry.kind, marker: entry.marker, ua_sensitive: entry.ua_sensitive, hint: entry.hint };
  }
  const cfMitigated = entries.find(([name]) => name.toLowerCase() === 'cf-mitigated');
  const haystack = `${text.slice(0, 4000)} ${cfMitigated ? cfMitigated.join('=') : ''}`;
  for (const entry of MARKERS) {
    if (entry.pattern.test(haystack)) {
      return { kind: entry.kind, marker: entry.marker, ua_sensitive: entry.ua_sensitive, hint: entry.hint };
    }
  }
  // A refusal with no recognisable shape is still a refusal: saying "blocked, reason unknown" beats
  // handing the caller a 403 body as if it were the page they asked for.
  return {
    kind: status === 429 ? 'rate_limited' : 'edge_denied',
    marker: `HTTP ${status} (noma'lum blok sahifasi)`,
    ua_sensitive: status === 403,
    hint: `Host ${status} qaytardi va bu blok sahifasi taniqli belgilarga mos kelmadi.`,
  };
}

/** Browser-shaped UA for the one opt-in retry. Off unless the operator turns it on. */
export const COMPAT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

export function compatUaEnabled(): boolean {
  return process.env.PRO_FETCH_HTTP_COMPAT_UA === '1' || process.env.PRO_FETCH_HTTP_COMPAT_UA === 'true';
}
