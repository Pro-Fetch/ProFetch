/**
 * Deciding whether a fetched document actually arrived.
 *
 * ## The problem this exists for
 *
 * `fetchUrl` asks a server for bytes and gets them. A server that answers 200 with an HTML shell — a
 * `<div id="root">` and a script that paints the page afterwards — has not delivered a document, it has
 * delivered an instruction to build one. Reading that as "the page is empty" is the most common way a
 * scraping pipeline invents absence, and it is invisible: the status is fine, the length is fine, the
 * content is nothing.
 *
 * So the decision is made here, from the response itself, and it is stated in words the caller can read:
 * `escalationReason` says what was seen ("28 words of body text, 3 script tags"), not that a heuristic
 * fired.
 *
 * ## What is deliberately not done
 *
 * - **No guessing from the domain.** A list of "sites that need JavaScript" is a snapshot of last year.
 *   The response is the evidence; the host is not.
 * - **No escalation on a refusal.** A block page is a host saying no. Rendering it in a browser would be
 *   an attempt to get around that answer, which is the thing this repository's policy layer refuses to do.
 * - **No silent browser.** When a browser is used, the answer says so — `method: 'browser'` — because a
 *   caller deciding whether to trust a document needs to know whether they are reading what the server
 *   sent or what the site chose to paint after scripts ran. Those are different artefacts.
 */

export type FetchMethod = 'http' | 'browser';

export interface EscalationSignal {
  escalate: boolean;
  reason: string;
  words: number;
  scriptTags: number;
  /** Whether the source leaves a mount element empty for its scripts to fill. */
  mountPoint: boolean;
}

/** Below this many words a 200 response is treated as a shell, not a document. */
const MIN_WORDS = 40;

/**
 * Below this many words, scripts alone are enough evidence — no recognised mount element needed.
 *
 * Set by the live reading it is named after: the page that had not run its scripts came back as 4 words of
 * navigation text. A complete short page measured 24, and sending that to a browser bought nothing.
 */
const SHELL_WORDS = 12;

/**
 * How long the browser stage waits for the page's own network activity to quiet down.
 *
 * Bounded on purpose, and its expiry is not an error: a page holding a websocket or polling never reports
 * idle, and the text painted by then is still the document we came for.
 */
const SETTLE_TIMEOUT_MS = 10_000;

/** One second, once, for the page that paints after the network already looks quiet. */
const RESTRIKE_MS = 1_000;

export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 1).length;
}

/**
 * The source left an element empty for its script to fill: the structural sign of a shell.
 *
 * `<div id="root"></div>` and `<app-root></app-root>` are not pages with little text, they are pages with no
 * text yet. Only the empty form counts: `<div id="app">…content…</div>` is a server-rendered page that merely
 * uses hydration, and reading it in a browser would cost a browser.
 */
