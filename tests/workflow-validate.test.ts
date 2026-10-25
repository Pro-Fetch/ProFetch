/** Tests for the deterministic workflow validators: DAG cycles, duplicate/missing deps, the
 *  "no fabricated tool names" rule, and the acceptance-criteria requirement. */

import { describe, it, expect } from 'vitest';
import {
  validateGoalSpec,
  validateTasks,
  validateToolPlan,
  validateFinding,
  validatePlan,
  findDependencyCycles,
} from '../src/core/workflow/validate.js';
import type { Finding, GoalSpec, Task, ToolPlan } from '../src/core/workflow/types.js';

const goal = (over: Partial<GoalSpec> = {}): GoalSpec => ({
  goal: 'g',
  explicitRequirements: [],
  implicitRequirements: [],
  constraints: [],
  deliverables: [],
  qualityTarget: 'high',
  acceptanceCriteria: ['ok'],
  unknowns: [],
  ...over,
});

const plan = (toolName: string): ToolPlan => ({
  toolName,
  category: 'x',
  purpose: 'p',
  sensitivity: 'read_only',
  requiresApproval: false,
});

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  objective: id,
  priority: 'medium',
  dependsOn: [],
  deliverables: [],
  toolPlan: [],
  acceptanceCriteria: ['ac'],
  verification: { method: 'test', evidenceRequired: true },
  status: 'pending',
  attempts: 0,
  evidenceRefs: [],
  blockers: [],
  ...over,
});

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('goal + finding validation', () => {
  it('flags a goal with no acceptance criteria', () => {
    expect(codes(validateGoalSpec(goal({ acceptanceCriteria: [] })))).toContain('acceptance_missing');
    expect(validateGoalSpec(goal())).toEqual([]);
  });
  it('requires evidence on a finding', () => {
    const f = {
      id: 'F1',
      severity: 'high',
      relatedRequirementIds: [],
      description: 'd',
      evidence: '',
      whyItMatters: 'w',
      requiredAction: '',
      acceptanceCriteria: [],
      confidence: 1,
      blocking: true,
      status: 'open',
    } as Finding;
    const issues = codes(validateFinding(f));
    expect(issues).toContain('finding_evidence_missing');
    expect(issues).toContain('finding_action_missing');
  });
});

describe('task graph validation', () => {
  it('accepts a clean DAG', () => {
    const tasks = [task('A'), task('B', { dependsOn: ['A'] }), task('C', { dependsOn: ['A', 'B'] })];
    expect(validateTasks(tasks)).toEqual([]);
    expect(findDependencyCycles(tasks)).toEqual([]);
  });
  it('detects duplicate ids and missing dependencies', () => {
    const tasks = [task('A'), task('A'), task('B', { dependsOn: ['nope'] })];
    const c = codes(validateTasks(tasks));
    expect(c).toContain('task_id_dup');
    expect(c).toContain('task_dep_missing');
  });
  it('detects a dependency cycle', () => {
    const tasks = [task('A', { dependsOn: ['B'] }), task('B', { dependsOn: ['A'] })];
    expect(codes(validateTasks(tasks))).toContain('task_cycle');
    expect(findDependencyCycles(tasks).length).toBeGreaterThan(0);
  });
  it('rejects a task with no acceptance criteria (unmeasurable)', () => {
    expect(codes(validateTasks([task('A', { acceptanceCriteria: [] })]))).toContain('task_acceptance_missing');
  });
});

describe('tool-plan resolution against the real registry', () => {
  const known = new Set(['pro_fetch_fetch_url', 'pro_gh_repo_info']);
  it('accepts a real tool name', () => {
    const tasks = [task('A', { toolPlan: [plan('pro_fetch_fetch_url')] })];
    expect(validateToolPlan(tasks, known)).toEqual([]);
  });
  it('rejects a fabricated tool name', () => {
    const tasks = [task('A', { toolPlan: [plan('pro_make_it_up_tool')] })];
    expect(codes(validateToolPlan(tasks, known))).toContain('toolplan_unknown');
  });
  it('validatePlan combines task-graph and tool-plan checks', () => {
    const bad = validatePlan([task('A', { toolPlan: [plan('ghost')] })], known);
    expect(bad.ok).toBe(false);
    expect(codes(bad.issues)).toContain('toolplan_unknown');
  });
});
