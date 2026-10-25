/**
 * Deterministic validation for the Bigfoot workflow. The spec is explicit: security and correctness
 * are enforced in CODE, not only in role prompts. So before a plan can move to PLAN_READY, and before
 * a tool plan is trusted, these pure functions reject the shapes that would let a run proceed on a
 * broken or fabricated plan.
 *
 * `validateToolPlan` takes the set of known tool names as an argument (dependency injection) rather
 * than importing the registry, so it is trivially unit-testable and cannot create an import cycle
 * back through core/tool.ts. The workflow controller passes the real registry names.
 */

import type { Finding, GoalSpec, Task, ToolPlan } from './types.js';

export interface ValidationIssue {
  code: string;
  message: string;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export function validateGoalSpec(goal: GoalSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isNonEmptyString(goal?.goal)) issues.push({ code: 'goal_missing', message: 'goal bo‘sh' });
  if (!Array.isArray(goal?.acceptanceCriteria) || goal.acceptanceCriteria.length === 0) {
    issues.push({ code: 'acceptance_missing', message: 'kamida bitta acceptance criteria kerak' });
  }
  return issues;
}

/** Detect dependency cycles among tasks (DFS). Returns the ids on a cycle, or [] if the graph is a DAG. */
export function findDependencyCycles(tasks: Task[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  let cycle: string[] = [];

  const visit = (id: string): boolean => {
    const node = byId.get(id);
    if (!node) return false;
    const s = state.get(id);
    if (s === 'visiting') {
      const at = stack.indexOf(id);
      cycle = stack.slice(at === -1 ? 0 : at).concat(id);
      return true;
    }
    if (s === 'done') return false;
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of node.dependsOn) {
      if (visit(dep)) return true;
    }
    stack.pop();
    state.set(id, 'done');
    return false;
  };

  for (const t of tasks) if (visit(t.id)) break;
  return cycle;
}

export function validateTasks(tasks: Task[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (!isNonEmptyString(t.id)) issues.push({ code: 'task_id_missing', message: 'task id bo‘sh' });
    else if (ids.has(t.id)) issues.push({ code: 'task_id_dup', message: `takroriy task id: ${t.id}` });
    else ids.add(t.id);
    if (!isNonEmptyString(t.objective))
      issues.push({ code: 'task_objective_missing', message: `task ${t.id}: objective yo‘q` });
    if (!Array.isArray(t.acceptanceCriteria) || t.acceptanceCriteria.length === 0) {
      issues.push({
        code: 'task_acceptance_missing',
        message: `task ${t.id}: acceptance criteria yo‘q (o‘lchanmaydigan vazifa)`,
      });
    }
    if (!isNonEmptyString(t.verification?.method)) {
      issues.push({ code: 'task_verification_missing', message: `task ${t.id}: verification method yo‘q` });
    }
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!ids.has(dep)) issues.push({ code: 'task_dep_missing', message: `task ${t.id}: noma'lum dependency ${dep}` });
    }
  }
  const cycle = findDependencyCycles(tasks);
  if (cycle.length) issues.push({ code: 'task_cycle', message: `dependency sikli: ${cycle.join(' → ')}` });
  return issues;
}

/** Every planned tool must be a REAL registered tool — never an invented name. */
export function validateToolPlan(tasks: Task[], knownTools: ReadonlySet<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const t of tasks) {
    for (const plan of t.toolPlan) {
      if (!isNonEmptyString(plan.toolName)) {
        issues.push({ code: 'toolplan_name_missing', message: `task ${t.id}: toolPlan nomi bo‘sh` });
        continue;
      }
      if (!knownTools.has(plan.toolName)) {
        issues.push({ code: 'toolplan_unknown', message: `task ${t.id}: registry'da yo'q tool: ${plan.toolName}` });
      }
    }
  }
  return issues;
}

export function validateFinding(f: Finding): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isNonEmptyString(f?.id)) issues.push({ code: 'finding_id_missing', message: 'finding id bo‘sh' });
  if (!isNonEmptyString(f?.evidence))
    issues.push({ code: 'finding_evidence_missing', message: `finding ${f?.id}: dalil yo‘q (evidence-based talab)` });
  if (!isNonEmptyString(f?.requiredAction))
    issues.push({ code: 'finding_action_missing', message: `finding ${f?.id}: requiredAction yo‘q` });
  return issues;
}

/** One entry point: is this plan internally valid AND does its tool plan resolve to real tools? */
export function validatePlan(
  tasks: Task[],
  knownTools: ReadonlySet<string>,
): { ok: boolean; issues: ValidationIssue[] } {
  const issues = [...validateTasks(tasks), ...validateToolPlan(tasks, knownTools)];
  return { ok: issues.length === 0, issues };
}
