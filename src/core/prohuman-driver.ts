/**
 * The driver: a scheduler that owns a session's cursor until it is told to stop.
 *
 * ## Why a scheduler and not a queue of awaited actions
 *
 * The M0 spike measured the alternative and rejected it: while the keyboard was busy for four seconds, the
 * pointer did not move once. A queue that awaits each action to completion produces exactly that — a
 * machine that fidgets only in the gaps between calls, which is the opposite of the premise. So the driver
 * runs one ticker with two independent due-times, one for the action in flight and one for idle drift, and
 * whichever comes first is served. Typing, dwelling and scrolling all continue while the pointer drifts,
 * because they are separate schedules sharing one clock.
 *
 * ## Lifecycle, and the three ways a driver dies
 *
 * - **stopped**: someone called `prohuman_stop`.
 * - **expired**: the profile's `max_runtime_ms` ran out. Unattended motion must end by itself; a driver that
 *   lives until the process does is a resource leak with a cursor.
 * - **lost**: the page or session went away — closed, navigated into a dead handle, or the engine threw. The
 *   error is kept as the reason rather than swallowed, because a driver that quietly stopped is the worst
 *   thing a caller can be told about afterwards.
 *
 * ## What the driver never does
 *
 * It does not touch anything the disclosure layer forbids, it does not take the cursor from a holder that is
 * alive, and it does not report a movement the surface did not perform: every action returns the events the
 * page recorded, not the plan.
 */

import { randomSeed, mulberry32, createProfile, type HumanProfile } from './prohuman-profile.js';
import {
  planPath,
  planScroll,
  planTyping,
  planDwell,
  nextIdleGap,
  planDrift,
  type PathStep,
  type Point,
} from './prohuman-path.js';
import type { Disclosure } from './prohuman-disclosure.js';
import { writingAllowed } from './prohuman-disclosure.js';
import { acquirePointer, releasePointer, renewPointer, pointerHolder } from './prohuman-lock.js';
import type { InputSurface } from './prohuman-surface.js';
import { browserUseSurface } from './prohuman-surface.js';
import { getSession, requireSession, type BrowserUseSession } from './browser-use-session.js';

export type ActionKind = 'move' | 'hover' | 'click' | 'type' | 'press' | 'scroll' | 'read' | 'tab_churn' | 'sequence';

export interface ActionRequest {
  kind: ActionKind;
  /** Element target: the node id the engine stamped, plus the width the collector measured. */
  identity?: string;
  backend_id?: string;
  target_width_px?: number;
  /** Absolute coordinates, used when there is no element to aim at. */
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  words?: number;
  direction?: 1 | -1;
  /** For `sequence`: the steps to run in order. */
  steps?: ActionRequest[];
  /** Set by the resolver when the caller named an element instead of coordinates. */
  resolved_from?: string;
  /** Override the profile's settle window for one click. */
  settle_ms?: number;
}

interface DriverEvent {
  dueMs: number;
  run: () => Promise<void>;
  label: string;
}

export interface DriverLogEntry {
  atMs: number;
  kind: string;
  detail: string;
}

export interface DriverState {
  id: string;
  sessionId: string;
  profile: HumanProfile;
  disclosure: Disclosure;
  surface: InputSurface;
  rng: () => number;
  running: boolean;
  startedAtMs: number;
  deadlineMs: number;
  stoppedReason?: string;
  pointer: Point;
  viewport: Point;
  /** When the pointer last moved, in wall-clock ms — the number the stillness ceiling is measured against. */
  lastPointerAtMs: number;
  nextIdleAtMs: number;
  events: DriverEvent[];
  queue: ActionRequest[];
  activeAction: { kind: ActionKind; startedAtMs: number; detail: string } | null;
  ticking: boolean;
  timer?: ReturnType<typeof setTimeout>;
  stats: {
    pointerMoves: number;
    drifts: number;
    clicks: number;
    keysDown: number;
    corrections: number;
    wheelBursts: number;
    tabSwitches: number;
    actionsFinished: number;
    actionsRefused: number;
    lockRenewals: number;
    /**
     * The driver's own lateness, in ms: how far behind the planned moment a pointer move actually
     * happened. A busy event loop delays the move, and the trace then shows a stillness the behaviour
     * never intended — without this, `verify` cannot tell a frozen cursor from a saturated machine.
     */
    schedulerLagMaxMs: number;
    schedulerLagSumMs: number;
    schedulerLagSamples: number;
  };
  log: DriverLogEntry[];
  /** Requests that were refused, with the reason: a silent refusal is a lost instruction. */
  refusals: Array<{ kind: string; reason: string; atMs: number }>;
}

