/**
 * Bigfoot workflow data model — MexaPlan (planning) + SmartToDo (audit/task-graph) + MaxEffort
 * (execution) share these types. They are pure data + status enums; the reasoning that fills them is
 * done by the connected host AI, never fabricated here.
 *
 * Requirement, unknown and evidence identifiers are *derived* from `GoalSpec` rather than stored
 * alongside it (`requirements()` below). The goal is fixed at `start`, so the ids a plan refers to
 * cannot drift mid-run, and the host does not have to invent an id scheme that the coverage audit
 * then has to trust.
 */

/** Lifecycle phases of a workflow run (see state-machine.ts for allowed transitions). */
export type WorkflowPhase =
  | 'NEW'
  | 'PLANNING'
  | 'AUDIT_REQUIRED'
  | 'REVISION_REQUIRED'
  | 'PLAN_READY'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'REPAIR'
  | 'FINAL_AUDIT'
  | 'REPLANNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'BLOCKED';

/**
 * Per-task status.
 *
 * Only `verified` counts as genuinely done. `passed` and `mock_verified` exist because the host must be
 * able to report a real distinction honestly (spec §12.2): a mock-verified task is *not* a task whose
 * external behaviour was proven, and `not_run` / `skipped` exist so an unexecuted check is never
 * silently folded into "done".
 */
export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'failed'
  | 'needs_verification'
  | 'not_run'
  | 'skipped'
  | 'passed'
  | 'mock_verified'
  | 'verified'
  | 'superseded';

/** How sensitive a planned tool is — drives approval + the read-only gate. */
export type ToolSensitivity = 'read_only' | 'mutating' | 'destructive' | 'sensitive';

/** Effort mode. `direct` skips planning friction but NEVER the security boundary. */
export type WorkflowMode = 'full' | 'lite' | 'direct';

/**
 * Verification kinds, ordered by how much they actually prove (spec §12.1).
 *
 * The rank matters: a task that requires an integration check must not be closed with a typecheck,
 * which is the exact substitution §12.2 calls out. `static` proves shape, `manual` proves nothing on
 * its own — it is recorded because the spec lists "manual approval" as a legitimate evidence type.
 */
export const VERIFICATION_TYPES = [
  'static',
  'typecheck',
  'unit',
  'regression',
  'runtime-smoke',
  'integration',
  'real-api',
  'security',
  'performance',
  'code-review',
  'artifact-audit',
  'manual',
] as const;

export type VerificationType = (typeof VERIFICATION_TYPES)[number];

/** Weaker-than rank: higher number = stronger evidence. `manual` is not a substitute for a run test. */
const VERIFICATION_STRENGTH: Record<VerificationType, number> = {
  static: 1,
  typecheck: 2,
  manual: 2,
  'code-review': 3,
  unit: 4,
  regression: 4,
  'artifact-audit': 4,
  'runtime-smoke': 5,
  'real-api': 6,
  integration: 6,
  security: 6,
  performance: 5,
};

export function verificationStrength(type: VerificationType): number {
  return VERIFICATION_STRENGTH[type];
}

/** How a new discovery is classified (spec §11.2). Drives whether it blocks completion. */
export const FINDING_CLASSIFICATIONS = [
  'must_fix',
  'should_fix',
  'report_only',
  'needs_user_approval',
  'false_positive',
] as const;

export type FindingClassification = (typeof FINDING_CLASSIFICATIONS)[number];

/** Classifications that stop a run from being called complete. */
export function isBlockingClassification(classification: FindingClassification): boolean {
  return classification === 'must_fix' || classification === 'needs_user_approval';
}

/** A planned use of an EXISTING, registry-resolved tool. toolName must be a real registered name. */
export interface ToolPlan {
  toolName: string;
  category: string;
  purpose: string;
  expectedEvidence?: string;
  sensitivity: ToolSensitivity;
  requiresApproval: boolean;
  fallback?: string;
  /**
   * The arguments the step will be called with, when the planner already knows them. The scheduler
   * reads resource identities out of these (`path`, `key`, `dataset`, `url`...), so a conflict is
   * visible even when nobody wrote it down in `deliverables`.
   */
  arguments?: Record<string, unknown>;
}

