/**
 * The workflow lifecycle: which phase may follow which, and the only way to move a run forward.
 *
 * Transitions are enforced in code, not in prose — the whole point of the state machine is that a
 * host cannot jump straight to COMPLETED, or start EXECUTING before a plan is AUDIT'd and PLAN_READY.
 * `transition()` is the single mutation path: it validates, records the reason in history, and bumps
 * revision, so the persisted state is always a legal sequence of moves.
 */

import type { GoalSpec, WorkflowMode, WorkflowPhase, WorkflowState } from './types.js';

const TRANSITIONS: Readonly<Record<WorkflowPhase, readonly WorkflowPhase[]>> = {
  NEW: ['PLANNING', 'BLOCKED'],
  PLANNING: ['AUDIT_REQUIRED', 'BLOCKED'],
  AUDIT_REQUIRED: ['REVISION_REQUIRED', 'PLAN_READY', 'BLOCKED'],
  REVISION_REQUIRED: ['PLANNING', 'AUDIT_REQUIRED', 'BLOCKED'],
  PLAN_READY: ['EXECUTING', 'BLOCKED'],
  EXECUTING: ['VERIFYING', 'REPLANNING', 'BLOCKED'],
  VERIFYING: ['COMPLETED', 'REPLANNING', 'EXECUTING', 'BLOCKED'],
  REPLANNING: ['PLANNING', 'EXECUTING', 'BLOCKED'],
  COMPLETED: [],
  BLOCKED: ['PLANNING', 'EXECUTING', 'NEW'],
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

/** True only when every task is `verified` and no blocking finding is still open — the honest gate. */
export function completionEligible(state: WorkflowState): { ok: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (state.phase !== 'VERIFYING' && state.phase !== 'EXECUTING') {
    blockers.push(`faza ${state.phase} (VERIFYING/EXECUTING bo‘lishi kerak)`);
  }
  const tasks = state.plan?.tasks ?? [];
  if (tasks.length === 0) blockers.push('reja bo‘sh (hech qanday task yo‘q)');
  for (const t of tasks) {
    if (t.status !== 'verified') blockers.push(`task ${t.id} verified emas (holat: ${t.status})`);
  }
  for (const f of state.findings) {
    if (f.blocking && f.status !== 'resolved' && f.status !== 'rejected') {
      blockers.push(`blocking finding ${f.id} hali ${f.status}`);
    }
  }
  return { ok: blockers.length === 0, blockers };
}