const drivers = new Map<string, DriverState>();
const TICK_MIN_MS = 25;
const LOG_CAP = 200;

function driverId(seed: number): string {
  return `ph-${(seed >>> 0).toString(16).padStart(8, '0')}`;
}

function log(state: DriverState, kind: string, detail: string): void {
  state.log.push({ atMs: Date.now() - state.startedAtMs, kind, detail });
  if (state.log.length > LOG_CAP) state.log.shift();
}

/** Attach a driver to an open session. Nothing moves until `start`. */
export async function attach(input: {
  session_id: string;
  profile?: HumanProfile;
  disclosure: Disclosure;
}): Promise<DriverState> {
  const session: BrowserUseSession = requireSession(input.session_id);
  const surface = browserUseSurface(session);
  const profile = input.profile ?? createProfile({ seed: randomSeed() });
  const vp = await surface.viewport();
  await surface.installRecorder();
  const id = driverId(profile.seed ^ (Date.now() & 0xffffffff));
  const now = Date.now();
  const state: DriverState = {
    id,
    sessionId: session.id,
    profile,
    disclosure: input.disclosure,
    surface,
    rng: mulberry32(profile.seed),
    running: false,
    startedAtMs: now,
    deadlineMs: now + profile.maxRuntimeMs,
    pointer: { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2) },
    viewport: { x: vp.width, y: vp.height },
    lastPointerAtMs: now,
    nextIdleAtMs: now + nextIdleGap(profile, mulberry32(profile.seed)),
    events: [],
    queue: [],
    activeAction: null,
    ticking: false,
    stats: {
      pointerMoves: 0,
      drifts: 0,
      clicks: 0,
      keysDown: 0,
      corrections: 0,
      wheelBursts: 0,
      tabSwitches: 0,
      actionsFinished: 0,
      actionsRefused: 0,
      lockRenewals: 0,
      schedulerLagMaxMs: 0,
      schedulerLagSumMs: 0,
      schedulerLagSamples: 0,
    },
    log: [],
    refusals: [],
  };
  drivers.set(id, state);
  log(state, 'attach', `engine=${surface.engine} viewport=${vp.width}x${vp.height} seed=${profile.seed}`);
  return state;
}

export function getDriver(id: string | undefined): DriverState {
  const state = id ? drivers.get(id) : undefined;
  if (!state) throw new Error(`no ProHuman driver "${id ?? '(none given)'}" — attach one first`);
  if (!getSession(state.sessionId)) {
    shutdown(state, 'lost: its browser_use session is gone');
    drivers.delete(state.id);
    throw new Error(`driver "${state.id}" lost its session ${state.sessionId} and was stopped`);
  }
  return state;
}

/**
 * Forget drivers whose session is gone.
 *
 * The bridge closes sessions from several directions — a caller, an idle reap, a new open — and a driver
 * cannot hook that without importing the module that imports it. So the sweep runs where the pack is
 * already asked about its drivers: a dead session's driver is stopped (which releases its cursor lease)
 * and dropped, and the reason is kept in the answer rather than left as a live-looking object.
 */
function pruneDeadDrivers(): number {
  let dropped = 0;
  for (const state of [...drivers.values()]) {
    if (getSession(state.sessionId)) continue;
    shutdown(state, 'lost: its browser_use session is gone');
    drivers.delete(state.id);
    dropped++;
  }
  return dropped;
}

