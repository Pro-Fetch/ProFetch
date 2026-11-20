/**
 * Loading the optional `better-sqlite3` driver — one place, because three modules need it.
 *
 * ## Why not `await import(specifier)`
 *
 * That is what all three call sites used, and it is what broke CI. The measured failure, from the
 * Actions annotations of run 44345633510: every gtfs and crawl-queue test on `Linux, Node v22.13.1` and
 * `Darwin, Node v22.13.1` died with
 * `Failed to load url better-sqlite3 (resolved id: better-sqlite3). Does the file exist?` — a resolver
 * error from Vitest's Vite layer, raised before any SQLite code ran. The same suite on Windows resolved
 * and ran, which is why this did not show up locally. It appeared with the move from better-sqlite3 11
 * (which ships only `main`) to 13.2.0 (which ships an `exports` map and bundles every platform's prebuild
 * under `build/Release/` instead of downloading one at install time).
 *
 * So the driver is taken through Node's own CommonJS resolver. That path exists in every runtime we can
 * observe — `require` is available in ESM through `createRequire`, and a package that ships CJS is exactly
 * what it is built for — and it removes the bundler's module graph from the question entirely.
 *
 * ## What is deliberately not claimed
 *
 * The precise line inside Vite that rejects the specifier has not been read, because the failure only
 * reproduces on a Linux/macOS runner. What is verified is the error text, the platforms it appears on,
 * the version it starts with, and that the CommonJS path works here.
 *
 * ## Degrading, not crashing
 *
 * The driver stays an optional dependency. A host without it — a slim container, a failed install — gets a
 * message naming the module, the fix command, and the underlying error, instead of a native stack trace at
 * import time. `src/tools/gtfs/_gtfs.ts`, `src/core/crawl-queue.ts` and `src/core/local-index.ts` each
 * wrap this with their own wording.
 */
import { createRequire } from 'node:module';

/** The constructor shape every caller needs; the callers know what their rows look like, not this file. */
export type SqliteConstructor = new (file: string) => unknown;

const requireFromHere = createRequire(import.meta.url);

/**
 * The driver's constructor, or a rejection carrying the driver's own error.
 *
 * better-sqlite3 is CommonJS: `require` returns the constructor directly. The `default` branch is kept
 * because a transpiled or interop layer in between would otherwise surface as "not a constructor" with no
 * clue where the function went.
 */
export async function requireSqliteDriver(): Promise<SqliteConstructor> {
  const mod = requireFromHere('better-sqlite3') as SqliteConstructor | { default?: SqliteConstructor };
  if (typeof mod === 'function') return mod;
  const nested = (mod as { default?: unknown }).default;
  if (typeof nested === 'function') return nested as SqliteConstructor;
  throw new Error('better-sqlite3 yuklandi, lekin eksport qilingan narsa funksiya emas');
}
