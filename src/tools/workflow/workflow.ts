/**
 * pro_fetch_workflow — the single Bigfoot controller.
 *
 * One action-based MCP tool drives the whole lifecycle (MexaPlan → SmartToDo → MaxEffort) so the host
 * AI is not handed a pile of workflow tools. The reasoning is the host's; this tool is the stateful
 * referee: it persists the run, validates every submission against the real registry, and refuses to
 * advance the state machine through an illegal move or to mark work complete without evidence.
 *
 * `introduce` is the onboarding funnel: it returns a short orientation and points the host at `start`,
 * so the first thing a connecting agent sees is "what Pro-Fetch is and how to use it", not 672 raw tools.
 */

import { defineTool } from '../../core/tool.js';
import { allTools } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { strOrEmpty, view } from '../../core/input.js';
import { detailMode } from '../../core/composite-budget.js';
import { createWorkflow, transition, completionEligible, canTransition } from '../../core/workflow/state-machine.js';
import { saveWorkflow, loadWorkflow } from '../../core/workflow/store.js';
import { validateGoalSpec, validatePlan, validateFinding } from '../../core/workflow/validate.js';
import type { Finding, GoalSpec, Task, WorkflowMode, WorkflowState } from '../../core/workflow/types.js';

const knownToolNames = (): ReadonlySet<string> => new Set(allTools().map((t) => t.name));

/** Task projection used under `detail: "summary"` — enough to act on, without the full criteria text. */
const briefTask = (t: Task) => ({
  id: t.id,
  objective: t.objective,
  priority: t.priority,
  status: t.status,
  tools: t.toolPlan.map((plan) => plan.toolName),
  depends_on: t.dependsOn,
});

const INTRO = [
  'Pro-Fetch: web fetch, crawl, search, deep research, GitHub, PDF/Office/image, data tools.',
  'For substantial work, run the workflow: start → submit_plan (MexaPlan) → submit_review (SmartToDo)',
  '→ get_next_task/report_task_result (MaxEffort) → verify → finish. Completion requires evidence.',
].join(' ');

function err(issues: { code: string; message: string }[]): string {
  return issues.map((i) => `${i.code}: ${i.message}`).join('; ');
}

async function requireWorkflow(id: string): Promise<WorkflowState | null> {
  if (!id) return null;
  return loadWorkflow(id);
}

