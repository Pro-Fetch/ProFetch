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

import { FINDING_CLASSIFICATIONS, VERIFICATION_TYPES, requirements, verificationStrength } from './types.js';
import type { Finding, GoalSpec, Task, ToolPlan, VerificationType } from './types.js';

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

export function validateTasks(tasks: Task[], knownRequirementIds?: ReadonlySet<string>): ValidationIssue[] {
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
    if (t.verification?.type !== undefined && !VERIFICATION_TYPES.includes(t.verification.type)) {
      issues.push({
        code: 'task_verification_type_unknown',
        message: `task ${t.id}: verification.type ${VERIFICATION_TYPES.join('|')} ro'yxatida yo'q`,
      });
    }
    // `covers` is what the coverage matrix reads; invented ids would let a plan declare itself complete.
    if (knownRequirementIds) {
      for (const ref of t.covers ?? []) {
        if (!knownRequirementIds.has(ref))
          issues.push({
            code: 'task_covers_unknown',
            message: `task ${t.id}: noma'lum talab id: ${ref} — mavjud idlar: ${[...knownRequirementIds].join(', ')}`,
          });
      }
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

export function validateFinding(f: Finding, knownRequirementIds?: ReadonlySet<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isNonEmptyString(f?.id)) issues.push({ code: 'finding_id_missing', message: 'finding id bo‘sh' });
  if (!isNonEmptyString(f?.evidence))
    issues.push({ code: 'finding_evidence_missing', message: `finding ${f?.id}: dalil yo‘q (evidence-based talab)` });
  if (!isNonEmptyString(f?.requiredAction))
    issues.push({ code: 'finding_action_missing', message: `finding ${f?.id}: requiredAction yo‘q` });
  if (!FINDING_CLASSIFICATIONS.includes(f?.classification)) {
    issues.push({
      code: 'finding_classification_missing',
      message: `finding ${f?.id}: classification ${FINDING_CLASSIFICATIONS.join('|')} dan biri bo‘lishi kerak (§11.2)`,
    });
  }
  if (typeof f?.confidence !== 'number' || f.confidence < 0 || f.confidence > 1) {
    issues.push({ code: 'finding_confidence_range', message: `finding ${f?.id}: confidence 0..1 bo‘lishi kerak` });
  }
  // A finding that points at a requirement id the goal never had is how a coverage matrix balances
  // itself into looking complete.
  if (knownRequirementIds) {
    for (const ref of f?.relatedRequirementIds ?? []) {
      if (!knownRequirementIds.has(ref))
        issues.push({
          code: 'finding_requirement_unknown',
          message: `finding ${f?.id}: GoalSpec'da yo'q talab: ${ref}`,
        });
    }
  }
  return issues;
}

/**
 * Duplicate work (spec §5.4): the auditor merges tasks that produce the same result instead of
 * running them twice. Two tasks with the same objective, or with an identical tool plan, are refused
 * at submission rather than reported.
 */
export function redundancyIssues(tasks: Task[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byObjective = new Map<string, string>();
  const byToolPlan = new Map<string, string>();
  for (const task of tasks) {
    const objective = (task.objective ?? '').trim().toLowerCase();
    if (byObjective.has(objective)) {
      issues.push({
        code: 'task_duplicate_objective',
        message: `task ${task.id}: ${byObjective.get(objective)} bilan bir xil objective (birlashtirish kerak)`,
      });
    } else byObjective.set(objective, task.id);

    // Identical tools are not yet identical work: two tasks may fetch the same endpoint for two
    // different requirements. The pair (tools, requirements carried) is what makes work duplicated.
    const signature = [
      (task.toolPlan ?? [])
        .map((plan) => plan.toolName)
        .sort()
        .join(','),
      [...(task.covers ?? [])].sort().join(','),
    ].join('|');
    if (signature.replace('|', '')) {
      if (byToolPlan.has(signature)) {
        issues.push({
          code: 'task_duplicate_toolplan',
          message:
            `task ${task.id}: ${byToolPlan.get(signature)} bilan bir xil toolPlan va bir xil talablar ` +
            `(${signature}) — birlashtirilsin`,
        });
      } else byToolPlan.set(signature, task.id);
    }
  }
  return issues;
}

/**
 * Tasks that carry no requirement (reported, not refused). A plan can legitimately include support
 * work; hiding the count would only make the coverage number look better than it is.
 */
export function orphanTasks(tasks: Task[]): string[] {
  return tasks.filter((task) => (task.covers ?? []).length === 0).map((task) => task.id);
}

/**
 * Is the evidence actually as strong as the task demanded? (spec §12.2: a typecheck does not replace
 * an integration test.) Both types must be known; a missing requirement means the task never claimed
 * a strength, so nothing is refused.
 */
export function verificationWeakness(
  required: VerificationType | undefined,
  given: VerificationType | undefined,
): ValidationIssue | null {
  if (!required || !given) return null;
  if (verificationStrength(given) >= verificationStrength(required)) return null;
  return {
    code: 'verification_weaker_than_required',
    message: `task ${required} talab qiladi, hisob ${given} berdi (kuchi ${verificationStrength(given)} < ${verificationStrength(required)})`,
  };
}

/** One entry point: internally valid, resolves to real tools, carries no duplicate work. */
export function validatePlan(
  tasks: Task[],
  knownTools: ReadonlySet<string>,
  goal?: GoalSpec,
): { ok: boolean; issues: ValidationIssue[] } {
  const knownRequirementIds = goal ? new Set(requirements(goal).map((requirement) => requirement.id)) : undefined;
  const issues = [
    ...validateTasks(tasks, knownRequirementIds),
    ...validateToolPlan(tasks, knownTools),
    ...redundancyIssues(tasks),
  ];
  return { ok: issues.length === 0, issues };
}
