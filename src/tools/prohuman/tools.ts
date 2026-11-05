/**
 * The ProHuman tool surface: twenty tools, one behaviour model behind them.
 *
 * ## Why they live in one file
 *
 * The packs that register eleven tools in one file (`sql`, `qr`, `encoding`) were invisible to the mutation
 * scanner for months, because it read the first tool name per file and stopped. That is now fixed — the scan
 * collects every registration in the file — so grouping them here keeps the shared input contract in one
 * place instead of twenty copies of the same five lines.
 *
 * ## What every writing tool does before it writes
 *
 * 1. refuses when the server runs in read-only mode, naming that as the reason rather than the caller's;
 * 2. refuses when the disclosure says nobody with authority over the site said yes, and records the refusal
 *    on the driver so `status` shows what was asked and denied;
 * 3. refuses when another writer holds the cursor, and names that holder;
 * 4. resolves a named element to the coordinates the engine measured, or refuses with the reason;
 * 5. otherwise enqueues the action and answers immediately — the driver runs on its own clock, which is the
 *    whole reason it exists.
 */

import { defineTool } from '../../core/tool.js';
import { assertWritable } from '../../core/read-only-guard.js';
import { optionalStr, num, bool } from '../../core/input.js';
import { fail, failJson, jsonBlock } from '../../core/format.js';
import { PRESETS, LIMITS, profileSummary } from '../../core/prohuman-profile.js';
import {
  attach,
  start,
  stop,
  destroy,
  enqueue,
  statusOf,
  harvest,
  listDrivers,
  noteRefusal,
  isReadOnlyAction,
  type ActionRequest,
} from '../../core/prohuman-driver.js';
import { measureTrace, stillnessVerdict, type TraceEvent } from '../../core/prohuman-metrics.js';
import { disclosureEcho, writingAllowed } from '../../core/prohuman-disclosure.js';
import { pointerHolder } from '../../core/prohuman-lock.js';
import {
  answer,
  driver,
  pick,
  readAction,
  readDisclosure,
  readProfile,
  resolveTarget,
  writeModeBlocked,
} from './_shared.js';

/** Where to aim: coordinates, or an element the engine already read. */
const TARGET_PROPS = {
  x: { type: 'number', description: 'Absolute css-viewport x to reach for' },
  y: { type: 'number', description: 'Absolute css-viewport y to reach for' },
  identity: { type: 'string', description: 'Element identity from the session’s last read — resolved to its centre' },
  node_id: { type: 'string', description: 'Node id from the same read, if the identity is not at hand' },
  target_width_px: {
    type: 'number',
    description:
      'Target width in CSS px. Fitts’ law needs it; 0 means a point, which plans a slower, overshooting reach',
  },
  wait_ms: {
    type: 'number',
    description: 'Let the driver run this long before answering (default 0 = answer immediately)',
  },
};

const DISCLOSURE_PROPS = {
  identity: {
    type: 'object',
    description: 'Who this session is: {name, contact_url, purpose}. Required — ProHuman does not run anonymously',
  },
  consent: {
    type: 'string',
    enum: ['own-site', 'authorized', 'public-read-only'],
    description:
      'Whose permission the session has. public-read-only (the default) allows observation and measurement, and refuses every action that changes a page',
  },
  robots: { type: 'object', description: 'Optional robots.txt decision: {allowed, reason, source, crawl_delay_ms}' },
};

function driverArg(description = 'Driver returned by pro_human_attach') {
  return { driver_id: { type: 'string', description } };
}

