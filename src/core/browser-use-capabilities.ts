/**
 * Capability profiles: what each browser product can actually be asked to do, and why not.
 *
 * This file is the honest part of the engine. The protocol facts behind it were read from the
 * specifications on 2026-11-01 — WebDriver BiDi Editor's Draft of 2026-10-08, the CDP protocol
 * viewer, and the MDN BiDi module list (modified 2026-04-22) — and they do not say what the marketing
 * of any library implies:
 *
 *   - BiDi has **no accessibility module**. Firefox is the browser where BiDi is production-ready
 *     (Mozilla moved Firefox off CDP at 129), and it is exactly the browser where an AX-tree
 *     perception pipeline cannot be promised.
 *   - BiDi screenshots are **viewport only**; full-page capture was still an open specification issue.
 *   - CDP is the only protocol here that offers both an accessibility tree and hit-testing, and it is
 *     Chromium-family only.
 *   - Safari is W3C WebDriver behind a macOS-only, user-enabled automation port. It is neither CDP
 *     nor BiDi, and it has no accessibility tree.
 *
 * Anything not verified on this machine is `UNKNOWN` or `DETECTED_NOT_TESTED` with a reason, never a
 * silent `true`. A matrix that fills its blanks looks authoritative and is lying.
 */

import type {
  BrowserCapability,
  BrowserEngine,
  BrowserProtocol,
  CapabilityAnswer,
  CapabilityProfile,
  EvidenceClass,
  CapabilityStatus,
} from './browser-use-contract.js';

export const ALL_CAPABILITIES: BrowserCapability[] = [
  'launch',
  'attachToRunning',
  'inspectTabs',
  'controlTabs',
  'navigate',
  'domRead',
  'accessibilityTree',
  'computedStyles',
  'boundingGeometry',
  'hitTesting',
  'screenshotViewport',
  'screenshotElement',
  'screenshotFullPage',
  'inputPointer',
  'inputKeyboard',
  'inputTouch',
  'networkInterception',
  'networkEvents',
  'consoleEvents',
  'scriptEvaluate',
  'cookies',
  'storageState',
  'dialogs',
  'downloads',
  'uploads',
  'websockets',
  'viewportEmulation',
  'deviceEmulation',
  'multiSession',
  'persistence',
];

function answer(
  capability: BrowserCapability,
  status: CapabilityStatus,
  evidence: EvidenceClass,
  reason: string,
  via?: BrowserProtocol,
): CapabilityAnswer {
  return { capability, status, evidence, reason, ...(via ? { via } : {}) };
}

