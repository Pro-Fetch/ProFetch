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

  it('only cites probe steps that passed in the artifact it names', () => {
    // The paragraph above stops a fact losing its file; this stops a fact losing its *meaning*. A run
    // log is a list of steps, and `ok: false` is a step that did not work. Pointing at a file without
    // checking the step inside it is how "we verified Chrome" survives a Chrome row that failed.
    const byArtifact = new Map<string, any>();
    for (const f of VERIFIED) {
      expect(existsSync(f.evidence), `missing artifact ${f.evidence}`).toBe(true);
      if (!byArtifact.has(f.evidence)) byArtifact.set(f.evidence, JSON.parse(readFileSync(f.evidence, 'utf8')));
      const run = byArtifact.get(f.evidence);
      const step = (run.results as any[]).find((r) => r.product === f.product && r.step === f.probeStep);
      expect(
        step,
        `${f.evidence} has no "${f.probeStep}" step for ${f.product} — the fact cites a step that never ran`,
      ).toBeTruthy();
      expect(step.ok, `${f.product}.${f.capability} cites ${f.probeStep}, which failed: ${step.detail}`).toBe(true);
    }
  });

  it('holds the claims the status document makes', () => {
    // The prose says: identity refuses a recycled element id, an overlay is seen through, a real DOM
    // groups, the model re-labels and navigates, and screenshots, input, console, network, dialogs,
    // downloads, uploads, cookies, storage, tabs, emulation and native attachment were driven. Here
    // those sentences are data, so a status change nobody noticed breaks a test instead of a reader.
    const artifacts = [...new Set(VERIFIED.map((f) => f.evidence))];
    expect(artifacts.length).toBeGreaterThan(0);
    const REQUIRED = [
      'launch',
      'navigate',
      'read',
      'geometry',
      'accessibility',
      'perceive',
      'stale-detection',
      'obstruction',
      'group',
      'world-model',
      'screenshot',
      'visual-diff',
      'coordinates',
      'input',
      'console',
      'network',
      'dialogs',
      'downloads',
      'uploads',
      'cookies',
      'storage',
      'tabs',
      'viewport',
      'device-scale',
      'attach-native',
      'frames',
      'annotate',
      'close',
    ];
    for (const path of artifacts) {
      const run = JSON.parse(readFileSync(path, 'utf8')) as {
        results: Array<{ product: string; step: string; ok: boolean; detail: string }>;
      };
      const all = [...new Set(run.results.map((r) => r.product))];
      expect(all.length, `${path} records no browser`).toBeGreaterThan(0);
      // A product that never launched has one honest failure and no steps to check. Demanding the rest
      // would turn "Safari cannot run on this host" into a missing-step error, which is a different claim.
      const driven = all.filter((product) =>
        run.results.some((r) => r.product === product && r.step === 'launch' && r.ok),
      );
      expect(driven.length, `${path} has no browser that launched`).toBeGreaterThan(0);
      const detailOf = (product: string, step: string): string =>
        run.results.find((r) => r.product === product && r.step === step)!.detail;
      for (const product of driven) {
        for (const step of REQUIRED) {
          const found = run.results.find((r) => r.product === product && r.step === step);
          expect(found, `${product}: ${step} never ran, so the claim about it is unsupported`).toBeTruthy();
          expect(found!.ok, `${product}.${step} failed: ${found!.detail}`).toBe(true);
        }
        expect(detailOf(product, 'stale-detection')).toMatch(/ID_RECYCLED/);
        expect(detailOf(product, 'obstruction')).toMatch(/hit-test at the centre returns a different element/);
        expect(detailOf(product, 'group')).toMatch(/groups \[list, form, navigation\]/);
        expect(detailOf(product, 'group')).toMatch(/every group evidenced/);
        expect(detailOf(product, 'world-model')).toMatch(/label change relabelled \(CHANGED\)/);
        expect(detailOf(product, 'world-model')).toMatch(/navigation voided \d+ identities/);
        expect(detailOf(product, 'world-model')).toMatch(/look-alike button refused/);
        expect(detailOf(product, 'screenshot')).toMatch(/blue in box \d+%\/\d+%/);
        expect(detailOf(product, 'visual-diff')).toMatch(/inside the mapped box/);
        expect(detailOf(product, 'coordinates')).toMatch(/refused/);
        expect(detailOf(product, 'input')).toMatch(/Enter logged "enter:hello"/);
        expect(detailOf(product, 'network')).toMatch(/nothing resolved on the network/);
        expect(detailOf(product, 'attach-native')).toMatch(/attached over CDP/);
        expect(detailOf(product, 'frames')).toMatch(/main>0@\d+,\d+/);
        expect(detailOf(product, 'frames')).toMatch(/lifted box [\d,]+ \d+x\d+ is \d+% blue/);
        expect(detailOf(product, 'frames')).toMatch(/boundaries: iframe /);
        expect(detailOf(product, 'annotate')).toMatch(/pixels written/);
        expect(detailOf(product, 'annotate')).toMatch(/0 outside the boxes/);
        expect(detailOf(product, 'annotate')).toMatch(/button blue intact/);
      }
    }
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
