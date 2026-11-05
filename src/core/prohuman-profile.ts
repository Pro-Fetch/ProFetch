/**
 * Human behaviour profiles: the numbers a driver runs on, and the random source that makes them vary.
 *
 * ## Why a profile is data and not a mood
 *
 * "Move like a human" is not implementable and not testable. `a = 170 ms, b = 110 ms, sigma_curve = 62 px,
 * typo_rate = 0.012` is both: the same numbers produce the same distribution, a unit test can pin them, and
 * a report can say what was asked versus what happened. Every preset below is therefore a table of numbers,
 * and the presets differ from each other in those numbers only.
 *
 * ## Seeded randomness, and why the seed is returned to the caller
 *
 * A run must be reproducible to be debugged: a trajectory that looks wrong is worth nothing if it cannot be
 * made again. So every random choice comes from `mulberry32(seed)`, and every tool answer carries the seed
 * it used. The seed itself is random per session, so reproducibility does not become a fixed pattern — a
 * driver that replays the identical path every time is the metronome this pack exists to avoid.
 */

export interface PointerProfile {
  /** Fitts' intercept: the part of a movement that does not depend on distance, in ms. */
  aMs: number;
  /** Fitts' slope: ms per index of difficulty, in ms. */
  bMs: number;
  /** How far a path bows away from the straight line, in CSS px. */
  sigmaCurvePx: number;
  /** How far past a small target a hand typically lands before correcting, in CSS px. */
  overshootPx: number;
  /** The window of sub-threshold movement before a click, in ms. */
  settleMs: number;
  /** The longest the pointer may hold perfectly still while a page is being worked on, in ms. */
  idleStillnessMs: number;
  /** Amplitude of the micro-drift that keeps stillness under that ceiling, in CSS px. */
  driftPx: number;
  /** Target width below which overshoot is planned, in CSS px. */
  smallTargetPx: number;
  /** Steps shorter than this are jitter, not direction: they are excluded from curvature. */
  noiseFloorPx: number;
}

export interface KeyboardProfile {
  /** Baseline typing speed in words per minute; a word is five characters by convention. */
  wpm: number;
  holdMinMs: number;
  holdMaxMs: number;
  gapMinMs: number;
  gapMaxMs: number;
  /** Extra pause after a space: word boundaries are planned, not typed. */
  wordPauseMs: number;
  /** Extra pause after , . ; : ! ? */
  punctPauseMs: number;
  /** Extra pause at the end of a sentence, where a person composes the next one. */
  sentencePauseMs: number;
  /** Probability per character of producing a neighbour-key mistake, 0–0.2. */
  typoRate: number;
}

export interface ScrollProfile {
  burstMin: number;
  burstMax: number;
  amplitudeMinPx: number;
  amplitudeMaxPx: number;
  pauseMinMs: number;
  pauseMaxMs: number;
  /** Probability that a burst is followed by a short scroll back — a re-read. */
  regressionRate: number;
}

export interface AttentionProfile {
  /** Words per minute the driver assumes when it dwells on text. */
  readWpm: number;
  /** Expected tab switches per minute of idle driving. */
  tabChurnPerMin: number;
  /** Probability that focus leaves the page at the end of a step. */
  blurRate: number;
  /** Probability that the pointer leaves the viewport during idle. */
  pointerOutRate: number;
}

export interface HumanProfile {
  name: string;
  seed: number;
  /** How long a driver may run unattended before it stops itself. */
  maxRuntimeMs: number;
  pointer: PointerProfile;
  keyboard: KeyboardProfile;
  scroll: ScrollProfile;
  attention: AttentionProfile;
}

/** Hard ceilings. A profile outside these is a mistake or an attempt to look like a machine. */
export const LIMITS = {
  aMs: [40, 900],
  bMs: [20, 600],
  sigmaCurvePx: [0, 400],
  overshootPx: [0, 60],
  settleMs: [0, 500],
  idleStillnessMs: [120, 4000],
  driftPx: [0, 24],
  smallTargetPx: [4, 120],
  noiseFloorPx: [0, 20],
  wpm: [40, 400],
  gapMs: [10, 1200],
  holdMs: [10, 400],
  typoRate: [0, 0.2],
  readWpm: [60, 600],
  tabChurnPerMin: [0, 20],
  maxRuntimeMs: [1000, 600_000],
} as const;

