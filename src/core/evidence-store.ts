/**
 * The evidence store: what a claim was resting on, and whether it still is.
 *
 * Every other tool in this server answers "what does the web say now". This one answers the question an
 * agent team actually gets asked a week later: "the thing you cited — is it still true, and what exactly
 * did you see at the time?" A receipt seals a digest of the material with its address and the moment it
 * was taken; a check re-fetches and reports drift, or reports that the source has gone behind a
 * challenge, which is a different fact and needs saying differently.
 *
 * Canonicalisation is deliberately narrow. Line endings and trailing spaces are normalised because a
 * re-fetch that differs only in CRLF is not a content change, and a tool that reports one trains people
 * to ignore the verdict. Nothing else is touched: whitespace inside a paragraph, a regenerated timestamp
 * in a page footer, a re-encoded PDF — those all change the digest, honestly, and `pro_evidence_diff`
 * shows which lines moved.
 *
 * Receipts live in the cache with a long TTL. The cache is an LRU: under pressure the oldest receipts go,
 * so `pro_evidence_stats` reports how many are held rather than implying a permanent archive.
 */

import { createHash } from 'node:crypto';
import { cache } from './cache.js';

export interface EvidenceCheck {
  at: string;
  verdict: string;
  sha256: string;
  ms: number;
}

export interface EvidenceReceipt {
  id: string;
  url: string;
  kind: string;
  label: string;
  sealed_at: string;
  sha256: string;
  bytes: number;
  lines: number;
  words: number;
  ttl_ms: number;
  checks: EvidenceCheck[];
  /** The canonical material, kept so a later diff and a citation quote are possible. */
  text: string;
  /** False when the document was larger than the cap: the digest is still exact, the copy is not full. */
  stored: boolean;
}

const PREFIX = 'evidence:';
const INDEX = 'evidence:index';
const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000;
/** This store is in-memory. A receipt may hold its material, but not a 40 MB dump of it. */
export const MAX_STORED_BYTES = 65_536;

/** The bytes a receipt commits to: same content, any line-ending style; different content, different hash. */
export function canonicalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

export function digestOf(text: string): { sha256: string; bytes: number; lines: number; words: number } {
  const canonical = canonicalize(text);
  const bytes = Buffer.byteLength(canonical, 'utf8');
  const lines = canonical.length === 0 ? 0 : canonical.split('\n').length;
  const words = canonical.split(/\s+/).filter(Boolean).length;
  return { sha256: createHash('sha256').update(canonical, 'utf8').digest('hex'), bytes, lines, words };
}

function shortId(url: string, sha256: string): string {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'inline';
    }
  })();
  return `${host}-${sha256.slice(0, 12)}`;
}

export function sealReceipt(input: {
  url: string;
  content: string;
  kind?: string;
  label?: string;
  ttlMs?: number;
}): EvidenceReceipt {
  const digest = digestOf(input.content);
  const canonical = canonicalize(input.content);
  const ttl = input.ttlMs && input.ttlMs > 0 ? Math.min(input.ttlMs, DEFAULT_TTL_MS) : DEFAULT_TTL_MS;
  const receipt: EvidenceReceipt = {
    id: shortId(input.url, digest.sha256),
    url: input.url,
    kind: input.kind && input.kind.trim() ? input.kind.trim() : 'web',
    label: input.label ?? '',
    sealed_at: new Date().toISOString(),
    sha256: digest.sha256,
    bytes: digest.bytes,
    lines: digest.lines,
    words: digest.words,
    ttl_ms: ttl,
    checks: [],
    text: canonical.slice(0, MAX_STORED_BYTES),
    stored: Buffer.byteLength(canonical, 'utf8') <= MAX_STORED_BYTES,
  };
  saveReceipt(receipt);
  return receipt;
}

export function saveReceipt(receipt: EvidenceReceipt): void {
  cache.put(PREFIX + receipt.id, JSON.stringify(receipt), receipt.ttl_ms, { type: 'evidence', url: receipt.url });
  const index = new Set(cache.keys(PREFIX).filter((key) => key !== INDEX));
  index.add(PREFIX + receipt.id);
  cache.put(INDEX, JSON.stringify([...index]), receipt.ttl_ms, { type: 'evidence-index' });
}

export function getReceipt(id: string): EvidenceReceipt | null {
  const hit = cache.get(PREFIX + id);
  if (!hit) return null;
  try {
    return JSON.parse(hit.value) as EvidenceReceipt;
  } catch {
    return null;
  }
}

export function listReceipts(limit = 50, contains = ''): EvidenceReceipt[] {
  const keys = cache.keys(PREFIX).filter((key) => key !== INDEX);
  const receipts: EvidenceReceipt[] = [];
  for (const key of keys) {
    const hit = cache.get(key);
    if (!hit) continue;
    try {
      const receipt = JSON.parse(hit.value) as EvidenceReceipt;
      if (contains && !`${receipt.url} ${receipt.label}`.includes(contains)) continue;
      receipts.push(receipt);
    } catch {
      /* a foreign value under a guessable key is not a receipt; skip it rather than throw */
    }
  }
  receipts.sort((a, b) => (a.sealed_at < b.sealed_at ? 1 : a.sealed_at > b.sealed_at ? -1 : 0));
  return receipts.slice(0, Math.max(1, Math.min(limit, 500)));
}

export function recordCheck(receipt: EvidenceReceipt, check: EvidenceCheck): EvidenceReceipt {
  receipt.checks = [...receipt.checks, check].slice(-20);
  saveReceipt(receipt);
  return receipt;
}

/** A quoted line is for reading; one 100 KB line must not become a 100 KB answer. */
function clipLine(line: string): string {
  const trimmed = line.trim();
  return trimmed.length <= 160 ? trimmed : trimmed.slice(0, 160) + ' …';
}

/** Line-level drift, summarised rather than dumped: how much moved, and the first lines that did. */
export function diffLines(
  before: string,
  after: string,
  maxShown = 8,
): {
  added: number;
  removed: number;
  unchanged: number;
  changed: boolean;
  sample: string[];
} {
  const a = canonicalize(before).split('\n');
  const b = canonicalize(after).split('\n');
  const seen = new Set(a);
  const back = new Set(b);
  const added = b.filter((line) => !seen.has(line));
  const removed = a.filter((line) => !back.has(line));
  const sample = [
    ...removed.slice(0, maxShown).map((line) => `- ${clipLine(line)}`),
    ...added.slice(0, maxShown).map((line) => `+ ${clipLine(line)}`),
  ].slice(0, maxShown);
  return {
    added: added.length,
    removed: removed.length,
    unchanged: b.length - added.length,
    changed: added.length > 0 || removed.length > 0,
    sample,
  };
}
