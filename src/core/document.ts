/**
 * A document, not a blob of markdown.
 *
 * ## The gap this closes
 *
 * `pro_fetch_fetch_url` answers with the page's text. That is the right answer for "what does this page say"
 * and the wrong shape for everything downstream: two reads of the same article cannot be told apart, a
 * pipeline cannot say "this one changed" without diffing the whole body, and a caller that stores the text
 * has no identifier that survives being copied between systems.
 *
 * So the same read is wrapped in an envelope with the four things a body does not carry:
 *
 * - **`document_id`** — a content address: the same page, read twice, gets the same id; a changed page gets
 *   a new one. It is derived from the text after whitespace is collapsed, so a re-render that shuffled
 *   indentation is recognised as the same document rather than a new one.
 * - **`revision`** — the exact checksum of the body that is returned, for when "identical" has to mean
 *   byte-identical.
 * - **Coordinates** — title, heading outline, counts of links and tables, word count: enough structure to
 *   route a document without reading it.
 * - **Provenance** — which stage produced it (`http` or `browser`), where it finally landed after
 *   redirects, and when it was read. A document without a fetch time is a claim about the present.
 *
 * ## What is deliberately not here
 *
 * No `author`, no `published_at`, no `summary`, no sentiment. A page that does not state those in its markup
 * cannot be asked for them honestly, and an envelope that invents fields to look complete is how a pipeline
 * ends up citing something nobody wrote. Everything below is counted or hashed from bytes we already hold.
 */

import { createHash } from 'node:crypto';
import type { FetchResult } from './fetcher.js';
import type { FetchMethod } from './browser-escalation.js';

export interface DocumentHeading {
  level: number;
  text: string;
}

export interface DocumentEnvelope {
  /** Content address, first 16 hex of the sha256 of the normalised body. */
  document_id: string;
  /** Full sha256 of the body exactly as returned. */
  revision: string;
  url: string;
  /** Where the answer actually came from after redirects. */
  final_url: string;
  host: string;
  status: number;
  content_type: string;
  /** Which stage produced the body: what the server sent, or what its scripts drew. */
  method: FetchMethod;
  /** ISO timestamp of this read. A document without one is a claim about the present. */
  fetched_at: string;
  title: string | null;
  headings: DocumentHeading[];
  words: number;
  characters: number;
  links: number;
  tables: number;
  code_blocks: number;
  truncated: boolean;
  cached: boolean;
  tokens: number;
  /** Present only when the fetch reported them: an envelope must not imply a browser ran when none did. */
  escalation_reason?: string;
  browser_ms?: number;
  resources_blocked?: number;
  blocked_kind?: string;
}

/** Collapse runs of whitespace: the normalisation `document_id` is computed over. */
export function normalizeBody(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

export function revisionOf(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex');
}

/**
 * The document id: content, not address.
 *
 * Two URLs holding the same text (a syndicated article, an AMP copy) share an id on purpose — that is what
 * makes it usable for dedupe. Two different readings of a page that changed do not.
 */
export function documentId(markdown: string): string {
  return createHash('sha256').update(normalizeBody(markdown), 'utf8').digest('hex').slice(0, 16);
}

/** ATX and setext headings outside fenced code blocks, with their level and text. */
export function extractHeadings(markdown: string): DocumentHeading[] {
  const lines = markdown.split('\n');
  const out: DocumentHeading[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^ {0,3}(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const atx = /^ {0,3}(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (atx) {
      const text = atx[2].trim();
      if (text) out.push({ level: atx[1].length, text });
      continue;
    }
    const setext = /^ {0,3}(=+|-{2,})\s*$/.exec(line);
    if (setext) {
      // The line above is the heading text, unless it is blank, another rule, or a table row.
      const candidate = (lines[i - 1] ?? '').trim();
      if (!candidate || candidate.startsWith('|') || candidate.startsWith('#')) continue;
      out.push({ level: setext[1].startsWith('=') ? 1 : 2, text: candidate });
    }
  }
  return out;
}

/** Markdown links, inline `[text](url)` and reference `[id][ref]` forms. */
export function countLinks(markdown: string): number {
  const inline = markdown.match(/\[[^\]]*\]\([^)]+\)/g) ?? [];
  const reference = markdown.match(/\[[^\]]+\]\[[^\]]*\]/g) ?? [];
  return inline.length + reference.length;
}

/**
 * How many separate tables the body holds.
 *
 * A table is a header row followed by a separator row (`| --- | --- |`); consecutive table lines count once,
 * because counting rows would report a 200-line export as two hundred tables.
 */
export function countTables(markdown: string): number {
  const lines = markdown.split('\n');
  let tables = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const row = lines[i].trim();
    const next = lines[i + 1].trim();
    if (row.startsWith('|') && row.endsWith('|') && /^\|[\s:|-]+\|$/.test(next) && next.includes('-')) {
      tables++;
      // Skip the body of this table so a long export is one table, not many.
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) i++;
    }
  }
  return tables;
}

export function countCodeBlocks(markdown: string): number {
  let open = false;
  let blocks = 0;
  for (const line of markdown.split('\n')) {
    if (/^ {0,3}(```|~~~)/.test(line)) {
      if (!open) blocks++;
      open = !open;
    }
  }
  return blocks;
}

/** The document's own first heading, which is what a page calls itself. */
export function deriveTitle(markdown: string, headings: DocumentHeading[]): string | null {
  const first = headings.find((heading) => heading.level === 1) ?? headings[0];
  if (first) return first.text;
  // A fetched page often starts with `# <url>` from the reader itself; that is not a title.
  return null;
}

export interface BuildDocumentOptions {
  /** Injected for tests; a read is stamped with the clock, and a clock that moves makes the test flaky. */
  now?: () => Date;
}

/**
 * Wrap a fetch result in the envelope.
 *
 * Provenance fields are copied only when the fetch actually reported them: an envelope that always prints
 * `browser_ms: 0` for an HTTP read would say the browser ran when it did not.
 */
export function buildDocument(result: FetchResult, options: BuildDocumentOptions = {}): DocumentEnvelope {
  const markdown = result.markdown;
  const headings = extractHeadings(markdown);
  const now = options.now ? options.now() : new Date();
  const host = (() => {
    try {
      return new URL(result.url).host;
    } catch {
      return '';
    }
  })();
  const envelope: DocumentEnvelope = {
    document_id: documentId(markdown),
    revision: revisionOf(markdown),
    url: result.url,
    final_url: result.url,
    host,
    status: result.status,
    content_type: result.contentType,
    method: result.method ?? 'http',
    fetched_at: now.toISOString(),
    title: deriveTitle(markdown, headings),
    headings,
    words: markdown.split(/\s+/).filter((word) => word.length > 1).length,
    characters: markdown.length,
    links: countLinks(markdown),
    tables: countTables(markdown),
    code_blocks: countCodeBlocks(markdown),
    truncated: result.truncated,
    cached: result.cached,
    tokens: result.tokens,
  };
  if (result.escalation_reason) envelope.escalation_reason = result.escalation_reason;
  if (result.browser_ms !== undefined) envelope.browser_ms = result.browser_ms;
  if (result.resources_blocked !== undefined) envelope.resources_blocked = result.resources_blocked;
  if (result.blocked) envelope.blocked_kind = result.blocked.kind;
  return envelope;
}
