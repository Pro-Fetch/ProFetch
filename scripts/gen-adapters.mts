// Write the host adapter files from the single rendered source. See src/core/workflow/adapters.ts.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

process.env.PRO_FETCH_PROFILE ??= 'full';
await import('../src/loader.js');
const { HOSTS, renderAdapter, renderReadme } = await import('../src/core/workflow/adapters.js');

const root = path.join(process.cwd(), 'adapters');
await mkdir(root, { recursive: true });
for (const host of HOSTS) await writeFile(path.join(root, host.file), renderAdapter(host), 'utf8');
await writeFile(path.join(root, 'README.md'), renderReadme(), 'utf8');
console.log(`WROTE adapters/: ${HOSTS.length} host files + README.md`);