export function listDrivers(sessionId?: string): DriverState[] {
  pruneDeadDrivers();
  const all = [...drivers.values()];
  return sessionId ? all.filter((d) => d.sessionId === sessionId) : all;
}

export function start(id: string): { ok: boolean; reason?: string; state: DriverState } {
  const state = getDriver(id);
  if (state.running) return { ok: true, state, reason: 'already running' };
  const taken = acquirePointer(state.sessionId, { kind: 'driver', id: state.id, ttlMs: 15_000 });
  if (!taken.ok) {
    state.stats.actionsRefused += 1;
    state.refusals.push({
      kind: 'start',
      reason: taken.reason ?? 'pointer busy',
      atMs: Date.now() - state.startedAtMs,
    });
    return { ok: false, reason: taken.reason, state };
  }
  state.running = true;
  state.startedAtMs = Date.now();
  state.deadlineMs = state.startedAtMs + state.profile.maxRuntimeMs;
  state.lastPointerAtMs = Date.now();
  state.nextIdleAtMs = Date.now() + nextIdleGap(state.profile, state.rng);
  log(state, 'start', `runtime ceiling ${state.profile.maxRuntimeMs} ms`);
  schedule(state, 0);
  return { ok: true, state };
}

/** The teardown itself. It must never route through `getDriver`: pruning a driver whose session is gone
would otherwise refuse to clean itself up. */
function shutdown(state: DriverState, reason: string): DriverState {
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  if (state.running) {
    releasePointer(state.sessionId, state.id);
    log(state, 'stop', reason);
  }
  state.running = false;
  state.stoppedReason = reason;
  state.events = [];
  state.activeAction = null;
  return state;
}

/** Stop the loop and hand the cursor back. Idempotent: stopping a stopped driver is not an error. */
export function stop(id: string, reason = 'stopped'): { ok: boolean; state: DriverState } {
  const state = drivers.get(id);
  if (!state) throw new Error(`no ProHuman driver "${id}" — attach one first`);
  return { ok: true, state: shutdown(state, reason) };
}

/** Free everything a session held when it closes; a dead page must not keep a lease alive. */
export function stopAllFor(sessionId: string, reason = 'session closed'): number {
  let n = 0;
  for (const state of [...drivers.values()]) {
    if (state.sessionId !== sessionId) continue;
    stop(state.id, reason);
    drivers.delete(state.id);
    n++;
  }
  return n;
}

/** Drop a driver entirely, for detach. */
export function destroy(id: string, reason = 'detached'): { ok: boolean; state: DriverState } {
  const state = shutdown(getDriver(id), reason);
  drivers.delete(id);
  return { ok: true, state };
}

function schedule(state: DriverState, delayMs: number): void {
  if (!state.running) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => void tick(state), Math.max(TICK_MIN_MS, Math.round(delayMs)));
}

/**
 * One pass of the scheduler: serve whichever due-time is nearest, then reschedule for the next one.
 *
 * Every branch is a decision the caller can see in the status output — action event, idle drift, deadline,
 * lost page — because a scheduler that decides invisibly is indistinguishable from one that is not running.
 */
async function tick(state: DriverState): Promise<void> {
  if (!state.running || state.ticking) return;
  state.ticking = true;
  const now = Date.now();
  try {
    if (now >= state.deadlineMs) {
      stop(state.id, `expired: the profile's ${state.profile.maxRuntimeMs} ms runtime ceiling ran out`);
      return;
    }
    renewPointer(state.sessionId, state.id, now);
    state.stats.lockRenewals += 1;

    if (!state.activeAction && state.queue.length > 0) {
      const request = state.queue.shift() as ActionRequest;
      beginAction(state, request);
    }

    let nextDue = Infinity;

    if (state.activeAction && state.events.length > 0) {
      while (state.events.length > 0 && state.events[0].dueMs <= now) {
        const event = state.events.shift() as DriverEvent;
        await event.run();
      }
      if (state.events.length === 0) {
        finishAction(state);
      } else {
        nextDue = state.events[0].dueMs;
      }
    }

    if (!state.activeAction) {
      if (now >= state.nextIdleAtMs) {
        await drift(state, now);
        nextDue = state.nextIdleAtMs;
      } else {
        nextDue = state.nextIdleAtMs;
      }
    }

    if (!state.running) return;
    schedule(state, Math.min(nextDue === Infinity ? 500 : nextDue - Date.now(), 500));
  } catch (error) {
    // A driver that cannot reach its page is not running; pretending otherwise leaves a caller watching a
    // status that says `running: true` while nothing on screen moves.
    const message = (error as Error).message ?? String(error);
    shutdown(state, `lost: ${message}`);
    state.refusals.push({ kind: 'tick', reason: message, atMs: Date.now() - state.startedAtMs });
  } finally {
    state.ticking = false;
  }
}

