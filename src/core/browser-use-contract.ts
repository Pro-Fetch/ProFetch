/**
 * The vocabulary of the Browser Intelligence Engine.
 *
 * Everything in this file is a *description*, not an operation: no imports from Playwright, no
 * process handles, no I/O. That separation is deliberate. The competitive survey found the same
 * failure in three different products — a capability claim that could not be checked separately from
 * the code that performs it. Stagehand's cache only exists in the paid tier, browser-use indexes by
 * an id it never revalidates, Skyvern ships URL validation switched off by default. Each of those is
 * a statement about a *capability*, and each was invisible until someone had to write it down in a
 * form a test could read.
 *
 * So: capability profiles are data here, and every runtime answer must be expressed in these terms.
 */

/** The rendering engine underneath a browser product. Engine and product are not the same thing. */
export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

/** A browser family for detection and policy grouping. */
export type BrowserFamily = 'chromium' | 'firefox' | 'webkit';

/**
 * How the engine reaches a browser.
 *
 * Listed per protocol rather than "local/remote" because the survey showed the two are not
 * interchangeable: CDP is Chromium-only and is the only source of an accessibility tree; BiDi is
 * cross-vendor but has no accessibility module at all; W3C WebDriver is the widest and the poorest.
 * A capability answer that hides which protocol produced it is not an answer.
 */
export type BrowserProtocol =
  | 'playwright-chromium'
  | 'playwright-firefox'
  | 'playwright-webkit'
  | 'cdp'
  | 'bidi'
  | 'webdriver'
  | 'safaridriver'
  | 'adb'
  | 'appium'
  | 'xcuitest';

/** Managed = this process launched the browser. Native = it attached to a browser already running. */
export type ConnectionMode = 'managed' | 'native';

export type OperatingSystem = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown';

export type DeviceClass = 'desktop' | 'mobile' | 'tablet' | 'unknown';

/**
 * Whether a capability holds for a product, and how we know.
 *
 * `UNSUPPORTED` and `UNKNOWN` are different answers and must never collapse into one another: the
 * first is a claim we verified or read in a specification, the second is an admission. A matrix that
 * fills blanks with `UNSUPPORTED` looks authoritative and is lying.
 */
export type CapabilityStatus =
  | 'VERIFIED_NATIVE'
  | 'VERIFIED_MANAGED'
  | 'PARTIALLY_VERIFIED'
  | 'DETECTED_NOT_TESTED'
  | 'UNSUPPORTED'
  | 'BLOCKED_BY_ENVIRONMENT'
  | 'UNKNOWN';

/** How a status was arrived at. Mirrors the confidence classes used in the competitive analysis. */
export type EvidenceClass = 'documented' | 'source-confirmed' | 'experimentally-verified' | 'inferred' | 'unknown';

/**
 * The capabilities the engine can be asked about.
 *
 * Deliberately fine-grained. "Does it support Firefox?" has no honest answer; "can Firefox give an
 * accessibility tree over BiDi?" does, and the answer is no.
 */
export type BrowserCapability =
  | 'launch'
  | 'attachToRunning'
  | 'inspectTabs'
  | 'controlTabs'
  | 'navigate'
  | 'domRead'
  | 'accessibilityTree'
  | 'computedStyles'
  | 'boundingGeometry'
  | 'hitTesting'
  | 'screenshotViewport'
  | 'screenshotElement'
  | 'screenshotFullPage'
  | 'inputPointer'
  | 'inputKeyboard'
  | 'inputTouch'
  | 'networkInterception'
  | 'networkEvents'
  | 'consoleEvents'
  | 'scriptEvaluate'
  | 'cookies'
  | 'storageState'
  | 'dialogs'
  | 'downloads'
  | 'uploads'
  | 'websockets'
  | 'viewportEmulation'
  | 'deviceEmulation'
  | 'multiSession'
  | 'persistence';

/** One capability answer with the reason attached, so a caller can show its work. */
export interface CapabilityAnswer {
  capability: BrowserCapability;
  status: CapabilityStatus;
  evidence: EvidenceClass;
  /** Why — a protocol gap, a missing module, an untested build. Never empty for a non-verified status. */
  reason: string;
  /** The protocol this answer was measured or read against, when the answer depends on it. */
  via?: BrowserProtocol;
}