export default defineTool({
  name: 'pro_fetch_workflow',
  description:
    'Bigfoot ish-oqimi kontrolleri (bitta tool). action: introduce | start | submit_plan | submit_review | ' +
    'get_next_task | report_task_result | verify | finish | status. MexaPlan→SmartToDo→MaxEffort hayot siklini ' +
    'boshqaradi; holat diskda saqlanadi; noqonuniy o‘tish va dalilsiz "tayyor" rad etiladi.',
  category: 'admin',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'introduce|start|submit_plan|submit_review|get_next_task|report_task_result|verify|finish|status',
      },
      workflow_id: {
        type: 'string',
        description: 'start javobidagi id (introduce/startdan tashqari barcha actionlar)',
      },
      goal: { type: 'string', description: 'start: foydalanuvchi maqsadi (GoalSpec JSON matni yoki oddiy satr)' },
      mode: { type: 'string', description: 'start: full|lite|direct (standart full)' },
      plan: { type: 'string', description: 'submit_plan: {tasks:[...]} JSON matni' },
      findings: { type: 'string', description: 'submit_review: [finding,...] JSON matni' },
      task_id: { type: 'string', description: 'report_task_result: task id' },
      task_status: { type: 'string', description: 'report_task_result: verified|needs_verification|failed|blocked' },
      evidence: { type: 'string', description: 'report_task_result: dalil matni (tokenlar avtomatik yashiriladi)' },
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

    if (action === 'introduce') {
      return jsonBlock('Pro-Fetch workflow — tanishuv', {
        intro: INTRO,
        next_action: 'start',
        ...(detail === 'full'
          ? { phases: ['NEW', 'PLANNING', 'AUDIT_REQUIRED', 'PLAN_READY', 'EXECUTING', 'VERIFYING', 'COMPLETED'] }
          : {}),
      });
    }

    if (action === 'start') {
      const rawGoal = strOrEmpty(p, 'goal');
      if (!rawGoal) return fail('start uchun goal kerak.');
      let goal: GoalSpec;
      try {
        goal = rawGoal.trim().startsWith('{')
          ? (JSON.parse(rawGoal) as GoalSpec)
          : {
              goal: rawGoal,
              explicitRequirements: [],
              implicitRequirements: [],
              constraints: [],
              deliverables: [],
              qualityTarget: 'high',
              acceptanceCriteria: [rawGoal],
              unknowns: [],
            };
      } catch {
        return fail('goal JSON matni noto‘g‘ri.');
      }
      const gIssues = validateGoalSpec(goal);
      if (gIssues.length) return fail(`GoalSpec yaroqsiz — ${err(gIssues)}`);
      const mode = (
        ['full', 'lite', 'direct'].includes(strOrEmpty(p, 'mode')) ? strOrEmpty(p, 'mode') : 'full'
      ) as WorkflowMode;
      const id = `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      let state = createWorkflow(id, goal, mode);
      state = transition(state, 'PLANNING', 'start');
      await saveWorkflow(state);
      return jsonBlock('Workflow boshlandi', {
        workflow_id: id,
        phase: state.phase,
        next_action: 'submit_plan',
        ...(detail === 'full'
          ? {
              instruction:
                'MexaPlan: real registry tool nomlari bilan tasklar + acceptance criteria + verification yozib submit_plan qiling.',
            }
          : {}),
      });
    }

    const id = strOrEmpty(p, 'workflow_id');
    let state = await requireWorkflow(id);
    if (!state) return fail(`workflow_id topilmadi: ${id || '(bo‘sh)'}`);

    switch (action) {
      case 'submit_plan': {
        if (state.phase !== 'PLANNING') return fail(`submit_plan faqat PLANNING fazasida (hozir: ${state.phase}).`);
        let tasks: Task[];
        try {
          const parsed = JSON.parse(strOrEmpty(p, 'plan'));
          tasks = (Array.isArray(parsed) ? parsed : parsed.tasks) as Task[];
        } catch {
          return fail('plan JSON matni noto‘g‘ri.');
        }
        const { ok, issues } = validatePlan(tasks, knownToolNames());
        if (!ok) return fail(`Plan rad etildi — ${err(issues)}`);
        state.plan = { tasks, risks: [], verificationStrategy: 'per-task verification' };
        state = transition(state, 'AUDIT_REQUIRED', 'plan submitted');
        await saveWorkflow(state);
        return jsonBlock('Plan qabul qilindi', {
          workflow_id: id,
          phase: state.phase,
          tasks: tasks.length,
          next_action: 'submit_review',
          ...(detail === 'full' ? { plan: tasks } : {}),
        });
      }

      case 'submit_review': {
        if (state.phase !== 'AUDIT_REQUIRED')
          return fail(`submit_review faqat AUDIT_REQUIRED fazasida (hozir: ${state.phase}).`);
        let findings: Finding[];
        try {
          findings = JSON.parse(strOrEmpty(p, 'findings')) as Finding[];
        } catch {
          return fail('findings JSON matni noto‘g‘ri.');
        }
        if (!Array.isArray(findings)) return fail('findings massiv bo‘lishi kerak.');
        for (const f of findings) {
          const fi = validateFinding(f);
          if (fi.length) return fail(`finding ${f?.id} yaroqsiz — ${err(fi)}`);
        }
        state.findings.push(...findings);
        const blockingOpen = findings.some((f) => f.blocking && f.status === 'open');
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
          next_action: blockingOpen ? 'revise_plan' : 'get_next_task',
          ...(detail === 'full'
            ? {
                findings: findings.map((f) => ({
                  id: f.id,
                  severity: f.severity,
                  blocking: f.blocking,
                  status: f.status,
                })),
              }
            : {}),
        });
      }

      case 'get_next_task': {
        if (state.phase === 'PLAN_READY' && canTransition('PLAN_READY', 'EXECUTING')) {
          state = transition(state, 'EXECUTING', 'execution started');
          await saveWorkflow(state);
        }
        if (state.phase !== 'EXECUTING') return fail(`get_next_task faqat EXECUTING fazasida (hozir: ${state.phase}).`);
        const done = new Set((state.plan?.tasks ?? []).filter((t) => t.status === 'verified').map((t) => t.id));
        const next = (state.plan?.tasks ?? []).find(
          (t) => t.status !== 'verified' && t.dependsOn.every((d) => done.has(d)),
        );
        return jsonBlock('Keyingi vazifa', {
          workflow_id: id,
          phase: state.phase,
          task: next ? (detail === 'full' ? next : briefTask(next)) : null,
          remaining: (state.plan?.tasks ?? []).filter((t) => t.status !== 'verified').length,
        });
      }

      case 'report_task_result': {
        const t = (state.plan?.tasks ?? []).find((x) => x.id === strOrEmpty(p, 'task_id'));
        if (!t) return fail(`task topilmadi: ${strOrEmpty(p, 'task_id')}`);
        const st = strOrEmpty(p, 'task_status');
        if (!['verified', 'needs_verification', 'failed', 'blocked'].includes(st))
          return fail('task_status noto‘g‘ri.');
        if (st === 'verified' && !strOrEmpty(p, 'evidence').trim())
          return fail('verified uchun evidence shart (soxta PASS rad etiladi).');
        t.status = st as Task['status'];
        t.attempts += 1;
        const ev = strOrEmpty(p, 'evidence');
        if (ev) {
          state.evidence.push({ id: `ev-${state.evidence.length + 1}`, taskId: t.id, summary: ev, redacted: true });
          t.evidenceRefs.push(`ev-${state.evidence.length}`);
        }
        await saveWorkflow(state);
        const remaining = (state.plan?.tasks ?? []).filter((x) => x.status !== 'verified').length;
        const evidenceId = t.evidenceRefs[t.evidenceRefs.length - 1];
        return jsonBlock('Task natijasi qabul qilindi', {
          workflow_id: id,
          task_id: t.id,
          status: t.status,
          verified: (state.plan?.tasks ?? []).filter((x) => x.status === 'verified').length,
          next_action: remaining === 0 ? 'verify' : 'get_next_task',
          ...(detail === 'full' ? { evidence_id: evidenceId ?? null, remaining } : {}),
        });
      }

      case 'verify': {
        if (state.phase !== 'EXECUTING') return fail(`verify faqat EXECUTING fazasida (hozir: ${state.phase}).`);
        state = transition(state, 'VERIFYING', 'verification pass');
        await saveWorkflow(state);
        const elig = completionEligible(state);
        return jsonBlock('Tekshiruv', {
          workflow_id: id,
          phase: state.phase,
          eligible_to_finish: elig.ok,
          blockers: elig.blockers,
          next_action: elig.ok ? 'finish' : 'report_task_result',
          ...(detail === 'full' ? { tasks: (state.plan?.tasks ?? []).map(briefTask) } : {}),
        });
      }

      case 'finish': {
        const elig = completionEligible(state);
        if (!elig.ok)
          return fail(`COMPLETED bo‘la olmaydi (fake-completion bloklandi) — blockers: ${elig.blockers.join(' | ')}`);
        if (state.phase !== 'VERIFYING') return fail(`finish faqat VERIFYING fazasida (hozir: ${state.phase}).`);
        state = transition(state, 'COMPLETED', 'all verified');
        await saveWorkflow(state);
        return jsonBlock('Workflow yakunlandi', {
          workflow_id: id,
          phase: state.phase,
          evidence: state.evidence.length,
          completed: true,
          ...(detail === 'full'
            ? { evidence_records: state.evidence, tasks: (state.plan?.tasks ?? []).map(briefTask) }
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
          verified: tasks.filter((t) => t.status === 'verified').length,
          total_tasks: tasks.length,
          open_findings: state.findings.filter((f) => f.status === 'open').length,
          ...(detail === 'full'
            ? {
                tasks: tasks.map(briefTask),
                findings: state.findings.map((f) => ({
                  id: f.id,
                  severity: f.severity,
                  blocking: f.blocking,
                  status: f.status,
                })),
              }
            : {}),
        });
      }

      default:
        return fail(`noma'lum action: ${action}`);
    }
  },
});
