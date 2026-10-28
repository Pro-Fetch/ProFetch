/**
 * pro_fetch_workflow — the single Bigfoot controller.
 *
 * One action-based MCP tool drives the whole lifecycle (MexaPlan → SmartToDo → MaxEffort) so the host
 * AI is not handed a pile of workflow tools. The reasoning is the host's; this tool is the stateful
 * referee: it persists the run, validates every submission against the real registry, and refuses to
 * advance the state machine through an illegal move or to mark work complete without evidence.
 *
 * Three rules shape the whole file:
 *
 * 1. **Nothing is taken on trust.** The plan's own `sensitivity` labels are re-derived from the
 *    registry (`risk.ts`), requirement ids in `covers` must exist in the goal, and a `verified` claim
 *    is refused if the evidence is weaker than what the task itself demanded (§12.2).
 * 2. **A refusal is data.** Every refusal goes through `refuse()`, which bumps a counter and persists
 *    it, so the metrics in §20.5 (fake-completion rate, unmapped requirements, unapproved execution)
 *    measure what actually happened rather than what the host remembers doing.
 * 3. **Honesty beats a clean number.** Skipping the blind review is allowed, but the run then carries
 *    `independence: "reduced"` in every later answer, including the final one.
 *
 * `introduce` is the onboarding funnel: it returns a short orientation and points the host at `start`,
 * so the first thing a connecting agent sees is "what Pro-Fetch is and how to use it", not 672 raw tools.
 */

import { createHash } from 'node:crypto';
import { defineTool } from '../../core/tool.js';
import { allTools } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { bool, strOrEmpty, view } from '../../core/input.js';
import { detailMode } from '../../core/composite-budget.js';
import {
  canTransition,
  completionEligible,
  createWorkflow,
  findingBlocks,
  PHASES,
  transition,
  unmappedRequirements,
} from '../../core/workflow/state-machine.js';
import { saveWorkflow, loadWorkflow } from '../../core/workflow/store.js';
import { validateFinding, validateGoalSpec, validatePlan, verificationWeakness } from '../../core/workflow/validate.js';
import { assessPlan, pendingApprovals, riskIssues } from '../../core/workflow/risk.js';
import { riskChecklist, riskCoverage, type RiskDisposal } from '../../core/workflow/risks.js';
import { nextRunnable, parallelisableTasks, planConflicts } from '../../core/workflow/schedule.js';
import {
  emptyStats,
  requirementIds,
  requirements,
  SOURCE_RELIABILITY,
  VERIFICATION_TYPES,
  verificationStrength,
  type Finding,
  type FindingClassification,
  type GoalSpec,
  type Source,
  type Task,
  type TaskStatus,
  type VerificationType,
  type WorkflowMode,
  type WorkflowPhase,
  type WorkflowState,
  type WorkflowStats,
} from '../../core/workflow/types.js';

const knownToolNames = (): ReadonlySet<string> => new Set(allTools().map((t) => t.name));
const requirementIdSet = (goal: GoalSpec): ReadonlySet<string> =>
  new Set(requirements(goal).map((requirement) => requirement.id));
const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Load a run by id. `null` (not a throw) when nothing is stored under that id. */
async function requireWorkflow(id: string): Promise<WorkflowState | null> {
  if (!id) return null;
  return loadWorkflow(id);
}

/** Statuses that say "this is done" in some degree. Only `verified` says it without a caveat. */
const CLOSING_STATUSES: readonly TaskStatus[] = ['verified', 'passed', 'mock_verified'];
const REPORTABLE_STATUSES: readonly TaskStatus[] = [
  'verified',
  'passed',
  'mock_verified',
  'needs_verification',
  'not_run',
  'skipped',
  'failed',
  'blocked',
];

/** Task ids whose steps the registry says can change state and that carry no approval yet. */
const awaitingApproval = (state: WorkflowState): string[] => {
  const tasks = state.plan?.tasks ?? [];
  return tasks.length ? pendingApprovals(tasks, assessPlan(tasks)) : [];
};

/** Task projection used under `detail: "summary"` — enough to act on, without the full criteria text. */
const briefTask = (t: Task) => ({
  id: t.id,
  objective: t.objective,
  priority: t.priority,
  status: t.status,
  approved: Boolean(t.approval),
  covers: t.covers ?? [],
  tools: t.toolPlan.map((plan) => plan.toolName),
  depends_on: t.dependsOn,
});

/** The §20.5 measures that can be computed from what was persisted. */
function metrics(state: WorkflowState): Record<string, unknown> {
  const tasks = state.plan?.tasks ?? [];
  const goalIds = requirements(state.goal);
  const mapped = new Set(tasks.flatMap((task) => task.covers ?? []));
  const reqIds = goalIds.filter((requirement) => requirement.kind !== 'unknown').map((requirement) => requirement.id);
  const mustFix = state.findings.filter((finding) => finding.classification === 'must_fix');
  const stats = state.stats ?? emptyStats();
  const closedUnknowns = new Set((state.unknowns ?? []).map((entry) => entry.id));
  return {
    requirement_coverage: {
      total: reqIds.length,
      mapped: reqIds.filter((id) => mapped.has(id)).length,
      percent: reqIds.length ? Math.round((100 * reqIds.filter((id) => mapped.has(id)).length) / reqIds.length) : 100,
    },
    tasks: { total: tasks.length, verified: tasks.filter((task) => task.status === 'verified').length },
    must_fix: { total: mustFix.length, resolved: mustFix.filter((finding) => finding.status === 'resolved').length },
    open_findings: state.findings.filter((finding) => finding.status === 'open').length,
    unknowns: {
      total: goalIds.filter((requirement) => requirement.kind === 'unknown').length,
      closed: [...closedUnknowns].filter((id) => goalIds.some((r) => r.id === id)).length,
    },
    evidence: state.evidence.length,
    attempts: stats.attempts,
    refused: {
      fake_completion: stats.fakeCompletionRefused,
      illegal_transition: stats.illegalTransitionRefused,
      unapproved_execution: stats.unapprovedExecutionRefused,
      understated_risk: stats.understatedRiskRefused,
      unmapped_requirement: stats.unmappedRequirementRefused,
      duplicate_submission: stats.duplicatePlanRefused,
      stagnation: stats.stagnationRefused,
      weak_evidence: stats.unverifiableEvidenceRefused,
      unsourced_resolution: stats.unsourcedResolutionRefused,
      unaddressed_risk: stats.unaddressedRiskRefused,
    },
    calls: { logged: stats.callsLogged, duplicated: stats.duplicateCalls },
    conflicts: { serialised: stats.conflictsSerialised, pairs: planConflicts(tasks) },
    sources: {
      total: (state.sources ?? []).length,
      by_reliability: SOURCE_RELIABILITY.reduce<Record<string, number>>((acc, kind) => {
        acc[kind] = (state.sources ?? []).filter((entry) => entry.reliability === kind).length;
        return acc;
      }, {}),
    },
    risk_audit: {
      applicable: (state.audit?.risks ?? []).length,
      by_finding: (state.audit?.risks ?? []).filter((entry) => entry.disposition === 'finding').length,
      dismissed: (state.audit?.risks ?? []).filter((entry) => entry.disposition === 'dismissed').length,
      open: (state.audit?.risks ?? []).filter((entry) => entry.disposition === 'open').length,
    },
    // §20.5 asks for result quality, not only refusals. These are computed from the ledger — ratios
    // of what the run actually holds, never an opinion about it. A 1.0 means every verifiable claim
    // in this run has evidence behind it; a value below 1 means something in it was closed on a
    // weaker basis (an accepted risk, an unpointed deliverable), which is legitimate but must show.
    quality: qualityScores(state),
    independence: state.audit?.independence ?? 'not-audited',
    elapsed_ms: state.updatedAt - state.createdAt,
  };
}

/**
 * The plan in the shape spec §4.5 asks for — machine-readable, and derived entirely from what is
 * already stored. Nothing here is a second source of truth: the requirement map is read from the
 * same `covers` the coverage gate enforces, the risk register is the graded mutating steps, and the
 * parallel set is what the scheduler would actually hand out at once. A host that wants to show a
 * plan to a human reads this instead of re-assembling the pieces and getting them subtly wrong.
 */
