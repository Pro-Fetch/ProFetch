/**
 * The workflow lifecycle: which phase may follow which, and the only way to move a run forward.
 *
 * Transitions are enforced in code, not in prose — the whole point of the state machine is that a
 * host cannot jump straight to COMPLETED, or start EXECUTING before a plan is AUDIT'd and PLAN_READY.
 * `transition()` is the single mutation path: it validates, records the reason in history, and bumps
 * revision, so the persisted state is always a legal sequence of moves.
 *
 * The phase set follows spec §17: `REPAIR` exists because a failed acceptance criterion sends work
 * back without pretending the plan was wrong, `FINAL_AUDIT` because the independent completion audit
 * (§12.3) is a step and not a mood, and `PAUSED` because an interrupted run must be restorable to the
 * phase it left rather than restarted.
 */

import type { GoalSpec, Task, WorkflowMode, WorkflowPhase, WorkflowState } from './types.js';
import { isBlockingClassification, requirementIds, requirements } from './types.js';

const TRANSITIONS: Readonly<Record<WorkflowPhase, readonly WorkflowPhase[]>> = {
  NEW: ['PLANNING', 'PAUSED', 'BLOCKED'],
  PLANNING: ['AUDIT_REQUIRED', 'PAUSED', 'BLOCKED'],
  AUDIT_REQUIRED: ['REVISION_REQUIRED', 'PLAN_READY', 'PAUSED', 'BLOCKED'],
  REVISION_REQUIRED: ['PLANNING', 'AUDIT_REQUIRED', 'PAUSED', 'BLOCKED'],
  PLAN_READY: ['EXECUTING', 'PAUSED', 'BLOCKED'],
  EXECUTING: ['VERIFYING', 'REPLANNING', 'PAUSED', 'BLOCKED'],
  // The edge exists for lite/direct runs; what keeps `full` mode honest is completionEligible, which
  // refuses COMPLETED from VERIFYING until the independent final audit has been passed (§12.3).
  VERIFYING: ['COMPLETED', 'REPAIR', 'FINAL_AUDIT', 'EXECUTING', 'REPLANNING', 'PAUSED', 'BLOCKED'],
  REPAIR: ['VERIFYING', 'EXECUTING', 'REPLANNING', 'PAUSED', 'BLOCKED'],
  FINAL_AUDIT: ['COMPLETED', 'REPLANNING', 'EXECUTING', 'BLOCKED'],
  REPLANNING: ['PLANNING', 'EXECUTING', 'PAUSED', 'BLOCKED'],
  // `resume` returns to wherever the pause record says; this is what is reachable from PAUSED.
  PAUSED: [
    'PLANNING',
    'AUDIT_REQUIRED',
    'REVISION_REQUIRED',
    'PLAN_READY',
    'EXECUTING',
    'VERIFYING',
    'REPLANNING',
    'NEW',
    'BLOCKED',
  ],
  COMPLETED: [],
  BLOCKED: ['PLANNING', 'EXECUTING', 'NEW', 'PAUSED'],
};

export function allowedTransitions(from: WorkflowPhase): readonly WorkflowPhase[] {
  return TRANSITIONS[from] ?? [];
}

/** The phases that actually exist, read off the transition table so no list of them can drift. */
export const PHASES = Object.keys(TRANSITIONS) as WorkflowPhase[];

export function canTransition(from: WorkflowPhase, to: WorkflowPhase): boolean {
  return allowedTransitions(from).includes(to);
}

export function assertTransition(from: WorkflowPhase, to: WorkflowPhase): void {
  if (!canTransition(from, to)) {
    const allowed = allowedTransitions(from);
    throw new Error(
      `Noto‘g‘ri o‘tish: ${from} → ${to}. Ruxsat etilgan: ${allowed.length ? allowed.join(', ') : '(yok, bu yakuniy faza)'}`,
    );
  }
}

/** A fresh run in NEW. Empty collections so the caller never has to null-check before pushing. */
export function createWorkflow(id: string, goal: GoalSpec, mode: WorkflowMode = 'full'): WorkflowState {
  const now = Date.now();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    phase: 'NEW',
    mode,
    goal,
    plan: null,
    findings: [],
    evidence: [],
    history: [{ at: now, from: 'NEW', to: 'NEW', reason: 'created' }],
  };
}

