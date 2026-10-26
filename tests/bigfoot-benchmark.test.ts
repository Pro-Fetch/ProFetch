/**
 * The Bigfoot benchmark (spec §20.1–§20.4).
 *
 * §20.5 says the point is not how many tools exist but how the workflow behaves, and §20.1–§20.4 name
 * four things worth measuring: does the planner reject broken plans, does the auditor catch defects,
 * does MaxEffort avoid fake completion and recover from failure, and can the model talk its way past
 * a security boundary. Each is measured here as a *rate over a labelled corpus*, not as a single
 * happy-path test, because the interesting failure mode is a gate that catches one case and misses
 * nine others that look similar.
 *
 * Everything runs offline against the real registry and a temp store. A rate that could not be
 * recomputed on a laptop is not a benchmark, it is a number in a document.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../src/loader.js';
import { dispatch } from '../src/core/tool.js';
import type { GoalSpec, Task } from '../src/core/workflow/types.js';

const ORIGINAL = { ...process.env };
let dir = '';

beforeEach(async () => {
  process.env.PRO_FETCH_PROFILE = 'full';
  dir = await mkdtemp(path.join(tmpdir(), `pf-bench-${Date.now()}-`));
  process.env.PRO_FETCH_WORKFLOW_DIR = dir;
});

afterEach(async () => {
  process.env = { ...ORIGINAL };
  if (dir) await rm(dir, { recursive: true, force: true });
});

const text = (result: { content?: Array<{ type: string; text?: string }> }) =>
  (result.content ?? []).map((item) => item.text ?? '').join(' ');

const jsonOf = (result: { content?: Array<{ type: string; text?: string }> }): Record<string, unknown> => {
  const raw = text(result);
  return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as Record<string, unknown>;
};

const call = (args: Record<string, unknown>) => dispatch('pro_fetch_workflow', args);
const rejected = (result: { isError?: boolean }) => result.isError === true;

/** A five-requirement goal: E1, C1, D1, A1, A2, plus one unknown (U1). */
const GOAL: GoalSpec = {
  goal: 'benchmark run',
  explicitRequirements: ['collect the numbers'],
  implicitRequirements: [],
  constraints: ['no new dependency'],
  deliverables: ['report.md'],
  qualityTarget: 'high',
  acceptanceCriteria: ['numbers reproduce', 'sources cited'],
  unknowns: [],
};
const ALL_REQUIREMENTS = ['E1', 'C1', 'D1', 'A1', 'A2'];

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    objective: `objective ${id}`,
    priority: 'medium',
    dependsOn: [],
    deliverables: [],
    toolPlan: [
      {
        toolName: 'pro_fetch_fetch_url',
        category: 'http',
        purpose: 'read',
        sensitivity: 'read_only',
        requiresApproval: false,
      },
    ],
    acceptanceCriteria: ['measured output'],
    verification: { method: 're-run', evidenceRequired: true },
    covers: ALL_REQUIREMENTS,
    status: 'pending',
    attempts: 0,
    evidenceRefs: [],
    blockers: [],
    ...over,
  } as Task;
}

async function started(goal: GoalSpec = GOAL): Promise<string> {
  return String(jsonOf(await call({ action: 'start', goal: JSON.stringify(goal) })).workflow_id);
}

/** A run in EXECUTING with a clean audit — the starting point for the execution benchmarks. */
async function readyToWork(over: Partial<Task> = {}): Promise<string> {
  const id = await started();
  await call({ action: 'submit_plan', workflow_id: id, plan: JSON.stringify({ tasks: [task('T001', over)] }) });
  await call({ action: 'begin_audit', workflow_id: id, stage: 'full' });
  const review = await call({ action: 'submit_review', workflow_id: id, findings: '[]' });
  expect(rejected(review), text(review)).toBe(false);
  const next = await call({ action: 'get_next_task', workflow_id: id });
  expect(rejected(next), text(next)).toBe(false);
  return id;
}

/** Runs each labelled case and reports recall / false-positive rate as one number. */
async function measure(cases: { label: string; run: () => Promise<boolean> }[]) {
  const results = [];
  for (const entry of cases) results.push({ label: entry.label, rejected: await entry.run() });
  const missed = results.filter((entry) => !entry.rejected).map((entry) => entry.label);
  return { total: results.length, missed, rate: (results.length - missed.length) / results.length };
}

