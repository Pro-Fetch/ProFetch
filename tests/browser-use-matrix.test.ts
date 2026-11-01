import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderEngineSupportMatrix } from '../src/core/browser-use-matrix.js';
import { ALL_CAPABILITIES, CAPABILITY_PROFILES } from '../src/core/browser-use-capabilities.js';

/**
 * The support matrix is the document people will quote in issues, and this repository has already
 * been burned twice by prose that drifted from the registry — a README claiming 42 categories while
 * listing 25, an ARCHITECTURE.md still saying 672 tools after the count moved. Both were fixed by
 * comparing the document to a manifest. This one is compared to its generator, which is stronger:
 * there is no second number to keep in sync.
 */
describe('the support matrix cannot drift from the profiles', () => {
  const committed = readFileSync('docs/browser-use/ENGINE_SUPPORT_MATRIX.md', 'utf8');

  it('matches the renderer byte for byte', () => {
    expect(committed).toBe(renderEngineSupportMatrix());
  });

  it('has a row for every product and a column entry for every capability', () => {
    const products = Object.keys(CAPABILITY_PROFILES);
    for (const product of products)
      expect(committed).toContain(`| \`${product}\` | ${CAPABILITY_PROFILES[product].engine} |`);
    for (const capability of ALL_CAPABILITIES) expect(committed).toContain(`| \`${capability}\` |`);
  });

  it('states its own provenance so nobody hand-edits it', () => {
    expect(committed).toContain('npm run gen:browser-matrix');
    expect(committed).toContain('Do not edit by hand');
  });

  it('does not claim anything is verified before Phase 4 has run', () => {
    // The document asserts this in prose; the assertion is checked against the data as well, so the
    // sentence cannot survive a status change that nobody noticed.
    const claimed = products().filter((p) =>
      CAPABILITY_PROFILES[p].answers.some((a) => a.status === 'VERIFIED_NATIVE' || a.status === 'VERIFIED_MANAGED'),
    );
    expect(claimed).toEqual([]);
    expect(committed).toContain('No cell in this revision is `Y*`');
  });
});

function products(): string[] {
  return Object.keys(CAPABILITY_PROFILES);
}
