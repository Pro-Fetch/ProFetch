/**
 * Live tests for the `pro_fetch_workflow` controller — the tool as the host AI actually calls it,
 * through `dispatch`, against the real registry and a real on-disk store.
 *
 * The foundation tests cover the pure state machine and store. What is only visible at this level is
 * the wiring, and the spec's promises are all wiring promises:
 *
 * - a plan that ignores a requirement is refused (§5.2), and an invented requirement id is refused too;
 * - a mutating step labelled `read_only` is refused, because the label is a claim and the registry is
 *   the evidence (§14.2);
 * - execution stops for an explicit, justified approval (§14.5);
 * - `verified` needs evidence at least as strong as the task demanded, plus a self-challenge note on
 *   high-stakes work (§12.2, §6.4);
 * - completion needs the independent final audit, every unknown closed and every blocker resolved, and
 *   each refusal is counted rather than forgotten (§12.3, §20.5).
 *
 * Where a rule is enforced *before* this tool (operator read-only policy), the test asserts the
 * measured behaviour, not the intention.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../src/loader.js';
import { allTools, dispatch } from '../src/core/tool.js';
import { isMutationTool } from '../src/core/tool-classification.js';
import type { Finding, GoalSpec, Task, WorkflowState } from '../src/core/workflow/types.js';
import { disclosePlan } from './helpers/bigfootAudit.js';

const ORIGINAL = { ...process.env };
let dir = '';

beforeEach(async () => {
  process.env.PRO_FETCH_PROFILE = 'full';
  dir = await mkdtemp(path.join(tmpdir(), `pf-wfc-${Date.now()}-`));
  process.env.PRO_FETCH_WORKFLOW_DIR = dir;
});

afterEach(async () => {
  process.env = { ...ORIGINAL };
  if (dir) await rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helpers */

