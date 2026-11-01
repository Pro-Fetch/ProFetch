/**
 * What has actually been run, on which host, and where the evidence lives.
 *
 * The capability profiles describe what a *protocol* can do; this file records what *this project*
 * has observed. They are separate on purpose. A `VERIFIED_MANAGED` that is baked into a profile would
 * travel to a Linux box and be quoted as though it were checked there, and the whole point of the
 * matrix is that a reader can tell a specification reading from an experiment.
 *
 * Every entry names the artifact that proves it. An entry without an artifact is not a verification,
 * and a test says so.
 */

import type {
  BrowserCapability,
  CapabilityAnswer,
  CapabilityStatus,
  EvidenceClass,
  OperatingSystem,
} from './browser-use-contract.js';

/** The probe artifact every entry below points at. Regenerate with `npm run probe:browser-use`. */
const ARTIFACT = 'probe-2026-11-01T15-41-32-746Z.json';

export interface VerifiedFact {
  product: string;
  capability: BrowserCapability;
  /** The operating system the observation was made on — a claim about a host, not about the world. */
  os: OperatingSystem;
  /** Version of the browser that was driven. */
  browserVersion: string;
  /** Path to the committed run artifact, relative to the repository root. */
  evidence: string;
  date: string;
  note: string;
}

/** Produced by `npm run probe:browser-use`. Regenerate rather than edit by hand. */
export const VERIFIED: VerifiedFact[] = [
  {
    product: 'chrome',
    capability: 'launch',
    os: 'windows',
    browserVersion: '156.0.8078.74',
    evidence: 'benchmarks/browser-use/artifacts/probe-2026-11-01T15-41-32-746Z.json',
    date: '2026-11-01',
    note: 'managed persistent context, isolated profile directory',
  },
  {
    product: 'chrome',
    capability: 'navigate',
    os: 'windows',
    browserVersion: '156.0.8078.74',
    evidence: 'benchmarks/browser-use/artifacts/probe-2026-11-01T15-41-32-746Z.json',
    date: '2026-11-01',
    note: 'about:blank + setContent, no network involved',
  },
  {
    product: 'chrome',
    capability: 'domRead',
    os: 'windows',
    browserVersion: '156.0.8078.74',
    evidence: 'benchmarks/browser-use/artifacts/probe-2026-11-01T15-41-32-746Z.json',
    date: '2026-11-01',
    note: 'element text read back exactly',
  },
  {
    product: 'chrome',
    capability: 'boundingGeometry',
    os: 'windows',
    browserVersion: '156.0.8078.74',
    evidence: 'benchmarks/browser-use/artifacts/probe-2026-11-01T15-41-32-746Z.json',
    date: '2026-11-01',
    note: 'locator.boundingBox() returned 50x21 at 8,80',
  },
  {
    product: 'chrome',
    capability: 'accessibilityTree',
    os: 'windows',
    browserVersion: '156.0.8078.74',
    evidence: 'benchmarks/browser-use/artifacts/probe-2026-11-01T15-41-32-746Z.json',
    date: '2026-11-01',
    note: 'Playwright ariaSnapshot yielded the accessible name; the CDP AX tree itself is separate',
  },
  {
    product: 'edge',
    capability: 'launch',
    os: 'windows',
    browserVersion: '156.0.4314.58',
    evidence: 'benchmarks/browser-use/artifacts/probe-2026-11-01T15-41-32-746Z.json',
    date: '2026-11-01',
    note: 'same driver path as Chrome, its own profile directory',
  },
  {
    product: 'edge',
    capability: 'navigate',
    os: 'windows',
    browserVersion: '156.0.4314.58',
    evidence: 'benchmarks/browser-use/artifacts/probe-2026-11-01T15-41-32-746Z.json',
    date: '2026-11-01',
    note: 'about:blank + setContent',
  },
  {
    product: 'edge',
    capability: 'domRead',
    os: 'windows',
    browserVersion: '156.0.4314.58',
    evidence: 'benchmarks/browser-use/artifacts/probe-2026-11-01T15-41-32-746Z.json',
    date: '2026-11-01',
    note: 'element text read back exactly',
  },
  {
    product: 'edge',
    capability: 'boundingGeometry',
    os: 'windows',
    browserVersion: '156.0.4314.58',
    evidence: 'benchmarks/browser-use/artifacts/probe-2026-11-01T15-41-32-746Z.json',
    date: '2026-11-01',
    note: 'identical box to Chrome on the same fixture',
  },
  {
    product: 'edge',
    capability: 'accessibilityTree',
    os: 'windows',
    browserVersion: '156.0.4314.58',
    evidence: 'benchmarks/browser-use/artifacts/probe-2026-11-01T15-41-32-746Z.json',
    date: '2026-11-01',
    note: 'ariaSnapshot yielded the accessible name',
  },
  {
    product: 'chrome',
    capability: 'hitTesting',
    os: 'windows',
    browserVersion: '156.0.8078.74',
    evidence: `benchmarks/browser-use/artifacts/${ARTIFACT}`,
    date: '2026-11-01',
    note: `elementFromPoint at the box centre distinguished a covered button from a free one`,
  },
  {
    product: 'edge',
    capability: 'hitTesting',
    os: 'windows',
    browserVersion: '156.0.4314.58',
    evidence: `benchmarks/browser-use/artifacts/${ARTIFACT}`,
    date: '2026-11-01',
    note: `same result as Chrome on the same fixture`,
  },
];

export function verifiedFor(
  product: string,
  capability: BrowserCapability,
  os: OperatingSystem,
): VerifiedFact | undefined {
  return VERIFIED.find((v) => v.product === product && v.capability === capability && v.os === os);
}

/**
 * The status to show a reader on *this* host.
 *
 * A profile says what the protocol allows; a verified fact says what was observed here. Where both
 * agree the answer is `VERIFIED_MANAGED` with the experiment as its evidence. Where a fact exists for
 * another OS only, the status stays as the profile had it and the note says who checked it — a
 * Windows observation is not a Linux guarantee.
 */
export function effectiveAnswer(
  product: string,
  capability: BrowserCapability,
  base: CapabilityAnswer,
  hostOs: OperatingSystem,
): CapabilityAnswer {
  const fact = verifiedFor(product, capability, hostOs);
  if (!fact) return base;
  const status: CapabilityStatus = 'VERIFIED_MANAGED';
  const evidence: EvidenceClass = 'experimentally-verified';
  return {
    ...base,
    status,
    evidence,
    reason: `${base.reason} — verified on ${fact.os} with ${fact.product} ${fact.browserVersion}: ${fact.note} (${fact.evidence})`,
  };
}

/** Every verified fact whose artifact path is present, used by the drift test. */
export function verifiedEntries(): VerifiedFact[] {
  return VERIFIED;
}