export interface Task {
  id: string;
  objective: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  dependsOn: string[];
  deliverables: string[];
  toolPlan: ToolPlan[];
  acceptanceCriteria: string[];
  verification: { method: string; evidenceRequired: boolean; type?: VerificationType };
  /**
   * Requirement ids (`E1`, `A2`, …) this task carries. Coverage is measured against these: a
   * requirement no task lists is `unmapped` and blocks PLAN_READY (spec §5.2).
   */
  covers?: string[];
  status: TaskStatus;
  attempts: number;
  evidenceRefs: string[];
  blockers: string[];
  /**
   * Files/resources this task modifies that are not themselves deliverables (a cache key, a repo
   * path, an output file). Conflict serialisation can only see what is declared; declaring nothing
   * is why `undeclared-write-resources` exists as a risk item.
   */
  writes?: string[];
  /**
   * Set by `approve_plan` for a task whose steps the registry says can change state. A new plan
   * replaces the task objects, so an approval never carries over from a revision.
   */
  approval?: { grantedAt: number; note: string } | null;
  /** Recorded by `report_task_result` when the task is closed, so the gate can compare it with what the
   * task's own `verification.type` demanded. */
  verifiedWith?: VerificationType;
}

/** A SmartToDo finding. `blocking` (or a blocking classification) prevents COMPLETED until resolved. */
export interface Finding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  relatedRequirementIds: string[];
  description: string;
  evidence: string;
  whyItMatters: string;
  requiredAction: string;
  acceptanceCriteria: string[];
  confidence: number;
  classification: FindingClassification;
  blocking: boolean;
  status: 'open' | 'resolved' | 'rejected' | 'false_positive';
  /** True when the finding was raised before the auditor was shown the plan (spec §5.1). */
  blind?: boolean;
  /**
   * The §5.3 risk item this finding disposes of. It is how "the audit happened" becomes checkable:
   * each risk the plan raises has to be either a finding about it or an explicit dismissal.
   */
  riskItem?: string;
  /**
   * How a closing was justified. Set by `resolve_finding`, never by the host editing the file: a
   * blocking finding cannot silently disappear, it has to carry the evidence that closed it.
   */
  resolution?: { status: 'resolved' | 'rejected'; note: string; at: number };
}

export interface Requirement {
  id: string;
  text: string;
  kind: 'explicit' | 'implicit' | 'constraint' | 'deliverable' | 'acceptance' | 'unknown';
}

export interface GoalSpec {
  goal: string;
  explicitRequirements: string[];
  implicitRequirements: string[];
  constraints: string[];
  deliverables: string[];
  qualityTarget: string;
  acceptanceCriteria: string[];
  unknowns: string[];
  /** Spec §4.1. Optional: an absent tolerance is treated as `low`, i.e. the strict reading. */
  riskTolerance?: 'low' | 'medium' | 'high';
}

/**
 * Stable ids derived from the goal. Prefixes: E (explicit), I (implicit), C (constraint),
 * D (deliverable), A (acceptance criterion), U (unknown).
 */
export function requirements(goal: GoalSpec): Requirement[] {
  const list: Requirement[] = [];
  const push = (kind: Requirement['kind'], prefix: string, items: string[] | undefined) => {
    (items ?? []).forEach((text, index) => list.push({ id: `${prefix}${index + 1}`, text, kind }));
  };
  push('explicit', 'E', goal?.explicitRequirements);
  push('implicit', 'I', goal?.implicitRequirements);
  push('constraint', 'C', goal?.constraints);
  push('deliverable', 'D', goal?.deliverables);
  push('acceptance', 'A', goal?.acceptanceCriteria);
  push('unknown', 'U', goal?.unknowns);
  return list;
}

/** Every requirement id except `unknowns`, which are tracked separately (spec §6.6). */
export function requirementIds(goal: GoalSpec): string[] {
  return requirements(goal)
    .filter((requirement) => requirement.kind !== 'unknown')
    .map((requirement) => requirement.id);
}

/**
 * How far a claim is backed (§10.3). `not_checked` is a real value on purpose: an unexamined source
 * must not quietly read as a supported one.
 */
export const SOURCE_RELIABILITY = ['confirmed', 'supported', 'uncertain', 'contradicted', 'not_checked'] as const;