export const DEFAULT_MAX_RUNTIME_MS = 120_000;

const BASE: Omit<HumanProfile, 'name' | 'seed'> = {
  maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS,
  pointer: {
    aMs: 170,
    bMs: 110,
    sigmaCurvePx: 60,
    overshootPx: 10,
    settleMs: 70,
    idleStillnessMs: 320,
    driftPx: 3,
    smallTargetPx: 24,
    noiseFloorPx: 5,
  },
  keyboard: {
    wpm: 240,
    holdMinMs: 55,
    holdMaxMs: 125,
    gapMinMs: 45,
    gapMaxMs: 125,
    wordPauseMs: 45,
    punctPauseMs: 220,
    sentencePauseMs: 620,
    typoRate: 0.012,
  },
  scroll: {
    burstMin: 2,
    burstMax: 6,
    amplitudeMinPx: 40,
    amplitudeMaxPx: 320,
    pauseMinMs: 90,
    pauseMaxMs: 400,
    regressionRate: 0.25,
  },
  attention: { readWpm: 260, tabChurnPerMin: 1.5, blurRate: 0.08, pointerOutRate: 0.05 },
};

/** Presets differ in numbers only; each name says which part of the body it changed. */
export const PRESETS: Record<string, Omit<HumanProfile, 'name' | 'seed'>> = {
  calm: structuredClone(BASE),
  fast: {
    ...structuredClone(BASE),
    pointer: { ...BASE.pointer, aMs: 110, bMs: 70, settleMs: 40, idleStillnessMs: 260 },
    keyboard: { ...BASE.keyboard, wpm: 330, gapMinMs: 30, gapMaxMs: 80, typoRate: 0.02 },
    scroll: { ...BASE.scroll, amplitudeMaxPx: 420, pauseMaxMs: 240 },
  },
  impatient: {
    ...structuredClone(BASE),
    pointer: { ...BASE.pointer, aMs: 80, bMs: 55, settleMs: 25, sigmaCurvePx: 34, overshootPx: 16 },
    keyboard: { ...BASE.keyboard, wpm: 380, typoRate: 0.035, punctPauseMs: 110, sentencePauseMs: 260 },
    attention: { ...BASE.attention, readWpm: 420, tabChurnPerMin: 4 },
  },
  one_handed: {
    ...structuredClone(BASE),
    pointer: { ...BASE.pointer, aMs: 230, bMs: 150, sigmaCurvePx: 110, overshootPx: 18, driftPx: 5 },
    keyboard: { ...BASE.keyboard, wpm: 150, typoRate: 0.05, gapMaxMs: 220 },
  },
  touchpad: {
    ...structuredClone(BASE),
    pointer: { ...BASE.pointer, aMs: 150, bMs: 95, sigmaCurvePx: 26, overshootPx: 4, settleMs: 90 },
    scroll: { ...BASE.scroll, amplitudeMinPx: 12, amplitudeMaxPx: 90, burstMin: 3, burstMax: 9, regressionRate: 0.4 },
  },
  tired: {
    ...structuredClone(BASE),
    pointer: { ...BASE.pointer, aMs: 260, bMs: 160, settleMs: 120, idleStillnessMs: 520 },
    keyboard: { ...BASE.keyboard, wpm: 165, typoRate: 0.045, wordPauseMs: 90, sentencePauseMs: 1100 },
    attention: { ...BASE.attention, readWpm: 180, tabChurnPerMin: 3.5 },
  },
};

