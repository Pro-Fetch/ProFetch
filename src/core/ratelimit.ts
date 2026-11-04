/**
 * The map is keyed by caller-controlled names (e.g. `domain:<hostname>`), so without a bound a
 * long-lived process that touches many distinct keys grows it forever.
 *
 * The bound used to be a suggestion: reaching it called `pruneStaleBuckets()`, which only drops buckets idle
 * for fifteen minutes, so a run that keeps naming new hosts grew the map past the ceiling — measured by an
 * external audit at 60,000 entries against a stated 50,000. It is now enforced in three steps, cheapest
 * first, because the steps are not equally lossless: an idle bucket is already refilled, a full bucket
 * recreates to exactly the same state, and only the last step forgets a bucket that still holds a debt.
 */
export const MAX_BUCKETS = 50_000;
const IDLE_MS = 15 * 60_000;

/** Evict down to 90% rather than one slot under the ceiling, so the sweep is amortised. */
const EVICT_FLOOR = MAX_BUCKETS - Math.floor(MAX_BUCKETS / 10);

interface Bucket {
  tokens: number;
  last: number;
  /** The limit this bucket was opened with, so a status can refill it the way `take` does. */
  limit: number;
  /** The window this bucket was opened with, for the same reason. */
  windowMs: number;
}
const buckets = new Map<string, Bucket>();

/** What a bucket holds at `now`, the same refill `take` and the snapshots compute. */
function refill(b: Bucket, now: number): number {
  return Math.min(b.limit, b.tokens + ((now - b.last) / b.windowMs) * b.limit);
}

function pruneStaleBuckets(now: number): void {
  for (const [key, b] of buckets) {
    if (now - b.last > IDLE_MS) buckets.delete(key);
  }
}

function enforceCeiling(now: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  pruneStaleBuckets(now);
  if (buckets.size < EVICT_FLOOR) return;
  // A bucket that is already full costs nothing to forget: the next access recreates it at full tokens.
  for (const [key, b] of Array.from(buckets)) {
    if (buckets.size <= EVICT_FLOOR) return;
    if (refill(b, now) >= b.limit) buckets.delete(key);
  }
  if (buckets.size <= EVICT_FLOOR) return;
  // Still over: drop least-recently-used. This is the honest cost of a bounded map — a key that was being
  // limited can have its bucket evicted by churn and regain a full budget on the next call. The ceiling
  // exists because caller-chosen keys are unbounded, and a server that runs out of memory serves nobody.
  for (const key of buckets.keys()) {
    if (buckets.size <= EVICT_FLOOR) return;
    buckets.delete(key);
  }
}

export function take(key: string, limit = 60, windowMs = 60_000): boolean {
  const now = Date.now();
  enforceCeiling(now);
  const existing = buckets.get(key);
  const b = existing ?? { tokens: limit, last: now, limit, windowMs };
  b.limit = limit;
  b.windowMs = windowMs;
  b.tokens = refill(b, now);
  b.last = now;
  // Re-insert rather than mutate in place: `Map` keeps insertion order, and an evicted key must be the one
  // least recently *used*, not the one created longest ago.
  buckets.delete(key);
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

/**
 * What a bucket holds right now, without spending from it.
 *
 * The refill is the same computation `take` performs, and a key that was never used reports a full
 * bucket rather than an empty one. Both were wrong before: a bucket that had been touched once and
 * then left alone for a minute reported the stale count, and a key that had never been touched
 * reported zero - a status that said the limiter was exhausted when it would have allowed sixty
 * requests. A status that does not predict the next call is worse than no status.
 */
export function bucketStatus(key: string, limit = 60, windowMs = 60_000): { tokens: number; limit: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b) return { tokens: limit, limit };
  return { tokens: Math.floor(refill(b, now)), limit: b.limit };
}

/**
 * Every bucket, refilled to what it would hold now.
 *
 * The snapshot used to read the stored counts, which are only brought up to date when a call is
 * actually made - so an idle limiter looked exhausted in the diagnostics that report it.
 */
export function bucketsSnapshot(): Record<string, number> {
  const now = Date.now();
  const out: Record<string, number> = {};
  for (const [key, b] of buckets) {
    out[key] = Math.floor(refill(b, now));
  }
  return out;
}

export function resetBuckets(): void {
  buckets.clear();
}