/** A concrete browser installation found on this machine, or asked for by the caller. */
export interface DetectedBrowser {
  /** Stable product key, e.g. `chrome`, `edge`, `brave`, `firefox`, `safari`. */
  product: string;
  /** Display name a human recognises. */
  label: string;
  family: BrowserFamily;
  engine: BrowserEngine;
  /** Release channel: stable, beta, dev, canary/nightly, esr, or a vendor-specific name. */
  channel: string;
  os: OperatingSystem;
  device: DeviceClass;
  /** Full version string as reported by the browser itself, e.g. `141.0.7396.99`. */
  version: string;
  /** Major version as a number, or 0 when the version could not be read. */
  major: number;
  /** Absolute path to the executable, when found. */
  executablePath: string;
  /** How this entry came to exist: found on disk, configured, or supplied by the caller. */
  source: 'detected' | 'configured' | 'caller';
  /** True when the executable is present but the engine has not been driven with it yet. */
  present: boolean;
}

/** What a caller asked for, before any machine is consulted. */
export interface BrowserRequest {
  product?: string;
  channel?: string;
  engine?: BrowserEngine;
  os?: OperatingSystem;
  device?: DeviceClass;
  minMajor?: number;
  /** Required capabilities — selection must refuse a browser that cannot satisfy them. */
  requires?: BrowserCapability[];
  mode?: ConnectionMode;
  protocol?: BrowserProtocol;
  /** Attach endpoint for native mode (CDP http/ws URL, remote WebDriver URL). */
  endpoint?: string;
  /** Prefer a specific executable path over discovery. */
  executablePath?: string;
}

/** The outcome of resolving a request against this machine. */
export interface ResolvedConnection {
  ok: boolean;
  browser?: DetectedBrowser;
  mode?: ConnectionMode;
  protocol?: BrowserProtocol;
  /** Why a request was refused, in terms a host AI can act on. */
  blocker?: string;
  /** What could be offered instead, and what would be lost by taking it. */
  alternatives?: Array<{
    browser: string;
    mode: ConnectionMode;
    protocol: BrowserProtocol;
    loses: BrowserCapability[];
  }>;
}

/**
 * The adapter contract.
 *
 * One browser product, one implementation of this interface — but the implementation may delegate
 * almost everything to a shared engine layer, and it must. The survey found the real cost of getting
 * this wrong: five Chromium-branded browsers do not need five engines, they need one protocol driver
 * and five *launch and attach* behaviours that differ in executable discovery, flags and profile
 * handling. An adapter that is a one-line subclass with nothing verified in it is the failure mode
 * the project brief names explicitly.
 */
export interface BrowserAdapter {
  /** Stable key used in requests and reports. */
  readonly product: string;
  readonly label: string;
  readonly family: BrowserFamily;
  readonly engine: BrowserEngine;
  /** Protocols this adapter can drive, in preference order. */
  readonly protocols: BrowserProtocol[];
  /** Where to look for the executable on this OS. */
  candidates(os: OperatingSystem): string[];
  /** Read the product's own version string, or `''` when it cannot be determined. */
  version(executablePath: string): Promise<string>;
  /** Launch flags this product needs that its engine does not imply. */
  launchArgs(options: LaunchOptions): string[];
  /** The capability profile, including the things this product cannot do. */
  capabilities(): CapabilityAnswer[];
  /** Whether an already-running instance can be attached to, and over what. */
  attach(endpoint: string): ResolvedConnection;
}

export interface LaunchOptions {
  headless: boolean;
  executablePath: string;
  /** Debugging port to expose, when native attachment or CDP is intended. */
  debuggingPort?: number;
  /** A caller-supplied profile directory; never a default profile of the user's browser. */
  userDataDir?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** A capability profile keyed by product, used by the registry and the support matrix. */
export interface CapabilityProfile {
  product: string;
  engine: BrowserEngine;
  protocols: BrowserProtocol[];
  answers: CapabilityAnswer[];
}

export function parseMajor(version: string): number {
  const match = /(\d+)(?:\.|$)/.exec(version.trim());
  return match ? Number(match[1]) : 0;
}

/** The status to report when a capability has simply never been checked here. */
export const UNVERIFIED: CapabilityStatus = 'UNKNOWN';