/** Everything a protocol family can answer the same way, keyed off the protocol's own reach. */
function engineBaseline(engine: BrowserEngine): CapabilityAnswer[] {
  const spec = engine === 'chromium' ? 'CDP' : engine === 'firefox' ? 'WebDriver BiDi' : 'W3C WebDriver';
  const protocol: BrowserProtocol = engine === 'chromium' ? 'cdp' : engine === 'firefox' ? 'bidi' : 'playwright-webkit';
  const axAvailable = engine === 'chromium';
  const hitAvailable = engine === 'chromium';
  return [
    answer('launch', 'PARTIALLY_VERIFIED', 'source-confirmed', `${spec} path implemented; not run here yet`, protocol),
    answer(
      'attachToRunning',
      engine === 'chromium' ? 'PARTIALLY_VERIFIED' : 'UNKNOWN',
      engine === 'chromium' ? 'source-confirmed' : 'unknown',
      engine === 'chromium'
        ? 'CDP exposes a DevTools endpoint on a running Chromium product'
        : `${spec} attachment to an already-running browser is not clearly specified`,
      protocol,
    ),
    answer('inspectTabs', 'PARTIALLY_VERIFIED', 'source-confirmed', `${spec} enumerates open tabs`, protocol),
    answer(
      'controlTabs',
      'PARTIALLY_VERIFIED',
      'source-confirmed',
      `${spec} creates, selects and closes tabs`,
      protocol,
    ),
    answer('navigate', 'PARTIALLY_VERIFIED', 'source-confirmed', `${spec} navigation`, protocol),
    answer('domRead', 'PARTIALLY_VERIFIED', 'source-confirmed', `${spec} DOM/script access`, protocol),
    answer(
      'accessibilityTree',
      axAvailable ? 'PARTIALLY_VERIFIED' : 'UNSUPPORTED',
      axAvailable ? 'source-confirmed' : 'documented',
      axAvailable
        ? 'Accessibility.getFullAXTree is part of CDP'
        : `${spec} defines no accessibility module, so there is no tree to ask for`,
      protocol,
    ),
    answer('computedStyles', 'PARTIALLY_VERIFIED', 'source-confirmed', 'via script evaluation', protocol),
    answer('boundingGeometry', 'PARTIALLY_VERIFIED', 'source-confirmed', 'via script evaluation', protocol),
    answer(
      'hitTesting',
      hitAvailable ? 'UNKNOWN' : 'UNSUPPORTED',
      hitAvailable ? 'inferred' : 'documented',
      hitAvailable
        ? 'the CDP viewer names a hit-testing method; its semantics were not verified here'
        : `${spec} has no element-from-point operation`,
      protocol,
    ),
    answer('screenshotViewport', 'PARTIALLY_VERIFIED', 'source-confirmed', `${spec} capture`, protocol),
    answer(
      'screenshotElement',
      engine === 'webkit' ? 'PARTIALLY_VERIFIED' : 'UNKNOWN',
      engine === 'webkit' ? 'documented' : 'unknown',
      engine === 'webkit'
        ? 'W3C WebDriver specifies an element screenshot endpoint'
        : `${spec} captures the viewport; per-element cropping is done locally, not by the browser`,
      protocol,
    ),
    answer(
      'screenshotFullPage',
      engine === 'firefox' ? 'UNSUPPORTED' : 'PARTIALLY_VERIFIED',
      engine === 'firefox' ? 'documented' : 'source-confirmed',
      engine === 'firefox'
        ? 'BiDi capture is viewport-only; full-page was still an open specification issue when read'
        : 'stitched or natively supported depending on the driver',
      protocol,
    ),
    answer('inputPointer', 'PARTIALLY_VERIFIED', 'source-confirmed', `${spec} input`, protocol),
    answer('inputKeyboard', 'PARTIALLY_VERIFIED', 'source-confirmed', `${spec} input`, protocol),
    answer(
      'inputTouch',
      engine === 'chromium' ? 'PARTIALLY_VERIFIED' : 'UNKNOWN',
      engine === 'chromium' ? 'source-confirmed' : 'unknown',
      engine === 'chromium' ? 'CDP Input.dispatchTouchEvent' : `${spec} touch input not verified here`,
      protocol,
    ),
    answer('networkInterception', 'PARTIALLY_VERIFIED', 'source-confirmed', `${spec} interception`, protocol),
    answer(
      'websockets',
      'UNSUPPORTED',
      'source-confirmed',
      'this process cannot route WebSocket frames through the SSRF check: the driver layer does not expose them. Documented in pinned-proxy.ts.',
      protocol,
    ),
    answer('networkEvents', 'PARTIALLY_VERIFIED', 'source-confirmed', `${spec} events`, protocol),
    answer('consoleEvents', 'PARTIALLY_VERIFIED', 'source-confirmed', `${spec} events`, protocol),
    answer('scriptEvaluate', 'PARTIALLY_VERIFIED', 'source-confirmed', `${spec} script module`, protocol),
    answer('cookies', 'PARTIALLY_VERIFIED', 'source-confirmed', `${spec} storage access`, protocol),
    answer(
      'storageState',
      'PARTIALLY_VERIFIED',
      'source-confirmed',
      'exported and re-injected by the driver',
      protocol,
    ),
    answer('dialogs', 'PARTIALLY_VERIFIED', 'source-confirmed', `${spec} javascript dialog handling`, protocol),
    answer('downloads', 'PARTIALLY_VERIFIED', 'source-confirmed', 'download event plus save-as', protocol),
    answer('uploads', 'PARTIALLY_VERIFIED', 'source-confirmed', 'file input injection', protocol),
    answer('viewportEmulation', 'PARTIALLY_VERIFIED', 'source-confirmed', 'context-level viewport', protocol),
    answer(
      'deviceEmulation',
      engine === 'chromium' ? 'PARTIALLY_VERIFIED' : 'UNKNOWN',
      engine === 'chromium' ? 'documented' : 'unknown',
      engine === 'chromium' ? 'CDP Emulation.setDeviceMetricsOverride' : `${spec} device metrics not verified`,
      protocol,
    ),
    answer('multiSession', 'PARTIALLY_VERIFIED', 'source-confirmed', 'session map keyed by id', protocol),
    answer('persistence', 'PARTIALLY_VERIFIED', 'source-confirmed', 'storage-state file per profile', protocol),
  ];
}

