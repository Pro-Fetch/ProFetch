/**
 * Certificate verification is not something a host environment may turn off quietly.
 *
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` is exported by the desktop application that spawns MCP servers on this
 * machine, and it is inherited by every server started from that environment. Left alone, it makes every
 * HTTPS request pro-fetch makes accept any certificate — a fact no tool result would ever show. These cases
 * pin the correction, the explicit opt-in, and the silence when nothing was disabled.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

async function boot(env: Record<string, string | undefined>): Promise<{ value: string | undefined; stderr: string }> {
  for (const [key, value] of Object.entries({
    NODE_TLS_REJECT_UNAUTHORIZED: undefined,
    PRO_FETCH_ALLOW_INSECURE_TLS: undefined,
    ...env,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.join(' '));
  });
  vi.resetModules();
  try {
    await import('../src/env.js');
  } finally {
    spy.mockRestore();
  }
  return { value: process.env.NODE_TLS_REJECT_UNAUTHORIZED, stderr: lines.join('\n') };
}

afterEach(() => {
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete process.env.PRO_FETCH_ALLOW_INSECURE_TLS;
  vi.resetModules();
});

describe('booting with an inherited TLS setting', () => {
  it('turns verification back on when the host disabled it, and says so', async () => {
    const booted = await boot({ NODE_TLS_REJECT_UNAUTHORIZED: '0' });
    expect(booted.value).toBe('1');
    expect(booted.stderr).toContain('qayta yoqildi');
    // The message names the escape hatch, so an operator who needs the old behaviour is not left guessing.
    expect(booted.stderr).toContain('PRO_FETCH_ALLOW_INSECURE_TLS=true');
  });

  it('honours an explicit opt-in but warns on every boot', async () => {
    const booted = await boot({ NODE_TLS_REJECT_UNAUTHORIZED: '0', PRO_FETCH_ALLOW_INSECURE_TLS: 'true' });
    expect(booted.value).toBe('0');
    expect(booted.stderr).toContain('OGOHLANTIRISH');
    expect(booted.stderr).toContain('tekshirilmaydi');
  });

  it('leaves a healthy environment alone and stays quiet', async () => {
    const booted = await boot({});
    expect(booted.value).toBeUndefined();
    expect(booted.stderr).toBe('');
    const explicit = await boot({ NODE_TLS_REJECT_UNAUTHORIZED: '1' });
    expect(explicit.value).toBe('1');
    expect(explicit.stderr).toBe('');
  });

  it('treats the other insecure spelling as the same fault', async () => {
    const booted = await boot({ NODE_TLS_REJECT_UNAUTHORIZED: 'FALSE' });
    expect(booted.value).toBe('1');
  });
});
