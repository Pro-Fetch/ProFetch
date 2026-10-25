/**
 * Bigfoot workflow data model — MexaPlan (planning) + SmartToDo (audit/task-graph) + MaxEffort
 * (execution) share these types. They are pure data + status enums; the reasoning that fills them is
 * done by the connected host AI, never fabricated here.
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
  | 'REPLANNING'
  | 'COMPLETED'
  | 'BLOCKED';

/** Per-task status. Only `verified` counts as genuinely done; `pending`/`ready` never imply completion. */
export type TaskStatus =
  'pending' | 'ready' | 'in_progress' | 'blocked' | 'failed' | 'needs_verification' | 'verified' | 'superseded';

/** How sensitive a planned tool is — drives approval + the read-only gate. */
export type ToolSensitivity = 'read_only' | 'mutating' | 'destructive' | 'sensitive';

/** Effort mode. `direct` skips planning friction but NEVER the security boundary. */
export type WorkflowMode = 'full' | 'lite' | 'direct';

/** A planned use of an EXISTING, registry-resolved tool. toolName must be a real registered name. */
export interface ToolPlan {
  toolName: string;
  category: string;
  purpose: string;
  expectedEvidence?: string;
  sensitivity: ToolSensitivity;
  requiresApproval: boolean;
  fallback?: string;
}

export interface Task {
  id: string;
  objective: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  dependsOn: string[];
  deliverables: string[];
  toolPlan: ToolPlan[];
  acceptanceCriteria: string[];
  verification: { method: string; evidenceRequired: boolean };
  status: TaskStatus;
  attempts: number;
  evidenceRefs: string[];
  blockers: string[];
}

/** A SmartToDo finding. `blocking: true` findings prevent COMPLETED until resolved. */
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
  blocking: boolean;
  status: 'open' | 'resolved' | 'rejected' | 'false_positive';
  /**
   * How a closing was justified. Set by `resolve_finding`, never by the host editing the file: a
   * blocking finding cannot silently disappear, it has to carry the evidence that closed it.
   */
  resolution?: { status: 'resolved' | 'rejected'; note: string; at: number };
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
}

export interface EvidenceRecord {
  id: string;
  taskId: string;
  summary: string;
  /** True if the summary passed through redact() before persistence. */
  redacted: boolean;
}

export interface TransitionRecord {
  at: number;
  from: WorkflowPhase;
  to: WorkflowPhase;
  reason: string;
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
}
