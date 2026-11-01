import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { renderEngineSupportMatrix } from '../src/core/browser-use-matrix.js';
import { ALL_CAPABILITIES, CAPABILITY_PROFILES } from '../src/core/browser-use-capabilities.js';
import { VERIFIED } from '../src/core/browser-use-verified.js';

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

  it('backs every Y* with a verified fact whose artifact actually exists', () => {
    // Phase 4 turned "nothing has been run" into a claim that needs checking. A `Y*` is now allowed —
    // but only where the overlay records a run, and only while the artifact that run wrote is still on
    // disk. Delete the evidence and the claim stops being true, which is the point.
    const missing = VERIFIED.filter((f) => !existsSync(f.evidence)).map(
      (f) => `${f.product}.${f.capability} → ${f.evidence}`,
    );
    expect(missing, 'a verified fact without its artifact is not verified').toEqual([]);
    expect(VERIFIED.length).toBeGreaterThan(0);
  });

  it('keeps the profiles themselves free of verified statuses', () => {
    // A run is a fact about a host, so it belongs in the overlay — not baked into a profile, where it
    // would travel to a Linux box and be quoted as though it had been checked there.
    const baked = products().filter((p) =>
      CAPABILITY_PROFILES[p].answers.some((a) => a.status === 'VERIFIED_NATIVE' || a.status === 'VERIFIED_MANAGED'),
    );
    expect(baked).toEqual([]);
  });

  it('lists each verified fact with the artifact that produced it', () => {
    for (const f of VERIFIED) {
      expect(committed).toContain(`\`${f.product} · ${f.capability} · ${f.os}\``);
      expect(committed).toContain(f.evidence);
    }
  });
});

function products(): string[] {
  return Object.keys(CAPABILITY_PROFILES);
}
