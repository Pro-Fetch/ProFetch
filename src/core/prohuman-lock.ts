/**
 * One writer per session's cursor.
 *
 * ## Why this is not a detail
 *
 * A browser page has one pointer. If a ProHuman driver is mid-reach and a `browser_use_act` call clicks,
 * the two interleave: the pointer jumps, the recorded path is neither the plan nor a human movement, and
 * every measurement taken afterwards describes a collision rather than a session. The failure is silent —
 * both calls return success.
 *
 * ## The rule, and what happens when it is not met
 *
 * The holder is named, and a second writer is *refused* rather than queued. Queueing would look polite and
 * be worse: the caller would believe its click happened at the moment it asked for it, while the pointer had
 * already been moved somewhere else under it. A refusal that says who holds the cursor is actionable; a
 * silent wait is a lie about timing.
 *
 * Every lock carries a TTL. A driver that dies mid-step (its session closed, its process killed) must not
 * leave a page un-clickable forever. An expired lock is reclaimed, and the reclaim is reported as the reason
 * the previous holder lost it.
 */

export type LockOwnerKind = 'driver' | 'action';

export interface LockOwner {
  kind: LockOwnerKind;
  /** The driver id or the action id — enough for a refusal to name who is in the way. */
  id: string;
  acquiredAtMs: number;
  ttlMs: number;
  /** How many times it has been renewed. A driver that stops renewing expires on its own. */
  renewals: number;
}

export interface LockResult {
  ok: boolean;
  holder?: LockOwner;
  reason?: string;
}

const DEFAULT_TTL_MS = 10_000;

const locks = new Map<string, LockOwner>();

function expired(owner: LockOwner, now: number): boolean {
  return now > owner.acquiredAtMs + owner.ttlMs;
}

/** Take the cursor, or be told who has it. Never wait. */
export function acquirePointer(
  sessionId: string,
  owner: { kind: LockOwnerKind; id: string; ttlMs?: number },
  now = Date.now(),
): LockResult {
  const current = locks.get(sessionId);
  if (current && !expired(current, now)) {
    if (current.id === owner.id) {
      // Re-entrant on purpose: a driver takes the cursor once per step and many steps share its id.
      current.acquiredAtMs = now;
      current.renewals += 1;
      return { ok: true, holder: { ...current } };
    }
    return {
      ok: false,
      holder: { ...current },
      reason:
        `the pointer is held by ${current.kind} "${current.id}" for another ${Math.max(0, Math.round(current.acquiredAtMs + current.ttlMs - now))} ms — ` +
        `stop that driver, or pass pause_driver=true to make it yield`,
    };
  }
  const reclaimed = current ? { ...current } : null;
  locks.set(sessionId, {
    kind: owner.kind,
    id: owner.id,
    acquiredAtMs: now,
    ttlMs: owner.ttlMs ?? DEFAULT_TTL_MS,
    renewals: 0,
  });
  const result: LockResult = { ok: true, holder: { ...locks.get(sessionId)! } };
  if (reclaimed) {
    result.reason = `reclaimed an expired lock held by ${reclaimed.kind} "${reclaimed.id}"`;
  }
  return result;
}

/** Release it. Only the holder can, and a wrong id says so instead of quietly freeing someone else. */
export function releasePointer(sessionId: string, ownerId: string, now = Date.now()): LockResult {
  const current = locks.get(sessionId);
  if (!current) return { ok: true, reason: 'no lock held' };
  if (current.id !== ownerId && !expired(current, now)) {
    return {
      ok: false,
      holder: { ...current },
      reason: `"${ownerId}" does not hold the pointer; "${current.id}" does`,
    };
  }
  locks.delete(sessionId);
  return { ok: true };
}

/** Renew without taking: a running driver keeps its own lease alive. */
export function renewPointer(sessionId: string, ownerId: string, now = Date.now()): LockResult {
  const current = locks.get(sessionId);
  if (!current) return { ok: false, reason: 'no lock held' };
  if (current.id !== ownerId) {
    // A renewal from the wrong owner is a refusal, never a release: dropping someone else's lease here
    // would hand the cursor over mid-movement.
    if (expired(current, now)) {
      locks.delete(sessionId);
      return { ok: false, reason: `the lock held by "${current.id}" had expired and was dropped` };
    }
    return {
      ok: false,
      holder: { ...current },
      reason: `"${ownerId}" does not hold the pointer; "${current.id}" does`,
    };
  }
  current.acquiredAtMs = now;
  current.renewals += 1;
  return { ok: true, holder: { ...current } };
}

export function pointerHolder(sessionId: string, now = Date.now()): LockOwner | null {
  const current = locks.get(sessionId);
  // Pure query: an expired lease reads as none, but the entry is left in place so the next
  // `acquirePointer` can say whose lock it reclaimed. Deleting here would make that reclaim silent.
  if (!current || expired(current, now)) return null;
  return { ...current };
}

/** A session closing frees whatever it held; nothing else can be waiting on a dead page. */
export function releaseAllFor(sessionId: string): void {
  locks.delete(sessionId);
}

/** Test seam only. Production code must not be able to clear every session's lock at once. */
export function __resetPointerLocks(): void {
  locks.clear();
}