const body = (result: { content?: Array<{ type: string; text?: string }> }): string =>
  (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');

function payload(result: { content?: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const raw = body(result)
    .replace(/^```json\s*/gm, '')
    .replace(/```\s*$/gm, '');
  return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as Record<string, unknown>;
}

const refused = (result: { isError?: boolean }): boolean => result.isError === true;

const call = (args: Record<string, unknown>) => dispatch('pro_fetch_workflow', args);

/** Names the registry must still contain for these fixtures to mean anything. */
const REAL_TOOL = 'pro_fetch_fetch_url';
const OTHER_REAL_TOOL = 'pro_fetch_web_search';
const MUTATING_TOOL = 'pro_fetch_cache_put';
const categoryOf = (name: string) => allTools().find((tool) => tool.name === name)?.category ?? 'http';

/**
 * A goal with two requirement families, so coverage has something to check:
 * E1, C1, D1, A1, A2 are requirements; U1 is an unknown (tracked separately, not by coverage).
 */
const GOAL: GoalSpec = {
  goal: 'publish a measured dashboard',
  explicitRequirements: ['render the collected numbers'],
  implicitRequirements: [],
  constraints: ['no new runtime dependency'],
  deliverables: ['dashboard.html'],
  qualityTarget: 'high',
  acceptanceCriteria: ['opens in a browser', 'numbers match the source'],
  unknowns: [],
};

/** The same goal with one open question, for the §6.6 unknown gate. */
const GOAL_WITH_UNKNOWN: GoalSpec = { ...GOAL, unknowns: ['is the upstream API paginated?'] };

function plannedTask(
  id: string,
  over: Partial<Task> & { toolName?: string; sensitivity?: Task['toolPlan'][number]['sensitivity'] } = {},
): Task {
  const { toolName = REAL_TOOL, sensitivity = 'read_only', ...rest } = over;
  return {
    id,
    objective: `measure ${id}`,
    priority: 'medium',
    dependsOn: [],
    deliverables: [],
    toolPlan: [
      {
        toolName,
        category: categoryOf(toolName),
        purpose: `do ${id}`,
        expectedEvidence: 'a tool result with content',
        sensitivity,
        requiresApproval: sensitivity !== 'read_only',
      },
    ],
    acceptanceCriteria: [`${id} produced a measurable result`],
    verification: { method: 're-run and compare', evidenceRequired: true },
    covers: [],
    status: 'pending',
    attempts: 0,
    evidenceRefs: [],
    blockers: [],
    ...rest,
  };
}

/** Two tasks that between them carry every requirement id of GOAL. */
const COVERED_PLAN = (): Task[] => [
  plannedTask('T001', { covers: ['E1', 'C1', 'D1'] }),
  plannedTask('T002', { toolName: OTHER_REAL_TOOL, covers: ['A1', 'A2'] }),
];

function finding(id: string, over: Partial<Finding> = {}): Finding {
  return {
    id,
    severity: 'medium',
    relatedRequirementIds: ['E1'],
    description: `finding ${id}`,
    evidence: 'measured against the running registry',
    whyItMatters: 'an unmeasured plan cannot be verified',
    requiredAction: 'add an acceptance criterion',
    acceptanceCriteria: ['criterion present'],
    confidence: 0.9,
    classification: 'should_fix',
    blocking: false,
    status: 'open',
    ...over,
  } as Finding;
}

async function phaseOf(id: string): Promise<string> {
  return String(payload(await call({ action: 'status', workflow_id: id })).phase);
}

async function started(goal: GoalSpec = GOAL): Promise<string> {
  const res = await call({ action: 'start', goal: JSON.stringify(goal), mode: 'full' });
  expect(refused(res), body(res)).toBe(false);
  return String(payload(res).workflow_id);
}

async function plannedWith(tasks: Task[], goal: GoalSpec = GOAL): Promise<string> {
  const id = await started(goal);
  const res = await call({ action: 'submit_plan', workflow_id: id, plan: JSON.stringify({ tasks }) });
  expect(refused(res), body(res)).toBe(false);
  return id;
}

/**
 * Open the plan to the auditor and file the review, disposing of every §5.3 risk item the audit
 * derived from this plan. Only valid from AUDIT_REQUIRED.
 */
async function audited(id: string, findings: Finding[] = [finding('F001')]): Promise<Record<string, unknown>> {
  expect(await phaseOf(id)).toBe('AUDIT_REQUIRED');
  const { review, checklist } = await disclosePlan(call, id, findings as unknown as Array<Record<string, unknown>>);
  // A plan with no derived risk would make the disposal above vacuous; the derivation is part of what
  // these tests depend on, so it is asserted rather than assumed.
  expect(checklist.length, 'risk checklist derived from the plan').toBeGreaterThan(0);
  expect(review.phase, JSON.stringify(review)).not.toBe('AUDIT_REQUIRED');
  return review;
}

/**
 * Advance the run to EXECUTING from whatever phase it is in, so a test states the rule it checks
 * instead of re-running the whole lifecycle. Approves whatever the registry says writes.
 */
async function executing(
  id: string,
  findings: Finding[] = [finding('F001')],
  tasks: Task[] = COVERED_PLAN(),
): Promise<Record<string, unknown>> {
  if ((await phaseOf(id)) === 'PLANNING') {
    const res = await call({ action: 'submit_plan', workflow_id: id, plan: JSON.stringify({ tasks }) });
    expect(refused(res), body(res)).toBe(false);
  }
  if ((await phaseOf(id)) === 'AUDIT_REQUIRED') await audited(id, findings);
  expect(await phaseOf(id), 'test premise: the run should reach PLAN_READY').toBe('PLAN_READY');
  const status = payload(await call({ action: 'status', workflow_id: id, detail: 'full' }));
  if ((status.pending_approvals as number) > 0) {
    const approved = await call({ action: 'approve_plan', workflow_id: id, note: 'operator confirmed the write' });
    expect(refused(approved), body(approved)).toBe(false);
  }
  const next = await call({ action: 'get_next_task', workflow_id: id });
  expect(refused(next), body(next)).toBe(false);
  return payload(next);
}

async function closeTask(id: string, taskId: string, over: Record<string, unknown> = {}) {
  const res = await call({
    action: 'report_task_result',
    workflow_id: id,
    task_id: taskId,
    task_status: 'verified',
    verification_type: 'integration',
    evidence: 'ran the planned tool and diffed the output against the source',
    artifact: 'report.md',
    ...over,
  });
  expect(refused(res), body(res)).toBe(false);
  return payload(res);
}

async function fullMetrics(id: string): Promise<Record<string, Record<string, number>>> {
  const status = payload(await call({ action: 'status', workflow_id: id, detail: 'full' }));
  return status.metrics as Record<string, Record<string, number>>;
}

/* ------------------------------------------------------------------ onboarding */

describe('pro_fetch_workflow — onboarding', () => {
  it('introduces itself and only lists phases under full', async () => {
    const summary = payload(await call({ action: 'introduce' }));
    expect(summary.next_action).toBe('start');
    expect(summary.phases).toBeUndefined();
    const full = payload(await call({ action: 'introduce', detail: 'full' }));
    expect((full.phases as string[]).length).toBeGreaterThanOrEqual(11);
  });

  it('refuses start with no goal and a goal nobody can test', async () => {
    expect(refused(await call({ action: 'start' }))).toBe(true);
    const noCriteria = await call({
      action: 'start',
      goal: JSON.stringify({ ...GOAL, acceptanceCriteria: [] }),
    });
    expect(refused(noCriteria)).toBe(true);
    expect(body(noCriteria)).toContain('acceptance');
  });

  it('reports the derived requirement ids a plan has to carry', async () => {
    const res = payload(await call({ action: 'start', goal: JSON.stringify(GOAL), detail: 'full' }));
    expect(res.requirements).toBe(5);
    const list = res.requirement_list as Array<{ id: string; kind: string }>;
    expect(list.map((entry) => entry.id)).toEqual(['E1', 'C1', 'D1', 'A1', 'A2']);
  });

  it('accepts the field names a model actually writes', async () => {
    // Measured: hosts lost their first `start` to `acceptance_missing` while the payload carried
    // `acceptance_criteria`, because the schema names were never said out loud in the failure.
    const snake = await call({
      action: 'start',
      goal: JSON.stringify({
        objective: 'make it reproducible',
        acceptance_criteria: ['runs twice'],
        unknowns: ['rate limit?'],
      }),
    });
    expect(refused(snake), body(snake)).toBe(false);
    const ids = payload(snake).requirement_ids as string[];
    expect(ids).toEqual(['A1']);
    expect(payload(snake).unknown_ids).toEqual(['U1']);

    const wrong = await call({ action: 'start', goal: JSON.stringify({ objective: 'x', must_haves: ['a'] }) });
    expect(refused(wrong)).toBe(true);
    // The refusal names the key it could not place, instead of only complaining what was missing.
    expect(body(wrong)).toContain('must_haves');
  });

  it('normalises arrays the host left out, but not an untestable goal', async () => {
    const sparse = await call({ action: 'start', goal: JSON.stringify({ goal: 'x', acceptanceCriteria: ['runs'] }) });
    expect(refused(sparse), body(sparse)).toBe(false);
    expect(payload(sparse).requirements).toBe(1);
    const noCriteria = await call({ action: 'start', goal: JSON.stringify({ goal: 'just a line' }) });
    expect(refused(noCriteria)).toBe(true);
  });
});

/* ------------------------------------------------------------------ §5.2 coverage */

describe('pro_fetch_workflow — requirement coverage (§5.2)', () => {
  it('refuses a plan that leaves a requirement unmapped and names it', async () => {
    const id = await started();
    const res = await call({
      action: 'submit_plan',
      workflow_id: id,
      // A2 is carried by nobody.
      plan: JSON.stringify({ tasks: [plannedTask('T001', { covers: ['E1', 'C1', 'D1', 'A1'] })] }),
    });
    expect(refused(res)).toBe(true);
    expect(body(res)).toContain('A2');
    const metrics = await fullMetrics(id);
    expect(metrics.refused.unmapped_requirement).toBe(1);
  });

  it('accepts the plan once every requirement is carried, and records coverage', async () => {
    const id = await plannedWith(COVERED_PLAN());
    const review = await audited(id);
    expect(review.phase).toBe('PLAN_READY');
    expect(review.coverage).toEqual({ total: 5, mapped: 5, unmapped: [] });
  });

  it('refuses a task that invents a requirement id', async () => {
    const id = await started();
    const res = await call({
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({ tasks: [plannedTask('T001', { covers: ['E99'] })] }),
    });
    expect(refused(res)).toBe(true);
    expect(body(res)).toContain('task_covers_unknown');
  });

  it('refuses a finding that points at a requirement the goal never declared', async () => {
    const id = await plannedWith(COVERED_PLAN());
    const res = await call({
      action: 'submit_review',
      workflow_id: id,
      findings: JSON.stringify([finding('F001', { relatedRequirementIds: ['Z7'] })]),
    });
    expect(refused(res)).toBe(true);
    expect(body(res)).toContain('finding_requirement_unknown');
  });

  it('re-checks coverage at completion for a run that bypassed the plan gate', async () => {
    const id = await plannedWith(COVERED_PLAN());
    await audited(id);
    await executing(id, []);
    for (const task of ['T001', 'T002']) await closeTask(id, task);
    await call({ action: 'verify', workflow_id: id });
    await call({ action: 'final_audit', workflow_id: id, note: 'checked each criterion against the ledger' });

    // Drop T002's mapping on disk: exactly what a hand-edited or pre-rule stored run could look like.
    const file = path.join(dir, 'workflows', `${id}.json`);
    const stored = JSON.parse(await readFile(file, 'utf8')) as WorkflowState;
    stored.plan!.tasks[1].covers = [];
    await writeFile(file, JSON.stringify(stored), 'utf8');

    const refusedFinish = await call({ action: 'finish', workflow_id: id });
    expect(refused(refusedFinish)).toBe(true);
    expect(body(refusedFinish)).toContain('A1');
    expect(body(refusedFinish)).toContain('qoplanmagan');
  });
});

/* ------------------------------------------------------------------ §5.4 duplication */

describe('pro_fetch_workflow — duplicate work (§5.4)', () => {
  it('refuses two tasks with the same objective', async () => {
    const id = await started();
    const res = await call({
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({
        tasks: [
          plannedTask('T001', { covers: ['E1', 'C1', 'D1', 'A1', 'A2'] }),
          plannedTask('T002', { objective: 'measure T001' }),
        ],
      }),
    });
    expect(refused(res)).toBe(true);
    expect(body(res)).toContain('task_duplicate_objective');
  });

  it('refuses two tasks with the same tool plan and the same requirements', async () => {
    const id = await started();
    const res = await call({
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({
        tasks: [
          plannedTask('T001', { objective: 'first', covers: ['E1', 'C1', 'D1'] }),
          plannedTask('T002', { objective: 'second', covers: ['E1', 'C1', 'D1'] }),
        ],
      }),
    });
    expect(refused(res)).toBe(true);
    expect(body(res)).toContain('task_duplicate_toolplan');
  });

  it('allows the same tool planned for different requirements', async () => {
    // The rule above must not become "one task per tool": measuring two different requirements with
    // the same endpoint is ordinary work. Measured the other way first — the blunt version of this
    // check refused a two-task plan that shared only a tool name.
    const id = await started();
    const res = await call({
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({
        tasks: [
          plannedTask('T001', { objective: 'first', covers: ['E1', 'C1', 'D1'] }),
          plannedTask('T002', { objective: 'second', covers: ['A1', 'A2'] }),
        ],
      }),
    });
    expect(refused(res), body(res)).toBe(false);
  });
});

/* ---------------------------------- regressions found by real hosts driving the tool */

describe('pro_fetch_workflow — regressions found from the host side', () => {
  it("accepts a plan that omits the machinery's own bookkeeping fields", async () => {
    // A host writes a plan, not a TypeScript literal. `dependsOn`, `deliverables`, `evidenceRefs`,
    // `blockers`, `attempts` and `status` are the controller's bookkeeping; when they were absent the
    // plan was accepted and the first honest report then threw
    // "Cannot read properties of undefined (reading 'push')".
    const id = await started();
    const bare = [
      {
        id: 'T001',
        objective: 'measure the source',
        priority: 'medium',
        acceptanceCriteria: ['a number was read'],
        verification: { method: 're-run', evidenceRequired: true },
        covers: ['E1', 'C1', 'D1', 'A1', 'A2'],
        toolPlan: [
          {
            toolName: REAL_TOOL,
            category: categoryOf(REAL_TOOL),
            purpose: 'read',
            sensitivity: 'read_only',
            requiresApproval: false,
          },
        ],
      },
    ];
    const planned = await call({ action: 'submit_plan', workflow_id: id, plan: JSON.stringify({ tasks: bare }) });
    expect(refused(planned), body(planned)).toBe(false);
    await executing(id);
    const closed = await closeTask(id, 'T001');
    expect(closed.status).toBe('verified');
    const stored = JSON.parse(await readFile(path.join(dir, 'workflows', `${id}.json`), 'utf8')) as WorkflowState;
    expect(stored.plan?.tasks[0].evidenceRefs.length).toBe(1);
    expect(stored.plan?.tasks[0].blockers).toEqual([]);
  });

  it('refuses a malformed plan instead of throwing at the host', async () => {
    // A real host sends JSON shapes it invented. Each of these used to surface as a TypeError from
    // inside the validator ("... is not iterable"), which tells the host nothing about what to send.
    const id = await started();
    const cases: Array<[string, unknown]> = [
      ['tasks is not an array', { tasks: { id: 'T001' } }],
      ['a task is a string', ['T001']],
      [
        'a task has no toolPlan',
        [
          {
            id: 'T001',
            objective: 'x',
            acceptanceCriteria: ['a'],
            verification: { method: 'm', evidenceRequired: true },
          },
        ],
      ],
    ];
    for (const [label, plan] of cases) {
      const res = await call({ action: 'submit_plan', workflow_id: id, plan: JSON.stringify(plan) });
      expect(refused(res), `${label}: ${body(res)}`).toBe(true);
      expect(body(res), label).not.toContain('not iterable');
      expect(body(res), label).not.toContain('is not a function');
    }
  });

  it('does not make a status-less finding unclosable, and names the ids a refusal means', async () => {
    // Both reported by hosts: a finding submitted without `status` could never be resolved
    // ("finding F1 allaqachon undefined"), and an invented `covers` id gave no hint what was legal.
    const id = await started();
    const bad = await call({
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({ tasks: [plannedTask('T001', { covers: ['E9'] })] }),
    });
    expect(refused(bad)).toBe(true);
    expect(body(bad)).toContain('E1');

    const plannedId = await plannedWith(COVERED_PLAN());
    const noStatus = { ...(finding('F001') as object), status: undefined } as unknown as Finding;
    const review = await disclosePlan(call, plannedId, [noStatus as unknown as Record<string, unknown>]);
    expect(review.review.phase).toBe('PLAN_READY');
    const closed = payload(
      await call({ action: 'resolve_finding', workflow_id: plannedId, finding_id: 'F001', resolution: 'checked' }),
    );
    expect(closed.status).toBe('resolved');
  });

  it('says so when direct mode skips the independent audit', async () => {
    const startedDirect = payload(await call({ action: 'start', goal: JSON.stringify(GOAL), mode: 'direct' }));
    const id = String(startedDirect.workflow_id);
    const planned = payload(
      await call({ action: 'submit_plan', workflow_id: id, plan: JSON.stringify({ tasks: COVERED_PLAN() }) }),
    );
    // Skipped out loud: the answer says so, and the run carries the lower independence level.
    expect(planned.audit_skipped).toBe(true);
    expect(planned.phase).toBe('PLAN_READY');
    const full = payload(await call({ action: 'status', workflow_id: id, detail: 'full' }));
    expect((full.metrics as { independence: string }).independence).toBe('reduced');
  });

  it('lets a run that fails its own final audit go back to work', async () => {
    // `finish` said the task was unverified; the only door back was `replan`, which then demanded a
    // new fact the host did not have. FINAL_AUDIT must be able to reach REPAIR too.
    const id = await plannedWith([plannedTask('T001', { covers: ['E1', 'C1', 'D1', 'A1', 'A2'] })]);
    await executing(id);
    await call({ action: 'report_task_result', workflow_id: id, task_id: 'T001', task_status: 'needs_verification' });
    await call({ action: 'verify', workflow_id: id });
    const audit = payload(await call({ action: 'final_audit', workflow_id: id, note: 'the ledger does not prove A2' }));
    expect(audit.phase).toBe('FINAL_AUDIT');
    expect((audit.blockers as string[]).some((line) => line.includes('needs_verification'))).toBe(true);
    const refusedFinish = await call({ action: 'finish', workflow_id: id });
    expect(refused(refusedFinish)).toBe(true);

    const repaired = payload(await call({ action: 'repair', workflow_id: id, reason: 'A2 was never compared' }));
    expect(repaired.phase).toBe('EXECUTING');
    await closeTask(id, 'T001');
    await call({ action: 'verify', workflow_id: id });
    const audited = payload(
      await call({ action: 'final_audit', workflow_id: id, note: 're-checked A2 against the source' }),
    );
    expect(audited.blockers).toEqual([]);
    expect(payload(await call({ action: 'finish', workflow_id: id })).phase).toBe('COMPLETED');
  });
});

/* ------------------------------------------------------------------ §5.3 risk audit */

describe('pro_fetch_workflow — omission/risk audit (§5.3)', () => {
  it('derives the item list from what the plan actually does', async () => {
    const id = await plannedWith(COVERED_PLAN());
    const opened = payload(await call({ action: 'begin_audit', workflow_id: id, stage: 'full' }));
    const items = (opened.risk_checklist as Array<{ item: string; because: string }>).map((entry) => entry.item);
    // A remote read plus no fallback plus a constraint: each derived from a real property of the plan.
    expect(items).toContain('source-reliability-and-limits');
    expect(items).toContain('fallback-for-failing-step');
    expect(items).toContain('constraint-compliance');
    // Nothing in this plan touches credentials or writes a local file, so those must not appear.
    expect(items).not.toContain('credentials-and-scopes');
    expect(items).not.toContain('local-state-recovery');
  });

  it('separates a local writer from an external one', async () => {
    // Measured against the registry, not assumed: pro_fetch_config_set writes locally, while
    // pro_fetch_cache_put reaches an archive service. A checklist that could not tell them apart would
    // demand an external-rollback review for work that never leaves the machine.
    const local = await plannedWith([
      plannedTask('T001', {
        toolName: 'pro_fetch_config_set',
        sensitivity: 'mutating',
        deliverables: ['dashboard.html'],
        covers: ['E1', 'C1', 'D1', 'A1', 'A2'],
      }),
    ]);
    const localItems = (
      (payload(await call({ action: 'begin_audit', workflow_id: local, stage: 'full' })).risk_checklist ??
        []) as Array<{
        item: string;
      }>
    ).map((entry) => entry.item);
    expect(localItems).toContain('local-state-recovery');
    expect(localItems).toContain('artifact-verifiability');
    expect(localItems).not.toContain('external-write-rollback');

    const remote = await plannedWith([
      plannedTask('T001', { toolName: MUTATING_TOOL, sensitivity: 'mutating', covers: ['E1', 'C1', 'D1', 'A1', 'A2'] }),
    ]);
    const remoteItems = (
      (payload(await call({ action: 'begin_audit', workflow_id: remote, stage: 'full' })).risk_checklist ??
        []) as Array<{
        item: string;
      }>
    ).map((entry) => entry.item);
    expect(remoteItems).toContain('external-write-rollback');
    expect(remoteItems).not.toContain('local-state-recovery');
  });

  it('refuses a review that leaves an item untouched, and does not keep the findings hostage', async () => {
    const id = await plannedWith(COVERED_PLAN());
    await call({ action: 'begin_audit', workflow_id: id, stage: 'full' });
    const silence = await call({ action: 'submit_review', workflow_id: id, findings: '[]' });
    expect(refused(silence)).toBe(true);
    expect(body(silence)).toContain('§5.3');
    expect((await fullMetrics(id)).refused.unaddressed_risk).toBe(1);

    // The refused submission must not leave findings behind: the corrected retry has to be accepted.
    const fixed = await disclosePlan(call, id, []);
    expect(fixed.review.phase).toBe('PLAN_READY');
    const status = payload(await call({ action: 'status', workflow_id: id, detail: 'full' }));
    expect((status.findings as unknown[]).length).toBe(0);
  });

  it('accepts a dismissal with a reason and refuses one without', async () => {
    const id = await plannedWith(COVERED_PLAN());
    const opened = payload(await call({ action: 'begin_audit', workflow_id: id, stage: 'full' }));
    const items = (opened.risk_checklist as Array<{ item: string }>).map((entry) => entry.item);
    const noReason = items.map((item) => ({ item, reason: '  ' }));
    const lazy = await call({
      action: 'submit_review',
      workflow_id: id,
      findings: '[]',
      dismissed_risks: JSON.stringify(noReason),
    });
    expect(refused(lazy)).toBe(true);
    expect(body(lazy)).toContain('sababsiz rad');

    const reasoned = items.map((item) => ({ item, reason: `reviewed: ${item} does not apply beyond the plan itself` }));
    const ok = payload(
      await call({
        action: 'submit_review',
        workflow_id: id,
        findings: '[]',
        dismissed_risks: JSON.stringify(reasoned),
      }),
    );
    expect(ok.phase).toBe('PLAN_READY');
    expect(ok.risks_reviewed).toBe(items.length);
  });

  it('refuses an item the plan never raised, instead of ignoring the typo', async () => {
    const id = await plannedWith(COVERED_PLAN());
    await call({ action: 'begin_audit', workflow_id: id, stage: 'full' });
    const res = await call({
      action: 'submit_review',
      workflow_id: id,
      findings: '[]',
      dismissed_risks: JSON.stringify([{ item: 'made-up-risk', reason: 'because I said so' }]),
    });
    expect(refused(res)).toBe(true);
    expect(body(res)).toContain('made-up-risk');
  });

  it('lets a finding dispose of the risk it names', async () => {
    const id = await plannedWith(COVERED_PLAN());
    const opened = payload(await call({ action: 'begin_audit', workflow_id: id, stage: 'full' }));
    const items = (opened.risk_checklist as Array<{ item: string }>).map((entry) => entry.item);
    const named = items[0];
    const { review } = await disclosePlan(call, id, [
      finding('F050', { riskItem: named }) as unknown as Record<string, unknown>,
    ]);
    expect(review.phase).toBe('PLAN_READY');
    expect(review.risks_by_finding).toBe(1);
    const full = payload(await call({ action: 'status', workflow_id: id, detail: 'full' }));
    const audit = (full.plan_view as { risk_audit: Array<{ item: string; disposition: string; note: string }> })
      .risk_audit;
    expect(audit.find((entry) => entry.item === named)?.disposition).toBe('finding');
    expect(audit.find((entry) => entry.item === named)?.note).toBe('F050');
  });

  it('keeps a risk dismissed in one round dismissed in the next', async () => {
    const id = await plannedWith(COVERED_PLAN());
    const opened = payload(await call({ action: 'begin_audit', workflow_id: id, stage: 'full' }));
    const items = (opened.risk_checklist as Array<{ item: string }>).map((entry) => entry.item);
    const roundOne = await disclosePlan(call, id, [
      finding('F001', { classification: 'must_fix', blocking: true }) as unknown as Record<string, unknown>,
    ]);
    expect(roundOne.review.phase).toBe('REVISION_REQUIRED');
    expect(roundOne.checklist.map((entry) => entry.item)).toEqual(items);
    // Round two: the same items must not have to be re-dismissed after the plan came back.
    await call({
      action: 'resolve_finding',
      workflow_id: id,
      finding_id: 'F001',
      resolution: 'acceptance criteria added',
    });
    const reopened = payload(await call({ action: 'begin_audit', workflow_id: id, stage: 'full' }));
    const again = payload(await call({ action: 'submit_review', workflow_id: id, findings: '[]' }));
    expect(reopened.next_action).toBe('submit_review');
    expect(again.phase).toBe('PLAN_READY');
  });
});

/* ------------------------------------------------------------------ §5.1 independence */

describe('pro_fetch_workflow — audit independence (§5.1)', () => {
  it('hands out a goal-only packet before the plan is visible', async () => {
    const id = await plannedWith(COVERED_PLAN());
    const blind = payload(await call({ action: 'begin_audit', workflow_id: id, stage: 'blind' }));
    expect(blind.plan_visible).toBe(false);
    expect(Array.isArray(blind.requirements)).toBe(true);
    expect(blind.next_action).toBe('submit_review');
    // The packet never contains the plan itself.
    expect(JSON.stringify(blind)).not.toContain('pro_fetch_fetch_url');
  });

  it('records blind findings, then compares them against the opened plan', async () => {
    const id = await plannedWith(COVERED_PLAN());
    await call({ action: 'begin_audit', workflow_id: id, stage: 'blind' });
    const blindRound = payload(
      await call({
        action: 'submit_review',
        workflow_id: id,
        findings: JSON.stringify([finding('B001', { classification: 'must_fix', blocking: true })]),
      }),
    );
    expect(blindRound.phase).toBe('AUDIT_REQUIRED');
    expect(blindRound.next_action).toBe('begin_audit');

    await call({ action: 'begin_audit', workflow_id: id, stage: 'full' });
    const { review } = await disclosePlan(call, id, []);
    expect(review.independence).toBe('blind');
    // The blind objection still stands: the plan cannot be declared ready under it.
    expect(review.phase).toBe('REVISION_REQUIRED');
    const full = payload(await call({ action: 'status', workflow_id: id, detail: 'full' }));
    const findings = full.findings as Array<{ id: string; blind: boolean }>;
    expect(findings.find((entry) => entry.id === 'B001')?.blind).toBe(true);
  });

  it('refuses an out-of-order round in both directions', async () => {
    const id = await plannedWith(COVERED_PLAN());
    const tooEarly = await call({
      action: 'submit_review',
      workflow_id: id,
      stage: 'blind',
      findings: JSON.stringify([finding('B001')]),
    });
    // No blind session started, so a blind round means nothing yet — it is refused, not accepted.
    expect(refused(tooEarly)).toBe(true);

    await call({ action: 'begin_audit', workflow_id: id, stage: 'blind' });
    const skipAhead = await call({
      action: 'submit_review',
      workflow_id: id,
      stage: 'full',
      findings: JSON.stringify([finding('B002')]),
    });
    expect(refused(skipAhead)).toBe(true);
    expect(body(skipAhead)).toContain('§5.1');

    await call({ action: 'begin_audit', workflow_id: id, stage: 'full' });
    const tooLate = await call({ action: 'begin_audit', workflow_id: id, stage: 'blind' });
    expect(refused(tooLate)).toBe(true);
  });

  it('says so when the review was not independent', async () => {
    const id = await plannedWith(COVERED_PLAN());
    const { review } = await disclosePlan(call, id, [finding('F001') as unknown as Record<string, unknown>]);
    expect(review.independence).toBe('reduced');
    await executing(id, []);
  });
});

/* ------------------------------------------------------------------ §5.7 finding lifecycle */

describe('pro_fetch_workflow — findings (§5.6, §5.7)', () => {
  it('requires a classification, an evidence line and an action per objection', async () => {
    const id = await plannedWith(COVERED_PLAN());
    const noClass = await call({
      action: 'submit_review',
      workflow_id: id,
      findings: JSON.stringify([{ ...finding('F001'), classification: undefined }]),
    });
    expect(refused(noClass)).toBe(true);
    expect(body(noClass)).toContain('finding_classification_missing');
    const badConfidence = await call({
      action: 'submit_review',
      workflow_id: id,
      findings: JSON.stringify([finding('F002', { confidence: 4 })]),
    });
    expect(refused(badConfidence)).toBe(true);
  });

  it('refuses the same finding twice, and reopening it without a new fact', async () => {
    const id = await plannedWith(COVERED_PLAN());
    const first = await disclosePlan(call, id, [finding('F001') as unknown as Record<string, unknown>]);
    expect(first.review.phase).toBe('PLAN_READY');
    const again = await call({
      action: 'report_finding',
      workflow_id: id,
      findings: JSON.stringify([finding('F001')]),
    });
    expect(refused(again)).toBe(true);
    expect(body(again)).toContain('allaqachon ochiq');

    // Close it, then try to reopen with identical evidence (§5.7).
    await call({ action: 'resolve_finding', workflow_id: id, finding_id: 'F001', resolution: 'criterion added' });
    const reopened = await call({
      action: 'report_finding',
      workflow_id: id,
      findings: JSON.stringify([finding('F001')]),
    });
    expect(refused(reopened)).toBe(true);
    expect(body(reopened)).toContain('§5.7');

    // The same objection with genuinely new evidence does reopen.
    const withNewFact = await call({
      action: 'report_finding',
      workflow_id: id,
      findings: JSON.stringify([finding('F001', { evidence: 're-measured on the staging build' })]),
    });
    expect(refused(withNewFact), body(withNewFact)).toBe(false);
    const status = payload(await call({ action: 'status', workflow_id: id, detail: 'full' }));
    expect((status.findings as Array<{ id: string; status: string }>)[0].status).toBe('open');
  });

  it('a closing needs evidence and cannot be undone', async () => {
    const id = await plannedWith(COVERED_PLAN());
    await audited(id);
    expect(refused(await call({ action: 'resolve_finding', workflow_id: id, finding_id: 'F001' }))).toBe(true);
    const closed = payload(
      await call({
        action: 'resolve_finding',
        workflow_id: id,
        finding_id: 'F001',
        resolution: 'acceptance criterion A2 now covers it, checked line by line',
      }),
    );
    expect(closed.status).toBe('resolved');
    expect(
      refused(await call({ action: 'resolve_finding', workflow_id: id, finding_id: 'F001', resolution: 'again' })),
    ).toBe(true);
  });

  it('needs_user_approval blocks completion even when the host forgot to flag it', async () => {
    const id = await plannedWith(COVERED_PLAN());
    await audited(id, [finding('F001', { classification: 'needs_user_approval', blocking: false })]);
    const status = payload(await call({ action: 'status', workflow_id: id, detail: 'full' }));
    const entry = (status.findings as Array<{ id: string; blocking: boolean }>)[0];
    expect(entry.blocking).toBe(true);
    expect(status.phase).toBe('REVISION_REQUIRED');
  });
});

/* ------------------------------------------------------------------ §14 risk + approval */

describe('pro_fetch_workflow — risk and approval gate (spec §14)', () => {
  it('grades steps with the registry, not with the label the host wrote', () => {
    expect(isMutationTool(MUTATING_TOOL), MUTATING_TOOL).toBe(true);
    expect(isMutationTool(REAL_TOOL), REAL_TOOL).toBe(false);
  });

  it('refuses a mutating step labelled read_only', async () => {
    const id = await started();
    const under = await call({
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify([plannedTask('T001', { toolName: MUTATING_TOOL, covers: ['E1', 'C1', 'D1', 'A1', 'A2'] })]),
    });
    expect(refused(under)).toBe(true);
    expect(body(under)).toContain('risk_understated');
    expect((await fullMetrics(id)).refused.understated_risk).toBe(1);
  });

  it('will not enter EXECUTING without an approval, nor accept an approval without a reason', async () => {
    const id = await plannedWith([
      plannedTask('T001', { toolName: MUTATING_TOOL, sensitivity: 'mutating', covers: ['E1', 'C1', 'D1', 'A1', 'A2'] }),
    ]);
    await audited(id);
    const blocked = await call({ action: 'get_next_task', workflow_id: id });
    expect(refused(blocked)).toBe(true);
    expect(body(blocked)).toContain('approve_plan');
    expect((await fullMetrics(id)).refused.unapproved_execution).toBe(1);

    expect(refused(await call({ action: 'approve_plan', workflow_id: id }))).toBe(true);
    const approved = payload(
      await call({ action: 'approve_plan', workflow_id: id, note: 'write scoped to the test cache namespace' }),
    );
    expect(approved.approved).toEqual(['T001']);
    expect(approved.next_action).toBe('get_next_task');
    const next = payload(await call({ action: 'get_next_task', workflow_id: id }));
    expect(next.phase).toBe('EXECUTING');
    expect((next.task as { approved: boolean }).approved).toBe(true);
  });

  it('approves only an audited plan and nothing that needs no approval', async () => {
    const id = await plannedWith(COVERED_PLAN());
    expect(refused(await call({ action: 'approve_plan', workflow_id: id, note: 'too early' }))).toBe(true);
    await audited(id);
    const pointless = await call({ action: 'approve_plan', workflow_id: id, task_id: 'T001', note: 'no writes here' });
    expect(refused(pointless)).toBe(true);
    expect(body(pointless)).toContain('shart emas');
  });

  it('operator read-only policy stops the controller and points only at the operator (§14.1)', async () => {
    const id = await plannedWith([
      plannedTask('T001', { toolName: MUTATING_TOOL, sensitivity: 'mutating', covers: ['E1', 'C1', 'D1', 'A1', 'A2'] }),
    ]);
    await audited(id);
    process.env.PRO_FETCH_READ_ONLY = 'true';
    let approval;
    let readOnly;
    let allowed;
    try {
      approval = await call({ action: 'approve_plan', workflow_id: id, note: 'past the operator setting' });
      readOnly = await call({ action: 'status', workflow_id: id });
      process.env.PRO_FETCH_MUTATION_ALLOWLIST = 'pro_fetch_workflow';
      allowed = await call({ action: 'status', workflow_id: id });
    } finally {
      delete process.env.PRO_FETCH_READ_ONLY;
      delete process.env.PRO_FETCH_MUTATION_ALLOWLIST;
    }
    expect(refused(approval)).toBe(true);
    expect(body(approval)).toContain('PRO_FETCH_READ_ONLY');
    expect(body(approval)).toContain('PRO_FETCH_MUTATION_ALLOWLIST');
    expect(refused(readOnly)).toBe(true);
    expect(refused(allowed)).toBe(false);
  });
});

/* ------------------------------------------------------------------ §12.2 honest evidence */

describe('pro_fetch_workflow — honest evidence (§12.2, §6.4)', () => {
  it('refuses a verified result with no evidence and counts it', async () => {
    const id = await started();
    await executing(id);
    const fake = await call({
      action: 'report_task_result',
      workflow_id: id,
      task_id: 'T001',
      task_status: 'verified',
      evidence: '   ',
    });
    expect(refused(fake)).toBe(true);
    expect(body(fake)).toContain('evidence');
    expect((await fullMetrics(id)).refused.fake_completion).toBe(1);
  });

  it('refuses a closing report that names no verification kind', async () => {
    const id = await started();
    await executing(id);
    const res = await call({
      action: 'report_task_result',
      workflow_id: id,
      task_id: 'T001',
      task_status: 'verified',
      evidence: 'it worked',
    });
    expect(refused(res)).toBe(true);
    expect(body(res)).toContain('verification_type');
  });

  it('refuses evidence weaker than the task demanded — a typecheck is not an integration test', async () => {
    const id = await plannedWith([
      plannedTask('T001', {
        covers: ['E1', 'C1', 'D1', 'A1', 'A2'],
        verification: { method: 'end-to-end run', evidenceRequired: true, type: 'integration' },
      }),
    ]);
    await executing(id);
    const weak = await call({
      action: 'report_task_result',
      workflow_id: id,
      task_id: 'T001',
      task_status: 'verified',
      verification_type: 'typecheck',
      evidence: 'tsc passed',
    });
    expect(refused(weak)).toBe(true);
    expect(body(weak)).toContain('verification_weaker_than_required');
    expect((await fullMetrics(id)).refused.weak_evidence).toBe(1);

    const strong = await call({
      action: 'report_task_result',
      workflow_id: id,
      task_id: 'T001',
      task_status: 'verified',
      verification_type: 'real-api',
      evidence: 'ran against the live endpoint, compared payloads',
    });
    expect(refused(strong), body(strong)).toBe(false);
  });

  it('does not let mock_verified stand in for a real check', async () => {
    const id = await plannedWith([plannedTask('T001', { covers: ['E1', 'C1', 'D1', 'A1', 'A2'] })]);
    await executing(id);
    const mocked = payload(
      await call({
        action: 'report_task_result',
        workflow_id: id,
        task_id: 'T001',
        task_status: 'mock_verified',
        verification_type: 'unit',
        evidence: 'mock server returned the fixture payload',
      }),
    );
    expect(mocked.counts_toward_completion).toBe(false);
    await call({ action: 'verify', workflow_id: id });
    const audit = payload(await call({ action: 'final_audit', workflow_id: id, note: 'checked the ledger' }));
    expect((audit.blockers as string[]).some((line) => line.includes('mock_verified'))).toBe(true);
    const finished = await call({ action: 'finish', workflow_id: id });
    expect(refused(finished)).toBe(true);
    expect(body(finished)).toContain('mock_verified');
  });

  it('asks what was tried to break it before closing high-stakes work (§6.4)', async () => {
    const id = await plannedWith([
      plannedTask('T001', { priority: 'critical', covers: ['E1', 'C1', 'D1', 'A1', 'A2'] }),
    ]);
    await executing(id);
    const noChallenge = await call({
      action: 'report_task_result',
      workflow_id: id,
      task_id: 'T001',
      task_status: 'verified',
      verification_type: 'integration',
      evidence: 'ran it',
    });
    expect(refused(noChallenge)).toBe(true);
    expect(body(noChallenge)).toContain('challenge');
    const withChallenge = await call({
      action: 'report_task_result',
      workflow_id: id,
      task_id: 'T001',
      task_status: 'verified',
      verification_type: 'integration',
      evidence: 'ran it twice with different inputs',
      challenge: 'tried an empty source and a 10x larger one; both behave the same',
    });
    expect(refused(withChallenge), body(withChallenge)).toBe(false);
  });

  it('keeps not_run and skipped visible instead of folding them into done', async () => {
    const id = await plannedWith([
      plannedTask('T001', { covers: ['E1', 'C1', 'D1'] }),
      plannedTask('T002', { toolName: OTHER_REAL_TOOL, covers: ['A1', 'A2'] }),
    ]);
    await executing(id);
    await closeTask(id, 'T001');
    await call({ action: 'report_task_result', workflow_id: id, task_id: 'T002', task_status: 'not_run' });
    await call({ action: 'verify', workflow_id: id });
    const audit = payload(await call({ action: 'final_audit', workflow_id: id, note: 'reviewed the ledger' }));
    expect((audit.blockers as string[]).some((line) => line.includes('not_run'))).toBe(true);
    const finished = await call({ action: 'finish', workflow_id: id });
    expect(refused(finished)).toBe(true);
    expect(body(finished)).toContain('not_run');
  });
});

/* ------------------------------------------------------------------ §6.5 / §6.6 execution */

describe('pro_fetch_workflow — execution bookkeeping (§6.5, §6.6)', () => {
  it('counts a repeated call that produced nothing, without blocking the run', async () => {
    const id = await started();
    await executing(id);
    const first = payload(
      await call({ action: 'log_call', workflow_id: id, tool_name: REAL_TOOL, purpose: 'read page', produced: 'true' }),
    );
    expect(first.duplicate).toBe(false);
    const again = payload(
      await call({
        action: 'log_call',
        workflow_id: id,
        tool_name: REAL_TOOL,
        purpose: 'read page',
        produced: 'false',
      }),
    );
    expect(again.duplicate).toBe(true);
    expect(again.next_action).toBe('report_finding');
    const metrics = await fullMetrics(id);
    expect(metrics.calls.logged).toBe(2);
    expect(metrics.calls.duplicated).toBe(1);
  });

  it('refuses to log a tool that is not in the registry or a call with no purpose', async () => {
    const id = await started();
    await executing(id);
    expect(
      refused(await call({ action: 'log_call', workflow_id: id, tool_name: 'pro_fetch_nope', purpose: 'x' })),
    ).toBe(true);
    expect(refused(await call({ action: 'log_call', workflow_id: id, tool_name: REAL_TOOL }))).toBe(true);
  });

  it('keeps finish out of reach while an unknown is unclosed, then lets it through', async () => {
    const id = await plannedWith(COVERED_PLAN(), GOAL_WITH_UNKNOWN);
    await executing(id);
    for (const task of ['T001', 'T002']) await closeTask(id, task);
    await call({ action: 'verify', workflow_id: id });
    const audit = payload(await call({ action: 'final_audit', workflow_id: id, note: 'everything maps and runs' }));
    expect((audit.blockers as string[]).some((line) => line.includes('U1'))).toBe(true);
    const blocked = await call({ action: 'finish', workflow_id: id });
    expect(refused(blocked)).toBe(true);
    expect(body(blocked)).toContain('U1');

    expect(refused(await call({ action: 'resolve_unknown', workflow_id: id, unknown_id: 'U1' }))).toBe(true);
    expect(
      refused(
        await call({
          action: 'resolve_unknown',
          workflow_id: id,
          unknown_id: 'U1',
          verdict: 'maybe',
          note: 'x',
        }),
      ),
    ).toBe(true);
    // A "resolved" verdict claims something was learned, so it needs a recorded source behind it.
    expect(
      refused(
        await call({ action: 'resolve_unknown', workflow_id: id, unknown_id: 'U1', verdict: 'resolved', note: 'x' }),
      ),
    ).toBe(true);
    expect((await fullMetrics(id)).refused.unsourced_resolution).toBe(1);

    const unrelated = payload(
      await call({
        action: 'record_source',
        workflow_id: id,
        reference: 'https://example.com/other',
        reliability: 'confirmed',
        observation: 'says nothing about pagination',
        relates_to: 'E1',
      }),
    );
    expect(
      refused(
        await call({
          action: 'resolve_unknown',
          workflow_id: id,
          unknown_id: 'U1',
          verdict: 'resolved',
          note: 'x',
          source_ids: String(unrelated.source_id),
        }),
      ),
    ).toBe(true);
    expect(
      refused(
        await call({
          action: 'resolve_unknown',
          workflow_id: id,
          unknown_id: 'U1',
          verdict: 'resolved',
          note: 'x',
          source_ids: 'src-99',
        }),
      ),
    ).toBe(true);

    const sourced = payload(
      await call({
        action: 'record_source',
        workflow_id: id,
        reference: 'https://docs.example.com/api',
        reliability: 'confirmed',
        observation: 'the endpoint is not paginated below 1000 rows',
        relates_to: 'U1,E1',
      }),
    );
    expect(sourced.reliability).toBe('confirmed');
    const closed = payload(
      await call({
        action: 'resolve_unknown',
        workflow_id: id,
        unknown_id: 'U1',
        verdict: 'resolved',
        note: 'checked the docs: the API is not paginated below 1000 rows',
        source_ids: String(sourced.source_id),
      }),
    );
    expect(closed.open_unknowns).toBe(0);

    const done = payload(await call({ action: 'finish', workflow_id: id }));
    expect(done.phase).toBe('COMPLETED');
  });

  it('routes a material discovery made during execution back through the plan', async () => {
    const id = await started();
    await executing(id);
    const reported = payload(
      await call({
        action: 'report_finding',
        workflow_id: id,
        findings: JSON.stringify([finding('F010', { classification: 'must_fix', blocking: true })]),
      }),
    );
    expect(reported.material).toBe(true);
    expect(reported.phase).toBe('PLANNING');
    expect(reported.next_action).toBe('submit_plan');
  });

  it('leaves a report_only discovery where it is', async () => {
    const id = await started();
    await executing(id);
    const reported = payload(
      await call({
        action: 'report_finding',
        workflow_id: id,
        findings: JSON.stringify([finding('F011', { classification: 'report_only' })]),
      }),
    );
    expect(reported.material).toBe(false);
    expect(reported.phase).toBe('EXECUTING');
    expect(reported.next_action).toBe('get_next_task');
  });
});

/* ------------------------------------------------------------------ §5.5 + §10 research/scheduling */

describe('pro_fetch_workflow — resource conflicts and research (§5.5, §10)', () => {
  /** Two writing tasks that both produce dashboard.html, but for different requirements. */
  const conflictingPlan = (): Task[] => [
    plannedTask('T001', {
      toolName: MUTATING_TOOL,
      sensitivity: 'mutating',
      deliverables: ['dashboard.html'],
      covers: ['E1', 'C1', 'D1'],
    }),
    plannedTask('T002', {
      toolName: MUTATING_TOOL,
      sensitivity: 'mutating',
      objective: 'measure render path',
      deliverables: ['dashboard.html'],
      covers: ['A1', 'A2'],
    }),
  ];

  it('reports the conflicting pair when the plan is disclosed to the auditor', async () => {
    const id = await plannedWith(conflictingPlan());
    const opened = payload(await call({ action: 'begin_audit', workflow_id: id, stage: 'full', detail: 'full' }));
    expect(opened.conflicts).toEqual([{ deliverable: 'dashboard.html', tasks: ['T001', 'T002'], bothWrite: true }]);
  });

  it('serialises the second writer instead of handing it out over the first', async () => {
    const id = await plannedWith(conflictingPlan());
    const first = await executing(id);
    expect((first.task as { id: string }).id).toBe('T001');

    const second = payload(await call({ action: 'get_next_task', workflow_id: id }));
    expect(second.task).toBeNull();
    expect(second.waiting_on).toBe('T001');
    expect((await fullMetrics(id)).conflicts.serialised).toBeGreaterThan(0);

    await closeTask(id, 'T001');
    const after = payload(await call({ action: 'get_next_task', workflow_id: id }));
    expect((after.task as { id: string }).id).toBe('T002');
  });

  it('does not serialise when only one side writes the shared deliverable', async () => {
    const id = await plannedWith([
      plannedTask('T001', {
        toolName: MUTATING_TOOL,
        sensitivity: 'mutating',
        deliverables: ['dashboard.html'],
        covers: ['E1', 'C1', 'D1'],
      }),
      plannedTask('T002', {
        objective: 'read back',
        deliverables: ['dashboard.html'],
        covers: ['A1', 'A2'],
      }),
    ]);
    const opened = payload(await call({ action: 'begin_audit', workflow_id: id, stage: 'full', detail: 'full' }));
    expect(opened.conflicts).toEqual([{ deliverable: 'dashboard.html', tasks: ['T001', 'T002'], bothWrite: false }]);
    await executing(id);
    const second = payload(await call({ action: 'get_next_task', workflow_id: id }));
    // A reader of the same file is not a writer racing it — that would serialise half of every plan.
    expect((second.task as { id: string }).id).toBe('T002');
  });

  it('accepts a reliability vocabulary it can defend', async () => {
    const id = await started();
    await executing(id);
    expect(
      refused(
        await call({
          action: 'record_source',
          workflow_id: id,
          reference: 'https://x',
          reliability: 'definitely',
          observation: 'o',
        }),
      ),
    ).toBe(true);
    expect(
      refused(await call({ action: 'record_source', workflow_id: id, reliability: 'confirmed', observation: 'o' })),
    ).toBe(true);
    expect(
      refused(
        await call({
          action: 'record_source',
          workflow_id: id,
          reference: 'https://x',
          reliability: 'supported',
          observation: 'o',
          relates_to: 'Z9',
        }),
      ),
    ).toBe(true);
    const ok = payload(
      await call({
        action: 'record_source',
        workflow_id: id,
        reference: 'https://x',
        reliability: 'uncertain',
        observation: 'partial answer only',
        relates_to: 'E1',
      }),
    );
    expect(ok.next_action).toBe('resolve_unknown');
    const metrics = await fullMetrics(id);
    expect(metrics.sources.total).toBe(1);
    expect(metrics.sources.by_reliability.uncertain).toBe(1);
  });
});

/* ------------------------------------------------------------------ §12.3 + §17 */

describe('pro_fetch_workflow — verification, repair, final audit', () => {
  it('will not finish from VERIFYING in full mode: the audit is a step (§12.3)', async () => {
    const id = await plannedWith([plannedTask('T001', { covers: ['E1', 'C1', 'D1', 'A1', 'A2'] })]);
    await executing(id);
    await closeTask(id, 'T001');
    const verify = payload(await call({ action: 'verify', workflow_id: id }));
    expect(verify.next_action).toBe('final_audit');
    const early = await call({ action: 'finish', workflow_id: id });
    expect(refused(early)).toBe(true);
    expect(body(early)).toContain('FINAL_AUDIT');
    expect((await fullMetrics(id)).refused.fake_completion).toBe(1);
  });

  it('sends a task back through REPAIR without pretending the plan changed', async () => {
    const id = await plannedWith([plannedTask('T001', { covers: ['E1', 'C1', 'D1', 'A1', 'A2'] })]);
    await executing(id);
    await closeTask(id, 'T001');
    await call({ action: 'verify', workflow_id: id });
    const repair = payload(await call({ action: 'repair', workflow_id: id, reason: 'A2 not actually compared' }));
    expect(repair.phase).toBe('EXECUTING');
    const history = (payload(await call({ action: 'status', workflow_id: id, detail: 'full' })).phase as string)!;
    expect(history).toBe('EXECUTING');
    const reverified = payload(await call({ action: 'verify', workflow_id: id }));
    expect(reverified.phase).toBe('VERIFYING');
  });

  it('a final audit that finds a gap reopens the plan instead of completing', async () => {
    const id = await plannedWith([plannedTask('T001', { covers: ['E1', 'C1', 'D1', 'A1', 'A2'] })]);
    await executing(id);
    await closeTask(id, 'T001');
    await call({ action: 'verify', workflow_id: id });
    const audit = payload(
      await call({
        action: 'final_audit',
        workflow_id: id,
        note: 're-read the acceptance criteria against the evidence',
        findings: JSON.stringify([finding('F020', { classification: 'must_fix', blocking: true })]),
      }),
    );
    expect(audit.gaps).toBe(1);
    expect(audit.phase).toBe('PLANNING');
    expect(audit.next_action).toBe('submit_plan');
  });

  it('refuses an audit note that says nothing', async () => {
    const id = await plannedWith([plannedTask('T001', { covers: ['E1', 'C1', 'D1', 'A1', 'A2'] })]);
    await executing(id);
    await closeTask(id, 'T001');
    await call({ action: 'verify', workflow_id: id });
    expect(refused(await call({ action: 'final_audit', workflow_id: id }))).toBe(true);
  });

  it('lite mode finishes from VERIFYING without the extra audit step', async () => {
    const lite = payload(await call({ action: 'start', goal: JSON.stringify(GOAL), mode: 'lite' }));
    const liteId = String(lite.workflow_id);
    expect(liteId).not.toBe('undefined');
    await call({ action: 'submit_plan', workflow_id: liteId, plan: JSON.stringify({ tasks: COVERED_PLAN() }) });
    await audited(liteId);
    await executing(liteId, []);
    for (const task of ['T001', 'T002']) await closeTask(liteId, task);
    const verify = payload(await call({ action: 'verify', workflow_id: liteId }));
    expect(verify.next_action).toBe('finish');
    expect(verify.eligible_to_finish).toBe(true);
    const done = payload(await call({ action: 'finish', workflow_id: liteId }));
    expect(done.phase).toBe('COMPLETED');
  });
});

/* ------------------------------------------------------------------ §13.3 + §17 pause */

describe('pro_fetch_workflow — stagnation and interruption', () => {
  it('refuses a second revision that brought neither new evidence nor a new finding (§13.3)', async () => {
    const id = await plannedWith(COVERED_PLAN());
    // Round one: the plan is rejected for a real objection, and the revision changes the finding count.
    await audited(id, [finding('F001', { classification: 'must_fix', blocking: true })]);
    await call({ action: 'revise_plan', workflow_id: id, reason: 'mapping for A2 added' });
    const second = await call({
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({ tasks: COVERED_PLAN() }),
    });
    expect(refused(second), body(second)).toBe(false);

    // Round two: nothing new was measured and no new objection exists, so the same loop is refused.
    await audited(id, []);
    await call({ action: 'revise_plan', workflow_id: id, reason: 'same plan again' });
    const third = await call({
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({ tasks: COVERED_PLAN() }),
    });
    expect(refused(third)).toBe(true);
    expect(body(third)).toContain('stagnation');
    expect((await fullMetrics(id)).refused.stagnation).toBe(1);
  });

  it('pause records what it interrupted and resume restores exactly that', async () => {
    const id = await started();
    await executing(id);
    const paused = payload(await call({ action: 'pause', workflow_id: id, reason: 'operator stepped away' }));
    expect(paused.phase).toBe('PAUSED');
    expect(paused.paused_from).toBe('EXECUTING');
    expect(refused(await call({ action: 'pause', workflow_id: id, reason: 'again' }))).toBe(true);

    const resumed = payload(await call({ action: 'resume', workflow_id: id }));
    expect(resumed.phase).toBe('EXECUTING');
    expect(resumed.next_action).toBe('get_next_task');
    expect(refused(await call({ action: 'resume', workflow_id: id }))).toBe(true);
  });

  it('resume into EXECUTING still passes the approval gate', async () => {
    const id = await plannedWith([
      plannedTask('T001', { toolName: MUTATING_TOOL, sensitivity: 'mutating', covers: ['E1', 'C1', 'D1', 'A1', 'A2'] }),
    ]);
    await audited(id);
    // Paused from PLAN_READY, then aimed at EXECUTING by hand is not possible; block+unblock is the door.
    await call({ action: 'block', workflow_id: id, reason: 'waiting for the operator' });
    const unblocked = await call({ action: 'unblock', workflow_id: id, target: 'EXECUTING' });
    expect(refused(unblocked)).toBe(true);
    expect(body(unblocked)).toContain('approve_plan');
  });
});

/* ------------------------------------------------------------------ §14 store + honesty of payload */

describe('pro_fetch_workflow — refusals, refusals of shape, and secrets', () => {
  it('refuses an unknown workflow id, an unknown action, an unknown task id', async () => {
    expect(refused(await call({ action: 'status', workflow_id: 'wf-nope' }))).toBe(true);
    expect(refused(await call({ action: 'do_everything' }))).toBe(true);
    const id = await started();
    expect(
      refused(await call({ action: 'report_task_result', workflow_id: id, task_id: 'T999', task_status: 'failed' })),
    ).toBe(true);
  });

  it('refuses an out-of-order phase move in both directions', async () => {
    const id = await plannedWith(COVERED_PLAN());
    const again = await call({
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({ tasks: COVERED_PLAN() }),
    });
    expect(refused(again)).toBe(true);
    expect(body(again)).toContain('PLANNING');
    await audited(id);
    expect(refused(await call({ action: 'verify', workflow_id: id }))).toBe(true);
  });

  it('refuses properties the schema never declared', async () => {
    expect(refused(await call({ action: 'introduce', nope: true } as unknown as Record<string, unknown>))).toBe(true);
  });

  it('redacts credential-shaped evidence before the workflow file is written', async () => {
    const id = await plannedWith([plannedTask('T001', { covers: ['E1', 'C1', 'D1', 'A1', 'A2'] })]);
    await executing(id);
    await closeTask(id, 'T001', { evidence: 'called the endpoint with token: hunter2-hunter2 and it returned 200' });
    const raw = await readFile(path.join(dir, 'workflows', `${id}.json`), 'utf8');
    expect(raw).toContain('[REDACTED]');
    expect(raw).not.toContain('hunter2-hunter2');
  });

  it('persists the run so a later read sees the same phase', async () => {
    const id = await plannedWith(COVERED_PLAN());
    const stored = JSON.parse(await readFile(path.join(dir, 'workflows', `${id}.json`), 'utf8')) as WorkflowState;
    expect(stored.phase).toBe('AUDIT_REQUIRED');
    expect(stored.plan?.tasks).toHaveLength(2);
    expect(stored.stats?.fakeCompletionRefused).toBe(0);
  });

  it('keeps the summary payload small and expands only on request', async () => {
    const id = await plannedWith(COVERED_PLAN());
    const summary = payload(await call({ action: 'status', workflow_id: id }));
    expect(summary.tasks).toBeUndefined();
    expect(summary.total_tasks).toBe(2);
    const full = payload(await call({ action: 'status', workflow_id: id, detail: 'full' }));
    expect((full.tasks as unknown[]).length).toBe(2);
    expect(JSON.stringify(full).length).toBeGreaterThan(JSON.stringify(summary).length);
  });
});

/* ------------------------------------------------------------------ §4.5 + §16.3 */

describe('pro_fetch_workflow — plan view and repeated failure (§4.5, §16.3)', () => {
  it('answers with the machine-readable plan the spec asks for', async () => {
    const id = await plannedWith([
      plannedTask('T001', {
        toolName: MUTATING_TOOL,
        sensitivity: 'mutating',
        deliverables: ['dashboard.html'],
        covers: ['E1', 'C1', 'D1'],
      }),
      plannedTask('T002', { objective: 'measure render', covers: ['A1', 'A2'] }),
    ]);
    const view = (payload(await call({ action: 'status', workflow_id: id, detail: 'full' })).plan_view ?? {}) as Record<
      string,
      unknown
    >;

    expect(view.goal).toBe(GOAL.goal);
    const map = view.requirement_map as Array<{ id: string; carried_by: string[] }>;
    expect(map.map((entry) => entry.id)).toEqual(['E1', 'C1', 'D1', 'A1', 'A2']);
    expect(map.find((entry) => entry.id === 'A2')?.carried_by).toEqual(['T002']);
    expect(view.capabilities).toEqual([MUTATING_TOOL, REAL_TOOL].sort());
    // cache_put reaches an external store, so the graded risk line says so — read from the registry, not the plan.
    expect(view.risk_register).toEqual(['T001: pro_fetch_cache_put — registry: mutating (tashqi tizim)']);
    expect(view.approval_required).toEqual(['T001']);
    expect(view.acceptance_criteria).toEqual(GOAL.acceptanceCriteria);
    // Nothing in this plan declared a fallback, and the view says so per step.
    expect(view.steps_without_fallback).toEqual([`T001:${MUTATING_TOOL}`, `T002:${REAL_TOOL}`]);
  });

  it('shows which work could run at once and withholds the conflicting one', async () => {
    const id = await plannedWith([
      plannedTask('T001', { covers: ['E1', 'C1', 'D1'] }),
      plannedTask('T002', { objective: 'measure render', toolName: OTHER_REAL_TOOL, covers: ['A1', 'A2'] }),
    ]);
    const view = payload(await call({ action: 'status', workflow_id: id, detail: 'full' })).plan_view as {
      parallelisable: string[];
      conflicts: unknown[];
      dependency_graph: unknown[];
    };
    expect(view.parallelisable).toEqual(['T001', 'T002']);
    expect(view.conflicts).toEqual([]);
    expect(view.dependency_graph).toEqual([
      { id: 'T001', depends_on: [] },
      { id: 'T002', depends_on: [] },
    ]);
  });

  it('records a task that keeps failing instead of letting it be retried forever (§16.3)', async () => {
    const id = await started();
    await executing(id);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const res = payload(
        await call({ action: 'report_task_result', workflow_id: id, task_id: 'T001', task_status: 'failed' }),
      );
      if (attempt < 3) expect(res.next_action).toBe('get_next_task');
      else expect(res.next_action).toBe('replan');
    }
    const full = payload(await call({ action: 'status', workflow_id: id, detail: 'full' }));
    const task = (full.tasks as Array<{ id: string; status: string }>)[0];
    expect(task.status).toBe('failed');
    const warned = await call({
      action: 'report_task_result',
      workflow_id: id,
      task_id: 'T001',
      task_status: 'failed',
    });
    expect(body(warned)).toContain('§16.3');
    const ledger = JSON.parse(await readFile(path.join(dir, 'workflows', `${id}.json`), 'utf8')) as WorkflowState;
    expect(ledger.plan?.tasks[0].blockers.some((entry) => entry.includes('failed x3'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ guards over the tool itself */

describe('pro_fetch_workflow — fixture and contract sanity', () => {
  it('plans tools that exist in the live registry', () => {
    const names = new Set(allTools().map((tool) => tool.name));
    for (const name of [REAL_TOOL, OTHER_REAL_TOOL, MUTATING_TOOL]) expect(names.has(name), name).toBe(true);
  });

  it('never promises a next_action the switch cannot handle', () => {
    // `submit_review` once answered a blocking finding with next_action "revise_plan", which no case
    // implemented: the run could not proceed, retry, or close the finding. That is a class of bug, so
    // it is checked against the source rather than by walking every path.
    const source = readFileSync('src/tools/workflow/workflow.ts', 'utf8');
    const handled = new Set([
      ...[...source.matchAll(/case '([a-z_]+)':/g)].map((match) => match[1]),
      ...[...source.matchAll(/action === '([a-z_]+)'/g)].map((match) => match[1]),
    ]);
    const promised = [...source.matchAll(/next_action:\s*([^,\n}]+)/g)]
      // In `cond ? 'a' : 'b'` the condition may compare quoted phase names; only branches are promises.
      .map((match) => (match[1].includes('?') ? match[1].slice(match[1].indexOf('?') + 1) : match[1]))
      .flatMap((expr) => [...expr.matchAll(/'([a-z_]+)'/g)].map((quoted) => quoted[1]));
    expect(promised.length, 'next_action literals found').toBeGreaterThan(8);
    const unhandled = promised.filter((name) => !handled.has(name));
    expect(unhandled, `unhandled next_action: ${unhandled.join(', ')}`).toEqual([]);
  });

  it('lists every handled action in the published description and schema', () => {
    const tool = allTools().find((entry) => entry.name === 'pro_fetch_workflow');
    const source = readFileSync('src/tools/workflow/workflow.ts', 'utf8');
    const handled = new Set([
      ...[...source.matchAll(/case '([a-z_]+)':/g)].map((match) => match[1]),
      ...[...source.matchAll(/action === '([a-z_]+)'/g)].map((match) => match[1]),
    ]);
    const actionEnum = (tool?.inputSchema.properties as { action: { description: string } }).action.description;
    for (const name of handled) expect(actionEnum, name).toContain(name);
    expect(tool?.description).toContain('begin_audit');
  });
});
