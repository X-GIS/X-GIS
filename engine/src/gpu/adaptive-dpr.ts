// ═══ Adaptive resolution scaling — measured frame time → device-pixel budget ═══
//
// The quality presets are a STATIC bet on the host's hardware, and the map has no
// way to know that bet was wrong. Measured on a dense OpenFreeMap Bright building
// scene (Paris z16, pitch 70), the frame cost is dominated by the number of device
// pixels: quartering them took the frame from ~3.84 s to ~1.61 s (a 2.38× win, so
// ≈75% of the frame is pixel-proportional and ≈25% is fixed CPU/geometry), and the
// pitched 3D-building view costs ~74% more than the same scene flat. Pixels are
// therefore the lever, and DPR is the only pixel knob that can move at runtime —
// MSAA is baked into every pipeline at build time and changing it costs a
// 100–300 ms rebuild, which is not something a frame-rate controller may do.
//
// So: watch the rendered-frame interval, and when the map has been over budget for
// a sustained stretch, step the device-pixel scale down; step it back up when the
// map has been comfortably fast for a sustained stretch. This is the dynamic-
// resolution-scaling design every mature engine ships (Unreal/Unity/Frostbite), and
// it is deliberately NOT a per-frame continuous controller — each change reallocates
// the swapchain, so the scale moves in discrete notches with a hysteresis gap.
//
// ## Why this cannot oscillate
//
// Three independent properties, each load-bearing:
//
//   1. HYSTERESIS GAP. Degrading needs a median above `DEGRADE_MS`; restoring needs
//      one below `RESTORE_MS`, and `RESTORE_MS < DEGRADE_MS`. A scene sitting on a
//      single threshold cannot satisfy both, so it settles instead of hunting.
//   2. WINDOW CLEAR ON CHANGE. The samples that justified a change were measured at
//      the OLD scale; leaving them in would immediately re-justify the reverse move.
//      Every change empties the window, so the next decision is made purely from
//      frames rendered at the new scale.
//   3. MEDIAN, NOT MEAN. One catastrophic frame (a tab resume, a style recompile, a
//      GC pause) cannot drag the statistic across a threshold on its own.
//
// The scale is a page-global singleton for the same reason the quality policy is:
// it describes the HOST's capability, so it must survive a device-lost re-boot or an
// SPA remount rather than re-learning the machine is slow every time.

/** Device-pixel scale notches. Descending, starting at 1 (untouched). Discrete
 *  because every change reallocates the swapchain; ~0.85 steps keep each move
 *  worth its cost while staying below the threshold where a single step is
 *  visually jarring. The last entry is the floor — a blurry map beats a frozen
 *  one, but past this point the fixed per-frame cost dominates anyway and further
 *  shrinking buys nothing (the measured scene was only ~75% pixel-proportional). */
const STEPS: readonly number[] = [1, 0.85, 0.72, 0.6, 0.5]

/** Sustained median frame interval above this ⇒ step down. 33.4 ms is the 30 fps
 *  line: the point where motion stops reading as smooth and the user calls it lag.
 *  Deliberately NOT the 60 fps line — degrading a map that is merely not-perfect
 *  would trade fidelity every mid-range machine did not ask to lose. */
const DEGRADE_MS = 33.4

/** Sustained median below this ⇒ step back up. The gap to {@link DEGRADE_MS} is the
 *  hysteresis: a scene must be comfortably fast (≈50 fps), not marginally fast,
 *  before paying a swapchain reallocation to buy fidelity back. */
const RESTORE_MS = 20

/** Frames per decision. Full window required, so nothing moves on a burst of a few
 *  bad frames. At 60 fps that is 0.2 s; on genuinely broken hardware (4 fps) it is
 *  3 s — slow enough to be sure, fast enough that the user is not left in the jank. */
const WINDOW = 12

const samples = new Float64Array(WINDOW)
let count = 0
let write = 0
let stepIndex = 0
let enabled = true
/** Scratch buffer for the median so a per-frame decision allocates nothing. */
const sorted = new Float64Array(WINDOW)

/** Turn the controller on/off. Off pins the scale at 1 and drops every sample, so
 *  a host that opts out gets byte-identical behaviour to before this existed. */
export function setAdaptiveDprEnabled(on: boolean): void {
  enabled = on
  if (!on) reset(0)
}

/** Whether the controller is currently allowed to act. */
export function isAdaptiveDprEnabled(): boolean {
  return enabled
}

function reset(nextStep: number): void {
  stepIndex = nextStep
  count = 0
  write = 0
}

/** The multiplier the DPR policy applies. 1 until the controller has proof the host
 *  cannot keep up. Read every frame — cheap by construction (a single array index). */
export function adaptiveDprScale(): number {
  return STEPS[stepIndex] as number
}

/** How many notches down the controller currently is (0 = untouched). Exposed for
 *  diagnostics/tests so a gate can assert the controller ACTED, not merely that a
 *  frame got faster. */
export function adaptiveDprStep(): number {
  return stepIndex
}

/** Test seam — forget everything the controller learned. */
export function _resetAdaptiveDprForTests(): void {
  enabled = true
  reset(0)
}

/** Feed one RENDERED-frame interval (ms) — called once per frame by the render loop.
 *
 *  RENDERED frames, not rAF ticks: the interval between frames the map actually drew
 *  is the only signal that includes the GPU work this thread merely submits, and an
 *  idle map's ticks are cheap BY DEFINITION — sampling those would let a map sitting
 *  still convince the controller the machine is fast and undo a degrade the user
 *  needs. Returns true when the scale changed, so the caller can react without
 *  diffing the value itself. */
export function noteFrameInterval(dtMs: number): boolean {
  if (!enabled) return false
  // A non-finite or non-positive delta is a clock artifact, not a frame cost.
  if (!(dtMs > 0) || !Number.isFinite(dtMs)) return false
  samples[write] = dtMs
  write = (write + 1) % WINDOW
  if (count < WINDOW) count++
  if (count < WINDOW) return false

  sorted.set(samples)
  sorted.sort()
  // Even window ⇒ take the lower middle. Biasing to the FASTER of the two middles
  // makes the controller conservative about degrading, which is the direction where
  // a wrong call costs the user visible fidelity.
  const median = sorted[WINDOW / 2 - 1] as number

  if (median > DEGRADE_MS && stepIndex < STEPS.length - 1) {
    reset(stepIndex + 1)
    return true
  }
  if (median < RESTORE_MS && stepIndex > 0) {
    reset(stepIndex - 1)
    return true
  }
  return false
}
