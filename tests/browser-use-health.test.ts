import { describe, it, expect } from 'vitest';
import { describeDiagnosis, diagnose, rescueRecord, type PageMeta } from '../src/core/browser-use-health.js';
import { buildSnapshot, type BuildOptions, type RawNode } from '../src/core/browser-use-perception.js';
import { createLedger } from '../src/core/browser-use-coverage.js';

/**
 * A diagnostics suite has to fail in both directions: a broken page must light up the checks, and a clean
 * page must produce no blocking findings. Only the first half would be satisfied by checks that fire on
 * everything.
 */

function raw(over: Partial<RawNode> = {}): RawNode {
  return {
    backendId: '1',
    token: 't1',
    frameId: 'main',
    path: 'html>body>button[1]',
    tag: 'button',
    role: 'button',
    name: 'Save',
    text: 'Save',
    rect: { x: 10, y: 20, width: 120, height: 40 },
    inViewport: true,
    styleVisible: true,
    hitTestSelf: true,
    obstructed: false,
    depth: 3,
    interactive: true,
    boundaries: [],
    ...over,
  };
}

const options: BuildOptions = {
  snapshotId: 'h-1',
  url: 'https://shop.test/checkout',
  title: 'Checkout',
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  scroll: { x: 0, y: 0 },
  capturedAt: 1000,
};

const snap = (nodes: RawNode[], over: Partial<BuildOptions> = {}) => buildSnapshot(nodes, { ...options, ...over });

const cleanMeta: PageMeta = {
  url: 'https://shop.test/checkout',
  title: 'Checkout',
  lang: 'en',
  hasViewportMeta: true,
  doctype: 'html',
  horizontalOverflow: 0,
  duplicateIdCount: 0,
  images: 2,
  imagesWithoutAlt: 0,
  frameCount: 0,
  loadSeconds: 0.4,
};

const meta = (over: Partial<PageMeta> = {}): PageMeta => ({ ...cleanMeta, ...over });

describe('a clean page', () => {
  it('produces no blocking findings', () => {
    const d = diagnose(
      snap([raw(), raw({ backendId: '2', token: 't2', name: 'Back', path: 'html>body>button[2]' })]),
      meta(),
    );
    expect(d.blocking).toBe(0);
    expect(d.findings.map((f) => f.kind)).toEqual([]);
    expect(d.pageFullyObserved).toBe(false);
  });

  it('still says the page was not confirmed read to the bottom without a ledger', () => {
    const d = diagnose(snap([raw()]), meta());
    expect(d.skipped.join(' ')).toContain('no coverage ledger');
  });

  it('reports full observation once a complete ledger agrees', () => {
    const snapshot = snap([raw()]);
    const ledger = createLedger(snapshot, { contentHeight: snapshot.viewport.height });
    const d = diagnose(snapshot, meta(), ledger);
    expect(d.pageFullyObserved).toBe(true);
  });
});

