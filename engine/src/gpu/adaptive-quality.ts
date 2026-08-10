// ═══ Adaptive quality — measured frame time → an ordered degradation ladder ═══
//
// The quality presets are a STATIC bet on the host's hardware, and the map has no
// way to know that bet was wrong. So: watch the rendered-frame interval, and when
// the map has been over budget for a sustained stretch, step DOWN the ladder below;
// step back up when it has been comfortably fast for a sustained stretch. This is
// the dynamic-quality design every mature engine ships (Unreal/Unity/Frostbite), and
// it is deliberately NOT a per-frame continuous controller — each change costs real
// work (a swapchain reallocation, or a re-tile), so it moves in discrete notches
// with a hysteresis gap.
//
// ## Why ONE controller with TWO levers, and why in this order
//
// Two independent controllers on one signal fight: each reads the other's improvement
// as its own success and keeps going. So there is a single ladder, and each notch
// says what the host gets at that level.
//
// FAR-FIELD LOD is spent BEFORE device pixels. Coarsening tiles several camera
// altitudes away is close to invisible — they are already metres-per-pixel — while
// lowering DPR blurs what it covers. Since #1429 INC-2 the DPR lever scales the
// SCENE target only on the WebGPU chain (the overlay composites at native
// resolution over the upscaled scene); on the WebGL2 twin it still scales the
// canvas, so there the whole frame — labels included — softens. The map spends
// its horizon before it spends the user's legibility either way.
//
// Neither lever alone is enough, which is why both are on the ladder:
//   * DPR bottoms out. Measured on a dense OpenFreeMap Bright building scene (Paris
//     z16, pitch 70), quartering the device pixels took the frame 3.84 s -> 1.61 s —
//     a 2.38x win, but ~25% of that frame is not pixel-proportional at all, and 1.61 s
//     is still nowhere near a budget. Past the floor, more DPR buys nothing.
//   * The LOD lever is inert on an UNPITCHED view, by construction. The far-field
//     ceiling engages by DISTANCE (`FAR_RAMP_NEAR`, data/tiles-sse.ts), and with a 45°
//     FOV an unpitched frame lies entirely inside that radius — there is no far field
//     to spend. That is the right behaviour, not a gap: at pitch 0 everything on
//     screen IS foreground, so the only LOD left to take is the detail the user is
//     looking straight at. Flat dense scenes are the DPR lever's job.
//
// ## Why this cannot oscillate
//
// Three independent properties, each load-bearing:
//
//   1. HYSTERESIS GAP. Degrading needs a median above `DEGRADE_MS`; restoring needs
//      one below `RESTORE_MS`, and `RESTORE_MS < DEGRADE_MS`. A scene sitting on a
//      single threshold cannot satisfy both, so it settles instead of hunting.
//   2. WINDOW CLEAR ON CHANGE. The samples that justified a change were measured at
//      the OLD notch; leaving them in would immediately re-justify the reverse move.
//      Every change empties the window, so the next decision is made purely from
//      frames rendered at the new notch.
//   3. MEDIAN, NOT MEAN. One catastrophic frame (a tab resume, a style recompile, a
//      GC pause) cannot drag the statistic across a threshold on its own.
//
// The notch is a page-global singleton for the same reason the quality policy is: it
// describes the HOST's capability, so it must survive a device-lost re-boot or an SPA
// remount rather than re-learning the machine is slow every time.
//
// ## Why the NOTCH is global but the SAMPLE WINDOW is not (#1567)
//
// The paragraph above is the reason this file does NOT reset on a map boot, and it
// stands. What did not follow from it is the sample ring being shared too. Two
// concurrent maps are a supported configuration (mvt-worker-pool.ts reasons about
// "two maps" explicitly), and they interleaved their per-map frame intervals into
// ONE 12-slot window — so the median described neither map, and a fast map could
// deny a struggling sibling its degrade by filling the window with its own good
// frames. Each frame-clock source now keeps its own ring, keyed by a token it
// passes in; the LEARNED NOTCH stays process-global exactly as the paragraph above
// requires.
//
// The rings live in a WeakMap keyed by that token, so a ring dies with the object
// that feeds it — no registry to enumerate and no teardown call to forget. Property
// 2 (WINDOW CLEAR ON CHANGE) still holds across every source: a notch change bumps
// a generation counter, and a ring whose generation is stale clears itself before
// accepting its next sample. That is the same invariant, applied lazily, and it is
// what stops map B's pre-change samples from immediately re-justifying the reverse
// move for map A.

/** The degradation ladder. Descending quality; index 0 is untouched.
 *
 *  `farLod` multiplies the far-field screen-space-error ceiling the tile selector
 *  already computes — a MULTIPLIER, not an absolute, so it composes with the
 *  pitch/zoom ramp that ceiling is derived from instead of overriding it. `dpr`
 *  multiplies the device-pixel cap.
 *
 *  The two pure-LOD notches come first (see the header). ~0.85 DPR steps keep each
 *  pixel move worth its swapchain reallocation while staying below the threshold
 *  where one step reads as jarring; 0.5 is the floor — a blurry map beats a frozen
 *  one, but below it the non-pixel-proportional part of the frame dominates anyway. */
const LADDER: readonly { readonly farLod: number; readonly dpr: number }[] = [
  { farLod: 1, dpr: 1 },
  { farLod: 2, dpr: 1 },
  { farLod: 4, dpr: 1 },
  { farLod: 4, dpr: 0.85 },
  { farLod: 4, dpr: 0.72 },
  { farLod: 6, dpr: 0.6 },
  { farLod: 6, dpr: 0.5 },
]

/** Sustained median frame interval above this ⇒ step down. 33.4 ms is the 30 fps
 *  line: the point where motion stops reading as smooth and the user calls it lag.
 *  Deliberately NOT the 60 fps line — degrading a map that is merely not-perfect
 *  would trade fidelity every mid-range machine did not ask to lose. */