/** Chromium-family products share the engine baseline and differ in launch, attach and profile handling. */
const CHROMIUM_PRODUCTS: Array<{ product: string; note: string }> = [
  { product: 'chrome', note: 'the reference Chromium product' },
  { product: 'chrome-beta', note: 'same protocol surface as stable' },
  { product: 'chrome-dev', note: 'same protocol surface as stable' },
  { product: 'chrome-canary', note: 'same protocol surface as stable' },
  { product: 'chromium', note: 'no Google-wide components; media codecs may be absent' },
  { product: 'edge', note: 'Chromium-based; its own DevTools endpoint and profile directory' },
  { product: 'edge-beta', note: 'same protocol surface as Edge stable' },
  { product: 'edge-dev', note: 'same protocol surface as Edge stable' },
  { product: 'edge-canary', note: 'same protocol surface as Edge stable' },
  { product: 'brave', note: 'shields can block sub-resources the engine would otherwise fetch' },
  { product: 'opera', note: 'Chromium-based; own profile layout' },
  { product: 'opera-gx', note: 'Chromium-based; own profile layout' },
  { product: 'vivaldi', note: 'Chromium-based; own profile layout' },
  { product: 'arc', note: 'Chromium core but no documented remote-debugging story' },
];

const FIREFOX_PRODUCTS = ['firefox', 'firefox-esr', 'firefox-developer', 'firefox-nightly'];

function chromiumProfile(product: string, note: string): CapabilityProfile {
  const base = engineBaseline('chromium');
  const answers = base.map((a) => ({ ...a }));
  if (product === 'arc') {
    const launch = answers.find((a) => a.capability === 'launch');
    if (launch) {
      launch.status = 'UNKNOWN';
      launch.evidence = 'unknown';
      launch.reason = 'Arc ships a Chromium core but no documented debugging endpoint; not verified here';
    }
  }
  if (product === 'brave') {
    const intercept = answers.find((a) => a.capability === 'networkInterception');
    if (intercept) {
      intercept.status = 'PARTIALLY_VERIFIED';
      intercept.reason = 'works, but Brave Shields can drop sub-resources before the driver sees them — ' + note;
    }
  }
  return { product, engine: 'chromium', protocols: ['playwright-chromium', 'cdp'], answers };
}

function firefoxProfile(product: string): CapabilityProfile {
  const answers = engineBaseline('firefox').map((a) => ({ ...a }));
  // Playwright's own Firefox build is managed-only: it can be launched, but a user's installed
  // Firefox cannot be attached to over CDP because Mozilla removed CDP support at 129.
  const attach = answers.find((a) => a.capability === 'attachToRunning');
  if (attach) {
    attach.status = 'PARTIALLY_VERIFIED';
    attach.evidence = 'documented';
    attach.reason =
      'over WebDriver BiDi only; CDP is not available in Firefox 129+, so a Playwright-managed build is not the same thing as the user browser';
    attach.via = 'bidi';
  }
  return { product, engine: 'firefox', protocols: ['playwright-firefox', 'bidi', 'webdriver'], answers };
}

function webkitProfile(): CapabilityProfile {
  const answers = engineBaseline('webkit').map((a) => ({ ...a }));
  const launch = answers.find((a) => a.capability === 'launch');
  if (launch) {
    launch.status = 'BLOCKED_BY_ENVIRONMENT';
    launch.reason =
      'Playwright WebKit builds are not published for Windows; on this machine the engine is unavailable regardless of the driver code';
  }
  return { product: 'webkit', engine: 'webkit', protocols: ['playwright-webkit'], answers };
}

