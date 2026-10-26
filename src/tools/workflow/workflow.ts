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
import {
  createWorkflow,
  transition,
  completionEligible,
  canTransition,
  PHASES,
} from '../../core/workflow/state-machine.js';
import { saveWorkflow, loadWorkflow } from '../../core/workflow/store.js';
import { validateGoalSpec, validatePlan, validateFinding } from '../../core/workflow/validate.js';
import { assessPlan, pendingApprovals, riskIssues } from '../../core/workflow/risk.js';
import type { Finding, GoalSpec, Task, WorkflowMode, WorkflowState } from '../../core/workflow/types.js';

const knownToolNames = (): ReadonlySet<string> => new Set(allTools().map((t) => t.name));

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
    'revise_plan | resolve_finding | approve_plan | replan | block | unblock | get_next_task | ' +
    'report_task_result | verify | finish | status. MexaPlan→SmartToDo→MaxEffort hayot siklini boshqaradi; ' +
    'holat diskda saqlanadi; noqonuniy o‘tish, operator siyosatiga zid qadam va dalilsiz "tayyor" rad etiladi.',
  category: 'admin',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description:
          'introduce|start|submit_plan|submit_review|revise_plan|resolve_finding|approve_plan|replan|block|' +
          'unblock|get_next_task|report_task_result|verify|finish|status',
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
      finding_id: { type: 'string', description: 'resolve_finding: topilma id si' },
      resolution: {
        type: 'string',
        description: 'resolve_finding: topilma qanday tugatilgani haqidagi dalil (resolved uchun majburiy)',
      },
      verdict: { type: 'string', description: 'resolve_finding: resolved (standart) | rejected (asossiz deb topildi)' },
      reason: {
        type: 'string',
        description: 'revise_plan | replan | block: nima uchun qayta rejalanyotgani / to‘xtab qolgani sababi',
      },
      target: { type: 'string', description: 'unblock: qaytiladigan faza — PLANNING yoki EXECUTING' },
      note: {
        type: 'string',
        description: 'approve_plan: nima uchun ruxsat berilgani (majburiy — sababsiz tasdiq audit izi emas)',
      },
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
        ...(detail === 'full' ? { phases: PHASES } : {}),
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
        // The host's `sensitivity` label is a claim; the registry is the evidence. A plan that calls a
        // mutating tool `read_only` is refused here rather than waved through with an approval gate
        // that could be switched off by mislabelling.
        const risks = assessPlan(tasks);
        const riskProblems = riskIssues(risks);
        if (riskProblems.length) return fail(`Plan xavf bahosi bo‘yicha rad etildi — ${err(riskProblems)}`);
        const mutating = risks.filter((risk) => risk.mutating);
        const pending = pendingApprovals(tasks, risks);
        state.plan = {
          tasks,
          risks: mutating.map(
            (risk) => `${risk.taskId}: ${risk.toolName} — registry: mutating${risk.remote ? ' (tashqi tizim)' : ''}`,
          ),
          verificationStrategy: 'per-task verification',
        };
        state = transition(state, 'AUDIT_REQUIRED', 'plan submitted');
        await saveWorkflow(state);
        return jsonBlock('Plan qabul qilindi', {
          workflow_id: id,
          phase: state.phase,
          tasks: tasks.length,
          mutating_steps: mutating.length,
          approval_required: pending.length,
          next_action: 'submit_review',
          ...(detail === 'full' ? { plan: tasks, risky_steps: mutating } : {}),
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

      case 'revise_plan': {
        if (state.phase !== 'REVISION_REQUIRED')
          return fail(`revise_plan faqat REVISION_REQUIRED fazasida (hozir: ${state.phase}).`);
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
          instruction: 'Yangi plan submit_plan orqali keladi va ALBATTA qayta audit‘dan o‘tadi.',
        });
      }

      case 'resolve_finding': {
        const fid = strOrEmpty(p, 'finding_id');
        const f = state.findings.find((entry) => entry.id === fid);
        if (!f) return fail(`finding topilmadi: ${fid || '(bo‘sh)'}`);
        if (f.status !== 'open') return fail(`finding ${fid} allaqachon ${f.status}.`);
        const verdict = strOrEmpty(p, 'verdict') || 'resolved';
        if (!['resolved', 'rejected'].includes(verdict))
          return fail('verdict resolved yoki rejected bo‘lishi kerak (false_positive — reject deb yoziladi).');
        const note = strOrEmpty(p, 'resolution').trim();
        // A finding cannot be closed on words: `rejected` needs the reason it was baseless.
        if (!note) return fail(`${verdict} uchun resolution dalili kerak (topilmani yopish ham dalil talab qiladi).`);
        f.status = verdict as Finding['status'];
        f.resolution = { status: verdict as 'resolved' | 'rejected', note, at: Date.now() };
        const stillBlocking =
          state.phase === 'REVISION_REQUIRED' &&
          state.findings.some((entry) => entry.blocking && entry.status === 'open');
        if (state.phase === 'REVISION_REQUIRED' && !stillBlocking) {
          // Nothing blocks the plan any more, but the revised plan is not trusted: it is audited again.
          state = transition(state, 'AUDIT_REQUIRED', `findings yopildi: ${fid}`);
        }
        await saveWorkflow(state);
        return jsonBlock('Topilma yopildi', {
          workflow_id: id,
          finding_id: fid,
          status: f.status,
          phase: state.phase,
          open_blocking: state.findings.filter((entry) => entry.blocking && entry.status === 'open').length,
          next_action: stillBlocking
            ? 'resolve_finding'
            : state.phase === 'AUDIT_REQUIRED'
              ? 'submit_review'
              : 'status',
        });
      }

      case 'approve_plan': {
        const tasks = state.plan?.tasks ?? [];
        if (tasks.length === 0) return fail('approve_plan uchun avval submit_plan kerak (reja bo‘sh).');
        // Only an audited plan can be approved: approving before SmartToDo has looked at it would make
        // the gate a rubber stamp on an unreviewed plan.
        if (state.phase !== 'PLAN_READY')
          return fail(`approve_plan faqat PLAN_READY fazasida (hozir: ${state.phase}) — avval submit_review.`);
        const note = strOrEmpty(p, 'note').trim();
        if (!note) return fail('approve_plan uchun note kerak: sababsiz tasdiq audit izi emas.');
        const risks = assessPlan(tasks);
        const pending = pendingApprovals(tasks, risks);
        const wanted = strOrEmpty(p, 'task_id');
        if (wanted && !tasks.some((task) => task.id === wanted)) return fail(`task topilmadi: ${wanted}`);
        if (wanted && !pending.includes(wanted))
          return fail(`${wanted} uchun tasdiq shart emas (registry bu qadamni read-only deydi).`);
        const targets = wanted ? [wanted] : pending;
        const grantedAt = Date.now();
        for (const task of tasks) {
          if (targets.includes(task.id)) task.approval = { grantedAt, note };
        }
        await saveWorkflow(state);
        return jsonBlock('Reja tasdiqlandi', {
          workflow_id: id,
          phase: state.phase,
          approved: targets,
          pending_approvals: pendingApprovals(tasks, risks).length,
          next_action: pendingApprovals(tasks, risks).length ? 'approve_plan' : 'get_next_task',
        });
      }

      case 'replan': {
        if (state.phase !== 'EXECUTING' && state.phase !== 'VERIFYING')
          return fail(`replan EXECUTING yoki VERIFYING fazasida kerak (hozir: ${state.phase}).`);
        if (!strOrEmpty(p, 'reason').trim()) return fail('replan uchun reason kerak (nima yangi fakt chiqdi?).');
        state = transition(state, 'REPLANNING', `replan: ${strOrEmpty(p, 'reason').trim()}`);
        state = transition(state, 'PLANNING', 'new plan expected');
        await saveWorkflow(state);
        return jsonBlock('Qayta rejalash', {
          workflow_id: id,
          phase: state.phase,
          next_action: 'submit_plan',
          note: 'verified tasklar saqlanib qoladi; yangi plan qayta audit‘dan o‘tadi.',
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
        const target = strOrEmpty(p, 'target').toUpperCase();
        if (target !== 'PLANNING' && target !== 'EXECUTING')
          return fail('unblock uchun target PLANNING yoki EXECUTING bo‘lishi kerak.');
        if (target === 'EXECUTING') {
          const waiting = awaitingApproval(state);
          if (waiting.length)
            return fail(
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

      case 'get_next_task': {
        if (state.phase === 'PLAN_READY' && canTransition('PLAN_READY', 'EXECUTING')) {
          const waiting = awaitingApproval(state);
          if (waiting.length)
            return fail(
              `EXECUTING oldidan tasdiq kerak: ${waiting.join(', ')} yozish qadamlarini o‘z ichiga oladi — ` +
                `approve_plan (note bilan) chaqiring.`,
            );
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
          pending_approvals: awaitingApproval(state).length,
          next_action: elig.ok ? 'finish' : 'report_task_result',
          ...(detail === 'full'
            ? { tasks: (state.plan?.tasks ?? []).map(briefTask), risks: state.plan?.risks ?? [] }
            : {}),
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
          pending_approvals: awaitingApproval(state).length,
          ...(detail === 'full'
            ? {
                risks: state.plan?.risks ?? [],
                awaiting_approval: awaitingApproval(state),
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