const DEGRADE_MS = 33.4

/** Sustained median below this ⇒ step back up. The gap to {@link DEGRADE_MS} is the
 *  hysteresis: a scene must be comfortably fast (≈50 fps), not marginally fast,
 *  before paying to buy fidelity back. */
const RESTORE_MS = 20

/** Frames per decision. Full window required, so nothing moves on a burst of a few
 *  bad frames. At 60 fps that is 0.2 s; on genuinely broken hardware (4 fps) it is
 *  3 s — slow enough to be sure, fast enough that the user is not left in the jank. */
const WINDOW = 12

/** One frame-clock source's sample window. `gen` is the notch generation the ring
 *  was filled under; a stale one clears before its next sample (see the header). */
interface SampleRing {
  readonly samples: Float64Array
  count: number
  write: number
  gen: number
}

/** Per-source rings. WeakMap so a ring is reclaimed with the object that feeds it —
 *  a destroyed map's window cannot outlive it and there is nothing to unregister. */
const rings = new WeakMap<object, SampleRing>()

/** The ring for callers that pass no token — the single-map case and every unit
 *  test. Shared, but shared by exactly the callers that could not tell two sources
 *  apart anyway. */
const DEFAULT_SOURCE: object = Object.freeze({})

let stepIndex = 0
let enabled = true
/** Bumped on every notch change. See header property 2 — this is what clears every
 *  source's window, not just the one whose sample triggered the change. */
let notchGen = 0
/** Scratch buffer for the median so a per-frame decision allocates nothing. */
const sorted = new Float64Array(WINDOW)

function ringFor(source: object): SampleRing {
  let r = rings.get(source)
  if (r === undefined) {
    r = { samples: new Float64Array(WINDOW), count: 0, write: 0, gen: notchGen }
    rings.set(source, r)
  } else if (r.gen !== notchGen) {
    // Lazy window clear: these samples were measured at a different notch.
    r.count = 0
    r.write = 0
    r.gen = notchGen
  }
  return r
}

/** Turn the controller on/off. Off pins the ladder at notch 0 and drops every sample,
 *  so a host that opts out gets byte-identical behaviour to before this existed. */
export function setAdaptiveQualityEnabled(on: boolean): void {
  enabled = on
  if (!on) reset(0)
}

/** Whether the controller is currently allowed to act. */
export function isAdaptiveQualityEnabled(): boolean {
  return enabled
}

function reset(nextStep: number): void {
  stepIndex = nextStep
  // Every source's window is now stale — see header property 2. Bumping the
  // generation invalidates all of them at once without holding strong refs.
  notchGen++
}

/** The multiplier the DPR policy applies. 1 until the controller has proof the host
 *  cannot keep up. Read every frame — cheap by construction (a single array index). */
export function adaptiveDprScale(): number {
  return (LADDER[stepIndex] as { dpr: number }).dpr
}

/** The multiplier the tile selector applies to its FAR-FIELD error ceiling. 1 leaves
 *  selection byte-identical; higher coarsens the horizon and leaves the foreground
 *  alone (that ceiling is distance-graded — the near field never sees this). */
export function adaptiveFarLodBoost(): number {
  return (LADDER[stepIndex] as { farLod: number }).farLod
}

/** How many notches down the controller currently is (0 = untouched). Exposed for
 *  diagnostics/tests so a gate can assert the controller ACTED, not merely that a
 *  frame got faster. */
export function adaptiveQualityStep(): number {
  return stepIndex
}

/** Test seam — forget everything the controller learned. */
export function _resetAdaptiveQualityForTests(): void {
  enabled = true
  reset(0)
}

/** Feed one RENDERED-frame interval (ms) — called once per frame by the render loop.
 *
 *  RENDERED frames, not rAF ticks: the interval between frames the map actually drew
 *  is the only signal that includes the GPU work this thread merely submits, and an
 *  idle map's ticks are cheap BY DEFINITION — sampling those would let a map sitting
 *  still convince the controller the machine is fast and undo a degrade the user
 *  needs. Returns true when the notch changed, so the caller can react without
 *  diffing the value itself.
 *
 *  `source` identifies the frame clock feeding this sample (#1567). Pass the object
 *  that owns the clock — one map's RenderStats — so two concurrent maps keep
 *  separate windows and the median describes ONE map's frames instead of an
 *  interleave of both. Omitting it is correct for a single map and for tests. */
export function noteFrameInterval(dtMs: number, source?: object): boolean {
  if (!enabled) return false
  // A non-finite or non-positive delta is a clock artifact, not a frame cost.
  if (!(dtMs > 0) || !Number.isFinite(dtMs)) return false
  // #1567 — one ring per frame-clock source. Callers that pass nothing share
  // DEFAULT_SOURCE, which is the pre-existing behaviour for a single map.
  const ring = ringFor(source ?? DEFAULT_SOURCE)
  const { samples } = ring
  samples[ring.write] = dtMs
  ring.write = (ring.write + 1) % WINDOW
  if (ring.count < WINDOW) ring.count++
  if (ring.count < WINDOW) return false

  sorted.set(samples)
  sorted.sort()
  // Even window ⇒ take the lower middle. Biasing to the FASTER of the two middles
  // makes the controller conservative about degrading, which is the direction where
  // a wrong call costs the user visible fidelity.
  const median = sorted[WINDOW / 2 - 1] as number

  if (median > DEGRADE_MS && stepIndex < LADDER.length - 1) {
    reset(stepIndex + 1)
    return true
  }
  if (median < RESTORE_MS && stepIndex > 0) {
    reset(stepIndex - 1)
    return true
  }
  return false
}
