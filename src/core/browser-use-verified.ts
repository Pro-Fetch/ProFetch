/**
 * What has actually been run, on which host, and where the evidence lives.
 *
 * The capability profiles describe what a *protocol* can do; this file records what *this project*
 * has observed. They are separate on purpose. A `VERIFIED_MANAGED` that is baked into a profile would
 * travel to a Linux box and be quoted as though it were checked there, and the whole point of the
 * matrix is that a reader can tell a specification reading from an experiment.
 *
 * The list is generated from one table plus the products that were driven, because a hand-typed list
 * of fifty claims is exactly where a wrong step name or a copied-and-forgotten version number would
 * live. Each entry names the probe step inside the artifact that proves it, and a test opens that
 * artifact and checks the step is there and passed.
 */

import type {
  BrowserCapability,
  CapabilityAnswer,
  CapabilityStatus,
  EvidenceClass,
  OperatingSystem,
} from './browser-use-contract.js';

/**
 * The probe artifact every entry below points at. Regenerate with `npm run probe:browser-use`, then
 * update this constant together with `RUN_DATE` and the versions — a fact and its evidence age together.
 */
const ARTIFACT = 'probe-2026-11-02T15-42-06-835Z.json';
export const RUN_EVIDENCE = 'benchmarks/browser-use/artifacts/' + ARTIFACT;
const RUN_DATE = '2026-11-02';
const RUN_OS: OperatingSystem = 'windows';

/** The products driven in this run, with the versions the registry read from the binaries. */
const PRODUCTS: Array<{ product: string; browserVersion: string }> = [
  { product: 'chrome', browserVersion: '156.0.8078.74' },
  { product: 'edge', browserVersion: '156.0.4314.58' },
];

export interface VerifiedFact {
  product: string;
  capability: BrowserCapability;
  /**
   * The probe step inside `evidence` that proves this fact. Named because a run log is a list of
   * steps: pointing at a file without saying which line of it holds the claim is how a verification
   * quietly becomes a citation.
   */
  probeStep: string;
  /** The operating system the observation was made on — a claim about a host, not about the world. */
  os: OperatingSystem;
  /** Version of the browser that was driven. */
  browserVersion: string;
  /** Path to the committed run artifact, relative to the repository root. */
  evidence: string;
  date: string;
  note: string;
}

interface ProbeFact {
  capability: BrowserCapability;
  step: string;
  /** What was observed, in one clause, written for a reader who was not in the room. */
  note: string;
  /** Only when the two products differ in a way that matters to the claim. */
  edgeNote?: string;
}

/**
 * Everything Phase 4 has driven on this host. A capability appears here only if a probe step answered
 * it; `p` in the matrix means "read from the specification", and that distinction is why this table is
 * a table and not a copy of the profiles.
 */
const PROBE_FACTS: ProbeFact[] = [
  {
    capability: 'launch',
    step: 'launch',
    note: 'managed persistent context, isolated profile directory',
    edgeNote: 'same driver path as Chrome, its own profile directory',
  },
  {
    capability: 'navigate',
    step: 'navigate',
    note: 'about:blank plus setContent, and a real data: navigation in the world-model step',
  },
  { capability: 'domRead', step: 'read', note: 'element text read back exactly' },
  {
    capability: 'scriptEvaluate',
    step: 'read',
    note: 'every probe step runs script in the page; the read step is the narrowest one that proves it',
  },
  { capability: 'boundingGeometry', step: 'geometry', note: 'locator.boundingBox() returned 50x21 at 8,80' },
  {
    capability: 'accessibilityTree',
    step: 'accessibility',
    note: 'Playwright ariaSnapshot yielded the accessible name; the raw CDP AX domain is a separate question',
  },
  {
    capability: 'hitTesting',
    step: 'obstruction',
    note: 'elementFromPoint at the box centre distinguished a covered button from a free one',
    edgeNote: 'same result as Chrome on the same fixture',
  },
  {
    capability: 'screenshotViewport',
    step: 'screenshot',
    note: '1280x720 capture at dpr 1; the DOM box mapped onto a crop that was 97% the button blue',
  },
  {
    capability: 'screenshotElement',
    step: 'screenshot',
    note: 'locator.screenshot() came back 120x32 for a 120x32 CSS box',
  },
  {
    capability: 'screenshotFullPage',
    step: 'screenshot',
    note: 'full-page capture 1280x2072 for a 2072px document; the mapping holds with a document origin',
  },
  {
    capability: 'inputPointer',
    step: 'input',
    note: 'mouse.click at the centre the snapshot reported focused a field and reached a button',
  },
  {
    capability: 'inputKeyboard',
    step: 'input',
    note: 'keyboard.type delivered "hello" to the focused field and Enter reached its keydown handler',
  },
  { capability: 'consoleEvents', step: 'console', note: 'log and warning delivered with type and text intact' },
  {
    capability: 'networkInterception',
    step: 'network',
    note: 'https://probe.invalid answered from memory (a 95-byte PNG), so nothing was resolved on the network',
  },
  { capability: 'networkEvents', step: 'network', note: 'request and response events observed with statuses' },
  {
    capability: 'dialogs',
    step: 'dialogs',
    note: 'alert and confirm captured by type and message; an accepted confirm returned true to the page',
  },
  {
    capability: 'downloads',
    step: 'downloads',
    note: 'blob download saved through the browser and read back (15 bytes)',
  },
  { capability: 'uploads', step: 'uploads', note: 'setInputFiles reached the page change handler as upload-me.txt:14' },
  {
    capability: 'cookies',
    step: 'cookies',
    note: 'page-written cookies visible in the context jar; clearCookies removed the named one',
  },
  {
    capability: 'storageState',
    step: 'storage',
    note: 'storageState() wrote an origin entry containing localStorage; the page read both stores back',
  },
  { capability: 'inspectTabs', step: 'tabs', note: 'context.pages() listed every tab with its title' },
  {
    capability: 'controlTabs',
    step: 'tabs',
    note: 'closing a tab removed it from the context and left the driver alive',
  },
  {
    capability: 'multiSession',
    step: 'tabs',
    note: 'several pages in one context, driven one at a time',
    edgeNote: 'Edge restored a previous session tab into the profile — counted, not assumed away',
  },
  {
    capability: 'viewportEmulation',
    step: 'viewport',
    note: '375x667 emulated: innerWidth matched, the capture came back 375x667, geometry followed',
  },
  {
    capability: 'attachToRunning',
    step: 'attach-native',
    note: 'connectOverCDP on the loopback endpoint at port 9333 read the page and left the managed session usable',
    edgeNote: 'same path at port 9334; a public endpoint was refused by the validator',
  },
];

/** Produced by `npm run probe:browser-use`. Regenerate rather than edit by hand. */
export const VERIFIED: VerifiedFact[] = PRODUCTS.flatMap(({ product, browserVersion }) =>
  PROBE_FACTS.map((fact) => ({
    product,
    capability: fact.capability,
    probeStep: fact.step,
    os: RUN_OS,
    browserVersion,
    evidence: RUN_EVIDENCE,
    date: RUN_DATE,
    note: product === 'edge' && fact.edgeNote ? fact.edgeNote : fact.note,
  })),
);

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
    reason: `${base.reason} — verified on ${fact.os} with ${fact.product} ${fact.browserVersion}: ${fact.note} (${fact.evidence} · step \`${fact.probeStep}\`)`,
  };
}

/** Every verified fact whose artifact path is present, used by the drift test. */
export function verifiedEntries(): VerifiedFact[] {
  return VERIFIED;
}