function safariProfile(): CapabilityProfile {
  const answers = engineBaseline('webkit').map((a) => ({ ...a }));
  // Some answers are intrinsic to the protocol and must not be flattened into "blocked by
  // environment": WebDriver has no accessibility tree and no request interception whether or not a
  // Mac is plugged in. Overwriting those with an environment excuse would lose the distinction
  // between "this machine is missing something" and "no machine can do this", which is the whole
  // point of carrying a reason string.
  const intrinsic = new Set(['websockets', 'networkInterception', 'accessibilityTree', 'hitTesting']);
  for (const a of answers) {
    if (intrinsic.has(a.capability)) {
      a.status = 'UNSUPPORTED';
      a.evidence = 'documented';
      a.via = 'safaridriver';
      a.reason = 'W3C WebDriver, which is what safaridriver implements, does not define this operation';
      continue;
    }
    a.status = 'BLOCKED_BY_ENVIRONMENT';
    a.evidence = 'documented';
    a.reason = 'safaridriver runs on macOS only; this profile cannot be verified from Windows';
    a.via = 'safaridriver';
  }
  const launch = answers.find((a) => a.capability === 'launch');
  if (launch) {
    launch.status = 'BLOCKED_BY_ENVIRONMENT';
    launch.evidence = 'documented';
    launch.reason = 'requires macOS plus a user-enabled automation port (`safaridriver --enable`)';
    launch.via = 'safaridriver';
  }
  const attach = answers.find((a) => a.capability === 'attachToRunning');
  if (attach) {
    attach.status = 'UNSUPPORTED';
    attach.evidence = 'documented';
    attach.reason =
      'safaridriver is a W3C WebDriver server; it does not expose an attach endpoint for a running browser';
    attach.via = 'safaridriver';
  }
  const ax = answers.find((a) => a.capability === 'accessibilityTree');
  if (ax) {
    ax.status = 'UNSUPPORTED';
    ax.evidence = 'documented';
    ax.reason = 'W3C WebDriver defines no accessibility tree';
    ax.via = 'safaridriver';
  }
  return { product: 'safari', engine: 'webkit', protocols: ['safaridriver', 'webdriver'], answers };
}

function androidChromeProfile(): CapabilityProfile {
  const answers = engineBaseline('chromium').map((a) => ({ ...a }));
  const attach = answers.find((a) => a.capability === 'attachToRunning');
  if (attach) {
    attach.status = 'PARTIALLY_VERIFIED';
    attach.evidence = 'documented';
    attach.reason = 'over `adb forward` to the WebView devtools socket; needs USB debugging enabled';
    attach.via = 'adb';
  }
  const launch = answers.find((a) => a.capability === 'launch');
  if (launch) {
    launch.status = 'PARTIALLY_VERIFIED';
    launch.evidence = 'documented';
    launch.reason = 'the browser is started by the device, not by this process (am start / instrumentation)';
    launch.via = 'adb';
  }
  const touch = answers.find((a) => a.capability === 'inputTouch');
  if (touch) {
    touch.status = 'PARTIALLY_VERIFIED';
    touch.evidence = 'documented';
    touch.reason = 'CDP touch events plus adb input';
    touch.via = 'adb';
  }
  const storage = answers.find((a) => a.capability === 'storageState');
  if (storage) {
    storage.status = 'UNKNOWN';
    storage.evidence = 'unknown';
    storage.reason = 'profile persistence on a device is not the same as a portable storage-state file';
  }
  return { product: 'android-chrome', engine: 'chromium', protocols: ['adb', 'cdp'], answers };
}

/**
 * Firefox on Android is not "Android Chrome with a different label".
 *
 * There is no CDP socket on it: remote debugging goes through the Gecko driver over ADB forwarding,
 * which means the accessibility tree and hit-testing that CDP provides are simply not on offer, and
 * the launch is performed by the device. Reusing the Chromium profile would have advertised a
 * capability the transport cannot carry.
 */
