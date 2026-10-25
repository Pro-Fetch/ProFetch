/**
 * Durable store for Bigfoot workflow state.
 *
 * The existing `cache.ts` is in-memory only, so a workflow could not survive a host restart — which
 * breaks the "resume an unfinished workflow without falsely marking it complete" requirement. This is
 * a small, dependency-free JSON store on disk: one file per workflow, written atomically (temp file +
 * rename, so a crash mid-write cannot leave a half-written state), and secret-redacted before it ever
 * touches disk (a plan or evidence string must not leak a token into the workflow file).
 *
 * The directory honours PRO_FETCH_WORKFLOW_DIR, then PRO_FETCH_CACHE_DIR, then `.pro-fetch-cache`,
 * and refuses a filesystem root the same way output-dir.ts does — a workflow file must not be written
 * to `/` or a drive root.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowState } from './types.js';

/** The directory holding one `<id>.json` per workflow. Throws if the base resolves to a filesystem root. */
export function workflowsRoot(): string {
  const base = process.env.PRO_FETCH_WORKFLOW_DIR ?? process.env.PRO_FETCH_CACHE_DIR ?? '.pro-fetch-cache';
  const resolved = path.resolve(base);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root || parsed.root === resolved || /^[A-Za-z]:[\\/]*$/.test(resolved) || resolved === '/') {
    throw new Error('workflow directory filesystem root bo‘lishi mumkin emas');
  }
  return path.join(resolved, 'workflows');
}

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/((?:token|password|secret|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]'],
  [/((?:https?):\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._:-]+/gi, '$1 [REDACTED]'],
];

/** Redact credential-shaped substrings from a single string. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((acc, [re, rep]) => acc.replace(re, rep), text);
}

/** Walk a value and redact every string leaf, so structure (keys, JSON syntax) is never corrupted. */
function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = redactDeep(val);
    return out;
  }
  return value;
}

/** Workflow ids become file names, so they must be a safe slug — never a path or `..`. */
function safeId(id: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error(`yaroqsiz workflow id: ${JSON.stringify(id)}`);
  }
  return id;
}

function fileFor(id: string): string {
  return path.join(workflowsRoot(), `${safeId(id)}.json`);
}

/** Persist a workflow atomically with secrets redacted. Bumps `updatedAt`. */
export async function saveWorkflow(state: WorkflowState): Promise<void> {
  const dir = workflowsRoot();
  await mkdir(dir, { recursive: true });
  const file = fileFor(state.id);
  const tmp = `${file}.${process.pid}.tmp`;
  const toWrite: WorkflowState = { ...state, updatedAt: Date.now() };
  await writeFile(tmp, JSON.stringify(redactDeep(toWrite), null, 2), 'utf8');
  await rename(tmp, file);
}

/** Load a workflow, or null if it does not exist. Throws on a corrupt file (never silently empty). */
export async function loadWorkflow(id: string): Promise<WorkflowState | null> {
  let raw: string;
  try {
    raw = await readFile(fileFor(id), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(raw) as WorkflowState;
}

/** All stored workflow ids (unsorted). Empty when nothing has been persisted yet. */
export async function listWorkflows(): Promise<string[]> {
  try {
    const entries = await readdir(workflowsRoot());
    return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function deleteWorkflow(id: string): Promise<void> {
  await rm(fileFor(id), { force: true });
}
