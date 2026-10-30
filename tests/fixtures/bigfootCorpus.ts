/**
 * A labelled corpus for the Bigfoot gates.
 *
 * Until now the benchmark asserted that specific cases fail — which answers "does this gate catch
 * the example I wrote a test for", not "how good is this gate". Ground truth is the missing piece:
 * each case here carries the verdict a careful human reviewer would give (`defect` with the rule
 * that must fire, or `clean`), so the suite can compute recall, false-positive rate and F1 instead
 * of a pass/fail count.
 *
 * Keeping it as data (not as 19 tests) is deliberate: adding a case is adding a row, and the metric
 * is recomputed over the whole set on every run.
 */

import type { GoalSpec, Task } from '../../src/core/workflow/types.js';

/** Five requirements plus one unknown: E1, C1, D1, A1, A2, U1. */
export const CORPUS_GOAL: GoalSpec = {
  goal: 'publish a measured dashboard',
  explicitRequirements: ['collect the numbers'],
  implicitRequirements: [],
  constraints: ['no new runtime dependency'],
  deliverables: ['dashboard.html'],
  qualityTarget: 'high',
  acceptanceCriteria: ['opens in a browser', 'numbers match the source'],
  unknowns: ['is the upstream paginated?'],
};

export const ALL_REQUIREMENTS = ['E1', 'C1', 'D1', 'A1', 'A2'];

const READ_TOOL = 'pro_fetch_fetch_url';
const OTHER_READ_TOOL = 'pro_fetch_web_search';
const WRITE_TOOL = 'pro_fetch_cache_put';

const categoryOf = (name: string): string =>
  ({ [READ_TOOL]: 'http', [OTHER_READ_TOOL]: 'search', [WRITE_TOOL]: 'archive' })[name] ?? 'http';

function step(toolName: string, sensitivity: 'read_only' | 'mutating', extra: Record<string, unknown> = {}) {
  return {
    toolName,
    category: categoryOf(toolName),
    purpose: `use ${toolName}`,
    sensitivity,
    requiresApproval: sensitivity !== 'read_only',
    ...extra,
  };
}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    objective: `objective ${id}`,
    priority: 'medium',
    dependsOn: [],
    deliverables: [],
    toolPlan: [step(READ_TOOL, 'read_only')],
    acceptanceCriteria: [`${id} produced a number`],
    verification: { method: 're-run and compare', evidenceRequired: true },
    covers: ALL_REQUIREMENTS,
    status: 'pending',
    attempts: 0,
    evidenceRefs: [],
    blockers: [],
    ...over,
  } as Task;
}

export interface PlanCase {
  /** Ground truth: was this plan acceptable? */
  label: 'defect' | 'clean';
  name: string;
  /** For defects: the rule that must refuse it. */
  expect?: string;
  tasks: unknown;
}

/**
 * Ten defects and four legitimate plans. The clean cases exist to measure the cost of an eager gate:
 * a checker that refuses everything scores perfect recall and is useless.
 */
export const PLAN_CASES: PlanCase[] = [
  {
    label: 'defect',
    name: 'requirement left unmapped',
    expect: 'qoplanmagan',
    tasks: [task('T001', { covers: ['E1', 'C1', 'D1', 'A1'] })],
  },
  {
    label: 'defect',
    name: 'invented requirement id',
    expect: 'task_covers_unknown',
    tasks: [task('T001', { covers: ['Z9'] })],
  },
  {
    label: 'defect',
    name: 'tool that is not in the registry',
    expect: 'registry',
    tasks: [task('T001', { toolPlan: [step('pro_fetch_totally_made_up', 'read_only')] })],
  },
  {
    label: 'defect',
    name: 'task with no acceptance criteria',
    expect: 'task_acceptance_missing',
    tasks: [task('T001', { acceptanceCriteria: [] })],
  },
  {
    label: 'defect',
    name: 'task with no verification method',
    expect: 'task_verification_missing',
    tasks: [task('T001', { verification: { method: '', evidenceRequired: true } })],
  },
  {
    label: 'defect',
    name: 'dependency cycle',
    expect: 'task_cycle',
    tasks: [task('T001', { dependsOn: ['T001'] })],
  },
  {
    label: 'defect',
    name: 'task carrying no requirement',
    expect: 'task_out_of_scope',
    tasks: [task('T001', { covers: ['E1', 'C1', 'D1', 'A1', 'A2'] }), task('T002', { covers: [] })],
  },
  {
    label: 'defect',
    name: 'same objective twice',
    expect: 'task_duplicate_objective',
    tasks: [task('T001'), task('T002', { objective: 'objective T001', covers: ALL_REQUIREMENTS })],
  },
  {
    label: 'defect',
    name: 'same tools for the same requirements',
    expect: 'task_duplicate_toolplan',
    tasks: [task('T001', { objective: 'first' }), task('T002', { objective: 'second' })],
  },
  {
    label: 'defect',
    name: 'mutating step labelled read_only',
    expect: 'risk_understated',
    tasks: [task('T001', { toolPlan: [step(WRITE_TOOL, 'read_only')] })],
  },
  { label: 'defect', name: 'plan is not a task array', expect: 'massiv', tasks: { tasks: { id: 'T001' } } },
  { label: 'clean', name: 'one task carrying every requirement', tasks: [task('T001')] },
  {
    label: 'clean',
    name: 'same tool, different requirements',
    tasks: [task('T001', { covers: ['E1', 'C1', 'D1'] }), task('T002', { objective: 'b', covers: ['A1', 'A2'] })],
  },
  {
    label: 'clean',
    name: 'chained dependencies',
    tasks: [
      task('T001', { covers: ['E1', 'C1'] }),
      task('T002', { objective: 'b', dependsOn: ['T001'], covers: ['D1', 'A1', 'A2'] }),
    ],
  },
  {
    label: 'clean',
    name: 'multi-step plan with a fallback and declared arguments',
    tasks: [
      task('T001', {
        toolPlan: [
          step(OTHER_READ_TOOL, 'read_only', { fallback: READ_TOOL }),
          step(READ_TOOL, 'read_only', { arguments: { url: 'https://example.com/data' } }),
        ],
      }),
    ],
  },
];

export interface CompletionCase {
  /** Ground truth: should this run be allowed to say COMPLETED? */
  label: 'complete' | 'incomplete';
  name: string;
  /** For incomplete runs: the blocker that must be named. */
  expect: string;
  /** How to get the run into that state. */
  setup: 'clean' | 'mock-only' | 'unknown-open' | 'blocking-finding' | 'unmapped-after-edit';
}

/**
 * The fake-completion half of the corpus: a run that looks finished and must not be, plus the one
 * that genuinely is.
 */
export const COMPLETION_CASES: CompletionCase[] = [
  { label: 'complete', name: 'everything verified with evidence', expect: '', setup: 'clean' },
  { label: 'incomplete', name: 'only mocked', expect: 'mock_verified', setup: 'mock-only' },
  { label: 'incomplete', name: 'unknown left open', expect: 'unknown', setup: 'unknown-open' },
  { label: 'incomplete', name: 'blocking objection open', expect: 'blocking finding', setup: 'blocking-finding' },
  { label: 'incomplete', name: 'coverage dropped on disk', expect: 'qoplanmagan', setup: 'unmapped-after-edit' },
];
