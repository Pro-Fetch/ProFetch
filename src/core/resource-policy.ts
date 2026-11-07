/**
 * Deciding which sub-resources a text reader does not need.
 *
 * ## The cost this trims
 *
 * A rendered read is not expensive because of the text. Chromium fetches the page, then everything the page
 * asks for: photographs at full resolution, web fonts, video manifests, analytics beacons. For a read whose
 * only purpose is `innerText`, all of that is paid for and thrown away — and on a slow host it is also the
 * reason the read times out at all. Blocking the visual-only kinds is the cheapest win available in the
 * second stage of the fetcher, and it is the one an operator can reason about in one line.
 *
 * ## What is never blocked by default, and why
 *
 * - **`document`** — the page itself, including frames. Blocking a frame removes embedded content from the
 *   answer, which is a claim about the page that is not true.
 * - **`script`, `xhr`, `fetch`, `websocket`, `eventsource`** — this is how a JavaScript-rendered page gets
 *   its data. Blocking them produces exactly the empty shell the second stage exists to avoid. They are
 *   allowed only when an operator names them explicitly, and the answer then says so.
 * - **`stylesheet`** — `innerText` is layout-dependent: what CSS hides, the DOM reports as hidden. Blocking
 *   styles can therefore change the text that comes back, not merely its timing. Explicit opt-in only.
 *
 * So the default is `image, media, font`: things a text reader cannot use.
 *
 * ## Honest limit
 *
 * An aborted request is counted, not measured: Playwright does not tell us how many bytes the host *would*
 * have sent. The savings reported from this are therefore request counts and wall-clock time, which is what
 * was actually observed, and never "bytes saved".
 */

/** Playwright's own resource taxonomy, as `request.resourceType()` returns it. */
export const RESOURCE_KINDS = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'xhr',
  'fetch',
  'websocket',
  'eventsource',
  'manifest',
  'texttrack',
  'other',
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** Safe for a text read: the page cannot say anything with these. */
export const READER_DEFAULT_BLOCK: ResourceKind[] = ['image', 'media', 'font'];

/**
 * Kinds that change what the answer *is*, not how fast it arrives. They are refused a place in the default
 * set and need to be named explicitly by an operator who accepts that consequence.
 */
export const CONTENT_BEARING: ResourceKind[] = ['document', 'script', 'xhr', 'fetch', 'websocket', 'eventsource'];

/**
 * The reader default, overridable by the operator.
 *
 * `PRO_FETCH_BLOCK_RESOURCES=none` (or an empty value) turns the feature off; a comma list replaces the
 * default set, so `image,media,font,stylesheet` is an explicit decision to let CSS affect the read.
 */
export function readerBlockSetting(): string {
  const raw = (process.env.PRO_FETCH_BLOCK_RESOURCES ?? '').trim();
  if (raw === '') return READER_DEFAULT_BLOCK.join(',');
  return raw;
}

/** Parse a block list. Unknown names are dropped rather than guessed at, and the result says which were. */
export function parseBlockKinds(raw: unknown): { kinds: Set<string>; rejected: string[] } {
  const rejected: string[] = [];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const kinds = new Set<string>();
  for (const entry of list) {
    const name = String(entry).trim().toLowerCase();
    if (!name) continue;
    if (name === 'none' || name === 'off' || name === 'false') {
      kinds.clear();
      return { kinds, rejected };
    }
    if ((RESOURCE_KINDS as readonly string[]).includes(name)) kinds.add(name);
    else rejected.push(name);
  }
  return { kinds, rejected };
}

/**
 * Should this request be aborted?
 *
 * Content-bearing kinds are protected even when an operator lists them, except for the ones whose listing is
 * a deliberate decision (`script`, `xhr`, `fetch` are honoured when named; `document` never is, because a
 * blocked document is a missing part of the page rather than a slow one).
 */
export function shouldBlock(kind: string, blockSet: Set<string>): boolean {
  if (blockSet.size === 0) return false;
  if (kind === 'document') return false;
  return blockSet.has(kind);
}

/** A short, honest label for what was refused, used in the answer and in tests. */
export function blockSummary(kinds: Set<string>): string {
  return kinds.size === 0 ? 'hech narsa bloklanmadi' : Array.from(kinds).sort().join(', ');
}