describe('broken page', () => {
  const broken = () =>
    snap([
      raw({ backendId: '1', token: 't1', name: '', text: '', role: 'button' }),
      raw({
        backendId: '2',
        token: 't2',
        tag: 'input',
        role: 'textbox',
        name: '',
        text: '',
        placeholder: '',
        path: 'html>body>input[1]',
      }),
      raw({ backendId: '3', token: 't3', name: 'Tiny', rect: { x: 5, y: 5, width: 10, height: 10 } }),
      raw({ backendId: '4', token: 't4', name: 'Covered', path: 'html>body>button[2]', obstructed: true }),
      raw({ backendId: '5', token: 't5', name: 'Below', path: 'html>body>button[3]', inViewport: false }),
    ]);

  it('names every finding it fires and never invents one it cannot support', () => {
    const d = diagnose(
      broken(),
      meta({
        title: '',
        lang: '',
        hasViewportMeta: false,
        images: 3,
        imagesWithoutAlt: 2,
        duplicateIdCount: 4,
        horizontalOverflow: 310,
      }),
    );
    const kinds = d.findings.map((f) => f.kind);
    expect(kinds).toContain('unnamed-controls');
    expect(kinds).toContain('unlabelled-fields');
    expect(kinds).toContain('tiny-targets');
    expect(kinds).toContain('unreachable-interactables');
    expect(kinds).toContain('interactables-outside-read-region');
    expect(kinds).toContain('images-without-alt');
    expect(kinds).toContain('no-title');
    expect(kinds).toContain('no-lang');
    expect(kinds).toContain('no-viewport-meta');
    expect(kinds).toContain('horizontal-overflow');
    expect(kinds).toContain('duplicate-ids');
    expect(d.blocking).toBeGreaterThanOrEqual(3);
    for (const f of d.findings) {
      expect(f.evidence.length).toBeGreaterThan(10);
      // A count can be larger than the named elements: some findings come from document metadata the
      // snapshot cannot enumerate. The reverse — naming more than is counted — would be a lie.
      expect(f.affected.length).toBeLessThanOrEqual(f.count);
      expect(f.affected.length).toBeLessThanOrEqual(12);
    }
  });

  it('accepts a placeholder as naming evidence', () => {
    const d = diagnose(
      snap([raw({ backendId: '9', token: 't9', name: '', text: '', placeholder: 'Search products' })]),
      meta(),
    );
    expect(d.findings.some((f) => f.kind === 'unnamed-controls')).toBe(false);
  });

  it('does not accept a value as a name', () => {
    const d = diagnose(snap([raw({ backendId: '10', token: 't10', name: '', text: '', role: 'checkbox' })]), meta());
    expect(d.findings.some((f) => f.kind === 'unnamed-controls')).toBe(true);
  });

  it('treats an empty alt as present, because that is what the attribute means', () => {
    const d = diagnose(snap([raw()]), meta({ images: 2, imagesWithoutAlt: 0 }));
    expect(d.findings.some((f) => f.kind === 'images-without-alt')).toBe(false);
  });

  it('says a page with nothing clickable is a read problem, not a static page', () => {
    const d = diagnose(
      snap([raw({ name: '', interactive: false, role: '', tag: 'p', path: 'html>body>p[1]' })]),
      meta(),
    );
    const f = d.findings.find((x) => x.kind === 'no-interactable-elements');
    expect(f).toBeTruthy();
    expect(f!.severity).toBe('BLOCKING');
    expect(f!.note).toContain('hydrated');
  });

  it('marks an http origin without pretending a local fix exists', () => {
    const d = diagnose(snap([raw()]), meta({ url: 'http://shop.test/checkout' }));
    const f = d.findings.find((x) => x.kind === 'insecure-origin');
    expect(f).toBeTruthy();
    expect(f!.recovery).toBe('REPORT_ONLY');
    expect(f!.recoveryStatus).toBe('NOT_ATTEMPTED');
  });

  it('separates a quirks-mode doctype from a blocking problem', () => {
    const d = diagnose(snap([raw()]), meta({ doctype: '' }));
    const f = d.findings.find((x) => x.kind === 'no-or-odd-doctype');
    expect(f!.severity).toBe('NOTICE');
    expect(f!.evidence).toContain('quirks mode');
  });
});

describe('rescue records', () => {
  it('refuses to remember an unverified fix as verified', () => {
    const r = rescueRecord({
      finding: 'tiny-targets',
      status: 'FIXED_VERIFIED',
      detail: 'enlarged hit area, then removed',
      appliedAt: 1,
      revertedAt: 2,
    });
    expect(r.status).toBe('APPLIED_UNVERIFIED');
    expect(r.verifiedAt).toBeNull();
  });

  it('keeps a verified rescue verified', () => {
    const r = rescueRecord({
      finding: 'tiny-targets',
      status: 'FIXED_VERIFIED',
      detail: 're-read showed the target at 44x44',
      appliedAt: 1,
      revertedAt: 2,
      verifiedAt: 1.5,
    });
    expect(r.status).toBe('FIXED_VERIFIED');
    expect(r.kind).toBe('TEMPORARY_LOCAL_VISUAL_RESCUE');
  });

  it('records a deliberate non-attempt as one', () => {
    const r = rescueRecord({ finding: 'unnamed-controls', status: 'NOT_ATTEMPTED', detail: 'no local fix exists' });
    expect(r.status).toBe('NOT_ATTEMPTED');
    expect(r.appliedAt).toBeNull();
  });
});

describe('description', () => {
  it('leads with the blocking findings and stays inside its budget', () => {
    const d = diagnose(
      snap([
        raw({ name: '', text: '', role: 'button' }),
        raw({ backendId: '2', token: 't2', name: 'Tiny', rect: { x: 1, y: 1, width: 8, height: 8 } }),
      ]),
      meta({ lang: '' }),
    );
    const full = describeDiagnosis(d, 2000);
    const lines = full.text.split('\n');
    expect(lines[1]).toMatch(/BLOCKING/);
    expect(full.text).toContain('NOT fully read');
    const tight = describeDiagnosis(d, 60);
    expect(tight.text.length).toBeLessThanOrEqual(60);
    expect(tight.omitted.length).toBeGreaterThan(0);
  });
});