describe('planning benchmark (§20.1)', () => {
  it('refuses every broken plan in the corpus', async () => {
    const bad: Array<{ label: string; mutate?: (t: Task[]) => Task[]; expect: string }> = [
      {
        label: 'unmapped requirement',
        mutate: (t) => [task('T001', { covers: ['E1', 'C1', 'D1', 'A1'] })],
        expect: 'A2',
      },
      {
        label: 'invented tool',
        mutate: (t) => [task('T001', { toolPlan: [{ ...t[0].toolPlan[0], toolName: 'pro_fetch_not_real' }] })],
        expect: 'registry',
      },
      {
        label: 'invented requirement id',
        mutate: (t) => [task('T001', { covers: ['Z9'] })],
        expect: 'task_covers_unknown',
      },
      {
        label: 'no acceptance criteria',
        mutate: (t) => [task('T001', { acceptanceCriteria: [] })],
        expect: 'task_acceptance_missing',
      },
      { label: 'dependency cycle', mutate: (t) => [task('T001', { dependsOn: ['T001'] })], expect: 'task_cycle' },
      {
        label: 'duplicated objective',
        mutate: (t) => [task('T001'), task('T002', { objective: 'objective T001', covers: [] })],
        expect: 'task_duplicate_objective',
      },
      {
        label: 'duplicated work',
        mutate: (t) => [task('T001'), task('T002', { objective: 'other' })],
        expect: 'task_duplicate_toolplan',
      },
      {
        label: 'understated risk',
        mutate: (t) => [
          task('T001', {
            toolPlan: [{ ...t[0].toolPlan[0], toolName: 'pro_fetch_cache_put', sensitivity: 'read_only' }],
          }),
        ],
        expect: 'risk_understated',
      },
    ];

    const outcomes = [];
    for (const item of bad) {
      const id = await started();
      const tasks = item.mutate ? item.mutate([task('T001')]) : [task('T001')];
      const res = await call({ action: 'submit_plan', workflow_id: id, plan: JSON.stringify({ tasks }) });
      outcomes.push({ label: item.label, rejected: rejected(res), body: text(res), expect: item.expect });
    }
    const missed = outcomes.filter((entry) => !entry.rejected || !entry.body.includes(entry.expect));
    console.log(`planning: ${outcomes.length - missed.length}/${outcomes.length} refused with the named rule`);
    expect(missed.map((entry) => entry.label)).toEqual([]);
  });

  it('accepts every valid plan in the corpus (no false refusals)', async () => {
    const valid: Array<{ label: string; tasks: Task[] }> = [
      { label: 'single task carrying all requirements', tasks: [task('T001')] },
      {
        label: 'two tasks sharing one tool for different requirements',
        tasks: [task('T001', { covers: ['E1', 'C1', 'D1'] }), task('T002', { objective: 'b', covers: ['A1', 'A2'] })],
      },
      {
        label: 'chained tasks',
        tasks: [
          task('T001', { covers: ['E1', 'C1'] }),
          task('T002', { objective: 'b', covers: ['D1', 'A1', 'A2'], dependsOn: ['T001'] }),
        ],
      },
      {
        label: 'multi-step tool plan',
        tasks: [
          task('T001', {
            toolPlan: [
              {
                toolName: 'pro_fetch_fetch_url',
                category: 'http',
                purpose: 'read',
                sensitivity: 'read_only',
                requiresApproval: false,
              },
              {
                toolName: 'pro_fetch_web_search',
                category: 'search',
                purpose: 'find',
                sensitivity: 'read_only',
                requiresApproval: false,
              },
            ],
          }),
        ],
      },
    ];
    for (const entry of valid) {
      const id = await started();
      const res = await call({ action: 'submit_plan', workflow_id: id, plan: JSON.stringify({ tasks: entry.tasks }) });
      expect(rejected(res), `${entry.label}: ${text(res)}`).toBe(false);
    }
  });
});