export type SourceReliability = (typeof SOURCE_RELIABILITY)[number];

/** One piece of research: what was looked at and what came of it (§10.1). */
export interface Source {
  id: string;
  /** URL, file, tool output or document reference — whatever the claim can be traced back to. */
  reference: string;
  reliability: SourceReliability;
  finding: string;
  /** Requirement or unknown ids this source bears on (E1…, U1…). */
  relatesTo: string[];
  at: number;
}

export interface EvidenceRecord {
  id: string;
  taskId: string;
  summary: string;
  /** True if the summary passed through redact() before persistence. */
  redacted: boolean;
  verificationType?: VerificationType;
  /** Optional raw provenance so a report can be checked rather than trusted. */
  command?: string;
  exitCode?: number;
  artifact?: string;
}

export interface TransitionRecord {
  at: number;
  from: WorkflowPhase;
  to: WorkflowPhase;
  reason: string;
}

/** What SmartToDo measured about the plan, not what it felt about it. */
export interface AuditRecord {
  /** Goal-only packet handed out before the plan was visible (spec §5.1). */
  blindStartedAt?: number;
  /** Set when the plan itself was disclosed to the auditor. */
  planSeenAt?: number;
  independence?: 'blind' | 'reduced';
  coverage?: { total: number; mapped: number; unmapped: string[] };
  /**
   * The §5.3 risk audit: every item this plan actually raises, and how the auditor disposed of it.
   * `open` means nobody dealt with it, which blocks PLAN_READY rather than being quietly omitted.
   */
  risks?: { item: string; because: string; disposition: 'finding' | 'dismissed' | 'open'; note?: string }[];
  at: number;
}

/**
 * Counters the benchmarks in spec §20.5 ask for. They are written by refusals too: a run that was
 * stopped from faking completion has to show that it was stopped.
 */
export interface WorkflowStats {
  fakeCompletionRefused: number;
  illegalTransitionRefused: number;
  unapprovedExecutionRefused: number;
  understatedRiskRefused: number;
  unmappedRequirementRefused: number;
  duplicatePlanRefused: number;
  stagnationRefused: number;
  unverifiableEvidenceRefused: number;
  unsourcedResolutionRefused: number;
  unaddressedRiskRefused: number;
  conflictsSerialised: number;
  duplicateCalls: number;
  callsLogged: number;
  attempts: number;
}

/** The persisted unit of a workflow run. */
export interface WorkflowState {
  id: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  phase: WorkflowPhase;
  mode: WorkflowMode;
  goal: GoalSpec;
  plan: { tasks: Task[]; risks: string[]; verificationStrategy: string } | null;
  findings: Finding[];
  evidence: EvidenceRecord[];
  history: TransitionRecord[];
  audit?: AuditRecord;
  stats?: WorkflowStats;
  /** Call fingerprints, used to detect a host repeating a call that produced nothing new (§6.5). */
  calls?: { fingerprint: string; at: number; task?: string; produced: boolean }[];
  /** Unknowns the host closed with a reason; ids reference `U1..Un` (spec §6.6). */
  unknowns?: { id: string; verdict: string; note: string; at: number; sources?: string[] }[];
  /** Evidence/finding counts at each revision, used to detect a plan loop with no new facts (§13.3). */
  progress?: { at: number; evidence: number; findings: number }[];
  /** Phase a `pause` interrupted, so `resume` can restore it. */
  pausedFrom?: WorkflowPhase;
  /** Recorded research, referenced when an unknown is closed (§10.1, §10.3). */
  sources?: Source[];
}

/** Zeroed counters, so `state.stats` never needs a null check at every call site. */
export function emptyStats(): WorkflowStats {
  return {
    fakeCompletionRefused: 0,
    illegalTransitionRefused: 0,
    unapprovedExecutionRefused: 0,
    understatedRiskRefused: 0,
    unmappedRequirementRefused: 0,
    duplicatePlanRefused: 0,
    stagnationRefused: 0,
    unverifiableEvidenceRefused: 0,
    unsourcedResolutionRefused: 0,
    unaddressedRiskRefused: 0,
    conflictsSerialised: 0,
    duplicateCalls: 0,
    callsLogged: 0,
    attempts: 0,
  };
}
