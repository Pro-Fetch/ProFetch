/**
 * The omission / risk audit (spec §5.3).
 *
 * §5.3 is explicit that this is *not* a fixed checklist: "alohida item'larni majburan qo'shmaydi,
 * vazifa turiga mos qoidalar tanlanadi". So the items are derived from what the plan actually does —
 * the registry's own classification of each step — and the auditor has to dispose of each one that
 * applies, either by raising a finding about it or by dismissing it with a reason.
 *
 * Why enforce it: without this, `submit_review` accepts any number of findings and the run reads as
 * "audited", while the one risk that mattered (an irreversible remote write with no rollback, say)
 * was simply never mentioned. Deriving the list from the registry means the host cannot shrink it by
 * under-declaring a step, and requiring a disposition means silence is an explicit, recorded choice.
 */

import type { PlanRisk } from './risk.js';
import { taskWrites } from './schedule.js';
import type { GoalSpec, Task } from './types.js';

export interface RiskItem {
  id: string;
  /** Why this item applies to *this* plan, with the evidence that selected it. */
  because: string;
}

interface RiskRule {
  id: string;
  applies: (input: { goal: GoalSpec; tasks: Task[]; risks: PlanRisk[] }) => string | null;
}

/** True when a step name looks like it touches credentials or scopes. */
const CREDENTIAL_SHAPE = /(?:^|_)(?:api_key|credential|oauth|token|session|scopes?|auth)(?:_|$)/i;

const RULES: readonly RiskRule[] = [
  {
    id: 'credentials-and-scopes',
    applies: ({ risks }) => {
      const hit = risks.find((risk) => risk.category === 'auth' || CREDENTIAL_SHAPE.test(risk.toolName));
      return hit ? `${hit.toolName} auth/credential sohasiga tegishli` : null;
    },
  },
  {
    id: 'external-write-rollback',
    applies: ({ risks }) => {
      const hit = risks.find((risk) => risk.mutating && risk.remote);
      return hit ? `${hit.taskId}:${hit.toolName} tashqi tizimda holatni o'zgartiradi` : null;
    },
  },
  {
    id: 'irreversibility',
    applies: ({ tasks }) => {
      const hit = tasks
        .flatMap((task) => task.toolPlan.map((plan) => ({ task, plan })))
        .find(
          ({ plan }) =>
            plan.sensitivity === 'destructive' || /(?:delete|clear|drop|purge|remove)(?:_|$)/i.test(plan.toolName),
        );
      return hit ? `${hit.task.id}:${hit.plan.toolName} qaytarib bo'lmaydigan amaldi` : null;
    },
  },
  {
    id: 'undeclared-write-resources',
    applies: ({ tasks }) => {
      // A mutating step that declares no file/key/path cannot be conflict-checked; §5.5 serialises on
      // declared resources, so the silent case is exactly the one that has to be raised.
      const silent = tasks.filter(
        (task) => taskWrites(task) && [...(task.deliverables ?? []), ...(task.writes ?? [])].length === 0,
      );
      return silent.length ? `yozuvchi qadam resurs e'lon qilmagan: ${silent.map((task) => task.id).join(', ')}` : null;
    },
  },
  {
    id: 'dependency-failure-propagation',
    applies: ({ tasks }) => {
      const chained = tasks.filter((task) => (task.dependsOn ?? []).length > 0);
      return chained.length ? `${chained.map((task) => task.id).join(', ')} boshqa tasklarga bog'liq` : null;
    },
  },
  {
    id: 'constraint-compliance',
    applies: ({ goal }) =>
      goal.constraints?.length ? `maqsad ${goal.constraints.length} ta constraint bilan cheklangan` : null,
  },
  {
    id: 'artifact-verifiability',
    applies: ({ tasks }) => {
      const withDeliverables = tasks.filter((task) => (task.deliverables ?? []).length > 0);
      return withDeliverables.length
        ? `deliverable(lar) e'lon qilingan: ${withDeliverables.flatMap((task) => task.deliverables).join(', ')}`
        : null;
    },
  },
  {
    id: 'source-reliability-and-limits',
    applies: ({ risks }) => {
      const hit = risks.find((risk) => risk.remote);
      return hit ? `${hit.toolName} tashqi servisga boradi (limit, failure mode, manba ishonchliligi)` : null;
    },
  },
  {
    id: 'unknown-resolution',
    applies: ({ goal }) => (goal.unknowns?.length ? `${goal.unknowns.length} ta noaniqlik qoldi` : null),
  },
  {
    id: 'fallback-for-failing-step',
    applies: ({ tasks }) => {
      const missing = tasks.flatMap((task) =>
        task.toolPlan.filter((plan) => !plan.fallback).map((plan) => `${task.id}:${plan.toolName}`),
      );
      return missing.length ? `fallback yo'q: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}` : null;
    },
  },
  {
    id: 'local-state-recovery',
    applies: ({ risks }) => {
      const hit = risks.find((risk) => risk.mutating && !risk.remote);
      return hit ? `${hit.taskId}:${hit.toolName} lokal holatni yozadi` : null;
    },
  },
];

/**
 * The risk items this plan cannot ignore.
 *
 * Ordered, deterministic and derived from the stored plan — the same input always yields the same
 * list, so the auditor's coverage can be measured across revisions instead of argued about.
 */
export function riskChecklist(goal: GoalSpec, tasks: Task[], risks: PlanRisk[]): RiskItem[] {
  const input = { goal, tasks, risks };
  const items: RiskItem[] = [];
  for (const rule of RULES) {
    const because = rule.applies(input);
    if (because) items.push({ id: rule.id, because });
  }
  return items;
}

export interface RiskDisposal {
  item: string;
  reason: string;
}

export interface RiskCoverageResult {
  ok: boolean;
  /** Applicable items with neither a finding nor a dismissal. */
  unaddressed: string[];
  /** Ids the auditor named that this plan does not actually raise. */
  invented: string[];
  emptyDismissing: string[];
}

/**
 * Did the audit dispose of every applicable risk?
 *
 * A finding covers an item by carrying `riskItem`; a dismissal covers it with a reason. An unknown
 * item id is refused rather than ignored: otherwise a typo ("external-write") would quietly drop a
 * requirement, and the coverage number would still look complete.
 */
export function riskCoverage(
  checklist: RiskItem[],
  findings: { riskItem?: string }[],
  dismissed: RiskDisposal[],
): RiskCoverageResult {
  const applicable = new Set(checklist.map((item) => item.id));
  const covered = new Set<string>();
  const invented: string[] = [];
  for (const finding of findings) {
    if (!finding.riskItem) continue;
    if (applicable.has(finding.riskItem)) covered.add(finding.riskItem);
    else invented.push(finding.riskItem);
  }
  const emptyDismissing: string[] = [];
  for (const entry of dismissed ?? []) {
    if (!applicable.has(entry.item)) {
      invented.push(entry.item);
      continue;
    }
    if (!entry.reason?.trim()) {
      emptyDismissing.push(entry.item);
      continue;
    }
    covered.add(entry.item);
  }
  const unaddressed = [...applicable].filter((id) => !covered.has(id));
  return {
    ok: unaddressed.length === 0 && invented.length === 0 && emptyDismissing.length === 0,
    unaddressed,
    invented: [...new Set(invented)],
    emptyDismissing,
  };
}