function planView(state: WorkflowState): Record<string, unknown> {
  const tasks = state.plan?.tasks ?? [];
  const requirements_ = requirements(state.goal).filter((entry) => entry.kind !== 'unknown');
  const closed = state.unknowns ?? [];
  return {
    goal: state.goal.goal,
    scope: { constraints: state.goal.constraints, deliverables: state.goal.deliverables },
    requirement_map: requirements_.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      text: entry.text,
      carried_by: tasks.filter((task) => (task.covers ?? []).includes(entry.id)).map((task) => task.id),
    })),
    dependency_graph: tasks.map((task) => ({ id: task.id, depends_on: task.dependsOn })),
    parallelisable: parallelisableTasks(tasks),
    conflicts: planConflicts(tasks),
    capabilities: [...new Set(tasks.flatMap((task) => task.toolPlan.map((plan) => plan.toolName)))].sort(),
    risk_register: state.plan?.risks ?? [],
    risk_audit: (state.audit?.risks ?? []).map((entry) => ({
      item: entry.item,
      disposition: entry.disposition,
      note: entry.note ?? '',
    })),
    approval_required: awaitingApproval(state),
    verification_strategy: state.plan?.verificationStrategy ?? '',
    steps_without_fallback: tasks.flatMap((task) =>
      task.toolPlan.filter((plan) => !plan.fallback).map((plan) => `${task.id}:${plan.toolName}`),
    ),
    acceptance_criteria: state.goal.acceptanceCriteria,
    unknowns: {
      open: requirements(state.goal)
        .filter((entry) => entry.kind === 'unknown' && !closed.some((done) => done.id === entry.id))
        .map((entry) => entry.id),
      closed: closed.map((entry) => ({ id: entry.id, verdict: entry.verdict })),
    },
  };
}

/**
 * Quality measured from the stored run. Denominators of zero report 1: an empty obligation set is
 * satisfied, not unknown, and the counts next to the ratio say how much was judged.
 */
function qualityScores(state: WorkflowState): Record<string, unknown> {
  const tasks = state.plan?.tasks ?? [];
  const verified = tasks.filter((task) => task.status === 'verified');
  const ratio = (num: number, den: number): number => (den === 0 ? 1 : Math.round((num / den) * 100) / 100);
  const evidenceBacked = verified.filter((task) => state.evidence.some((record) => record.taskId === task.id)).length;
  const strengthMet = verified.filter((task) => {
    const required = task.verification?.type;
    const given = task.verifiedWith;
    if (!required || !given) return true;
    return verificationStrength(given) >= verificationStrength(required);
  }).length;
  const promised = tasks.filter((task) => (task.deliverables ?? []).length > 0).length;
  const pointed = tasks.filter(
    (task) =>
      (task.deliverables ?? []).length > 0 &&
      state.evidence.some((record) => record.taskId === task.id && record.artifact),
  ).length;
  const risks = state.audit?.risks ?? [];
  const disposed = risks.filter((entry) => entry.disposition !== 'open').length;
  const unknownTotal = requirements(state.goal).filter((entry) => entry.kind === 'unknown').length;
  const unknownClosed = state.unknowns ?? [];
  const unknownSourced = unknownClosed.filter(
    (entry) => entry.verdict === 'resolved' && (entry.sources?.length ?? 0) > 0,
  ).length;
  return {
    evidence_backed_verified: { ratio: ratio(evidenceBacked, verified.length), of: verified.length },
    strength_met: { ratio: ratio(strengthMet, verified.length), of: verified.length },
    deliverables_pointed: { ratio: ratio(pointed, promised), of: promised },
    risks_disposed: { ratio: ratio(disposed, risks.length), of: risks.length },
    unknowns_closed: { ratio: ratio(unknownClosed.length, unknownTotal), of: unknownTotal },
    unknowns_sourced: { ratio: ratio(unknownSourced, unknownClosed.length), of: unknownClosed.length },
  };
}

const INTRO = [
  'Pro-Fetch: web fetch, crawl, search, deep research, GitHub, PDF/Office/image, data tools.',
  'For substantial work, run the workflow: start → submit_plan (MexaPlan) → begin_audit + submit_review',
  '(SmartToDo) → approve_plan if anything writes → get_next_task/report_task_result (MaxEffort) → verify →',
  'final_audit → finish. Completion needs evidence, mapped requirements and a final audit.',
].join(' ');

/** A GoalSpec from a host that is allowed to be sloppy about arrays, but not about the goal itself. */
/**
 * A GoalSpec is written by a model, in prose, under a name it invented. Measured from hosts driving
 * the tool: several lost their first `start` call to `acceptance_missing` while the payload carried
 * `acceptance_criteria`. So the field names are matched case- and separator-insensitively plus the
 * obvious synonyms, and anything still unrecognised is named back rather than dropped in silence —
 * the second case is invisible unless it is reported.
 */
const GOAL_ALIASES: Record<string, readonly string[]> = {
  goal: ['goal', 'objective', 'aim', 'maqsad'],
  explicitRequirements: ['explicitrequirements', 'explicit_requirements', 'requirements', 'explicit'],
  implicitRequirements: ['implicitrequirements', 'implicit_requirements', 'implicit'],
  constraints: ['constraints', 'restrictions', 'limitations'],
  deliverables: ['deliverables', 'outputs', 'artifacts', 'results'],
  acceptanceCriteria: ['acceptancecriteria', 'acceptance_criteria', 'acceptance', 'criteria'],
  unknowns: ['unknowns', 'open_questions', 'openquestions', 'uncertainties'],
  qualityTarget: ['qualitytarget', 'quality_target', 'quality'],
  riskTolerance: ['risktolerance', 'risk_tolerance', 'risk'],
};

/** Fields the controller will still be missing after normalisation, for the refusal message. */
export interface GoalNormalisation {
  goal: GoalSpec;
  recognised: string[];
  unrecognised: string[];
}

export function readGoalSpec(raw: unknown): GoalNormalisation {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const lowered = new Map<string, unknown>();
  // Report the key the host actually typed, not the normalised form it was matched under.
  const original = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    lowered.set(normalised, value);
    original.set(normalised, key);
  }
  const recognised: string[] = [];
  const used = new Set<string>();
  const pick = (field: string): unknown => {
    for (const alias of GOAL_ALIASES[field] ?? []) {
      if (lowered.has(alias)) {
        used.add(alias);
        recognised.push(field);
        return lowered.get(alias);
      }
    }
    return undefined;
  };
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((item) => String(item)).filter((item) => item.trim()) : [];
  const single = (value: unknown): string[] => (typeof value === 'string' && value.trim() ? [value.trim()] : []);

  const goal: GoalSpec = {
    goal: String(pick('goal') ?? '').trim(),
    explicitRequirements: [...list(pick('explicitRequirements')), ...single(source.explicitRequirements as unknown)],
    implicitRequirements: list(pick('implicitRequirements')),
    constraints: list(pick('constraints')),
    deliverables: list(pick('deliverables')),
    acceptanceCriteria: list(pick('acceptanceCriteria')),
    unknowns: list(pick('unknowns')),
    qualityTarget: String(pick('qualityTarget') ?? 'high'),
    riskTolerance: (['low', 'medium', 'high'] as const).includes(pick('riskTolerance') as never)
      ? (pick('riskTolerance') as GoalSpec['riskTolerance'])
      : 'low',
  };
  const unrecognised = [...lowered.keys()].filter((key) => !used.has(key)).map((key) => original.get(key) ?? key);
  return { goal, recognised: [...new Set(recognised)], unrecognised };
}

function normaliseGoal(raw: unknown): GoalSpec {
  return readGoalSpec(raw).goal;
}