async function runAction(input: Record<string, unknown>, kind: ActionRequest['kind'], summary: string) {
  const blocked = writeModeBlocked();
  if (blocked.blocked) return fail(blocked.message);
  const found = driver(input.driver_id);
  if (!found.ok) return fail(found.error!);
  const state = found.value;

  if (!isReadOnlyAction(kind)) {
    const write = writingAllowed(state.disclosure);
    if (!write.ok) {
      noteRefusal(state, kind, write.reason ?? 'consent does not allow writing');
      return failJson('action refused', {
        ok: false,
        action: kind,
        reason: write.reason,
        disclosure: disclosureEcho(state.disclosure),
      });
    }
    assertWritable(`ProHuman ${kind} on session ${state.sessionId}`);
  }

  const holder = pointerHolder(state.sessionId);
  if (holder && holder.id !== state.id) {
    return failJson('pointer busy', {
      ok: false,
      action: kind,
      reason: `${holder.kind} "${holder.id}" holds the cursor; stop it or wait for its lease to expire`,
    });
  }

  const request = readAction(input, kind);
  if (input.settle_ms !== undefined) request.settle_ms = num(input, 'settle_ms', 0, 0, 5000);
  const resolved = resolveTarget(state, request);
  if (!resolved.ok) return fail(resolved.error!);
  if (kind === 'move' || kind === 'hover' || kind === 'click') {
    if (resolved.value.x === undefined || resolved.value.y === undefined) {
      return fail('this action needs x and y, or an identity/node_id that is in the session’s latest read');
    }
  }
  const queued = enqueue(state.id, resolved.value);
  if (!queued.ok) return fail(queued.reason ?? 'refused');

  const waitMs = num(input, 'wait_ms', 0, 0, 60_000);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  return answer(summary, state, {
    queued: queued.queued,
    waited_ms: waitMs,
    ...(resolved.value.resolved_from ? { aimed_at: resolved.value.resolved_from } : {}),
    status: statusOf(state),
  });
}