function androidFirefoxProfile(): CapabilityProfile {
  const answers = engineBaseline('firefox').map((a) => ({ ...a }));
  const launch = answers.find((a) => a.capability === 'launch');
  if (launch) {
    launch.status = 'BLOCKED_BY_ENVIRONMENT';
    launch.evidence = 'documented';
    launch.reason = 'requires a connected Android device and the Gecko driver; not reachable from this test run';
    launch.via = 'adb';
  }
  const attach = answers.find((a) => a.capability === 'attachToRunning');
  if (attach) {
    attach.status = 'UNKNOWN';
    attach.evidence = 'unknown';
    attach.reason = 'GeckoView remote debugging exists but was not verified here, and it is not a CDP endpoint';
    attach.via = 'adb';
  }
  const touch = answers.find((a) => a.capability === 'inputTouch');
  if (touch) {
    touch.status = 'UNKNOWN';
    touch.evidence = 'unknown';
    touch.reason = 'touch input over the Gecko driver not verified here';
  }
  return { product: 'android-firefox', engine: 'firefox', protocols: ['adb', 'bidi', 'webdriver'], answers };
}

function iosSafariProfile(): CapabilityProfile {
  const answers = safariProfile().answers.map((a) => ({ ...a }));
  for (const a of answers) {
    if (a.status === 'BLOCKED_BY_ENVIRONMENT') {
      a.reason = 'iOS automation requires a macOS host with Xcode plus WebDriverAgent; not available here';
      a.via = 'appium';
    }
  }
  return { product: 'ios-safari', engine: 'webkit', protocols: ['appium', 'xcuitest'], answers };
}

/** Every profile the registry knows about, keyed by product. */
export const CAPABILITY_PROFILES: Record<string, CapabilityProfile> = {};

for (const { product, note } of CHROMIUM_PRODUCTS) CAPABILITY_PROFILES[product] = chromiumProfile(product, note);
for (const product of FIREFOX_PRODUCTS) CAPABILITY_PROFILES[product] = firefoxProfile(product);
CAPABILITY_PROFILES.webkit = webkitProfile();
CAPABILITY_PROFILES.safari = safariProfile();
CAPABILITY_PROFILES['android-chrome'] = androidChromeProfile();
CAPABILITY_PROFILES['samsung-internet'] = { ...androidChromeProfile(), product: 'samsung-internet' };
CAPABILITY_PROFILES['android-firefox'] = androidFirefoxProfile();
CAPABILITY_PROFILES['ios-safari'] = iosSafariProfile();

/** Every capability a product has, verified or not — used to build the support matrix. */
export function profileFor(product: string): CapabilityProfile | undefined {
  return CAPABILITY_PROFILES[product];
}

export function capabilityOf(product: string, capability: BrowserCapability): CapabilityAnswer | undefined {
  return profileFor(product)?.answers.find((a) => a.capability === capability);
}

/**
 * Does this product satisfy a capability requirement?
 *
 * Only `VERIFIED_*` and `PARTIALLY_VERIFIED` count as yes, and `PARTIALLY_VERIFIED` counts only when
 * the caller accepts partial evidence. `UNKNOWN` is a **no**: the difference between "we did not
 * check" and "it does not work" belongs in the report, not in the selection.
 */
export function supports(
  product: string,
  capability: BrowserCapability,
  options: { allowPartial?: boolean; via?: BrowserProtocol } = {},
): { yes: boolean; answer?: CapabilityAnswer } {
  const found = capabilityOf(product, capability);
  if (!found) return { yes: false };
  if (options.via && found.via && found.via !== options.via) return { yes: false, answer: found };
  const good: CapabilityStatus[] = options.allowPartial
    ? ['VERIFIED_NATIVE', 'VERIFIED_MANAGED', 'PARTIALLY_VERIFIED']
    : ['VERIFIED_NATIVE', 'VERIFIED_MANAGED'];
  return { yes: good.includes(found.status), answer: found };
}

/** Capabilities a product cannot provide at all — the "what would be lost" half of an alternative. */
export function missingFor(product: string, capabilities: BrowserCapability[]): BrowserCapability[] {
  return capabilities.filter((c) => !supports(product, c, { allowPartial: true }).yes);
}