export default defineTool({
  name: 'pro_fetch_workflow',
  description:
    'Bigfoot ish-oqimi kontrolleri (bitta tool). action: introduce | start | submit_plan | begin_audit | ' +
    'submit_review | revise_plan | resolve_finding | report_finding | approve_plan | get_next_task | ' +
    'report_task_result | log_call | record_source | resolve_unknown | verify | repair | final_audit | ' +
    'replan | finish | block | unblock | pause | resume | status. MexaPlan→SmartToDo→MaxEffort hayot siklini ' +
    'boshqaradi; xavf registrydan o‘lchanadi, talablar qoplamasi tekshiriladi, xulosalar manbaga bog‘lanadi, ' +
    'dalilsiz va kuchsiz dalilli "tayyor" rad etiladi.',
  category: 'admin',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description:
          'introduce|start|submit_plan|begin_audit|submit_review|revise_plan|resolve_finding|report_finding|' +
          'approve_plan|get_next_task|report_task_result|log_call|record_source|resolve_unknown|verify|repair|' +
          'final_audit|replan|finish|block|unblock|pause|resume|status',
      },
      workflow_id: {
        type: 'string',
        description: 'start javobidagi id (introduce/startdan tashqari barcha actionlar)',
      },
      goal: { type: 'string', description: 'start: foydalanuvchi maqsadi (GoalSpec JSON matni yoki oddiy satr)' },
      mode: {
        type: 'string',
        description:
          'start: full | lite (yakuniy audit ixtiyoriy) | direct (mustaqil auditni host o‘z zimmasiga oladi)',
      },
      plan: {
        type: 'string',
        description:
          'submit_plan: {tasks:[{id, objective, priority, dependsOn[], deliverables[], covers:[E1,A2,...], ' +
          'acceptanceCriteria[], verification:{method, evidenceRequired, type?}, toolPlan:[{toolName, category, ' +
          'purpose, sensitivity, requiresApproval, fallback?}]}]} JSON matni',
      },
      findings: { type: 'string', description: 'submit_review | report_finding | final_audit: [finding,...] JSON' },
      stage: { type: 'string', description: 'begin_audit/submit_review: blind (plan ko‘rinmaydi) | full' },
      dismissed_risks: {
        type: 'string',
        description:
          'submit_review: [{item, reason}] JSON matni — bu plan ko‘targan, lekin alohida topilma ' +
          'talab qilmaydigan risk bandlari (sabab majburiy, §5.3)',
      },
      task_id: { type: 'string', description: 'report_task_result | log_call | approve_plan: task id' },
      task_status: { type: 'string', description: 'report_task_result: §12.2 holatlaridan biri' },
      evidence: { type: 'string', description: 'report_task_result: dalil matni (tokenlar avtomatik yashiriladi)' },
      verification_type: {
        type: 'string',
        description: `report_task_result: dalil kuchi (${VERIFICATION_TYPES.join('|')})`,
      },
      challenge: {
        type: 'string',
        description: 'report_task_result: critical/high taskni yopishda o‘z xulosangizni qanday sinaganingiz (§6.4)',
      },
      command: { type: 'string', description: 'report_task_result: dalil uchun bajarilgan buyruq (ixtiyoriy)' },
      exit_code: { type: 'string', description: 'report_task_result: buyruq exit code (ixtiyoriy, raqam matni)' },
      artifact: { type: 'string', description: 'report_task_result: dalil fayli yoki URI (ixtiyoriy)' },
      tool_name: { type: 'string', description: 'log_call: ishlatilgan registry tool nomi' },
      purpose: { type: 'string', description: 'log_call: chaqiruvning vazifasi (§6.5) va produced=true/false' },
      produced: {
        type: 'boolean',
        description: 'log_call: chaqiruv yangi dalil berdimi (true|false, "true"/"false" matni ham qabul qilinadi)',
      },
      unknown_id: { type: 'string', description: 'resolve_unknown: noaniqlik id si (U1, U2, ...)' },
      source_ids: {
        type: 'string',
        description: 'resolve_unknown: xulosa suyangan manba idlari (verdict=resolved uchun majburiy)',
      },
      reference: { type: 'string', description: 'record_source: tekshirilgan manba (URL, fayl, tool natijasi)' },
      reliability: {
        type: 'string',
        description: `record_source: ${SOURCE_RELIABILITY.join('|')}`,
      },
      observation: { type: 'string', description: 'record_source: bu manbadan nima ma’lum bo‘ldi' },
      relates_to: { type: 'string', description: 'record_source: aloqador talab idlari (E1,A2,U1...)' },
      finding_id: { type: 'string', description: 'resolve_finding: topilma id si' },
      resolution: {
        type: 'string',
        description: 'resolve_finding: topilma qanday tugatilgani haqidagi dalil (resolved uchun majburiy)',
      },
      verdict: {
        type: 'string',
        description: 'resolve_finding: resolved|rejected · resolve_unknown: resolved|accepted_risk|out_of_scope',
      },
      note: {
        type: 'string',
        description:
          'approve_plan: sabab (majburiy) · final_audit/resolve_unknown: nima tekshirilgani/yopilgani yozuvi',
      },
      reason: {
        type: 'string',
        description: 'revise_plan | replan | repair | block | pause: sabab (§13.2 — yangi fakt ko‘rsatilsin)',
      },
      target: { type: 'string', description: 'unblock: qaytiladigan faza — PLANNING yoki EXECUTING' },
      detail: {
        type: 'string',
        enum: ['summary', 'full'],
        description:
          'Javob hajmi: summary (standart) faqat qaror maydonlari, full — task/finding/evidence tafsilotlari bilan.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const action = strOrEmpty(p, 'action').toLowerCase();
    const detail = detailMode(strOrEmpty(p, 'detail'));

    /** Count one measured event against the run's ledger. */
    const bump = (target: WorkflowState, counter: keyof WorkflowStats, by = 1): void => {
      target.stats = target.stats ?? emptyStats();
      target.stats[counter] += by;
    };

    /** Count the refusal, persist it, then refuse. A refusal that is not recorded is a metric lost. */
    const refuse = async (
      state: WorkflowState,
      counter: keyof WorkflowStats | null,
      message: string,
    ): Promise<ReturnType<typeof fail>> => {
      if (counter) {
        bump(state, counter);
        await saveWorkflow(state);
      }
      return fail(message);
    };

    if (action === 'introduce') {
      return jsonBlock('Pro-Fetch workflow — tanishuv', {
        intro: INTRO,
        next_action: 'start',
        ...(detail === 'full' ? { phases: PHASES } : {}),
      });
    }

    if (action === 'start') {
      const rawGoal = strOrEmpty(p, 'goal');
      if (!rawGoal) return fail('start uchun goal kerak.');
      let goal: GoalSpec;
      try {
        goal = rawGoal.trim().startsWith('{')
          ? normaliseGoal(JSON.parse(rawGoal))
          : { ...normaliseGoal({ goal: rawGoal }), acceptanceCriteria: [rawGoal.trim()] };
      } catch {
        return fail('goal JSON matni noto‘g‘ri.');
      }
      const read = readGoalSpec(rawGoal.trim().startsWith('{') ? JSON.parse(rawGoal) : { goal: rawGoal });
      goal = read.goal;
      const gIssues = validateGoalSpec(goal);
      if (gIssues.length)
        return fail(
          `GoalSpec yaroqsiz — ${err(gIssues)}` +
            (read.unrecognised.length
              ? `. Tushunilmagan kalitlar: ${read.unrecognised.join(', ')} (kutilgani: goal, explicitRequirements, ` +
                'constraints, deliverables, acceptanceCriteria, unknowns)'
              : ''),
        );
      const mode = (
        ['full', 'lite', 'direct'].includes(strOrEmpty(p, 'mode')) ? strOrEmpty(p, 'mode') : 'full'
      ) as WorkflowMode;
      const id = `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      let state = createWorkflow(id, goal, mode);
      state.stats = emptyStats();
      state = transition(state, 'PLANNING', 'start');
      await saveWorkflow(state);
      return jsonBlock('Workflow boshlandi', {
        workflow_id: id,
        phase: state.phase,
        requirements: requirements(goal).length,
        // Hosts guessed at `E1`/`A1` often enough to burn a round trip each time; the ids a plan has
        // to carry are cheap and are the whole point of the coverage gate.
        requirement_ids: requirementIds(goal),
        unknown_ids: requirements(goal)
          .filter((entry) => entry.kind === 'unknown')
          .map((entry) => entry.id),
        next_action: 'submit_plan',
        ...(detail === 'full'
          ? {
              instruction:
                'MexaPlan: har taskda covers:[talab id] bo‘lsin (E1.., I1.., C1.., D1.., A1..), real registry ' +
                'tool nomlari, acceptance criteria va verification.type bilan submit_plan qiling.',
              requirement_list: requirements(goal),
            }
          : {}),
      });
    }

    const id = strOrEmpty(p, 'workflow_id');
    let state = await requireWorkflow(id);
    if (!state) return fail(`workflow_id topilmadi: ${id || '(bo‘sh)'}`);
    state.stats = state.stats ?? emptyStats();

    /** Parse + validate a findings payload, rejecting duplicates and invented requirement refs. */
    const readFindings = (blind: boolean): Finding[] | string => {
      let findings: Finding[];
      try {
        findings = JSON.parse(strOrEmpty(p, 'findings')) as Finding[];
      } catch {
        return 'findings JSON matni noto‘g‘ri.';
      }
      if (!Array.isArray(findings)) return 'findings massiv bo‘lishi kerak.';
      const known = requirementIdSet(state!.goal);
      const existing = new Map(state!.findings.map((entry) => [entry.id, entry]));
      for (const finding of findings) {
        // Same reason tasks are normalised: `status` is what the closing step reads. Without a default
        // a finding submitted without one became permanently unclosable ("finding F2 allaqachon undefined").
        finding.status = finding.status ?? 'open';
        finding.blocking = Boolean(finding.blocking);
        const issues = validateFinding(finding, known);
        if (issues.length) return `finding ${finding?.id} yaroqsiz — ${err(issues)}`;
        const prior = existing.get(finding.id);
        if (prior) {
          // §5.7: a closed objection does not reopen without a new fact.
          if (prior.status !== 'open') {
            if (hash(prior.evidence) === hash(finding.evidence))
              return `finding ${finding.id} qayta ochilmoqda yangi dalilsiz (evidence bir xil) — §5.7`;
            Object.assign(prior, finding, { status: 'open', resolution: undefined, blind });
          } else return `finding ${finding.id} allaqachon ochiq (takror yubormang)`;
          continue;
        }
        finding.blind = blind;
        state!.findings.push(finding);
      }
      return findings;
    };

    switch (action) {
      case 'submit_plan': {
        if (state.phase !== 'PLANNING')
          return refuse(
            state,
            'illegalTransitionRefused',
            `submit_plan faqat PLANNING fazasida (hozir: ${state.phase}).`,
          );
        let tasks: Task[];
        try {
          const parsed = JSON.parse(strOrEmpty(p, 'plan'));
          tasks = (Array.isArray(parsed) ? parsed : parsed?.tasks) as Task[];
        } catch {
          return fail('plan JSON matni noto‘g‘ri.');
        }
        if (!Array.isArray(tasks))
          return fail('plan {tasks:[...]} yoki to‘g‘ridan-to‘g‘ri task massivi bo‘lishi kerak.');
        if (tasks.some((entry) => typeof entry !== 'object' || entry === null))
          return fail('har bir task obyekti bo‘lishi kerak (matn yoki massiv emas).');
        // A host that omits an array field must not be able to crash the controller three calls later.
        // `validateTasks` checks what a plan has to *say*; this fills what the machinery *uses*.
        // Measured: a plan submitted without `evidenceRefs` passed validation, then threw
        // "Cannot read properties of undefined (reading 'push')" on the first honest report.
        tasks = tasks.map((entry) => ({
          ...entry,
          dependsOn: entry.dependsOn ?? [],
          deliverables: entry.deliverables ?? [],
          evidenceRefs: entry.evidenceRefs ?? [],
          blockers: entry.blockers ?? [],
          covers: entry.covers ?? [],
          toolPlan: entry.toolPlan ?? [],
          acceptanceCriteria: entry.acceptanceCriteria ?? [],
          attempts: Number.isFinite(entry.attempts) ? entry.attempts : 0,
          status: entry.status ?? 'pending',
        }));

        const { ok, issues } = validatePlan(tasks, knownToolNames(), state.goal);
        if (!ok) return refuse(state, 'duplicatePlanRefused', `Plan rad etildi — ${err(issues)}`);
        // The host's `sensitivity` label is a claim; the registry is the evidence.
        const risks = assessPlan(tasks);
        const riskProblems = riskIssues(risks);
        if (riskProblems.length)
          return refuse(state, 'understatedRiskRefused', `Plan xavf bahosi bo‘yicha rad etildi — ${err(riskProblems)}`);
        // §13.3: a revision that brought neither new evidence nor a new finding is a loop, not progress.
        const snapshot = { at: Date.now(), evidence: state.evidence.length, findings: state.findings.length };
        const last = state.progress?.[state.progress.length - 1];
        if (last && last.evidence === snapshot.evidence && last.findings === snapshot.findings)
          return refuse(
            state,
            'stagnationRefused',
            'stagnation: bu revision oldingisidan farq qilmaydi (yangi dalil ham, yangi topilma ham yo‘q). ' +
              'Yangi fakt qo‘shing yoki block bilan aniq blocker qayd eting (§13.3).',
          );
        // §5.2: an unmapped requirement is resolved before the plan is called ready — asking the
        // auditor to review a plan that ignores half the goal wastes the review.
        const unmapped = unmappedRequirements(state.goal, tasks);
        if (unmapped.length)
          return refuse(
            state,
            'unmappedRequirementRefused',
            `Qoplanmagan talablar: ${unmapped.join(', ')} — har birini kamida bitta task.covers‘ga bog‘lang (§5.2).`,
          );
        const mutating = risks.filter((risk) => risk.mutating);
        state.plan = {
          tasks,
          risks: mutating.map(
            (risk) => `${risk.taskId}: ${risk.toolName} — registry: mutating${risk.remote ? ' (tashqi tizim)' : ''}`,
          ),
          verificationStrategy: 'per-task verification',
        };
        // Both numbers are measured here. An earlier version wrote `mapped: 0` and counted unknowns
        // as requirements, so an unaudited run reported a coverage figure that was simply wrong.
        const requiredIds = requirementIds(state.goal);
        state.audit = {
          at: Date.now(),
          coverage: {
            total: requiredIds.length,
            mapped: requiredIds.length - unmapped.length,
            unmapped,
          },
          risks: riskChecklist(state.goal, tasks, risks).map((item) => ({
            item: item.id,
            because: item.because,
            disposition: 'open' as const,
          })),
        };
        state.progress = [...(state.progress ?? []), snapshot];
        state = transition(state, 'AUDIT_REQUIRED', 'plan submitted');
        let skippedAudit = false;
        if (state.mode === 'direct') {
          // `direct` means the host accepts the plan without an independent SmartToDo pass. The step is
          // still traversed in history and said out loud in the answer and the metrics: a skipped step
          // that leaves no trace is how a run starts believing it was reviewed.
          state = transition(state, 'PLAN_READY', 'direct mode: independent audit skipped by the host');
          state.audit = { at: Date.now(), ...state.audit, independence: 'reduced' };
          skippedAudit = true;
        }
        await saveWorkflow(state);
        return jsonBlock('Plan qabul qilindi', {
          ...(skippedAudit ? { audit_skipped: true } : {}),
          workflow_id: id,
          phase: state.phase,
          tasks: tasks.length,
          mutating_steps: mutating.length,
          approval_required: pendingApprovals(tasks, risks).length,
          next_action: 'begin_audit',
          ...(detail === 'full' ? { plan: tasks, risky_steps: mutating } : {}),
        });
      }

      case 'begin_audit': {
        if (state.phase !== 'AUDIT_REQUIRED')
          return refuse(
            state,
            'illegalTransitionRefused',
            `begin_audit faqat AUDIT_REQUIRED fazasida (hozir: ${state.phase}).`,
          );
        const stage = strOrEmpty(p, 'stage').toLowerCase() === 'full' ? 'full' : 'blind';
        state.audit = state.audit ?? { at: Date.now() };
        if (stage === 'blind') {
          if (state.audit.planSeenAt)
            return fail('blind packet berilmaydi: plan allaqachon ochilgan (planSeenat). Mustaqillik — reduced.');
          state.audit.blindStartedAt = Date.now();
          state.audit.independence = 'blind';
          await saveWorkflow(state);
          // The blind packet is the goal only: what must be true, not what the planner proposed (§5.1).
          return jsonBlock('Blind audit paketi', {
            workflow_id: id,
            phase: state.phase,
            goal: state.goal.goal,
            requirements: requirements(state.goal),
            unknowns: state.goal.unknowns,
            plan_visible: false,
            next_action: 'submit_review',
            instruction: 'Plan’ni ko‘rmasdan: talablar ro‘yxati bo‘yicha qanday ish va tekshiruv KERAKLIGINI yozing.',
          });
        }
        state.audit.planSeenAt = Date.now();
        state.audit.independence = state.audit.blindStartedAt ? 'blind' : 'reduced';
        await saveWorkflow(state);
        return jsonBlock('Plan audite ochildi', {
          workflow_id: id,
          phase: state.phase,
          independence: state.audit.independence,
          next_action: 'submit_review',
          // §5.3: the items are derived from what the plan actually does, so the auditor cannot be
          // told a shorter list than the plan deserves.
          risk_checklist: (state.audit?.risks ?? []).map((entry) => ({ item: entry.item, because: entry.because })),
          risk_rule:
            'Har bir item bo‘yicha topilma yozing (finding.riskItem) yoki `dismissed_risks` bilan sabab bilan rad eting.',
          ...(detail === 'full'
            ? { plan: state.plan?.tasks ?? [], conflicts: planConflicts(state.plan?.tasks ?? []) }
            : {}),
        });
      }

      case 'submit_review': {
        if (state.phase !== 'AUDIT_REQUIRED')
          return refuse(
            state,
            'illegalTransitionRefused',
            `submit_review faqat AUDIT_REQUIRED fazasida (hozir: ${state.phase}).`,
          );
        const blindFirst = Boolean(state.audit?.blindStartedAt) && !state.audit?.planSeenAt;
        const stage = strOrEmpty(p, 'stage').toLowerCase() || (blindFirst ? 'blind' : 'full');
        if (stage === 'full' && blindFirst)
          return fail(
            'Blind bosqich tugamagan: avval begin_audit stage=full bilan plan’ni oching, keyin to‘liq review bering (§5.1).',
          );
        if (stage === 'blind' && !blindFirst)
          return fail("Blind review endi ma'nosiz: plan allaqachon ochilgan — submit_review stage=full.");
        const findingsBefore = state.findings.length;
        const parsed = readFindings(stage === 'blind');
        if (typeof parsed === 'string') return refuse(state, 'duplicatePlanRefused', parsed);

        if (stage === 'blind') {
          await saveWorkflow(state);
          return jsonBlock('Blind topilmalar qayd etildi', {
            workflow_id: id,
            phase: state.phase,
            recorded: parsed.length,
            independence: 'blind',
            next_action: 'begin_audit',
            instruction: 'Endi begin_audit stage=full bilan plan’ni oching va uni shu topilmalar bilan solishtiring.',
          });
        }
        const tasks = state.plan?.tasks ?? [];
        const unmapped = unmappedRequirements(state.goal, tasks);
        const required = requirements(state.goal).filter((requirement) => requirement.kind !== 'unknown');
        // §5.3: the risk items are derived from the plan, and every one of them has to be disposed of
        // before the plan can be called ready — as a finding, or as a dismissal with a reason. Items
        // dismissed in an earlier round stay disposed of; the auditor is not asked to argue twice.
        const checklist = riskChecklist(state.goal, tasks, assessPlan(tasks));
        let dismissed: RiskDisposal[] = (state.audit?.risks ?? [])
          .filter((entry) => entry.disposition === 'dismissed')
          .map((entry) => ({ item: entry.item, reason: entry.note ?? '' }));
        const rawDismissed = strOrEmpty(p, 'dismissed_risks');
        if (rawDismissed) {
          try {
            const parsedDismissed = JSON.parse(rawDismissed) as RiskDisposal[];
            if (!Array.isArray(parsedDismissed)) return fail('dismissed_risks massiv bo‘lishi kerak.');
            dismissed = [...dismissed, ...parsedDismissed];
          } catch {
            return fail('dismissed_risks JSON matni noto‘g‘ri.');
          }
        }
        const riskCheck = riskCoverage(checklist, state.findings, dismissed);
        if (!riskCheck.ok) {
          const named = (list: string[]) => (list.length ? list.join(', ') : '—');
          // Roll the submission back rather than half-keeping it: findings left behind would make the
          // corrected retry fail the duplicate check instead of the risk check it now violates.
          state.findings.length = findingsBefore;
          return refuse(
            state,
            'unaddressedRiskRefused',
            `Risk audit to‘liq emas (§5.3) — qarovsiz qolgan: ${named(riskCheck.unaddressed)}; ` +
              `plan ko'tarmagan item: ${named(riskCheck.invented)}; sababsiz rad: ${named(riskCheck.emptyDismissing)}. ` +
              `Hujumni topilma (finding.riskItem) yoki dismissed_risks bilan yopib qayta yuboring.`,
          );
        }
        const audit = {
          ...(state.audit ?? { at: Date.now() }),
          independence: state.audit?.blindStartedAt ? ('blind' as const) : ('reduced' as const),
          coverage: { total: required.length, mapped: required.length - unmapped.length, unmapped },
          risks: checklist.map((item) => {
            const finding = state!.findings.find((entry) => entry.riskItem === item.id);
            if (finding)
              return { item: item.id, because: item.because, disposition: 'finding' as const, note: finding.id };
            const dismissal = dismissed.find((entry) => entry.item === item.id);
            return {
              item: item.id,
              because: item.because,
              disposition: 'dismissed' as const,
              note: dismissal?.reason ?? '',
            };
          }),
        };
        state.audit = audit;
        const blockingOpen = state.findings.some((finding) => findingBlocks(finding) && finding.status === 'open');
        state = transition(
          state,
          blockingOpen ? 'REVISION_REQUIRED' : 'PLAN_READY',
          blockingOpen ? 'blocking findings' : 'review clean',
        );
        await saveWorkflow(state);
        return jsonBlock('Review qayd etildi', {
          workflow_id: id,
          phase: state.phase,
          blocking: blockingOpen,
          independence: audit.independence,
          coverage: audit.coverage,
          risks_reviewed: audit.risks?.length ?? 0,
          risks_by_finding: (audit.risks ?? []).filter((entry) => entry.disposition === 'finding').length,
          next_action: blockingOpen ? 'revise_plan' : awaitingApproval(state).length ? 'approve_plan' : 'get_next_task',
          ...(detail === 'full'
            ? {
                findings: state.findings.map((finding) => ({
                  id: finding.id,
                  severity: finding.severity,
                  classification: finding.classification,
                  blocking: findingBlocks(finding),
                  status: finding.status,
                  blind: Boolean(finding.blind),
                })),
              }
            : {}),
        });
      }

      case 'revise_plan': {
        if (state.phase !== 'REVISION_REQUIRED')
          return refuse(
            state,
            'illegalTransitionRefused',
            `revise_plan faqat REVISION_REQUIRED fazasida (hozir: ${state.phase}).`,
          );
        if (!strOrEmpty(p, 'reason').trim())
          return fail(
            'revise_plan uchun reason kerak: rejada nima o‘zgargani yozilsin (yangi fakt yo‘qmi, takror reja ham yo‘q).',
          );
        state = transition(state, 'PLANNING', `revise: ${strOrEmpty(p, 'reason').trim()}`);
        await saveWorkflow(state);
        return jsonBlock('Reja ko‘rib chiqishga qaytdi', {
          workflow_id: id,
          phase: state.phase,
          next_action: 'submit_plan',
          instruction: 'Yangi plan qayta audit‘dan o‘tadi va yangi dalil yoki topilma keltirishi kerak (§13.3).',
        });
      }

      case 'resolve_finding': {
        const fid = strOrEmpty(p, 'finding_id');
        const finding = state.findings.find((entry) => entry.id === fid);
        if (!finding) return fail(`finding topilmadi: ${fid || '(bo‘sh)'}`);
        if (finding.status !== 'open') return fail(`finding ${fid} allaqachon ${finding.status}.`);
        const verdict = strOrEmpty(p, 'verdict') || 'resolved';
        if (!['resolved', 'rejected'].includes(verdict))
          return fail('verdict resolved yoki rejected bo‘lishi kerak (false_positive — reject deb yoziladi).');
        const note = strOrEmpty(p, 'resolution').trim();
        if (!note) return fail(`${verdict} uchun resolution dalili kerak (topilmani yopish ham dalil talab qiladi).`);
        finding.status = verdict as Finding['status'];
        finding.resolution = { status: verdict as 'resolved' | 'rejected', note, at: Date.now() };
        const stillBlocking = state.findings.some((entry) => findingBlocks(entry) && entry.status === 'open');
        if (state.phase === 'REVISION_REQUIRED' && !stillBlocking) {
          state = transition(state, 'AUDIT_REQUIRED', `findings yopildi: ${fid}`);
        }
        await saveWorkflow(state);
        return jsonBlock('Topilma yopildi', {
          workflow_id: id,
          finding_id: fid,
          status: finding.status,
          phase: state.phase,
          open_blocking: state.findings.filter((entry) => findingBlocks(entry) && entry.status === 'open').length,
          next_action: stillBlocking
            ? 'resolve_finding'
            : state.phase === 'AUDIT_REQUIRED'
              ? 'submit_review'
              : 'status',
        });
      }

      case 'report_finding': {
        // §11: a discovery made while working has somewhere to go, and a material one reopens the plan.
        const allowed: WorkflowPhase[] = ['EXECUTING', 'VERIFYING', 'REPAIR', 'FINAL_AUDIT', 'PLAN_READY'];
        if (!allowed.includes(state.phase))
          return refuse(
            state,
            'illegalTransitionRefused',
            `report_finding ${state.phase} fazasida qabul qilinmaydi (ijro yoki tekshiruv bosqichida kerak).`,
          );
        const stage = state.phase === 'PLAN_READY' ? 'full' : strOrEmpty(p, 'stage').toLowerCase() || 'full';
        const parsed = readFindings(stage === 'blind');
        if (typeof parsed === 'string') return refuse(state, 'duplicatePlanRefused', parsed);
        const material = parsed.some((finding) => findingBlocks(finding) && finding.status === 'open');
        if (material && (state.phase === 'EXECUTING' || state.phase === 'VERIFYING' || state.phase === 'REPAIR')) {
          state = transition(state, 'REPLANNING', `material finding: ${parsed.map((f) => f.id).join(', ')}`);
          state = transition(state, 'PLANNING', 'new plan expected');
        } else if (material && state.phase === 'FINAL_AUDIT') {
          state = transition(state, 'REPLANNING', 'final audit found a gap');
          state = transition(state, 'PLANNING', 'new plan expected');
        }
        await saveWorkflow(state);
        return jsonBlock('Topilma qayd etildi', {
          workflow_id: id,
          phase: state.phase,
          recorded: parsed.length,
          material,
          next_action: material ? 'submit_plan' : state.phase === 'EXECUTING' ? 'get_next_task' : 'verify',
        });
      }

      case 'approve_plan': {
        const tasks = state.plan?.tasks ?? [];
        if (tasks.length === 0) return fail('approve_plan uchun avval submit_plan kerak (reja bo‘sh).');
        if (state.phase !== 'PLAN_READY')
          return refuse(
            state,
            'illegalTransitionRefused',
            `approve_plan faqat PLAN_READY fazasida (hozir: ${state.phase}) — avval submit_review.`,
          );
        const note = strOrEmpty(p, 'note').trim();
        if (!note) return fail('approve_plan uchun note kerak: sababsiz tasdiq audit izi emas.');
        const risks = assessPlan(tasks);
        const pending = pendingApprovals(tasks, risks);
        const wanted = strOrEmpty(p, 'task_id');
        if (wanted && !tasks.some((task) => task.id === wanted)) return fail(`task topilmadi: ${wanted}`);
        if (wanted && !pending.includes(wanted))
          return fail(`${wanted} uchun tasdiq shart emas (registry read-only deydi).`);
        const targets = wanted ? [wanted] : pending;
        if (!targets.length) return fail('bu rejda tasdiq shart emas (registry hammasini read-only deydi).');
        const grantedAt = Date.now();
        for (const task of tasks) if (targets.includes(task.id)) task.approval = { grantedAt, note };
        await saveWorkflow(state);
        const still = awaitingApproval(state);
        return jsonBlock('Reja tasdiqlandi', {
          workflow_id: id,
          phase: state.phase,
          approved: targets,
          pending_approvals: still.length,
          next_action: still.length ? 'approve_plan' : 'get_next_task',
        });
      }

      case 'get_next_task': {
        if (state.phase === 'PLAN_READY' && canTransition('PLAN_READY', 'EXECUTING')) {
          const waiting = awaitingApproval(state);
          if (waiting.length) {
            return refuse(
              state,
              'unapprovedExecutionRefused',
              `EXECUTING oldidan tasdiq kerak: ${waiting.join(', ')} yozish qadamlarini o‘z ichiga oladi — ` +
                `approve_plan (note bilan) chaqiring.`,
            );
          }
          state = transition(state, 'EXECUTING', 'execution started');
          await saveWorkflow(state);
        }
        if (state.phase !== 'EXECUTING')
          return fail(
            `get_next_task faqat EXECUTING fazasida (hozir: ${state.phase}) — ` +
              (state.phase === 'AUDIT_REQUIRED'
                ? 'avval begin_audit stage=full va submit_review.'
                : state.phase === 'PLAN_READY'
                  ? 'avval approve_plan (yozish qadami bo‘lsa), so‘ng get_next_task.'
                  : 'keyingi actionni pastdagi xabardan oling.'),
          );
        const tasks = state.plan?.tasks ?? [];
        const picked = nextRunnable(tasks);
        if (picked.serialised) bump(state, 'conflictsSerialised', picked.serialised);
        if (picked.task) picked.task.status = 'in_progress';
        if (picked.task || picked.serialised) await saveWorkflow(state);
        const recent = state.calls?.slice(-6) ?? [];
        const repeated = recent.filter((entry) => !entry.produced).length >= 4;
        return jsonBlock('Keyingi vazifa', {
          workflow_id: id,
          phase: state.phase,
          task: picked.task ? (detail === 'full' ? picked.task : briefTask(picked.task)) : null,
          ...(picked.waitingOn ? { waiting_on: picked.waitingOn, serialised: picked.serialised } : {}),
          remaining: tasks.filter((task) => task.status !== 'verified').length,
          ...(repeated
            ? { warning: 'oxirgi chaqiruvlarning aksari yangi dalil bermagan — usulni o‘zgartiring (§6.5)' }
            : {}),
        });
      }

      case 'report_task_result': {
        const task = (state.plan?.tasks ?? []).find((entry) => entry.id === strOrEmpty(p, 'task_id'));
        if (!task) return fail(`task topilmadi: ${strOrEmpty(p, 'task_id')}`);
        const status = strOrEmpty(p, 'task_status') as TaskStatus;
        if (!REPORTABLE_STATUSES.includes(status))
          return fail(`task_status noto‘g‘ri (kelishadi: ${REPORTABLE_STATUSES.join(', ')}).`);
        const evidence = strOrEmpty(p, 'evidence').trim();
        const closing = CLOSING_STATUSES.includes(status);
        if (closing && !evidence)
          return refuse(
            state,
            'fakeCompletionRefused',
            `${status} uchun evidence shart (soxta PASS rad etiladi, §12.2).`,
          );
        const given = strOrEmpty(p, 'verification_type') as VerificationType | '';
        if (closing && !VERIFICATION_TYPES.includes(given as VerificationType))
          return fail(`verification_type kerak (${VERIFICATION_TYPES.join('|')}) — dalil nimaga asoslangan.`);
        if (closing) {
          const weak = verificationWeakness(task.verification?.type, given as VerificationType);
          if (weak)
            return refuse(
              state,
              'unverifiableEvidenceRefused',
              `Task ${task.id} ${task.verification.type} talab qilgan — ${err([weak])} (§12.2).`,
            );
          if ((task.priority === 'critical' || task.priority === 'high') && !strOrEmpty(p, 'challenge').trim())
            return fail(
              `Task ${task.id} (${task.priority}) yopilishida challenge kerak: o‘z xulosingizni qanday sinadingiz (§6.4)?`,
            );
          if (status === 'verified' && (task.deliverables ?? []).length > 0 && !strOrEmpty(p, 'artifact').trim())
            return refuse(
              state,
              'unverifiableEvidenceRefused',
              `Task ${task.id} deliverable va’da qiladi (${task.deliverables.join(', ')}) — artifact (fayl yo‘li yoki ` +
                `hojja) ko‘rsating, §6.6.`,
            );
        }
        task.status = status;
        task.attempts += 1;
        bump(state, 'attempts');
        // §16.3: repeated failure is recorded, not quietly retried. The third one turns the task into
        // a blocker and sends the host to replan or block, which is the difference between a retry
        // budget and an infinite loop with extra steps.
        const stuck = status === 'failed' && task.attempts >= 3;
        if (stuck && !task.blockers.some((entry) => entry.startsWith(`failed x${task.attempts}`)))
          task.blockers.push(`failed x${task.attempts}: oxirgi xato qaytarildi, keyingi urinish samarasiz`);
        if (closing) task.verifiedWith = given as VerificationType;
        if (evidence) {
          const exitCode = Number.parseInt(strOrEmpty(p, 'exit_code'), 10);
          state.evidence.push({
            id: `ev-${state.evidence.length + 1}`,
            taskId: task.id,
            summary: evidence,
            redacted: true,
            verificationType: given as VerificationType,
            ...(strOrEmpty(p, 'command') ? { command: strOrEmpty(p, 'command') } : {}),
            ...(Number.isFinite(exitCode) ? { exitCode } : {}),
            ...(strOrEmpty(p, 'artifact') ? { artifact: strOrEmpty(p, 'artifact') } : {}),
          });
          task.evidenceRefs.push(`ev-${state.evidence.length}`);
        }
        await saveWorkflow(state);
        const remaining = (state.plan?.tasks ?? []).filter((entry) => entry.status !== 'verified').length;
        return jsonBlock('Task natijasi qabul qilindi', {
          workflow_id: id,
          task_id: task.id,
          status: task.status,
          counts_toward_completion: status === 'verified',
          verified: (state.plan?.tasks ?? []).filter((entry) => entry.status === 'verified').length,
          next_action: stuck ? 'replan' : remaining === 0 ? 'verify' : 'get_next_task',
          ...(stuck
            ? {
                warning:
                  `task ${task.id} ${task.attempts} marta xato berdi — boshqa yo‘l sinash yoki block ` +
                  `bilan aniq blocker qayd etish kerak (§16.3)`,
              }
            : {}),
          ...(detail === 'full'
            ? {
                evidence_id: task.evidenceRefs[task.evidenceRefs.length - 1] ?? null,
                remaining,
                blockers: task.blockers,
              }
            : {}),
        });
      }

      case 'log_call': {
        // §6.5: every call has to have a job. Repeat a fruitless call often enough and the controller
        // says so; it counts rather than blocks, because a duplicate call is not a security issue.
        if (state.phase !== 'EXECUTING' && state.phase !== 'VERIFYING' && state.phase !== 'REPAIR')
          return fail(`log_call ijro/tekshiruv bosqichida ishlatiladi (hozir: ${state.phase}).`);
        const tool = strOrEmpty(p, 'tool_name');
        if (!knownToolNames().has(tool)) return fail(`log_call: registry'da yo'q tool: ${tool}`);
        const purpose = strOrEmpty(p, 'purpose').trim();
        if (!purpose) return fail('log_call uchun purpose kerak (chaqiruvning vazifasi nima edi?).');
        const produced = bool(p, 'produced', false);
        state.calls = state.calls ?? [];
        bump(state, 'callsLogged');
        const fingerprint = hash(`${tool}|${purpose}`);
        const duplicate = state.calls.some((entry) => entry.fingerprint === fingerprint);
        if (duplicate) bump(state, 'duplicateCalls');
        state.calls.push({ fingerprint, at: Date.now(), task: strOrEmpty(p, 'task_id') || undefined, produced });
        await saveWorkflow(state);
        return jsonBlock('Chaqiruv yozildi', {
          workflow_id: id,
          tool,
          duplicate,
          produced,
          next_action: duplicate && !produced ? 'report_finding' : 'get_next_task',
          ...(duplicate && !produced
            ? { warning: 'bu chaqiruv avval ham bo‘lgan va dalil bermagan — usulni o‘zgartiring (§6.5).' }
            : {}),
        });
      }

      case 'record_source': {
        if (state.phase === 'COMPLETED' || state.phase === 'NEW')
          return fail(`record_source ${state.phase} fazasida qabul qilinmaydi.`);
        const reference = strOrEmpty(p, 'reference').trim();
        if (!reference) return fail('record_source uchun reference kerak (URL, fayl yoki tool natijasi).');
        const reliability = strOrEmpty(p, 'reliability') as (typeof SOURCE_RELIABILITY)[number];
        if (!SOURCE_RELIABILITY.includes(reliability))
          return fail(`reliability ${SOURCE_RELIABILITY.join('|')} dan biri bo‘lishi kerak.`);
        const observation = strOrEmpty(p, 'observation').trim();
        if (!observation) return fail('record_source uchun observation kerak: manbadan nima ma’lum bo‘ldi?');
        const known = requirementIdSet(state.goal);
        const relatesTo = strOrEmpty(p, 'relates_to')
          .split(',')
          .map((entry) => entry.trim().toUpperCase())
          .filter(Boolean);
        for (const ref of relatesTo) if (!known.has(ref)) return fail(`relates_to: noma'lum talab id: ${ref}`);
        state.sources = state.sources ?? [];
        const source: Source = {
          id: `src-${state.sources.length + 1}`,
          reference,
          reliability,
          finding: observation,
          relatesTo,
          at: Date.now(),
        };
        state.sources.push(source);
        await saveWorkflow(state);
        return jsonBlock('Manba yozildi', {
          workflow_id: id,
          source_id: source.id,
          reliability,
          relates_to: relatesTo,
          next_action: 'resolve_unknown',
        });
      }

      case 'resolve_unknown': {
        const uid = strOrEmpty(p, 'unknown_id').toUpperCase();
        const known = requirements(state.goal).filter((requirement) => requirement.kind === 'unknown');
        if (!known.some((requirement) => requirement.id === uid))
          return fail(
            `unknown topilmadi: ${uid || '(bo‘sh)'} (mavjud: ${known.map((entry) => entry.id).join(', ') || 'yo‘q'}).`,
          );
        const verdict = strOrEmpty(p, 'verdict');
        if (!['resolved', 'accepted_risk', 'out_of_scope'].includes(verdict))
          return fail('verdict resolved|accepted_risk|out_of_scope bo‘lishi kerak.');
        const note = strOrEmpty(p, 'note').trim();
        if (!note) return fail(`${verdict} uchun note kerak: nima bilan yopildi yoki nega qabul qilindi.`);
        const cited = strOrEmpty(p, 'source_ids')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        if (verdict === 'resolved') {
          if (!cited.length)
            return refuse(
              state,
              'unsourcedResolutionRefused',
              `${uid} “resolved” deyish uchun manba kerak: record_source orqali tekshirilgan manbani yozing va ` +
                `source_ids bilan ko‘rsating (§10.1). Boshqa holatda verdict=accepted_risk yoki out_of_scope ishlating.`,
            );
          for (const ref of cited) {
            const source = (state.sources ?? []).find((entry) => entry.id === ref);
            if (!source) return fail(`source_ids: yozilmagan manba: ${ref}`);
            if (!source.relatesTo.includes(uid))
              return fail(
                `${ref} bu noaniqlikka (${uid}) aloqador deb yozilmagan — record_source relates_to ni to‘ldiring.`,
              );
            if (source.reliability === 'contradicted' || source.reliability === 'not_checked')
              return fail(`${ref} ${source.reliability} — xulosa yasash uchun uning ustida ishlash kerak (§10.3).`);
          }
        }
        state.unknowns = (state.unknowns ?? []).filter((entry) => entry.id !== uid);
        state.unknowns.push({ id: uid, verdict, note, at: Date.now(), sources: cited });
        await saveWorkflow(state);
        return jsonBlock('Noaniqlik yopildi', {
          workflow_id: id,
          unknown_id: uid,
          verdict,
          open_unknowns: known.length - state.unknowns.length,
          next_action: 'status',
        });
      }

      case 'verify': {
        if (state.phase !== 'EXECUTING' && state.phase !== 'REPAIR')
          return refuse(
            state,
            'illegalTransitionRefused',
            `verify EXECUTING yoki REPAIR fazasida kerak (hozir: ${state.phase}).`,
          );
        state = transition(state, 'VERIFYING', 'verification pass');
        await saveWorkflow(state);
        const elig = completionEligible(state);
        return jsonBlock('Tekshiruv', {
          workflow_id: id,
          phase: state.phase,
          eligible_to_finish: elig.ok,
          blockers: elig.blockers,
          pending_approvals: awaitingApproval(state).length,
          next_action: state.mode === 'full' ? 'final_audit' : elig.ok ? 'finish' : 'repair',
          ...(detail === 'full'
            ? { tasks: (state.plan?.tasks ?? []).map(briefTask), risks: state.plan?.risks ?? [] }
            : {}),
        });
      }

      case 'repair': {
        // Reachable from both places a run finds out it is not actually done: VERIFYING (a check
        // failed) and FINAL_AUDIT (the independent audit found the gap). Without the second one, a
        // host told by `finish` that a task is unverified has no legal door back to work on it.
        if (state.phase !== 'VERIFYING' && state.phase !== 'FINAL_AUDIT')
          return refuse(
            state,
            'illegalTransitionRefused',
            `repair VERIFYING yoki FINAL_AUDIT fazasida kerak (hozir: ${state.phase}).`,
          );
        if (!strOrEmpty(p, 'reason').trim()) return fail('repair uchun reason kerak: qaysi qabul mezoni bajarilmadi?');
        state = transition(state, 'REPAIR', `repair: ${strOrEmpty(p, 'reason').trim()}`);
        state = transition(state, 'EXECUTING', 'repair continues execution');
        await saveWorkflow(state);
        return jsonBlock('Tuzatish bosqichi', {
          workflow_id: id,
          phase: state.phase,
          next_action: 'get_next_task',
          note: 'verified bo‘lmagan tasklar qaytadi; reja o‘zgarmasa replan kerak emas.',
        });
      }

      case 'final_audit': {
        // §12.3: the completion audit is a step, so `finish` cannot be reached without it in full mode.
        if (state.phase !== 'VERIFYING')
          return refuse(
            state,
            'illegalTransitionRefused',
            `final_audit faqat VERIFYING fazasida (hozir: ${state.phase}) — avval verify.`,
          );
        const note = strOrEmpty(p, 'note').trim();
        if (!note) return fail('final_audit uchun note kerak: nimani mustaqil tekshirdingiz?');
        state = transition(state, 'FINAL_AUDIT', `final audit: ${note}`);
        const parsed = strOrEmpty(p, 'findings') ? readFindings(false) : [];
        if (typeof parsed === 'string') {
          await saveWorkflow(state);
          return refuse(state, 'duplicatePlanRefused', parsed);
        }
        const gaps = parsed.filter((finding) => findingBlocks(finding) && finding.status === 'open');
        if (gaps.length) {
          state = transition(state, 'REPLANNING', `final audit gaps: ${gaps.map((finding) => finding.id).join(', ')}`);
          state = transition(state, 'PLANNING', 'new plan expected');
        }
        await saveWorkflow(state);
        return jsonBlock('Yakuniy audit', {
          workflow_id: id,
          phase: state.phase,
          gaps: gaps.length,
          blockers: completionEligible(state).blockers,
          next_action: gaps.length ? 'submit_plan' : 'finish',
          ...(detail === 'full'
            ? { findings: parsed.map((finding) => ({ id: finding.id, severity: finding.severity })) }
            : {}),
        });
      }

      case 'replan': {
        const allowed: WorkflowPhase[] = ['EXECUTING', 'VERIFYING', 'REPAIR', 'FINAL_AUDIT'];
        if (!allowed.includes(state.phase))
          return refuse(
            state,
            'illegalTransitionRefused',
            `replan ${allowed.join('|')} fazalarida kerak (hozir: ${state.phase}).`,
          );
        if (!strOrEmpty(p, 'reason').trim()) return fail('replan uchun reason kerak (nima yangi fakt chiqdi?).');
        state = transition(state, 'REPLANNING', `replan: ${strOrEmpty(p, 'reason').trim()}`);
        state = transition(state, 'PLANNING', 'new plan expected');
        await saveWorkflow(state);
        return jsonBlock('Qayta rejalash', {
          workflow_id: id,
          phase: state.phase,
          next_action: 'submit_plan',
          note: 'verified tasklar saqlanadi; yangi plan qayta audit‘dan o‘tadi va yangi dalil keltirishi kerak.',
        });
      }

      case 'block': {
        if (state.phase === 'BLOCKED' || state.phase === 'COMPLETED' || state.phase === 'NEW')
          return fail(`block ${state.phase} fazasida ma'no bermaydi.`);
        if (!strOrEmpty(p, 'reason').trim()) return fail('block uchun reason kerak.');
        state = transition(state, 'BLOCKED', `block: ${strOrEmpty(p, 'reason').trim()}`);
        await saveWorkflow(state);
        return jsonBlock('Ish to‘xtatildi', {
          workflow_id: id,
          phase: state.phase,
          next_action: 'unblock',
          open_findings: state.findings.filter((entry) => entry.status === 'open').length,
        });
      }

      case 'unblock': {
        if (state.phase !== 'BLOCKED') return fail(`unblock faqat BLOCKED fazasida (hozir: ${state.phase}).`);
        const target = strOrEmpty(p, 'target').toUpperCase() as WorkflowPhase;
        if (target !== 'PLANNING' && target !== 'EXECUTING')
          return fail('unblock uchun target PLANNING yoki EXECUTING bo‘lishi kerak.');
        if (target === 'EXECUTING') {
          const waiting = awaitingApproval(state);
          if (waiting.length)
            return refuse(
              state,
              'unapprovedExecutionRefused',
              `unblock → EXECUTING oldidan tasdiq kerak: ${waiting.join(', ')} — avval approve_plan (note bilan).`,
            );
        }
        state = transition(state, target, `unblock → ${target}`);
        await saveWorkflow(state);
        return jsonBlock('Davom etilmoqda', {
          workflow_id: id,
          phase: state.phase,
          next_action: target === 'PLANNING' ? 'submit_plan' : 'get_next_task',
        });
      }

      case 'pause': {
        if (!canTransition(state.phase, 'PAUSED'))
          return fail(`pause ${state.phase} fazasidan mumkin emas (COMPLETED/BLOCKED/PAUSED da ma'nosi yo‘q).`);
        if (!strOrEmpty(p, 'reason').trim()) return fail('pause uchun reason kerak (foydalanuvchi yoki muhit uzdi).');
        const interrupted = state.phase;
        state = transition(state, 'PAUSED', `pause: ${strOrEmpty(p, 'reason').trim()}`);
        state.pausedFrom = interrupted;
        await saveWorkflow(state);
        return jsonBlock('Vaqtinchalik to‘xtatildi', {
          workflow_id: id,
          phase: state.phase,
          paused_from: interrupted,
          next_action: 'resume',
        });
      }

      case 'resume': {
        if (state.phase !== 'PAUSED') return fail(`resume faqat PAUSED fazasida (hozir: ${state.phase}).`);
        const target: WorkflowPhase =
          state.pausedFrom && canTransition('PAUSED', state.pausedFrom) ? state.pausedFrom : 'PLANNING';
        if (target === 'EXECUTING') {
          const waiting = awaitingApproval(state);
          if (waiting.length)
            return refuse(
              state,
              'unapprovedExecutionRefused',
              `resume → EXECUTING oldidan tasdiq kerak: ${waiting.join(', ')}.`,
            );
        }
        state = transition(state, target, `resume → ${target}`);
        state.pausedFrom = undefined;
        await saveWorkflow(state);
        return jsonBlock('Davom etmoqda', {
          workflow_id: id,
          phase: state.phase,
          next_action:
            target === 'PLANNING'
              ? 'submit_plan'
              : target === 'AUDIT_REQUIRED'
                ? 'begin_audit'
                : target === 'EXECUTING'
                  ? 'get_next_task'
                  : target === 'VERIFYING'
                    ? 'final_audit'
                    : 'status',
        });
      }

      case 'finish': {
        const elig = completionEligible(state);
        if (!elig.ok)
          return refuse(
            state,
            'fakeCompletionRefused',
            `COMPLETED bo‘la olmaydi (fake-completion bloklandi) — blockers: ${elig.blockers.join(' | ')}`,
          );
        state = transition(state, 'COMPLETED', 'all verified');
        await saveWorkflow(state);
        const measures = metrics(state);
        return jsonBlock('Workflow yakunlandi', {
          workflow_id: id,
          phase: state.phase,
          completed: true,
          evidence: state.evidence.length,
          independence: state.audit?.independence ?? 'not-audited',
          metrics: measures,
          ...(detail === 'full'
            ? {
                evidence_records: state.evidence,
                plan_view: planView(state),
                tasks: (state.plan?.tasks ?? []).map(briefTask),
              }
            : {}),
        });
      }

      case 'status': {
        const tasks = state.plan?.tasks ?? [];
        return jsonBlock('Workflow holati', {
          workflow_id: id,
          phase: state.phase,
          mode: state.mode,
          revision: state.revision,
          verified: tasks.filter((task) => task.status === 'verified').length,
          total_tasks: tasks.length,
          open_findings: state.findings.filter((finding) => finding.status === 'open').length,
          pending_approvals: awaitingApproval(state).length,
          ...(detail === 'full'
            ? {
                metrics: metrics(state),
                plan_view: planView(state),
                risks: state.plan?.risks ?? [],
                awaiting_approval: awaitingApproval(state),
                tasks: tasks.map(briefTask),
                findings: state.findings.map((finding) => ({
                  id: finding.id,
                  severity: finding.severity,
                  classification: finding.classification,
                  blocking: findingBlocks(finding),
                  status: finding.status,
                  blind: Boolean(finding.blind),
                })),
                unknowns: state.unknowns ?? [],
                coverage: state.audit?.coverage ?? null,
              }
            : {}),
        });
      }

      default:
        return fail(`noma'lum action: ${action}`);
    }
  },
});

function err(issues: { code: string; message: string }[]): string {
  return issues.map((issue) => `${issue.code}: ${issue.message}`).join('; ');
}