/**
 * Move a run to `to`, recording why. Throws on an illegal transition, so a caller cannot mark work
 * complete or begin execution without the intervening phases. Returns the same object (mutated) for
 * chaining with saveWorkflow.
 */
export function transition(state: WorkflowState, to: WorkflowPhase, reason: string): WorkflowState {
  assertTransition(state.phase, to);
  const now = Date.now();
  state.history.push({ at: now, from: state.phase, to, reason });
  state.phase = to;
  state.updatedAt = now;
  state.revision += 1;
  return state;
}

/** A finding stops completion if it is flagged blocking or classified must_fix / needs approval (§11.2). */
export function findingBlocks(finding: { blocking?: boolean; classification?: string; status: string }): boolean {
  const classified = isBlockingClassification((finding.classification ?? 'should_fix') as never);
  return (Boolean(finding.blocking) || classified) && finding.status !== 'resolved' && finding.status !== 'rejected';
}

/** Requirement ids no task carries. Unknowns are excluded — they close through `resolve_unknown`. */
export function unmappedRequirements(goal: GoalSpec, tasks: Task[]): string[] {
  const covered = new Set(tasks.flatMap((task) => task.covers ?? []));
  return requirementIds(goal).filter((id) => !covered.has(id));
}

/**
 * The honest completion gate (spec §6.6, §12.3).
 *
 * Every item below is a way a run has actually been observed to lie about itself: a `passed` that was
 * only mocked, an unknown nobody closed, a deliverable with no evidence behind it, a plan that was
 * never independently audited. They are checked in code rather than reminded about in prose.
 */
export function completionEligible(state: WorkflowState): { ok: boolean; blockers: string[] } {
  const blockers: string[] = [];
  const needsFinalAudit = state.mode === 'full';
  const allowed: WorkflowPhase[] = needsFinalAudit ? ['FINAL_AUDIT'] : ['VERIFYING', 'FINAL_AUDIT'];
  if (!allowed.includes(state.phase)) {
    blockers.push(
      needsFinalAudit
        ? `faza ${state.phase} (COMPLETED uchun avval final_audit → FINAL_AUDIT kerak)`
        : `faza ${state.phase} (VERIFYING yoki FINAL_AUDIT bo‘lishi kerak)`,
    );
  }

  const tasks = state.plan?.tasks ?? [];
  if (tasks.length === 0) blockers.push('reja bo‘sh (hech qanday task yo‘q)');
  for (const task of tasks) {
    if (task.status === 'verified') continue;
    const label = task.status === 'mock_verified' ? ' (mock real test o‘rnini bosmaydi)' : '';
    blockers.push(`task ${task.id} verified emas (holat: ${task.status})${label}`);
  }
  // §6.6: a deliverable has to be pointable at, not merely claimed. Evidence alone does not satisfy
  // it — the record has to name the artifact, otherwise the report says "done" about something nobody
  // can go and look at.
  for (const task of tasks) {
    if ((task.deliverables ?? []).length === 0) continue;
    const pointed = state.evidence.some((record) => record.taskId === task.id && record.artifact);
    if (!pointed)
      blockers.push(`task ${task.id}: deliverable bor, ammo artifact ko‘rsatilmagan (${task.deliverables.join(', ')})`);
  }
  for (const finding of state.findings) {
    if (findingBlocks(finding)) blockers.push(`blocking finding ${finding.id} hali ${finding.status}`);
  }
  const closed = new Set((state.unknowns ?? []).map((entry) => entry.id));
  for (const unknown of requirements(state.goal).filter((entry) => entry.kind === 'unknown')) {
    if (!closed.has(unknown.id)) blockers.push(`unknown ${unknown.id} yopilmagan: ${unknown.text}`);
  }
  // Coverage is a plan-time gate too, but a re-planned plan can regress, so it is checked again here.
  const unmapped = unmappedRequirements(state.goal, tasks);
  if (unmapped.length) blockers.push(`qoplanmagan talablar: ${unmapped.join(', ')}`);

  return { ok: blockers.length === 0, blockers };
}
