/**
 * The shipped host adapters must be the instruction the server actually serves.
 *
 * §15.2 says each agent gets its own adapter; §15.4 says the server cannot force the host to use it.
 * The one thing that is in our control is that the shipped text and the served text are the same
 * bytes — a stale adapter telling an agent to call actions that no longer exist is worse than no
 * adapter, and hand-copied files drift the moment either side changes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import '../src/loader.js';
import { dispatch } from '../src/core/tool.js';
import { HOST_INSTRUCTION } from '../src/tools/workflow/workflow.js';
import { HOSTS, renderAdapter, renderReadme } from '../src/core/workflow/adapters.js';

describe('host adapters (§15.2)', () => {
  it('ships one adapter per documented host', () => {
    expect(HOSTS.length).toBeGreaterThanOrEqual(4);
    for (const host of HOSTS) {
      const onDisk = readFileSync(`adapters/${host.file}`, 'utf8');
      expect(onDisk, host.file).toBe(renderAdapter(host));
      expect(onDisk, host.file).toContain(HOST_INSTRUCTION);
      expect(onDisk, host.file).toContain('pro_fetch_workflow');
    }
  });

  it('the index matches the renderer', () => {
    expect(readFileSync('adapters/README.md', 'utf8')).toBe(renderReadme());
  });

  it('states the boundary it cannot promise across (§15.4)', () => {
    const readme = renderReadme();
    expect(readme).toContain('cannot be');
    expect(readme).toContain('not guaranteed');
    // The adapters must not oversell: the enforcement list and the limits list both ship.
    const adapter = renderAdapter(HOSTS[0]);
    expect(adapter).toContain('What the server enforces');
    expect(adapter).toContain('What it cannot guarantee');
    expect(adapter).toContain('cannot see or steer');
  });
});

describe('introduce carries the same instruction', () => {
  it('serves the shipped text, not a copy of it', async () => {
    const result = await dispatch('pro_fetch_workflow', { action: 'introduce' });
    const raw = (result.content ?? []).map((item) => item.text ?? '').join('');
    const payload = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as Record<string, unknown>;
    expect(payload.host_instruction).toBe(HOST_INSTRUCTION);
    expect((payload.enforced as unknown[]).length).toBeGreaterThan(4);
    expect((payload.not_guaranteed as unknown[]).length).toBeGreaterThan(2);
  });
});
