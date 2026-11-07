import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Zero-dependency `.env` loader.
 *
 * Must be imported before any module that reads `process.env` (e.g. `./loader.js`), so this file
 * performs its work as a side effect at import time. It resolves `.env` next to the project root
 * (one level above this `src/` folder) so it works regardless of the current working directory the
 * MCP client spawns the server with.
 *
 * Precedence: values already present in the real environment (for example supplied by the MCP
 * client through `mcp.json`) are NEVER overwritten — the client config always wins, `.env` only
 * fills the gaps. Missing or unreadable `.env` is silently ignored so the server still boots.
 */
function loadEnvFile(): void {
  let raw: string;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const envPath = path.resolve(here, '..', '.env');
    raw = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    let key = trimmed.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice('export '.length).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

/**
 * A fetcher that does not check certificates is not a secure fetcher, whatever else it does.
 *
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` disables verification for the whole process, and it is inherited rather
 * than chosen: on this machine the desktop application that spawns MCP servers exports it, so every server
 * started from that environment — this one included — would silently accept any certificate. A caller cannot
 * see that in a tool result, so it is corrected here, at the earliest point of our own code, and reported.
 *
 * An operator who really needs unverified TLS says so explicitly with `PRO_FETCH_ALLOW_INSECURE_TLS=true`;
 * that path keeps the host's value and warns on every boot, because a debugging shortcut left set for a
 * month is exactly how a credential ends up on somebody else's proxy.
 */
function enforceTlsVerification(): void {
  const flag = (process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '').trim().toLowerCase();
  if (flag !== '0' && flag !== 'false') return;
  if (process.env.PRO_FETCH_ALLOW_INSECURE_TLS === 'true') {
    console.error(
      '[pro-fetch] OGOHLANTIRISH: NODE_TLS_REJECT_UNAUTHORIZED=' +
        flag +
        ' va PRO_FETCH_ALLOW_INSECURE_TLS=true — HTTPS sertifikatlari tekshirilmaydi. ' +
        'Bu faqat ishonchli lokal tarmoq uchun; boshqa har qanday joyda xavfsizlik buzilishi.',
    );
    return;
  }
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
  console.error(
    '[pro-fetch] muhit NODE_TLS_REJECT_UNAUTHORIZED=' +
      flag +
      ' edi — sertifikat tekshiruvi qayta yoqildi (1). ' +
      'Ataylab o‘chirish uchun: PRO_FETCH_ALLOW_INSECURE_TLS=true.',
  );
}

enforceTlsVerification();

export {};