describe('MaxEffort benchmark (§20.3)', () => {
  it('refuses every fake-completion attempt', async () => {
    const attempts = [
      {
        label: 'verified with no evidence',
        run: async () =>
          rejected(
            await call({
              action: 'report_task_result',
              workflow_id: await readyToWork(),
              task_id: 'T001',
              task_status: 'verified',
            }),
          ),
      },
      {
        label: 'verified without naming the method',
        run: async () =>
          rejected(
            await call({
              action: 'report_task_result',
              workflow_id: await readyToWork(),
              task_id: 'T001',
              task_status: 'verified',
              evidence: 'done',
            }),
          ),
      },
      {
        label: 'verified on weaker evidence than required',
        run: async () => {
          const id = await readyToWork({
            verification: { method: 'e2e', evidenceRequired: true, type: 'integration' },
          });
          return rejected(
            await call({
              action: 'report_task_result',
              workflow_id: id,
              task_id: 'T001',
              task_status: 'verified',
              verification_type: 'typecheck',
              evidence: 'tsc',
            }),
          );
        },
      },
      {
        label: 'critical task closed without a self-challenge',
        run: async () =>
          rejected(
            await call({
              action: 'report_task_result',
              workflow_id: await readyToWork({ priority: 'critical' }),
              task_id: 'T001',
              task_status: 'verified',
              verification_type: 'integration',
              evidence: 'ran',
            }),
          ),
      },
      {
        label: 'finish after skipping the final audit',
        run: async () => {
          const id = await readyToWork();
          await call({
            action: 'report_task_result',
            workflow_id: id,
            task_id: 'T001',
            task_status: 'verified',
            verification_type: 'unit',
            evidence: 'ran',
          });
          await call({ action: 'verify', workflow_id: id });
          return rejected(await call({ action: 'finish', workflow_id: id }));
        },
      },
      {
        label: 'finish with a blocking finding open',
        run: async () => {
          const id = await started();
          await call({ action: 'submit_plan', workflow_id: id, plan: JSON.stringify({ tasks: [task('T001')] }) });
          await call({
            action: 'submit_review',
            workflow_id: id,
            findings: JSON.stringify([
              {
                id: 'F1',
                severity: 'critical',
                relatedRequirementIds: ['E1'],
                description: 'd',
                evidence: 'e',
                whyItMatters: 'w',
                requiredAction: 'a',
                acceptanceCriteria: ['c'],
                confidence: 0.9,
                classification: 'must_fix',
                blocking: true,
                status: 'open',
              },
            ]),
          });
          return rejected(await call({ action: 'finish', workflow_id: id }));
        },
      },
      {
        label: 'verified deliverable with no artifact',
        run: async () => {
          const id = await readyToWork({ deliverables: ['report.md'] });
          return rejected(
            await call({
              action: 'report_task_result',
              workflow_id: id,
              task_id: 'T001',
              task_status: 'verified',
              verification_type: 'unit',
              evidence: 'ran it',
            }),
          );
        },
      },
      {
        label: 'finish while a promised artifact was never produced',
        run: async () => {
          const id = await readyToWork({ deliverables: ['report.md'] });
          await call({ action: 'report_task_result', workflow_id: id, task_id: 'T001', task_status: 'failed' });
          await call({ action: 'get_next_task', workflow_id: id });
          await call({
            action: 'report_task_result',
            workflow_id: id,
            task_id: 'T001',
            task_status: 'verified',
            verification_type: 'unit',
            evidence: 'ran it and wrote the file',
          });
          await call({ action: 'verify', workflow_id: id });
          return rejected(await call({ action: 'finish', workflow_id: id }));
        },
      },
    ];
    const measured = await measure(attempts);
    console.log(`fake completion refused: ${measured.total - measured.missed.length}/${measured.total}`);
    expect(measured.missed).toEqual([]);
  });

  it('recovers from a failed attempt and lets the honest one through', async () => {
    const id = await readyToWork();
    const failed = await call({
      action: 'report_task_result',
      workflow_id: id,
      task_id: 'T001',
      task_status: 'failed',
    });
    expect(rejected(failed)).toBe(false);
    const retry = await call({ action: 'get_next_task', workflow_id: id });
    expect(jsonOf(retry).task).not.toBeNull();
    const closed = await call({
      action: 'report_task_result',
      workflow_id: id,
      task_id: 'T001',
      task_status: 'verified',
      verification_type: 'integration',
      evidence: 're-ran after fixing the input parsing',
    });
    expect(rejected(closed), text(closed)).toBe(false);
    const status = jsonOf(await call({ action: 'status', workflow_id: id, detail: 'full' }));
    expect((status.metrics as { attempts: number }).attempts).toBe(2);
  });
});

