import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Single source of truth for the package version.
 *
 * Read from `package.json` at runtime instead of hard-coded literals, because a hard-coded
 * string silently goes stale (the User-Agent and the MCP `serverInfo` previously disagreed with
 * `package.json`). Resolution walks up from this module so it works for both `src/` (tsx) and
 * `dist/` (compiled) layouts. Falls back to `unknown` rather than throwing: a missing version
 * must never stop the server from booting.
 */
function readManifestField(field: 'name' | 'version'): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // `src/core/` and `dist/core/` are both exactly two levels below the package root.
  const manifest = path.resolve(here, '..', '..', 'package.json');
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
    const value = parsed[field];
    if (typeof value === 'string' && value) return value;
  } catch {
    // Fall through: a missing manifest must not stop the server from booting.
  }
  return 'unknown';
}

function readName(): string {
  return readManifestField('name');
}

function readVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // `src/core/` and `dist/core/` are both exactly two levels below the package root.
  const manifest = path.resolve(here, '..', '..', 'package.json');
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown };
    if (typeof parsed.name === 'string' && parsed.name && typeof parsed.version === 'string' && parsed.version) {
      return parsed.version;
    }
  } catch {
    // Fall through to the fallback below.
  }
  return 'unknown';
}

/**
 * The published package name, read from the same manifest as the version.
 *
 * It used to be hard-coded in the version guard and in the User-Agent, which meant renaming the
 * package silently turned `VERSION` into `unknown` and left the User-Agent claiming the old name.
 * Deriving both from `package.json` makes a rename a one-line change instead of a trap.
 */
export const PACKAGE_NAME: string = readName();

export const VERSION: string = readVersion();

/**
 * The product token for the User-Agent header.
 *
 * A scoped package name is not a legal HTTP product token: `@` and a second `/` are both outside
 * RFC 7231's token grammar, so `@pro-fetch/mcp/1.0.0` would be read by a strict parser as a product
 * named `@pro-fetch` at version `mcp`. The scope is flattened into the token instead — the header
 * still names the package, in the one alphabet HTTP allows.
 */
export const UA_PRODUCT: string = PACKAGE_NAME.replace(/^@/, '').replace(/\//g, '-');

/** User-Agent sent with every outbound request made by this server. */
export const USER_AGENT: string = `${UA_PRODUCT}/${VERSION}`;