const MOUNT_PATTERNS: RegExp[] = [
  /<div\b[^>]*\bid=["']?(?:root|app|main|__next|react-app|application)["']?(?=[\s>])[^>]*>\s*<\/div>/i,
  /<(?:app-root|ng-app)\b[^>]*>\s*<\/(?:app-root|ng-app)>/i,
  /<main\b[^>]*>\s*<\/main>/i,
  /<body\b[^>]*>\s*<\/body>/i,
];

export function hasEmptyMount(html: string): boolean {
  return MOUNT_PATTERNS.some((pattern) => pattern.test(html));
}

/**
 * Should this response be re-read in a browser?
 *
 * Everything here is measured from the bytes we already hold. Two live readings set the thresholds: a page
 * whose scripts had not run came back as 4 words with an empty mount point, while a complete short page came
 * back as 24 words with one analytics script — and opening a browser for the second one cost 700 ms to fetch
 * what was already there. So "short and has a script" alone is not evidence of a shell; a shell needs either
 * the empty mount point or almost nothing to read at all.
 */
export function needsBrowser(input: {
  status: number;
  contentType: string;
  markdown: string;
  html: string;
  blocked?: unknown;
}): EscalationSignal {
  const words = countWords(input.markdown);
  const scriptTags = (input.html.match(/<script\b/gi) ?? []).length;
  const mountPoint = hasEmptyMount(input.html);
  const isHtml = /text\/html|application\/xhtml/.test(input.contentType) || /^\s*</.test(input.html);

  if (input.blocked) {
    return {
      escalate: false,
      reason: 'host refused the request; a browser is not used to go around a refusal',
      words,
      scriptTags,
      mountPoint,
    };
  }
  if (input.status >= 400) {
    return {
      escalate: false,
      reason: `HTTP ${input.status} is an answer, not an empty page`,
      words,
      scriptTags,
      mountPoint,
    };
  }
  if (!isHtml) {
    return {
      escalate: false,
      reason: `${input.contentType || 'no content type'} is not HTML; there is nothing to paint`,
      words,
      scriptTags,
      mountPoint,
    };
  }
  if (words >= MIN_WORDS) {
    return {
      escalate: false,
      reason: `${words} words came back over HTTP; no browser needed`,
      words,
      scriptTags,
      mountPoint,
    };
  }
  if (scriptTags === 0) {
    return {
      escalate: false,
      reason: `${words} words and no script tag — this page is short, not rendered`,
      words,
      scriptTags,
      mountPoint,
    };
  }
  if (!mountPoint && words > SHELL_WORDS) {
    return {
      escalate: false,
      reason: `${words} words with ${scriptTags} script tag(s) and no empty mount point — a short page, not a shell`,
      words,
      scriptTags,
      mountPoint,
    };
  }
  return {
    escalate: true,
    reason:
      `${words} words came back with ${scriptTags} script tag(s)` +
      (mountPoint ? ' and an empty mount element' : '') +
      ' — an HTML shell that scripts fill in',
    words,
    scriptTags,
    mountPoint,
  };
}

/**
 * The browser half, kept behind a dynamic import.
 *
 * `browser-tools.ts` pulls in Playwright and the session layer; importing it at module load would make
 * every fetch path depend on a browser being installed. The policy in this repository is that a missing
 * optional engine is reported, not fatal — so the import happens only when a shell was actually detected,
 * and its absence becomes a named reason in the answer.
 */
export async function renderWithBrowser(
  url: string,
  maxChars: number,
): Promise<
  | { ok: true; markdown: string; ms: number; truncated: boolean; blockedRequests: number }
  | { ok: false; reason: string }
> {
  const started = Date.now();
  try {
    const { withGuardedPage, resourceBlockReport } = await import('./browser-tools.js');
    const drawn = await withGuardedPage(url, {}, async (page) => {
      // `goto` in this repository resolves on `domcontentloaded`, and a page that asks for its data over the
      // network has not drawn anything at that moment — reading then would report a full page as a shell.
      // The wait is bounded and its failure is not fatal: an SPA that keeps a socket open never reaches
      // networkidle, and the page it has painted by now is still the answer we came for.
      await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
      const first = await page.locator('body').innerText();
      if (countWords(first) >= MIN_WORDS) return { text: first, blocked: resourceBlockReport(page.context()) };
      // One short second read separates "slow" from "genuinely empty". Without it a page that paints 300 ms
      // later is reported as a shell, and the report is the whole point of this file.
      await new Promise((done) => setTimeout(done, RESTRIKE_MS));
      const text = await page.locator('body').innerText();
      return { text, blocked: resourceBlockReport(page.context()) };
    });
    // The caller clips to a token budget; this cap exists so a multi-megabyte single-page app cannot be
    // handed over as a string first. `truncated` reports whichever cut actually happened, because an answer
    // that says "here is the page" about a page we stopped reading at 200 kB would be a lie.
    const cap = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 200_000;
    return {
      ok: true,
      markdown: drawn.text.slice(0, cap),
      ms: Date.now() - started,
      truncated: drawn.text.length > cap,
      // A count, not a byte figure: Playwright does not say what an aborted request would have carried, and
      // a number this file cannot measure is a number this file does not print.
      blockedRequests: drawn.blocked.total,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The SSRF refusal is a policy answer and has to survive as itself; the Playwright absence is an
    // environment fact; anything else is the browser failing to produce a page.
    return { ok: false, reason: message.slice(0, 300) };
  }
}