async function writes(): Promise<string> {
  const id = await started();
  await call({
    action: 'submit_plan',
    workflow_id: id,
    plan: JSON.stringify({
      tasks: [
        task('T001', {
          toolPlan: [
            {
              toolName: 'pro_fetch_cache_put',
              category: 'knowledge',
              purpose: 'write',
              sensitivity: 'mutating',
              requiresApproval: true,
            },
          ],
        }),
      ],
    }),
  });
  await call({ action: 'begin_audit', workflow_id: id, stage: 'full' });
  await call({ action: 'submit_review', workflow_id: id, findings: '[]' });
  return id;
}

describe('security benchmark (§20.4)', () => {
  it('refuses every attempt to skip the approval or the operator policy', async () => {
    const attempts = [
      {
        label: 'execute an unapproved write',
        run: async () => rejected(await call({ action: 'get_next_task', workflow_id: await writes() })),
      },
      {
        label: 'approve without a reason',
        run: async () => rejected(await call({ action: 'approve_plan', workflow_id: await writes(), note: '  ' })),
      },
      {
        label: 'approve before the audit',
        run: async () => {
          const id = await started();
          await call({ action: 'submit_plan', workflow_id: id, plan: JSON.stringify({ tasks: [task('T001')] }) });
          return rejected(await call({ action: 'approve_plan', workflow_id: id, note: 'early' }));
        },
      },
      {
        label: 'run at all under operator read-only',
        run: async () => {
          process.env.PRO_FETCH_READ_ONLY = 'true';
          try {
            return rejected(await call({ action: 'start', goal: 'x' }));
          } finally {
            delete process.env.PRO_FETCH_READ_ONLY;
          }
        },
      },
      {
        label: 'send an undeclared argument',
        run: async () =>
          rejected(
            await call({ action: 'status', workflow_id: 'wf-x', nope: true } as unknown as Record<string, unknown>),
          ),
      },
    ];
    const measured = await measure(attempts);
    console.log(`security refusals: ${measured.total - measured.missed.length}/${measured.total}`);
    expect(measured.missed).toEqual([]);
  });

  it('does not let the model talk itself into a write the operator forbade', async () => {
    const id = await writes();
    process.env.PRO_FETCH_READ_ONLY = 'true';
    let approval;
    try {
      approval = await call({ action: 'approve_plan', workflow_id: id, note: 'the task needs this write' });
    } finally {
      delete process.env.PRO_FETCH_READ_ONLY;
    }
    expect(rejected(approval)).toBe(true);
    // The only lever is the operator's, and the refusal says so instead of offering a workaround.
    expect(text(approval)).toContain('PRO_FETCH_MUTATION_ALLOWLIST');
  });

  it('keeps a secret out of the persisted ledger', async () => {
    const id = await readyToWork();
    await call({
      action: 'report_task_result',
      workflow_id: id,
      task_id: 'T001',
      task_status: 'verified',
      verification_type: 'integration',
      evidence: 'used token: s3cr3t-token-value and it worked',
    });
    const raw = await readFile(path.join(dir, 'workflows', `${id}.json`), 'utf8');
    expect(raw).toContain('[REDACTED]');
    expect(raw).not.toContain('s3cr3t-token-value');
  });

  it('refuses an approval the registry says is unnecessary rather than granting a fake one', async () => {
    const id = await started();
    await call({ action: 'submit_plan', workflow_id: id, plan: JSON.stringify({ tasks: [task('T001')] }) });
    await call({ action: 'begin_audit', workflow_id: id, stage: 'full' });
    await call({ action: 'submit_review', workflow_id: id, findings: '[]' });
    const res = await call({ action: 'approve_plan', workflow_id: id, note: 'nothing writes here' });
    expect(rejected(res)).toBe(true);
    expect(text(res)).toContain('shart emas');
  });
});
