/**
 * Writer for `docs/browser-use/ENGINE_SUPPORT_MATRIX.md`.
 *
 * The rendering lives in `src/core/browser-use-matrix.ts` so the runtime can answer the same question
 * the document answers; this file only puts it on disk.
 */

import process from 'node:process';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

process.env.PRO_FETCH_PROFILE ??= 'full';

const { renderEngineSupportMatrix } = await import('../src/core/browser-use-matrix.js');
const target = path.join(process.cwd(), 'docs', 'browser-use', 'ENGINE_SUPPORT_MATRIX.md');
await writeFile(target, renderEngineSupportMatrix(), 'utf8');
console.log(`WROTE ${target}`);
