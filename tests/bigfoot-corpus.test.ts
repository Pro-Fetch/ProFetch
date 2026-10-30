/**
 * Gate quality measured against ground truth, not against itself.
 *
 * Every case in `fixtures/bigfootCorpus.ts` carries the verdict a careful reviewer would give. This
 * file runs the gates over them and reports recall, false-positive rate and F1 — the numbers §20.2
 * and §20.5 ask for. A gate that refuses everything scores recall 1.0 and precision 0, and that is
 * the failure mode a pass/fail test count cannot see.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../src/loader.js';
import { dispatch } from '../src/core/tool.js';
import { disclosePlan } from './helpers/bigfootAudit.js';
import { COMPLETION_CASES, CORPUS_GOAL, PLAN_CASES, type CompletionCase } from './fixtures/bigfootCorpus.js';
import type { WorkflowState } from '../src/core/workflow/types.js';

const ORIGINAL = { ...process.env };
let dir = '';

beforeEach(async () => {
  process.env.PRO_FETCH_PROFILE = 'full';
  dir = await mkdtemp(path.join(tmpdir(), `pf-corpus-${Date.now()}-`));
  process.env.PRO_FETCH_WORKFLOW_DIR = dir;
});

afterEach(async () => {
  process.env = { ...ORIGINAL };
  if (dir) await rm(dir, { recursive: true, force: true });
});

const call = (args: Record<string, unknown>) => dispatch('pro_fetch_workflow', args);

const bodyOf = (result: Awaited<ReturnType<typeof call>>): string =>
  (result.content ?? []).map((item) => item.text ?? '').join(' ');

const jsonOf = (result: Awaited<ReturnType<typeof call>>): Record<string, unknown> => {
  const raw = bodyOf(result);
  return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as Record<string, unknown>;
};

async function startedCorpusRun(): Promise<string> {
  return String(jsonOf(await call({ action: 'start', goal: JSON.stringify(CORPUS_GOAL) })).workflow_id);
}

/** Close the goal's unknown the honest way: a recorded source, then a resolution citing it. */
async function closeUnknown(id: string): Promise<void> {
  const source = jsonOf(
    await call({
      action: 'record_source',
      workflow_id: id,
      reference: 'https://upstream.example/docs#pagination',
      reliability: 'confirmed',
      observation: 'the endpoint returns at most 1000 rows and has no pagination',
      relates_to: 'U1',
    }),
  );
  await call({
    action: 'resolve_unknown',
    workflow_id: id,
    unknown_id: 'U1',
    verdict: 'resolved',
    note: 'docs checked against the live endpoint',
    source_ids: String(source.source_id),
  });
}

/** Drive a labelled completion case up to the point where `finish` is asked. */
async function buildRun(setup: CompletionCase['setup']): Promise<string> {
  const id = await startedCorpusRun();
  const tasks = [
    {
      id: 'T001',
      objective: 'collect the numbers',
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
      acceptanceCriteria: ['a number was read'],
      verification: { method: 're-run', evidenceRequired: true },
      covers: ['E1', 'C1', 'D1', 'A1', 'A2'],
      status: 'pending',
      attempts: 0,
      evidenceRefs: [],
      blockers: [],
    },
  ];
  await call({ action: 'submit_plan', workflow_id: id, plan: JSON.stringify({ tasks }) });
  const blocking = setup === 'blocking-finding';
  await disclosePlan(
    call,
    id,
    blocking
      ? [
          {
            id: 'F001',
            severity: 'critical',
            relatedRequirementIds: ['E1'],
            description: 'the collection step has no fallback and no declared resource',
            evidence: 'plan reviewed against the registry: pro_fetch_fetch_url with no fallback',
            whyItMatters: 'a single upstream failure leaves the dashboard with no numbers',
            requiredAction: 'add a fallback source',
            acceptanceCriteria: ['a fallback is declared'],
            confidence: 0.9,
            classification: 'must_fix',
            blocking: true,
            status: 'open',
          },
        ]
      : [],
  );
  if (blocking) return id;

  if (setup !== 'mock-only') {
    await call({ action: 'get_next_task', workflow_id: id });
    await call({
      action: 'report_task_result',
      workflow_id: id,
      task_id: 'T001',
      task_status: 'verified',
      verification_type: 'integration',
      evidence: 're-ran twice and compared the payloads',
    });
  } else {
    await call({ action: 'get_next_task', workflow_id: id });
    await call({
      action: 'report_task_result',
      workflow_id: id,
      task_id: 'T001',
      task_status: 'mock_verified',
      verification_type: 'unit',
      evidence: 'mocked upstream returned the fixture payload',
    });
  }

  if (setup !== 'unknown-open') await closeUnknown(id);

  await call({ action: 'verify', workflow_id: id });
  await call({ action: 'final_audit', workflow_id: id, note: 'each criterion checked against the ledger' });

  if (setup === 'unmapped-after-edit') {
    // Exactly the shape a stored run could have: coverage removed after the plan gate passed.
    const file = path.join(dir, 'workflows', `${id}.json`);
    const stored = JSON.parse(await readFile(file, 'utf8')) as WorkflowState;
    stored.plan!.tasks[0].covers = [];
    await writeFile(file, JSON.stringify(stored), 'utf8');
  }
  return id;
}