/** Micro-drift: the pointer is never perfectly still while a driver is alive. */
async function drift(state: DriverState, now: number): Promise<void> {
  const gap = nextIdleGap(state.profile, state.rng);
  // How late this move is compared with the moment it was planned for. Positive only when the event
  // loop kept the driver waiting — the difference between a cursor that sat still and a machine that
  // could not move it.
  const lag = Math.max(0, now - state.nextIdleAtMs);
  state.stats.schedulerLagMaxMs = Math.max(state.stats.schedulerLagMaxMs, lag);
  state.stats.schedulerLagSumMs += lag;
  state.stats.schedulerLagSamples += 1;
  const next = planDrift(state.pointer, state.viewport, state.profile, state.rng);
  await state.surface.pointerMove(next.x, next.y);
  state.pointer = next;
  state.lastPointerAtMs = now;
  state.nextIdleAtMs = now + gap;
  state.stats.drifts += 1;
}

function refuse(state: DriverState, kind: string, reason: string): void {
  state.stats.actionsRefused += 1;
  state.refusals.push({ kind, reason, atMs: Date.now() - state.startedAtMs });
  log(state, 'refused', `${kind}: ${reason}`);
}

/** Build the event list for one action. Nothing here touches the page; that happens in `tick`. */
function beginAction(state: DriverState, request: ActionRequest): void {
  const write = writingAllowed(state.disclosure);
  if (!isReadOnlyAction(request.kind) && !write.ok) {
    refuse(state, request.kind, write.reason ?? 'consent does not allow writing');
    state.activeAction = null;
    state.nextIdleAtMs = Date.now() + nextIdleGap(state.profile, state.rng);
    return;
  }

  const profile = state.profile;
  const rng = state.rng;
  const events: DriverEvent[] = [];
  let cursor = state.pointer;
  let detail: string = request.kind;

  switch (request.kind) {
    case 'move':
    case 'hover':
    case 'click': {
      const to: Point =
        typeof request.x === 'number' && typeof request.y === 'number'
          ? { x: request.x, y: request.y }
          : { x: cursor.x + 40, y: cursor.y + 40 };
      const width = request.target_width_px ?? 0;
      const plan = planPath(cursor, to, width, profile, rng);
      let at = Date.now();
      for (const step of plan.steps) {
        at += step.delayMs;
        events.push({ dueMs: at, label: step.phase, run: makeMove(state, step) });
      }
      if (request.kind === 'click') {
        const settle = request.settle_ms ?? profile.pointer.settleMs;
        at += Math.round(settle * (0.4 + rng() * 0.6));
        events.push({
          dueMs: at,
          label: 'down',
          run: async () => {
            await state.surface.pointerDown();
            state.stats.clicks += 1;
          },
        });
        at += Math.round(45 + rng() * 70);
        events.push({
          dueMs: at,
          label: 'up',
          run: async () => {
            await state.surface.pointerUp();
          },
        });
        at += Math.round(120 + rng() * 380);
        events.push({
          dueMs: at,
          label: 'after-click pause',
          run: async () => {
            // The pause is a scheduled event, not an await: the idle drift keeps running through it.
          },
        });
      }
      cursor = to;
      detail = `${request.kind} ${Math.round(plan.directPx)}px, ${plan.steps.length} steps, ${plan.durationMs} ms${plan.overshot ? ', overshot' : ''}`;
      break;
    }
    case 'type': {
      const text = request.text ?? '';
      const plan = planTyping(text, profile, rng);
      let at = Date.now();
      for (const step of plan) {
        at += Math.round(step.holdMs * 0.4);
        const key = step.key;
        events.push({
          dueMs: at,
          label: step.kind,
          run: async () => {
            await state.surface.keyDown(key);
            state.stats.keysDown += 1;
            if (step.kind === 'correction') state.stats.corrections += 1;
          },
        });
        at += step.holdMs;
        events.push({ dueMs: at, label: `${key} up`, run: () => state.surface.keyUp(key) });
        at += step.gapMs;
      }
      detail = `type ${text.length} chars, ${plan.length} events, ${plan.filter((s) => s.kind === 'correction').length} corrections`;
      break;
    }
    case 'press': {
      const key = request.key ?? 'Tab';
      const now = Date.now();
      events.push({ dueMs: now, label: `down ${key}`, run: () => state.surface.keyDown(key) });
      events.push({
        dueMs:
          now +
          Math.round(profile.keyboard.holdMinMs + rng() * (profile.keyboard.holdMaxMs - profile.keyboard.holdMinMs)),
        label: `up ${key}`,
        run: () => state.surface.keyUp(key),
      });
      detail = `press ${key}`;
      break;
    }
    case 'scroll': {
      const bursts = planScroll(profile, rng, request.direction ?? 1);
      let at = Date.now();
      for (const burst of bursts) {
        at += burst.pauseMs;
        events.push({
          dueMs: at,
          label: burst.regression ? 're-read' : 'burst',
          run: async () => {
            await state.surface.wheel(burst.dy);
            state.stats.wheelBursts += 1;
          },
        });
      }
      detail = `scroll ${bursts.length} bursts (${bursts.filter((b) => b.regression).length} regressions)`;
      break;
    }
    case 'read': {
      const words = Math.max(1, Math.round(request.words ?? 40));
      const dwell = planDwell(words, profile, rng);
      const at = Date.now() + dwell;
      events.push({
        dueMs: at,
        label: 'dwell end',
        run: async () => {
          // Reading is the absence of action. The drift schedule is what proves it was not a hang.
        },
      });
      detail = `read ${words} words ≈ ${dwell} ms at ${profile.attention.readWpm} wpm`;
      break;
    }
    case 'tab_churn': {
      const at = Date.now();
      events.push({
        dueMs: at,
        label: 'switch',
        run: async () => {
          const tabs = await state.surface.listTabs();
          if (tabs.length < 2) {
            refuse(state, 'tab_churn', `only ${tabs.length} tab open — there is nothing to switch to`);
            return;
          }
          const others = tabs.filter((t) => !t.active);
          const pickFrom = others.length ? others : tabs;
          const target = pickFrom[Math.floor(rng() * pickFrom.length) % pickFrom.length];
          const result = await state.surface.activateTab(target.index);
          if (result.ok) {
            state.stats.tabSwitches += 1;
            log(state, 'tab_churn', `→ tab ${target.index} ${target.url.slice(0, 60)}`);
          } else {
            refuse(state, 'tab_churn', result.reason ?? 'activation refused');
          }
        },
      });
      const back = at + Math.round(1500 + rng() * 4500);
      events.push({
        dueMs: back,
        label: 'return',
        run: async () => {
          const tabs = await state.surface.listTabs();
          const own = tabs.find((t) => t.active === false);
          if (own) await state.surface.activateTab(own.index);
        },
      });
      detail = 'tab churn';
      break;
    }
    case 'sequence':
      // Sequences are expanded at enqueue time, never here.
      break;
  }

  state.pointer = cursor;
  state.events = events;
  state.activeAction = { kind: request.kind, startedAtMs: Date.now(), detail };
  log(state, 'action', detail);
}

