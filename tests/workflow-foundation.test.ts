/**
 * Foundation tests for the Bigfoot workflow layer: the durable store (atomic write, redaction, id
 * safety) and the state machine (legal/illegal transitions, honest completion gate). These run offline
 * against a temp directory — no network, no host AI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveWorkflow, loadWorkflow, listWorkflows, deleteWorkflow, redact } from '../src/core/workflow/store.js';
import { createWorkflow, transition, canTransition, completionEligible } from '../src/core/workflow/state-machine.js';
import type { GoalSpec, Task, WorkflowState } from '../src/core/workflow/types.js';

const ORIGINAL = { ...process.env };
let dir = '';

const goal: GoalSpec = {
  goal: 'test goal',
  explicitRequirements: ['a'],
  implicitRequirements: [],
  constraints: [],
  deliverables: [],
  qualityTarget: 'high',
  acceptanceCriteria: ['done verified'],
  unknowns: [],
};

function task(id: string, status: Task['status'], dependsOn: string[] = []): Task {
  return {
    id,
    objective: id,
    priority: 'medium',
    dependsOn,
    deliverables: [],
    toolPlan: [],
    acceptanceCriteria: ['x'],
    // The fixture goal declares E1 + A1; the completion gate re-checks coverage (§5.2).
    covers: ['E1', 'A1'],
    verification: { method: 'test', evidenceRequired: true },
    status,
    attempts: 0,
    evidenceRefs: [],
    blockers: [],
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'pf-wf-'));
  process.env.PRO_FETCH_WORKFLOW_DIR = dir;
});

afterEach(async () => {
  process.env = { ...ORIGINAL };
  await rm(dir, { recursive: true, force: true });
});

describe('state machine', () => {
  it('createWorkflow starts in NEW with seeded history', () => {
    const w = createWorkflow('wf1', goal);
    expect(w.phase).toBe('NEW');
    expect(w.revision).toBe(0);
    expect(w.history.length).toBe(1);
  });

  it('allows the legal happy path and records each move', () => {
    let w = createWorkflow('wf2', goal);
    for (const to of [
      'PLANNING',
      'AUDIT_REQUIRED',
      'PLAN_READY',
      'EXECUTING',
      'VERIFYING',
      'FINAL_AUDIT',
      'COMPLETED',
    ] as const) {
      w = transition(w, to, `→${to}`);
    }
    expect(w.phase).toBe('COMPLETED');
    expect(w.revision).toBe(7);
    expect(w.history.at(-1)?.to).toBe('COMPLETED');
  });

  it('rejects illegal transitions (no skipping straight to done/execution)', () => {
    const w = createWorkflow('wf3', goal);
    expect(canTransition('NEW', 'COMPLETED')).toBe(false);
    expect(() => transition(w, 'COMPLETED', 'cheat')).toThrow(/Noto‘g‘ri/);
    // A run driven to PLAN_READY still cannot jump to COMPLETED (must pass EXECUTING/VERIFYING).
    let ready = transition(w, 'PLANNING', 'p');
    ready = transition(ready, 'AUDIT_REQUIRED', 'a');
    ready = transition(ready, 'PLAN_READY', 'r');
    expect(ready.phase).toBe('PLAN_READY');
    expect(canTransition(ready.phase, 'COMPLETED')).toBe(false);
    expect(canTransition(ready.phase, 'EXECUTING')).toBe(true);
  });

  it('completionEligible is honest: empty plan / unverified task / open blocking finding all block', () => {
    let w = createWorkflow('wf4', goal);
    w = transition(w, 'PLANNING', 'p');
    w = transition(w, 'AUDIT_REQUIRED', 'a');
    w = transition(w, 'PLAN_READY', 'r');
    w = transition(w, 'EXECUTING', 'e');
    expect(completionEligible(w).ok).toBe(false); // plan empty

    w.plan = { tasks: [task('T1', 'verified')], risks: [], verificationStrategy: 'test' };
    // A full-mode run is only eligible once the independent completion audit has been passed (§12.3).
    w = transition(w, 'VERIFYING', 'v');
    w = transition(w, 'FINAL_AUDIT', 'fa');
    expect(completionEligible(w).ok).toBe(true);

    w.findings = [
      {
        id: 'F1',
        severity: 'high',
        relatedRequirementIds: [],
        description: 'd',
        evidence: 'e',
        whyItMatters: 'w',
        requiredAction: 'a',
        acceptanceCriteria: [],
        confidence: 0.9,
        blocking: true,
        status: 'open',
      },
    ];
    expect(completionEligible(w).ok).toBe(false);
    w.findings[0].status = 'resolved';
    expect(completionEligible(w).ok).toBe(true);
  });
});

describe('durable store', () => {
  it('round-trips a workflow through disk', async () => {
    const w = createWorkflow('rt1', goal);
    await saveWorkflow(w);
    const loaded = await loadWorkflow('rt1');
    expect(loaded?.id).toBe('rt1');
    expect(loaded?.phase).toBe('NEW');
    expect(await listWorkflows()).toContain('rt1');
    await deleteWorkflow('rt1');
    expect(await loadWorkflow('rt1')).toBeNull();
  });

  it('writes valid JSON atomically (file parses)', async () => {
    await saveWorkflow(createWorkflow('atom1', goal));
    const raw = await readFile(path.join(dir, 'workflows', 'atom1.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('redacts credential-shaped strings before they hit disk', async () => {
    const w = createWorkflow('red1', goal);
    w.evidence = [
      { id: 'ev1', taskId: 'T1', summary: 'used token=SECRET_ABC and https://user:PASS@example.com', redacted: true },
    ];
    await saveWorkflow(w);
    const raw = await readFile(path.join(dir, 'workflows', 'red1.json'), 'utf8');
    expect(raw).not.toContain('SECRET_ABC');
    expect(raw).not.toContain('PASS@');
    expect(raw).toContain('[REDACTED]');
    const loaded = await loadWorkflow('red1');
    expect(loaded?.evidence[0].summary).toContain('[REDACTED]');
  });

  it('rejects unsafe workflow ids (no path traversal)', async () => {
    const bad = {
      id: '../evil',
      createdAt: 0,
      updatedAt: 0,
      revision: 0,
      phase: 'NEW',
      mode: 'full',
      goal,
      plan: null,
      findings: [],
      evidence: [],
      history: [],
    } as WorkflowState;
    await expect(saveWorkflow(bad)).rejects.toThrow(/yaroqsiz workflow id/);
  });

  it('redact() leaves normal text untouched', () => {
    expect(redact('plain summary of the change')).toBe('plain summary of the change');
  });
});
