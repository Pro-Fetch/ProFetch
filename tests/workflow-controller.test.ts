/**
 * Live tests for the `pro_fetch_workflow` controller — the tool as the host AI actually calls it,
 * through `dispatch`, against the real registry and a real on-disk store.
 *
 * The foundation tests cover the pure state machine and store. What is only visible at this level is
 * the wiring: whether an illegal move is refused *by the tool*, whether a fake PASS is blocked before
 * it is persisted, whether `detail` changes the payload instead of being a declared-but-dead property,
 * and whether evidence is redacted on the way to disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../src/loader.js';
import { allTools, dispatch } from '../src/core/tool.js';
import type { Task } from '../src/core/workflow/types.js';

const ORIGINAL = { ...process.env };
let dir = '';

beforeEach(async () => {
  process.env.PRO_FETCH_PROFILE = 'full';
  dir = await mkdtemp(path.join(tmpdir(), `pf-wf-${Date.now()}-`));
  process.env.PRO_FETCH_WORKFLOW_DIR = dir;
});

afterEach(async () => {
  process.env = { ...ORIGINAL };
  if (dir) await rm(dir, { recursive: true, force: true });
});

const body = (result: { content?: Array<{ type: string; text?: string }> }) =>
  (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');

/** The JSON payload the controller wraps its answers in. */
function payload(result: { content?: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const raw = body(result)
    .replace(/^```json\s*/gm, '')
    .replace(/```\s*$/gm, '');
  return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as Record<string, unknown>;
}

const refused = (result: { isError?: boolean }) => result.isError === true;

/** Two names that must exist in the registry; the plan validator refuses anything else. */
const REAL_TOOL = 'pro_fetch_fetch_url';
const OTHER_REAL_TOOL = 'pro_fetch_web_search';
const categoryOf = (name: string) => (name === OTHER_REAL_TOOL ? 'search' : 'http');

/** A task that satisfies the validator; `objective` doubles as the id suffix. */
function plannedTask(id: string, toolName = REAL_TOOL): Task {
  return {
    id,
    objective: `measure ${id}`,
    priority: 'high',
    dependsOn: [],
    deliverables: [`${id}-report`],
    toolPlan: [
      {
        toolName,
        category: categoryOf(toolName),
        purpose: `do ${id}`,
        expectedEvidence: 'a tool result with content',
        sensitivity: 'read_only',
        requiresApproval: false,
      },
    ],
    acceptanceCriteria: [`${id} produced a measurable result`],
    verification: { method: 're-run and compare', evidenceRequired: true },
    status: 'pending',
    attempts: 0,
    evidenceRefs: [],
    blockers: [],
  };
}

function finding(id: string, over: Partial<{ blocking: boolean; status: string }> = {}) {
  return {
    id,
    severity: 'medium',
    relatedRequirementIds: ['r1'],
    description: `finding ${id}`,
    evidence: 'measured in the running registry',
    whyItMatters: 'an unmeasured plan cannot be verified',
    requiredAction: 'add an acceptance criterion',
    acceptanceCriteria: ['criterion present'],
    confidence: 0.9,
    blocking: over.blocking ?? false,
    status: over.status ?? 'open',
  } as Record<string, unknown>;
}

async function startedWorkflow(): Promise<string> {
  const started = await dispatch('pro_fetch_workflow', {
    action: 'start',
    goal: 'measure the controller end to end',
    mode: 'full',
  });
  expect(refused(started)).toBe(false);
  return String(payload(started).workflow_id);
}

describe('pro_fetch_workflow — onboarding', () => {
  it('introduces itself and only lists the phase names when the caller asks for full', async () => {
    const summary = payload(await dispatch('pro_fetch_workflow', { action: 'introduce' }));
    expect(summary.next_action).toBe('start');
    expect(summary.phases).toBeUndefined();

    const full = payload(await dispatch('pro_fetch_workflow', { action: 'introduce', detail: 'full' }));
    expect(Array.isArray(full.phases)).toBe(true);
    expect((full.phases as string[]).length).toBeGreaterThan(5);
  });

  it('refuses start without a goal, and a goal with no acceptance criteria', async () => {
    expect(refused(await dispatch('pro_fetch_workflow', { action: 'start' }))).toBe(true);
    const noCriteria = await dispatch('pro_fetch_workflow', {
      action: 'start',
      goal: JSON.stringify({
        goal: 'x',
        explicitRequirements: [],
        implicitRequirements: [],
        constraints: [],
        deliverables: [],
        qualityTarget: 'high',
        acceptanceCriteria: [],
        unknowns: [],
      }),
    });
    expect(refused(noCriteria)).toBe(true);
    expect(body(noCriteria)).toContain('acceptance');
  });
});

describe('pro_fetch_workflow — the honest path', () => {
  it('walks start → plan → review → execute → verify → finish and lands on COMPLETED', async () => {
    const id = await startedWorkflow();

    const planned = await dispatch('pro_fetch_workflow', {
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({ tasks: [plannedTask('T001'), plannedTask('T002', OTHER_REAL_TOOL)] }),
    });
    expect(refused(planned)).toBe(false);
    expect(payload(planned).phase).toBe('AUDIT_REQUIRED');
    expect(payload(planned).tasks).toBe(2);

    const reviewed = payload(
      await dispatch('pro_fetch_workflow', {
        action: 'submit_review',
        workflow_id: id,
        findings: JSON.stringify([finding('F001')]),
      }),
    );
    expect(reviewed.phase).toBe('PLAN_READY');
    expect(reviewed.next_action).toBe('get_next_task');

    const next = payload(await dispatch('pro_fetch_workflow', { action: 'get_next_task', workflow_id: id }));
    expect(next.phase).toBe('EXECUTING');
    expect((next.task as { id: string }).id).toBe('T001');

    for (const task of ['T001', 'T002']) {
      const reported = await dispatch('pro_fetch_workflow', {
        action: 'report_task_result',
        workflow_id: id,
        task_id: task,
        task_status: 'verified',
        evidence: `${task}: ran the planned tool, 3 results, checked by hand`,
      });
      expect(refused(reported)).toBe(false);
    }

    const verified = payload(await dispatch('pro_fetch_workflow', { action: 'verify', workflow_id: id }));
    expect(verified.eligible_to_finish).toBe(true);
    expect(verified.next_action).toBe('finish');

    const done = payload(await dispatch('pro_fetch_workflow', { action: 'finish', workflow_id: id }));
    expect(done.phase).toBe('COMPLETED');
    expect(done.completed).toBe(true);
    expect(done.evidence).toBe(2);

    const status = payload(await dispatch('pro_fetch_workflow', { action: 'status', workflow_id: id }));
    expect(status.verified).toBe(2);
    expect(status.total_tasks).toBe(2);
  });

  it('persists the run so a later call in a fresh read sees the same phase', async () => {
    const id = await startedWorkflow();
    await dispatch('pro_fetch_workflow', {
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({ tasks: [plannedTask('T001')] }),
    });
    const stored = JSON.parse(await readFile(path.join(dir, 'workflows', `${id}.json`), 'utf8')) as {
      phase: string;
      plan: { tasks: unknown[] };
    };
    expect(stored.phase).toBe('AUDIT_REQUIRED');
    expect(stored.plan.tasks).toHaveLength(1);

    const status = payload(await dispatch('pro_fetch_workflow', { action: 'status', workflow_id: id }));
    expect(status.phase).toBe('AUDIT_REQUIRED');
  });
});

describe('pro_fetch_workflow — refusals', () => {
  it('rejects a plan whose tool plan names a tool the registry does not have', async () => {
    const id = await startedWorkflow();
    const res = await dispatch('pro_fetch_workflow', {
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({ tasks: [plannedTask('T001', 'pro_fetch_totally_made_up')] }),
    });
    expect(refused(res)).toBe(true);
    expect(body(res)).toContain('registry');
  });

  it('rejects a plan with no acceptance criteria or no verification method', async () => {
    const id = await startedWorkflow();
    const bad = plannedTask('T001');
    bad.acceptanceCriteria = [];
    const res = await dispatch('pro_fetch_workflow', {
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({ tasks: [bad] }),
    });
    expect(refused(res)).toBe(true);
    expect(body(res)).toContain('acceptance');
  });

  it('refuses a "verified" result that carries no evidence', async () => {
    const id = await startedWorkflow();
    await dispatch('pro_fetch_workflow', {
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({ tasks: [plannedTask('T001')] }),
    });
    await dispatch('pro_fetch_workflow', {
      action: 'submit_review',
      workflow_id: id,
      findings: JSON.stringify([finding('F001')]),
    });
    await dispatch('pro_fetch_workflow', { action: 'get_next_task', workflow_id: id });

    const fakePass = await dispatch('pro_fetch_workflow', {
      action: 'report_task_result',
      workflow_id: id,
      task_id: 'T001',
      task_status: 'verified',
      evidence: '   ',
    });
    expect(refused(fakePass)).toBe(true);
    expect(body(fakePass)).toContain('evidence');

    // The refusal must not have written the status either.
    const status = payload(await dispatch('pro_fetch_workflow', { action: 'status', workflow_id: id }));
    expect(status.verified).toBe(0);
  });

  it('keeps finish out of reach while a blocking finding is open', async () => {
    const id = await startedWorkflow();
    await dispatch('pro_fetch_workflow', {
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({ tasks: [plannedTask('T001')] }),
    });
    const reviewed = payload(
      await dispatch('pro_fetch_workflow', {
        action: 'submit_review',
        workflow_id: id,
        findings: JSON.stringify([finding('F001', { blocking: true })]),
      }),
    );
    expect(reviewed.phase).toBe('REVISION_REQUIRED');

    // Execution cannot start from REVISION_REQUIRED, and finish cannot be reached at all.
    expect(refused(await dispatch('pro_fetch_workflow', { action: 'get_next_task', workflow_id: id }))).toBe(true);
    expect(refused(await dispatch('pro_fetch_workflow', { action: 'verify', workflow_id: id }))).toBe(true);
    const finished = await dispatch('pro_fetch_workflow', { action: 'finish', workflow_id: id });
    expect(refused(finished)).toBe(true);
    expect(body(finished)).toContain('blocking');
  });

  it('refuses an out-of-order phase move in both directions', async () => {
    const id = await startedWorkflow();
    // submit_plan twice: the second one arrives in AUDIT_REQUIRED.
    const plan = JSON.stringify({ tasks: [plannedTask('T001')] });
    expect(refused(await dispatch('pro_fetch_workflow', { action: 'submit_plan', workflow_id: id, plan }))).toBe(false);
    const again = await dispatch('pro_fetch_workflow', { action: 'submit_plan', workflow_id: id, plan });
    expect(refused(again)).toBe(true);
    expect(body(again)).toContain('PLANNING');

    // finish before verify.
    await dispatch('pro_fetch_workflow', {
      action: 'submit_review',
      workflow_id: id,
      findings: JSON.stringify([finding('F001')]),
    });
    await dispatch('pro_fetch_workflow', { action: 'get_next_task', workflow_id: id });
    await dispatch('pro_fetch_workflow', {
      action: 'report_task_result',
      workflow_id: id,
      task_id: 'T001',
      task_status: 'verified',
      evidence: 'checked the output line by line',
    });
    const early = await dispatch('pro_fetch_workflow', { action: 'finish', workflow_id: id });
    expect(refused(early)).toBe(true);
    expect(body(early)).toContain('VERIFYING');
  });

  it('refuses an unknown workflow id, an unknown action and an unknown task id', async () => {
    expect(refused(await dispatch('pro_fetch_workflow', { action: 'status', workflow_id: 'wf-nope' }))).toBe(true);
    expect(refused(await dispatch('pro_fetch_workflow', { action: 'do_everything' }))).toBe(true);

    const id = await startedWorkflow();
    expect(
      refused(
        await dispatch('pro_fetch_workflow', {
          action: 'report_task_result',
          workflow_id: id,
          task_id: 'T999',
          task_status: 'failed',
        }),
      ),
    ).toBe(true);
  });

  it('refuses properties the schema never declared', async () => {
    const res = await dispatch('pro_fetch_workflow', {
      action: 'introduce',
      definitely_not_a_field: true,
    } as unknown as Record<string, unknown>);
    expect(refused(res)).toBe(true);
  });
});

describe('pro_fetch_workflow — the detail knob is implemented', () => {
  it('summary projects the next task, full returns the whole record', async () => {
    const id = await startedWorkflow();
    await dispatch('pro_fetch_workflow', {
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({ tasks: [plannedTask('T001')] }),
    });
    await dispatch('pro_fetch_workflow', {
      action: 'submit_review',
      workflow_id: id,
      findings: JSON.stringify([finding('F001')]),
    });

    const summary = payload(await dispatch('pro_fetch_workflow', { action: 'get_next_task', workflow_id: id }));
    const brief = summary.task as Record<string, unknown>;
    expect(brief.id).toBe('T001');
    expect(brief.acceptanceCriteria).toBeUndefined();
    expect(Array.isArray(brief.tools)).toBe(true);
    expect((brief.tools as string[])[0]).toBe(REAL_TOOL);

    const full = payload(
      await dispatch('pro_fetch_workflow', { action: 'get_next_task', workflow_id: id, detail: 'full' }),
    );
    const whole = full.task as Record<string, unknown>;
    expect(Array.isArray(whole.acceptanceCriteria)).toBe(true);
    expect(whole.verification).toBeDefined();
    expect(JSON.stringify(full).length).toBeGreaterThan(JSON.stringify(summary).length);
  });

  it('status and finish stay small by default and only expand on request', async () => {
    const id = await startedWorkflow();
    await dispatch('pro_fetch_workflow', {
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({ tasks: [plannedTask('T001')] }),
    });

    const summaryStatus = payload(await dispatch('pro_fetch_workflow', { action: 'status', workflow_id: id }));
    expect(summaryStatus.tasks).toBeUndefined();
    expect(summaryStatus.total_tasks).toBe(1);

    const fullStatus = payload(
      await dispatch('pro_fetch_workflow', { action: 'status', workflow_id: id, detail: 'full' }),
    );
    expect((fullStatus.tasks as Array<Record<string, unknown>>)[0].id).toBe('T001');
  });

  it('every smart-profile tool still declares the detail enum', () => {
    for (const name of ['pro_fetch_workflow']) {
      const tool = allTools().find((entry) => entry.name === name);
      const detail = (tool?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined)?.detail;
      expect(detail?.enum).toEqual(['summary', 'full']);
    }
  });
});

describe('pro_fetch_workflow — secrets do not reach disk', () => {
  it('redacts credential-shaped evidence before the workflow file is written', async () => {
    const id = await startedWorkflow();
    await dispatch('pro_fetch_workflow', {
      action: 'submit_plan',
      workflow_id: id,
      plan: JSON.stringify({ tasks: [plannedTask('T001')] }),
    });
    await dispatch('pro_fetch_workflow', {
      action: 'submit_review',
      workflow_id: id,
      findings: JSON.stringify([finding('F001')]),
    });
    await dispatch('pro_fetch_workflow', { action: 'get_next_task', workflow_id: id });
    await dispatch('pro_fetch_workflow', {
      action: 'report_task_result',
      workflow_id: id,
      task_id: 'T001',
      task_status: 'verified',
      evidence: 'called the endpoint with token: hunter2-hunter2 and it returned 200',
    });

    const raw = await readFile(path.join(dir, 'workflows', `${id}.json`), 'utf8');
    expect(raw).toContain('[REDACTED]');
    expect(raw).not.toContain('hunter2-hunter2');
  });
});

describe('pro_fetch_workflow — fixture sanity', () => {
  it('plans tools that exist in the live registry', () => {
    // When a fixture name goes stale, validatePlan refuses the plan and every downstream assertion
    // fails for a reason that has nothing to do with the controller.
    const names = new Set(allTools().map((tool) => tool.name));
    expect(names.has(REAL_TOOL), REAL_TOOL).toBe(true);
    expect(names.has(OTHER_REAL_TOOL), OTHER_REAL_TOOL).toBe(true);
  });
});