/** A 32-bit seed from the platform RNG. Profiles are reproducible; sessions are not. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

/** Deterministic 32-bit PRNG. Same seed, same sequence — that is the whole point of passing it around. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x668e1ded) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

function clamp(name: string, value: unknown, [min, max]: readonly [number, number]): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProfileError(`${name} must be a finite number, got ${JSON.stringify(value)}`);
  }
  if (value < min || value > max) {
    throw new ProfileError(`${name} = ${value} is outside the supported range ${min}..${max}`);
  }
  return value;
}

export interface ProfileInput {
  name?: string;
  preset?: string;
  seed?: number;
  max_runtime_ms?: number;
  pointer?: Partial<PointerProfile>;
  keyboard?: Partial<KeyboardProfile>;
  scroll?: Partial<ScrollProfile>;
  attention?: Partial<AttentionProfile>;
}

/**
 * Build a profile from a preset plus overrides, checking every number.
 *
 * A profile is not validated at the point of use: a driver three actions deep failing because someone
 * passed `wpm: 5000` is worse than refusing the profile. The ranges in `LIMITS` are where a value stops
 * describing a hand and starts describing a script.
 */
export function createProfile(input: ProfileInput = {}): HumanProfile {
  const presetName = input.preset ?? 'calm';
  const base = PRESETS[presetName];
  if (!base) {
    throw new ProfileError(`unknown preset "${presetName}" — known: ${Object.keys(PRESETS).sort().join(', ')}`);
  }
  const p = structuredClone(base);
  const seed = input.seed === undefined ? randomSeed() : Math.trunc(clamp('seed', input.seed, [0, 0xffffffff]));

  const profile: HumanProfile = {
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 60) : presetName,
    seed,
    maxRuntimeMs: Math.trunc(clamp('max_runtime_ms', input.max_runtime_ms ?? p.maxRuntimeMs, LIMITS.maxRuntimeMs)),
    pointer: {
      aMs: clamp('pointer.aMs', input.pointer?.aMs ?? p.pointer.aMs, LIMITS.aMs),
      bMs: clamp('pointer.bMs', input.pointer?.bMs ?? p.pointer.bMs, LIMITS.bMs),
      sigmaCurvePx: clamp(
        'pointer.sigmaCurvePx',
        input.pointer?.sigmaCurvePx ?? p.pointer.sigmaCurvePx,
        LIMITS.sigmaCurvePx,
      ),
      overshootPx: clamp(
        'pointer.overshootPx',
        input.pointer?.overshootPx ?? p.pointer.overshootPx,
        LIMITS.overshootPx,
      ),
      settleMs: clamp('pointer.settleMs', input.pointer?.settleMs ?? p.pointer.settleMs, LIMITS.settleMs),
      idleStillnessMs: Math.trunc(
        clamp(
          'pointer.idleStillnessMs',
          input.pointer?.idleStillnessMs ?? p.pointer.idleStillnessMs,
          LIMITS.idleStillnessMs,
        ),
      ),
      driftPx: clamp('pointer.driftPx', input.pointer?.driftPx ?? p.pointer.driftPx, LIMITS.driftPx),
      smallTargetPx: clamp(
        'pointer.smallTargetPx',
        input.pointer?.smallTargetPx ?? p.pointer.smallTargetPx,
        LIMITS.smallTargetPx,
      ),
      noiseFloorPx: clamp(
        'pointer.noiseFloorPx',
        input.pointer?.noiseFloorPx ?? p.pointer.noiseFloorPx,
        LIMITS.noiseFloorPx,
      ),
    },
    keyboard: {
      wpm: clamp('keyboard.wpm', input.keyboard?.wpm ?? p.keyboard.wpm, LIMITS.wpm),
      holdMinMs: clamp('keyboard.holdMinMs', input.keyboard?.holdMinMs ?? p.keyboard.holdMinMs, LIMITS.holdMs),
      holdMaxMs: clamp('keyboard.holdMaxMs', input.keyboard?.holdMaxMs ?? p.keyboard.holdMaxMs, LIMITS.holdMs),
      gapMinMs: clamp('keyboard.gapMinMs', input.keyboard?.gapMinMs ?? p.keyboard.gapMinMs, LIMITS.gapMs),
      gapMaxMs: clamp('keyboard.gapMaxMs', input.keyboard?.gapMaxMs ?? p.keyboard.gapMaxMs, LIMITS.gapMs),
      wordPauseMs: clamp('keyboard.wordPauseMs', input.keyboard?.wordPauseMs ?? p.keyboard.wordPauseMs, LIMITS.gapMs),
      punctPauseMs: clamp(
        'keyboard.punctPauseMs',
        input.keyboard?.punctPauseMs ?? p.keyboard.punctPauseMs,
        LIMITS.gapMs,
      ),
      sentencePauseMs: clamp(
        'keyboard.sentencePauseMs',
        input.keyboard?.sentencePauseMs ?? p.keyboard.sentencePauseMs,
        LIMITS.gapMs,
      ),
      typoRate: clamp('keyboard.typoRate', input.keyboard?.typoRate ?? p.keyboard.typoRate, LIMITS.typoRate),
    },
    scroll: {
      burstMin: Math.trunc(clamp('scroll.burstMin', input.scroll?.burstMin ?? p.scroll.burstMin, [1, 20])),
      burstMax: Math.trunc(clamp('scroll.burstMax', input.scroll?.burstMax ?? p.scroll.burstMax, [1, 40])),
      amplitudeMinPx: clamp(
        'scroll.amplitudeMinPx',
        input.scroll?.amplitudeMinPx ?? p.scroll.amplitudeMinPx,
        [1, 2000],
      ),
      amplitudeMaxPx: clamp(
        'scroll.amplitudeMaxPx',
        input.scroll?.amplitudeMaxPx ?? p.scroll.amplitudeMaxPx,
        [1, 4000],
      ),
      pauseMinMs: clamp('scroll.pauseMinMs', input.scroll?.pauseMinMs ?? p.scroll.pauseMinMs, LIMITS.gapMs),
      pauseMaxMs: clamp('scroll.pauseMaxMs', input.scroll?.pauseMaxMs ?? p.scroll.pauseMaxMs, LIMITS.gapMs),
      regressionRate: clamp('scroll.regressionRate', input.scroll?.regressionRate ?? p.scroll.regressionRate, [0, 1]),
    },
    attention: {
      readWpm: clamp('attention.readWpm', input.attention?.readWpm ?? p.attention.readWpm, LIMITS.readWpm),
      tabChurnPerMin: clamp(
        'attention.tabChurnPerMin',
        input.attention?.tabChurnPerMin ?? p.attention.tabChurnPerMin,
        LIMITS.tabChurnPerMin,
      ),
      blurRate: clamp('attention.blurRate', input.attention?.blurRate ?? p.attention.blurRate, [0, 1]),
      pointerOutRate: clamp(
        'attention.pointerOutRate',
        input.attention?.pointerOutRate ?? p.attention.pointerOutRate,
        [0, 1],
      ),
    },
  };

  // Order relationships the clamps cannot see: a max below its min is a profile that would throw at every
  // draw, far from here.
  if (profile.scroll.burstMax < profile.scroll.burstMin) {
    throw new ProfileError(
      `scroll.burstMax (${profile.scroll.burstMax}) must be >= scroll.burstMin (${profile.scroll.burstMin})`,
    );
  }
  if (profile.scroll.amplitudeMaxPx < profile.scroll.amplitudeMinPx) {
    throw new ProfileError(
      `scroll.amplitudeMaxPx (${profile.scroll.amplitudeMaxPx}) must be >= amplitudeMinPx (${profile.scroll.amplitudeMinPx})`,
    );
  }
  if (profile.keyboard.holdMaxMs < profile.keyboard.holdMinMs) {
    throw new ProfileError('keyboard.holdMaxMs must be >= holdMinMs');
  }
  if (profile.keyboard.gapMaxMs < profile.keyboard.gapMinMs) {
    throw new ProfileError('keyboard.gapMaxMs must be >= gapMinMs');
  }
  if (profile.scroll.pauseMaxMs < profile.scroll.pauseMinMs) {
    throw new ProfileError('scroll.pauseMaxMs must be >= pauseMinMs');
  }
  return profile;
}

/** The same numbers, in the order a reader of a report expects: what was asked, not what was felt. */
export function profileSummary(profile: HumanProfile): Record<string, unknown> {
  return {
    name: profile.name,
    seed: profile.seed,
    max_runtime_ms: profile.maxRuntimeMs,
    pointer: profile.pointer,
    keyboard: profile.keyboard,
    scroll: profile.scroll,
    attention: profile.attention,
  };
}
