/**
 * Task scheduling with resource conflicts (spec §5.5).
 *
 * A task graph is a DAG, and a DAG invites the assumption that everything not blocked by a
 * dependency can run at once. For read-only steps that is true. For steps that write the same
 * deliverable it is not: two tasks producing `dashboard.html` will overwrite each other, and neither
 * result is reproducible afterwards.
 *
 * So the scheduler serialises on the pair (shared deliverable, at least one side actually writes).
 * Whether a side writes is decided by the registry (`isMutationTool`, through `assessPlan`), not by
 * the plan's own claim — the same reason the approval gate does not trust `sensitivity`: a label that
 * says `read_only` on a writing tool would otherwise turn the serialisation off by mislabelling.
 */

import { assessPlan } from './risk.js';
import type { Task } from './types.js';

/** Statuses that occupy a resource. `needs_verification` is deliberately absent: that work must be
 * handed out again, not treated as still running. */
const IN_FLIGHT: readonly Task['status'][] = ['in_progress'];

/** Does this task's plan contain a step the registry says can change state? */
export function taskWrites(task: Task): boolean {
  return assessPlan([task]).some((risk) => risk.mutating);
}

/**
 * Argument names that identify a resource the step touches. Not a whitelist of tools: any key that
 * names a path, key, dataset or endpoint counts, because that is what a conflict is made of.
 */
const RESOURCE_ARG_KEYS = [
  'path',
  'file',
  'filename',
  'file_path',
  'output_path',
  'dir',
  'directory',
  'key',
  'cache_key',
  'dataset',
  'table',
  'bucket',
  'prefix',
  'queue',
  'channel',
  'webhook',
  'webhook_url',
  'url',
  'endpoint',
  'session_id',
  'issue_id',
  'pull_id',
  'pr_id',
  'page_id',
  'note_id',
  'task_id',
  'glob',
];

/** One argument value into a comparable resource id. URLs lose query and fragment; everything is trimmed. */
function resourceKey(value: unknown): string | null {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!text) return null;
  if (/^https?:\/\//.test(text)) {
    try {
      const url = new URL(text);
      return `${url.host.replace(/^www\./, '')}${url.pathname}`.replace(/\/+$/, '') || url.host;
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * What a task touches: declared deliverables and writes, plus whatever its step arguments name.
 *
 * Inferring from arguments is what makes this more than a paperwork check. A plan that says
 * `cache_put {key: "bench"}` twice conflicts whether or not anybody wrote it in `deliverables`;
 * the declaration is now the escape hatch for steps whose arguments are not known yet, not the only
 * way the scheduler can see anything.
 */
export function taskResources(task: Task): Set<string> {
  const found = new Set<string>();
  for (const item of [...(task.deliverables ?? []), ...(task.writes ?? [])]) {
    const key = resourceKey(item);
    if (key) found.add(key);
  }
  for (const plan of task.toolPlan ?? []) {
    for (const [name, value] of Object.entries(plan.arguments ?? {})) {
      if (!RESOURCE_ARG_KEYS.includes(name.toLowerCase())) continue;
      const key = resourceKey(value);
      if (key) found.add(key);
    }
  }
  return found;
}

/** A resource both tasks name, if any. */
function sharedResource(left: Task, right: Task): string | null {
  const leftResources = taskResources(left);
  for (const resource of taskResources(right)) if (leftResources.has(resource)) return resource;
  return null;
}

/**
 * Two tasks that would modify the same resource at the same time (§5.5).
 *
 * A writer and a reader of the same deliverable is not what the spec serialises, and blocking it
 * would stop half of ordinary plans for no stated reason; it is reported to the auditor instead.
 */
export function conflicts(left: Task, right: Task): string | null {
  if (left.id === right.id) return null;
  if (!taskWrites(left) || !taskWrites(right)) return null;
  return sharedResource(left, right);
}

/**
 * The work that could run concurrently right now (§4.5): dependencies satisfied, not already in
 * flight, and not racing another ready task for the same deliverable.
 */
export function parallelisableTasks(tasks: Task[]): string[] {
  const done = new Set(tasks.filter((task) => task.status === 'verified').map((task) => task.id));
  const ready = tasks.filter(
    (task) =>
      task.status !== 'verified' && !IN_FLIGHT.includes(task.status) && task.dependsOn.every((dep) => done.has(dep)),
  );
  const chosen: Task[] = [];
  for (const candidate of ready) {
    if (!chosen.some((other) => conflicts(candidate, other))) chosen.push(candidate);
  }
  return chosen.map((task) => task.id);
}

/** Every pair touching the same deliverable, flagged by whether both of them write it. */
export function planConflicts(tasks: Task[]): { resource: string; tasks: [string, string]; bothWrite: boolean }[] {
  const found: { resource: string; tasks: [string, string]; bothWrite: boolean }[] = [];
  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const resource = sharedResource(tasks[i], tasks[j]);
      if (!resource) continue;
      found.push({
        resource,
        tasks: [tasks[i].id, tasks[j].id],
        bothWrite: taskWrites(tasks[i]) && taskWrites(tasks[j]),
      });
    }
  }
  return found;
}

export interface NextRunnable {
  /** The task that may start now, or `null` when nothing is free. */
  task: Task | null;
  /** Set when a task was ready on dependencies but is waiting for an in-flight writer. */
  waitingOn: string | null;
  /** How many ready tasks were skipped for conflict, which is what §20.5 wants counted. */
  serialised: number;
}

/**
 * Pick the next task to run: dependencies verified, and no in-flight task writing the same
 * deliverable. Order is the plan's own order, so a host that sequenced the graph deliberately gets
 * the sequence it asked for.
 */
export function nextRunnable(tasks: Task[]): NextRunnable {
  const done = new Set(tasks.filter((task) => task.status === 'verified').map((task) => task.id));
  const inFlight = tasks.filter((task) => IN_FLIGHT.includes(task.status));
  let serialised = 0;
  let waitingOn: string | null = null;

  for (const task of tasks) {
    if (task.status === 'verified' || inFlight.includes(task)) continue;
    if (!task.dependsOn.every((dep) => done.has(dep))) continue;
    const busy = inFlight.find((other) => conflicts(task, other));
    if (busy) {
      serialised += 1;
      waitingOn = busy.id;
      continue;
    }
    return { task, waitingOn, serialised };
  }
  return { task: null, waitingOn, serialised };
}
