/**
 * Shared helpers for driving the Bigfoot audit disclosure from tests.
 *
 * Spec §5.3 makes the auditor dispose of every risk item the plan actually raises — as a finding, or
 * as a dismissal with a reason. Tests that are not *about* that gate still have to get past it, and a
 * test that hard-codes the item list would pass even if the derivation broke: the whole point of the
 * gate is that the list comes from the plan. So the list is read back from the audit response and the
 * items nobody raised a finding about are dismissed with an explicit reason.
 */

type ToolResultLike = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

/** Parse the JSON payload the controller wraps its answers in. */
export function auditPayload(result: ToolResultLike): Record<string, unknown> {
  const raw = (result.content ?? []).map((item) => item.text ?? '').join('\n');
  return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as Record<string, unknown>;
}

export const bodyOf = (result: ToolResultLike): string =>
  (result.content ?? []).map((item) => item.text ?? '').join(' ');

export const refusedResult = (result: ToolResultLike): boolean => result.isError === true;

/** Items the audit handed out that no finding in this submission covers. */
export function uncoveredRisks(checklist: Array<{ item: string }>, findings: Array<{ riskItem?: string }>): string[] {
  const covered = new Set(
    findings.map((entry) => entry.riskItem).filter((item): item is string => typeof item === 'string'),
  );
  return checklist.map((entry) => entry.item).filter((item) => !covered.has(item));
}

/**
 * Open the plan to the auditor and file the review, dismissing every risk item no finding covers.
 *
 * Returns the parsed `submit_review` answer. The dismissal reason is deliberately specific: an empty
 * or generic one is what the gate refuses, so the helper has to satisfy the rule it is stepping over.
 */
export async function disclosePlan(
  invoke: (args: Record<string, unknown>) => Promise<ToolResultLike>,
  workflowId: string,
  findings: Array<Record<string, unknown>>,
  options: { reason?: string; stage?: string } = {},
): Promise<{
  review: Record<string, unknown>;
  opened: Record<string, unknown>;
  checklist: Array<{ item: string; because: string }>;
}> {
  const opened = auditPayload(await invoke({ action: 'begin_audit', workflow_id: workflowId, stage: 'full' }));
  const checklist = (opened.risk_checklist ?? []) as Array<{ item: string; because: string }>;
  const dismiss = uncoveredRisks(checklist, findings as Array<{ riskItem?: string }>).map((item) => ({
    item,
    reason: options.reason ?? `reviewed and dismissed: no evidence this plan is exposed (${item})`,
  }));
  const reviewResult = await invoke({
    action: 'submit_review',
    workflow_id: workflowId,
    stage: options.stage ?? 'full',
    findings: JSON.stringify(findings),
    ...(dismiss.length ? { dismissed_risks: JSON.stringify(dismiss) } : {}),
  });
  return { review: auditPayload(reviewResult), opened, checklist };
}
