/**
 * Risk assessment for a Bigfoot plan — derived from the registry, never from the host's own claim.
 *
 * ## Why this exists
 *
 * `toolPlan[].sensitivity` and `requiresApproval` are written by the connected AI. Spec §14.2 (least
 * privilege) and §14.5 (approval and risk) only mean something if the referee checks them against
 * reality: a plan that labels `pro_fetch_cache_clear` as `read_only` is not read_only, and a workflow
 * that trusted the label would have made the approval gate a formality the host could fill in wrong —
 * or on purpose.
 *
 * So the truth comes from the same rule `assertToolAllowed` enforces at dispatch time:
 * `isMutationTool()` — name patterns plus the generated sink table, which exists precisely because
 * names lie (`pro_fetch_import_bundle` writes with no verb in its name).
 *
 * ## Where operator policy is enforced
 *
 * Spec §14.1 (the model may not change operator policy) is enforced at dispatch, in
 * `security-policy.ts`: `PRO_FETCH_READ_ONLY` refuses every state-changing action of this controller
 * except the two that only read, and only the operator can add a tool to `PRO_FETCH_MUTATION_ALLOWLIST`.
 * This layer deliberately does not re-check that flag: a plan that got as far as existing already
 * passed the operator's gate, and refusing it again here would overrule an explicit allowlist entry.
 */

import { isMutationTool, isRemoteCategory } from '../tool-classification.js';
import type { Task, ToolPlan } from './types.js';

/** Registry-derived risk for one planned tool call. */
export interface PlanRisk {
  taskId: string;
  toolName: string;
  category: string;
  /** Does the registry believe this tool can change state? */
  mutating: boolean;
  /** Does it reach outside the machine? Drives the "hard to undo" framing in approval notes. */
  remote: boolean;
  /** What the host claimed, kept so an understatement can be named in the refusal. */
  claimed: ToolPlan['sensitivity'];
}

/** Every planned step, graded by the registry rather than by the plan's own label. */
export function assessPlan(tasks: Task[]): PlanRisk[] {
  const risks: PlanRisk[] = [];
  for (const task of tasks) {
    for (const plan of task.toolPlan ?? []) {
      const mutating = isMutationTool(plan.toolName);
      risks.push({
        taskId: task.id,
        toolName: plan.toolName,
        category: plan.category,
        mutating,
        remote: isRemoteCategory(plan.category),
        claimed: plan.sensitivity,
      });
    }
  }
  return risks;
}

/** Steps that need a human approval: anything the registry says can change state. */
export function approvalRequired(risks: PlanRisk[]): PlanRisk[] {
  return risks.filter((risk) => risk.mutating || risk.claimed === 'destructive' || risk.claimed === 'sensitive');
}

/** Task ids that still lack an approval. A task is approved by `t.approval`, set by `approve_plan`. */
export function pendingApprovals(tasks: Task[], risks: PlanRisk[]): string[] {
  const needed = new Set(approvalRequired(risks).map((risk) => risk.taskId));
  return [...needed].filter((taskId) => !tasks.find((task) => task.id === taskId)?.approval);
}

export interface RiskIssue {
  code: string;
  message: string;
}

/**
 * Plan-time refusal: a step whose claimed sensitivity is calmer than the registry says it is.
 *
 * An over-cautious label (`destructive` on a read-only tool) is not a defect and is not refused —
 * it only costs the host an extra approval. An understated label is refused, because that is the
 * direction that turns the gate off. Operator policy is not checked here; see the header.
 */
export function riskIssues(risks: PlanRisk[]): RiskIssue[] {
  const issues: RiskIssue[] = [];
  for (const risk of risks) {
    if (risk.claimed === 'read_only' && risk.mutating) {
      issues.push({
        code: 'risk_understated',
        message:
          `task ${risk.taskId}: ${risk.toolName} registry bo‘yicha mutate qiladi, lekin sensitivity=read_only ` +
          `deb belgilangan. To‘g‘ri nom: mutating yoki destructive.`,
      });
    }
  }
  return issues;
}