function makeMove(state: DriverState, step: PathStep): () => Promise<void> {
  return async () => {
    await state.surface.pointerMove(step.x, step.y);
    state.pointer = { x: step.x, y: step.y };
    state.lastPointerAtMs = Date.now();
    state.stats.pointerMoves += 1;
  };
}

function finishAction(state: DriverState): void {
  if (state.activeAction) {
    state.stats.actionsFinished += 1;
    log(state, 'done', state.activeAction.detail);
  }
  state.activeAction = null;
  state.nextIdleAtMs = Date.now() + nextIdleGap(state.profile, state.rng);
}

/**
 * Record a refusal the tool layer made before enqueueing.
 *
 * Without this, `status.refusals` only shows refusals the driver itself raised, and a session that was
 * denied every click by its own consent looks like a session where nothing was ever asked.
 */
export function noteRefusal(state: DriverState, kind: string, reason: string): void {
  refuse(state, kind, reason);
}

/** Actions that do not change the page: allowed even under `public-read-only`. */
export function isReadOnlyAction(kind: ActionKind): boolean {
  return kind === 'move' || kind === 'hover' || kind === 'read' || kind === 'sequence';
}

/**
 * Enqueue one action. Returns the queue length so a caller can tell whether it landed behind a long
 * sequence or ran immediately.
 */