describe('bigfoot corpus — plan gates against labelled truth (§20.2)', () => {
  const defects = PLAN_CASES.filter((entry) => entry.label === 'defect');
  const clean = PLAN_CASES.filter((entry) => entry.label === 'clean');

  it('computes recall, false-positive rate and F1 over the corpus', async () => {
    let caught = 0;
    const missed: string[] = [];
    const wrongRule: string[] = [];
    for (const entry of defects) {
      const id = await startedCorpusRun();
      const res = await call({ action: 'submit_plan', workflow_id: id, plan: JSON.stringify({ tasks: entry.tasks }) });
      if (!res.isError) missed.push(entry.name);
      // Case-insensitive: rule names are matched, not the sentence casing they arrive in.
      else if (entry.expect && !bodyOf(res).toLowerCase().includes(entry.expect.toLowerCase()))
        wrongRule.push(`${entry.name} → ${bodyOf(res).slice(0, 60)}`);
      else caught += 1;
    }

    let falseRefusals = 0;
    const refusedClean: string[] = [];
    for (const entry of clean) {
      const id = await startedCorpusRun();
      const res = await call({ action: 'submit_plan', workflow_id: id, plan: JSON.stringify({ tasks: entry.tasks }) });
      if (res.isError) {
        falseRefusals += 1;
        refusedClean.push(`${entry.name} → ${bodyOf(res).slice(0, 90)}`);
      }
    }

    const recall = caught / defects.length;
    const precision = defects.length / (defects.length + falseRefusals);
    const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
    console.log(
      `corpus(plan): recall=${recall.toFixed(2)} precision=${precision.toFixed(2)} f1=${f1.toFixed(2)} ` +
        `(${caught}/${defects.length} defects caught, ${falseRefusals}/${clean.length} clean refused)`,
    );
    expect(missed, `defects that passed: ${missed.join('; ')}`).toEqual([]);
    expect(wrongRule, `refused, but not by the rule that should have caught them`).toEqual([]);
    expect(refusedClean, `legitimate plans refused`).toEqual([]);
    expect(f1).toBe(1);
  });
});

describe('bigfoot corpus — completion gates against labelled truth (§20.3)', () => {
  it('reports the fake-completion rate the gates allowed', async () => {
    let allowedWrongly = 0;
    let refusedRightly = 0;
    const wrongBlockers: string[] = [];
    let completed = 0;

    for (const entry of COMPLETION_CASES) {
      const id = await buildRun(entry.setup);
      const res = await call({ action: 'finish', workflow_id: id });
      const refused = res.isError === true;
      if (entry.label === 'incomplete') {
        if (!refused) allowedWrongly += 1;
        else if (!bodyOf(res).includes(entry.expect))
          wrongBlockers.push(`${entry.name} → ${bodyOf(res).slice(0, 120)}`);
        else refusedRightly += 1;
      } else {
        if (refused) wrongBlockers.push(`${entry.name} should have completed: ${bodyOf(res).slice(0, 160)}`);
        else completed += 1;
      }
    }

    const incomplete = COMPLETION_CASES.filter((entry) => entry.label === 'incomplete').length;
    const fakeRate = allowedWrongly / incomplete;
    console.log(
      `corpus(completion): fake_completion_rate=${fakeRate.toFixed(2)} ` +
        `(${refusedRightly}/${incomplete} incomplete runs refused, ${completed} complete run accepted)`,
    );
    expect(allowedWrongly).toBe(0);
    expect(wrongBlockers).toEqual([]);
    expect(completed).toBe(1);
  });
});