const tools = [
  defineTool({
    name: 'pro_human_profiles',
    description:
      'List the human behaviour presets and the ranges a profile may take. Pure data: nothing is attached, nothing moves.',
    category: 'prohuman',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async handler() {
      return jsonBlock(`${Object.keys(PRESETS).length} presets`, {
        ok: true,
        presets: Object.fromEntries(Object.entries(PRESETS).map(([name, p]) => [name, p])),
        limits: LIMITS,
        note: 'presets differ in numbers only; every action tool takes the same overrides',
      });
    },
  }),

  defineTool({
    name: 'pro_human_profile_check',
    description:
      'Normalise a profile from a preset plus overrides and return the effective numbers, without touching a session. Out-of-range values are refused here rather than discovered mid-movement.',
    category: 'prohuman',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        preset: { type: 'string', description: 'calm | fast | impatient | one_handed | touchpad | tired' },
        profile_name: { type: 'string', description: 'Label carried into every later answer' },
        seed: { type: 'number', description: 'Fix the randomness so a run can be reproduced' },
        max_runtime_ms: { type: 'number', description: 'How long a driver may run unattended (1s..10min)' },
        pointer: { type: 'object', description: 'Overrides for the pointer block' },
        keyboard: { type: 'object', description: 'Overrides for the keyboard block' },
        scroll: { type: 'object', description: 'Overrides for the scroll block' },
        attention: { type: 'object', description: 'Overrides for the attention block' },
      },
      required: [],
      additionalProperties: false,
    },
    async handler(input) {
      const parsed = readProfile({
        preset: optionalStr(input, 'preset'),
        profile_name: optionalStr(input, 'profile_name'),
        seed: input.seed,
        max_runtime_ms: input.max_runtime_ms,
        pointer: input.pointer,
        keyboard: input.keyboard,
        scroll: input.scroll,
        attention: input.attention,
      });
      if (!parsed.ok) return fail(parsed.error!);
      return jsonBlock(`profile "${parsed.value.name}" is valid`, {
        ok: true,
        profile: profileSummary(parsed.value),
        note: 'the seed is random unless you pass one; reproducibility is per run, not across runs',
      });
    },
  }),

  defineTool({
    name: 'pro_human_attach',
    description:
      'Attach a ProHuman driver to an open browser_use session and install the page-side event recorder. Nothing moves until pro_human_start. Identity and consent are required.',
    category: 'prohuman',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'An open browser_use session' },
        ...DISCLOSURE_PROPS,
        preset: { type: 'string', description: 'Behaviour preset to start from' },
        profile_name: { type: 'string', description: 'Label for the profile' },
        seed: { type: 'number', description: 'Fix the randomness' },
        max_runtime_ms: { type: 'number', description: 'Runtime ceiling for the driver' },
        pointer: { type: 'object', description: 'Overrides for the pointer block' },
        keyboard: { type: 'object', description: 'Overrides for the keyboard block' },
        scroll: { type: 'object', description: 'Overrides for the scroll block' },
        attention: { type: 'object', description: 'Overrides for the attention block' },
      },
      required: ['session_id', 'identity'],
      additionalProperties: false,
    },
    async handler(input) {
      const blocked = writeModeBlocked();
      if (blocked.blocked) return fail(blocked.message);
      assertWritable('ProHuman attach (installs a recorder in the page)');
      const sessionId = optionalStr(input, 'session_id');
      if (!sessionId) return fail('session_id is required');
      const profile = readProfile({
        preset: optionalStr(input, 'preset'),
        profile_name: optionalStr(input, 'profile_name'),
        seed: input.seed,
        max_runtime_ms: input.max_runtime_ms,
        pointer: input.pointer,
        keyboard: input.keyboard,
        scroll: input.scroll,
        attention: input.attention,
      });
      if (!profile.ok) return fail(profile.error!);
      const disclosure = readDisclosure(input);
      if (!disclosure.ok) return fail(disclosure.error!);
      try {
        const state = await attach({ session_id: sessionId, profile: profile.value, disclosure: disclosure.value });
        return jsonBlock(`driver ${state.id} attached`, {
          ok: true,
          driver_id: state.id,
          session_id: state.sessionId,
          engine: state.surface.engine,
          profile: profileSummary(state.profile),
          disclosure: disclosureEcho(state.disclosure),
          running: state.running,
          note: 'the recorder is armed for this document and for every document a navigation creates',
        });
      } catch (error) {
        return fail(`attach failed: ${(error as Error).message}`);
      }
    },
  }),

  defineTool({
    name: 'pro_human_start',
    description:
      'Start a driver: it takes the cursor and keeps it alive, drifting on its own schedule until it is stopped or its runtime ceiling expires.',
    category: 'prohuman',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: driverArg('Driver to start'),
      required: ['driver_id'],
      additionalProperties: false,
    },
    async handler(input) {
      const blocked = writeModeBlocked();
      if (blocked.blocked) return fail(blocked.message);
      assertWritable('ProHuman start (takes the cursor)');
      const found = driver(input.driver_id);
      if (!found.ok) return fail(found.error!);
      const result = start(found.value.id);
      if (!result.ok) {
        return failJson('start refused', {
          ok: false,
          reason: result.reason,
          holder: pointerHolder(found.value.sessionId),
        });
      }
      return answer('driver running', found.value, { status: statusOf(found.value) });
    },
  }),

  defineTool({
    name: 'pro_human_stop',
    description: 'Stop a driver and hand the cursor back. Idempotent, and it reports what the driver did.',
    category: 'prohuman',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ...driverArg('Driver to stop'),
        reason: { type: 'string', description: 'Why, recorded in the driver log' },
      },
      required: ['driver_id'],
      additionalProperties: false,
    },
    async handler(input) {
      const found = driver(input.driver_id);
      if (!found.ok) return fail(found.error!);
      const stopped = stop(found.value.id, optionalStr(input, 'reason') ?? 'stopped by the caller');
      return jsonBlock('driver stopped', {
        ok: true,
        driver_id: found.value.id,
        reason: stopped.state.stoppedReason,
        stats: stopped.state.stats,
        refusals: stopped.state.refusals.slice(-10),
        cursor_holder: pointerHolder(stopped.state.sessionId),
      });
    },
  }),

  defineTool({
    name: 'pro_human_detach',
    description: 'Stop a driver and forget it. The page keeps the recorder until it is navigated away.',
    category: 'prohuman',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: driverArg('Driver to destroy'),
      required: ['driver_id'],
      additionalProperties: false,
    },
    async handler(input) {
      const found = driver(input.driver_id);
      if (!found.ok) return fail(found.error!);
      const result = destroy(found.value.id, 'detached');
      return jsonBlock('driver detached', {
        ok: true,
        driver_id: found.value.id,
        session_id: found.value.sessionId,
        stats: result.state.stats,
        still_attached: listDrivers(found.value.sessionId).length,
      });
    },
  }),

  defineTool({
    name: 'pro_human_list',
    description:
      'List the drivers that exist, optionally filtered to one session. Drivers whose session is gone are dropped here.',
    category: 'prohuman',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string', description: 'Only this session' } },
      required: [],
      additionalProperties: false,
    },
    async handler(input) {
      const only = optionalStr(input, 'session_id');
      const all = listDrivers(only);
      return jsonBlock(`${all.length} driver(s)`, {
        ok: true,
        drivers: all.map((d) => ({
          id: d.id,
          session_id: d.sessionId,
          running: d.running,
          stopped_reason: d.stoppedReason ?? null,
          profile: d.profile.name,
          seed: d.profile.seed,
          stats: d.stats,
        })),
      });
    },
  }),

  defineTool({
    name: 'pro_human_status',
    description:
      'What the driver is doing right now: the pointer, how long since it last moved, the active action, the queue, the counters and the refusals.',
    category: 'prohuman',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: driverArg('Driver to inspect'),
      required: ['driver_id'],
      additionalProperties: false,
    },
    async handler(input) {
      const found = driver(input.driver_id);
      if (!found.ok) return fail(found.error!);
      return jsonBlock(found.value.running ? 'driver running' : `driver ${found.value.stoppedReason ?? 'stopped'}`, {
        ok: true,
        ...statusOf(found.value),
      });
    },
  }),

  defineTool({
    name: 'pro_human_move',
    description:
      'Reach a point along a curved, minimum-jerk path sized by Fitts’ law, ending with a settle window. Returns immediately; the movement happens on the driver’s clock.',
    category: 'prohuman',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: { ...driverArg(), ...TARGET_PROPS },
      required: ['driver_id'],
      additionalProperties: false,
    },
    async handler(input) {
      return runAction(
        pick(input, ['driver_id', 'x', 'y', 'identity', 'node_id', 'target_width_px', 'wait_ms']),
        'move',
        'move queued',
      );
    },
  }),

  defineTool({
    name: 'pro_human_hover',
    description: 'Reach a point and rest on it — the pointer arrives, settles and stays, the way a hover is entered.',
    category: 'prohuman',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: { ...driverArg(), ...TARGET_PROPS },
      required: ['driver_id'],
      additionalProperties: false,
    },
    async handler(input) {
      return runAction(
        pick(input, ['driver_id', 'x', 'y', 'identity', 'node_id', 'target_width_px', 'wait_ms']),
        'hover',
        'hover queued',
      );
    },
  }),

  defineTool({
    name: 'pro_human_click',
    description:
      'Reach a target, settle on it, press, release and pause afterwards. Refused unless the session says whose site it is and that writing is allowed.',
    category: 'prohuman',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ...driverArg(),
        ...TARGET_PROPS,
        settle_ms: { type: 'number', description: 'Override the profile’s settle window for this click (ms)' },
      },
      required: ['driver_id'],
      additionalProperties: false,
    },
    async handler(input) {
      return runAction(
        pick(input, [...['driver_id', 'x', 'y', 'identity', 'node_id', 'target_width_px', 'wait_ms'], 'settle_ms']),
        'click',
        'click queued',
      );
    },
  }),

  defineTool({
    name: 'pro_human_type',
    description:
      'Type text with a cadence: per-key hold and gap, longer at word boundaries and punctuation, and seeded mistakes that are corrected with backspaces.',
    category: 'prohuman',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ...driverArg(),
        text: { type: 'string', description: 'The text to type' },
        wait_ms: { type: 'number', description: 'Let it run this long before answering' },
      },
      required: ['driver_id', 'text'],
      additionalProperties: false,
    },
    async handler(input) {
      if (!optionalStr(input, 'text')) return fail('text is required');
      return runAction(
        pick(input, ['driver_id', 'text', 'key', 'direction', 'words', 'wait_ms']),
        'type',
        'typing queued',
      );
    },
  }),

  defineTool({
    name: 'pro_human_press',
    description: 'Press one key with a human hold duration — Enter, Tab, Escape, a shortcut.',
    category: 'prohuman',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ...driverArg(),
        key: { type: 'string', description: 'Key name, as the engine names it' },
        wait_ms: { type: 'number', description: 'Let it run this long before answering' },
      },
      required: ['driver_id', 'key'],
      additionalProperties: false,
    },
    async handler(input) {
      return runAction(
        pick(input, ['driver_id', 'text', 'key', 'direction', 'words', 'wait_ms']),
        'press',
        'key press queued',
      );
    },
  }),

  defineTool({
    name: 'pro_human_scroll',
    description: 'Scroll in bursts of differing amplitude with pauses between them, and occasional short scrolls back.',
    category: 'prohuman',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ...driverArg(),
        direction: { type: 'number', description: '1 down (default), -1 up' },
        wait_ms: { type: 'number', description: 'Let it run this long before answering' },
      },
      required: ['driver_id'],
      additionalProperties: false,
    },
    async handler(input) {
      return runAction(
        pick(input, ['driver_id', 'text', 'key', 'direction', 'words', 'wait_ms']),
        'scroll',
        'scroll queued',
      );
    },
  }),

  defineTool({
    name: 'pro_human_read',
    description:
      'Dwell for as long as reading `words` words takes at the profile’s rate. The pointer keeps drifting through it — which is what separates reading from hanging.',
    category: 'prohuman',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ...driverArg(),
        words: { type: 'number', description: 'How many words are being read (default 40)' },
        wait_ms: { type: 'number', description: 'Let it run this long before answering' },
      },
      required: ['driver_id'],
      additionalProperties: false,
    },
    async handler(input) {
      return runAction(
        pick(input, ['driver_id', 'text', 'key', 'direction', 'words', 'wait_ms']),
        'read',
        'reading queued',
      );
    },
  }),

  defineTool({
    name: 'pro_human_tab_churn',
    description:
      'Switch to another tab, stay a while, come back. Refused when only one tab is open — a driver that invents attention it cannot show is worse than one that says no.',
    category: 'prohuman',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: { ...driverArg(), wait_ms: { type: 'number', description: 'Let it run this long before answering' } },
      required: ['driver_id'],
      additionalProperties: false,
    },
    async handler(input) {
      return runAction(pick(input, ['driver_id', 'wait_ms']), 'tab_churn', 'tab churn queued');
    },
  }),

  defineTool({
    name: 'pro_human_sequence',
    description:
      'Queue several actions in order — read, move, click, type — and let the driver run them on its own clock. Returns immediately; the answer says how many are queued.',
    category: 'prohuman',
    annotations: { readOnlyHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ...driverArg(),
        steps: {
          type: 'array',
          description: 'JSON array of {kind, x, y, identity, node_id, text, key, words, target_width_px}',
        },
        wait_ms: { type: 'number', description: 'Let the sequence run this long before answering' },
      },
      required: ['driver_id', 'steps'],
      additionalProperties: false,
    },
    async handler(input) {
      const blocked = writeModeBlocked();
      if (blocked.blocked) return fail(blocked.message);
      const found = driver(input.driver_id);
      if (!found.ok) return fail(found.error!);
      let steps: unknown;
      try {
        steps = typeof input.steps === 'string' ? JSON.parse(input.steps) : (input.steps ?? []);
      } catch (error) {
        return fail(`steps must be a JSON array: ${(error as Error).message}`);
      }
      if (!Array.isArray(steps) || steps.length === 0) return fail('steps must be a non-empty JSON array');
      if (steps.length > 40) return fail(`steps has ${steps.length} entries; the limit is 40`);
      const requests: ActionRequest[] = [];
      const aimed: string[] = [];
      for (const [index, raw] of steps.entries()) {
        if (!raw || typeof raw !== 'object') return fail(`steps[${index}] is not an object`);
        const rec = raw as Record<string, unknown>;
        const kind = optionalStr(rec, 'kind') as ActionRequest['kind'] | undefined;
        if (!kind || !['move', 'hover', 'click', 'type', 'press', 'scroll', 'read', 'tab_churn'].includes(kind)) {
          return fail(`steps[${index}].kind must be one of move, hover, click, type, press, scroll, read, tab_churn`);
        }
        const step = readAction(rec, kind);
        if (rec.settle_ms !== undefined) step.settle_ms = num(rec, 'settle_ms', 0, 0, 5000);
        const resolvedStep = resolveTarget(found.value, step);
        if (!resolvedStep.ok) return fail(`steps[${index}]: ${resolvedStep.error}`);
        if (resolvedStep.value.resolved_from) aimed.push(resolvedStep.value.resolved_from);
        requests.push(resolvedStep.value);
      }
      assertWritable(`ProHuman sequence of ${requests.length} action(s)`);
      const queued = enqueue(found.value.id, { kind: 'sequence', steps: requests });
      if (!queued.ok) return fail(queued.reason ?? 'refused');
      const waitMs = num(input, 'wait_ms', 0, 0, 60_000);
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      return answer('sequence queued', found.value, {
        steps: requests.length,
        waited_ms: waitMs,
        ...(aimed.length ? { aimed_at: aimed } : {}),
        status: statusOf(found.value),
      });
    },
  }),

  defineTool({
    name: 'pro_human_trace',
    description:
      'The events the page itself recorded — type, timeStamp, isTrusted, coordinates, keys. This is the evidence; the driver’s log is only intent.',
    category: 'prohuman',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ...driverArg('Driver whose page is measured'),
        limit: { type: 'number', description: 'Most recent events to return (default 200, 0 for all)' },
        clear: {
          type: 'boolean',
          description: 'Empty the buffer after reading, so the next measurement covers one window',
        },
      },
      required: ['driver_id'],
      additionalProperties: false,
    },
    async handler(input) {
      const found = driver(input.driver_id);
      if (!found.ok) return fail(found.error!);
      let events: TraceEvent[];
      try {
        events = (await harvest(found.value.id)).events;
      } catch (error) {
        return fail(`the page could not be read: ${(error as Error).message}`);
      }
      const limit = num(input, 'limit', 200, 0);
      const slice = limit === 0 ? events : events.slice(-limit);
      const shouldClear = bool(input, 'clear', false);
      if (shouldClear) {
        try {
          await found.value.surface.clearTrace();
        } catch (error) {
          return fail(`trace read, but the buffer could not be cleared: ${(error as Error).message}`);
        }
      }
      return jsonBlock(`${slice.length} of ${events.length} recorded events`, {
        ok: true,
        driver_id: found.value.id,
        document: await found.value.surface.currentUrl().catch(() => 'unknown'),
        returned: slice.length,
        total: events.length,
        cleared: shouldClear,
        events: slice,
      });
    },
  }),

  defineTool({
    name: 'pro_human_report',
    description:
      'Measure the recorded trace: curvature, tortuosity, inter-event variation, key holds, stillness and the trusted ratio — the numbers the profile asked for beside the ones that happened.',
    category: 'prohuman',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ...driverArg('Driver to measure'),
        clear: { type: 'boolean', description: 'Empty the buffer after measuring' },
      },
      required: ['driver_id'],
      additionalProperties: false,
    },
    async handler(input) {
      const found = driver(input.driver_id);
      if (!found.ok) return fail(found.error!);
      let events: TraceEvent[];
      try {
        events = (await harvest(found.value.id)).events;
      } catch (error) {
        return fail(`the page could not be read: ${(error as Error).message}`);
      }
      const profile = found.value.profile;
      const measured = measureTrace(events, profile.pointer.noiseFloorPx);
      const verdict = stillnessVerdict(events, profile.pointer.idleStillnessMs);
      if (bool(input, 'clear', false)) await found.value.surface.clearTrace().catch(() => {});
      return jsonBlock(
        measured.pointerEvents < 2
          ? 'nothing to measure yet'
          : `${measured.pointerEvents} pointer events over ${measured.windowMs} ms`,
        {
          ok: true,
          driver_id: found.value.id,
          measured,
          stillness: verdict,
          asked_for: {
            idle_stillness_ms: profile.pointer.idleStillnessMs,
            sigma_curve_px: profile.pointer.sigmaCurvePx,
            wpm: profile.keyboard.wpm,
            noise_floor_px: profile.pointer.noiseFloorPx,
          },
          driver_stats: found.value.stats,
          disclosure: disclosureEcho(found.value.disclosure),
          limits:
            measured.trustedRatio < 1
              ? 'some recorded events were not trusted — they were dispatched by script, not by the browser'
              : '',
        },
      );
    },
  }),

  defineTool({
    name: 'pro_human_verify',
    description:
      'The one claim this pack can make honestly: did the pointer ever hold still longer than the profile allows? An empty trace is a failure, not a pass.',
    category: 'prohuman',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ...driverArg('Driver to check'),
        ceiling_ms: { type: 'number', description: 'Override the profile’s stillness ceiling for this check' },
      },
      required: ['driver_id'],
      additionalProperties: false,
    },
    async handler(input) {
      const found = driver(input.driver_id);
      if (!found.ok) return fail(found.error!);
      let events: TraceEvent[];
      try {
        events = (await harvest(found.value.id)).events;
      } catch (error) {
        return fail(`the page could not be read: ${(error as Error).message}`);
      }
      const ceiling =
        input.ceiling_ms !== undefined ? num(input, 'ceiling_ms', 0, 1) : found.value.profile.pointer.idleStillnessMs;
      const verdict = stillnessVerdict(events, ceiling);
      const measured = measureTrace(events, found.value.profile.pointer.noiseFloorPx);
      return jsonBlock(
        verdict.ok ? `no stillness over ${verdict.ceilingMs} ms` : `the pointer held still for ${verdict.worstMs} ms`,
        {
          ok: verdict.ok,
          verdict,
          trusted_ratio: measured.trustedRatio,
          explanation:
            verdict.samples < 2
              ? 'fewer than two recorded pointer events: this says the recorder or the session is broken, not that the pointer was steady'
              : '',
        },
      );
    },
  }),
];

export default tools;
