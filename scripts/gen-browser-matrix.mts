/**
 * Writer for `docs/browser-use/ENGINE_SUPPORT_MATRIX.md`.
 *
 * The rendering lives in `src/core/browser-use-matrix.ts` so the runtime can answer the same question
 * the document answers; this file only puts it on disk.
 *
 * It renders against `EVIDENCE_OS` — the host the probe actually ran on — and not against whatever machine
 * executes it. An external audit on a Linux clone found the committed document impossible to reproduce:
 * verified rows are filtered by operating system, so a Linux generator rewrote every `Y*` into `p` and the
 * byte-for-byte drift test failed with no code change. A committed statement about a run has to be
 * reproducible anywhere; `pro_browser_use_capabilities_matrix` is the place that answers for the host it is
 * asked on.
 */

import process from 'node:process';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

process.env.PRO_FETCH_PROFILE ??= 'full';

const { renderEngineSupportMatrix } = await import('../src/core/browser-use-matrix.js');
const { EVIDENCE_OS } = await import('../src/core/browser-use-verified.js');
const target = path.join(process.cwd(), 'docs', 'browser-use', 'ENGINE_SUPPORT_MATRIX.md');
await writeFile(target, renderEngineSupportMatrix(EVIDENCE_OS), 'utf8');
console.log(`WROTE ${target} (as of ${EVIDENCE_OS})`);