export function enqueue(id: string, request: ActionRequest): { ok: boolean; queued: number; reason?: string } {
  const state = getDriver(id);
  const write = writingAllowed(state.disclosure);
  if (!isReadOnlyAction(request.kind) && !write.ok) {
    refuse(state, request.kind, write.reason ?? 'consent does not allow writing');
    return { ok: false, queued: state.queue.length, reason: write.reason };
  }
  if (request.kind === 'sequence' && Array.isArray(request.steps)) {
    for (const step of request.steps) {
      if (step.kind === 'sequence') {
        return { ok: false, queued: state.queue.length, reason: 'a sequence cannot contain another sequence' };
      }
      state.queue.push(step);
    }
    log(state, 'sequence', `${request.steps.length} step(s) queued`);
    if (!state.running) start(state.id);
    return { ok: true, queued: state.queue.length };
  }
  state.queue.push(request);
  if (!state.running) start(state.id);
  return { ok: true, queued: state.queue.length };
}

/** Who holds the cursor right now, for `status` and for a refusal that names the holder. */
export function cursorHolder(sessionId: string) {
  return pointerHolder(sessionId);
}

/** The trace the page recorded, for measurement. */
export async function harvest(
  id: string,
): Promise<{ events: Awaited<ReturnType<InputSurface['readTrace']>>; state: DriverState }> {
  const state = getDriver(id);
  return { events: await state.surface.readTrace(), state };
}

export function statusOf(state: DriverState): Record<string, unknown> {
  const now = Date.now();
  return {
    id: state.id,
    session_id: state.sessionId,
    engine: state.surface.engine,
    running: state.running,
    stopped_reason: state.stoppedReason ?? null,
    uptime_ms: now - state.startedAtMs,
    runtime_left_ms: Math.max(0, state.deadlineMs - now),
    pointer: state.pointer,
    pointer_last_moved_ms_ago: now - state.lastPointerAtMs,
    active_action: state.activeAction,
    queued: state.queue.length,
    pending_events: state.events.length,
    stats: state.stats,
    /** Derived from the stats above: the driver's own worst and average lateness behind plan time. */
    scheduler_lag_ms: {
      max_ms: state.stats.schedulerLagMaxMs,
      mean_ms: state.stats.schedulerLagSamples
        ? Math.round(state.stats.schedulerLagSumMs / state.stats.schedulerLagSamples)
        : 0,
      samples: state.stats.schedulerLagSamples,
    },
    refusals: state.refusals.slice(-10),
    log: state.log.slice(-20),
    profile: {
      name: state.profile.name,
      seed: state.profile.seed,
      idle_stillness_ms: state.profile.pointer.idleStillnessMs,
    },
    cursor_holder: cursorHolder(state.sessionId),
  };
}
