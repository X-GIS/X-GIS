// ═══ IBFV advection step parameters (#1333) ═══
//
// Turns "this coverage, this frame" into the four numbers `flow-advect.ts` consumes. Pure
// arithmetic, no GPU — so the part that is easy to get silently wrong is testable here rather
// than only visible as a skewed animation on a screen this environment does not have.
//
// TWO THINGS THIS DELIBERATELY IS NOT:
//
// 1. NOT a physical simulation. The pack already normalized the components by the field's peak
//    speed, so what reaches the shader is a RATIO, not m/s. Advecting at the true rate would be
//    invisible anyway — 0.5 kn over a 60 km cell moves ~4 mm in a 16 ms frame — so `ratePerSec`
//    is a DISPLAY control: "uv travelled per second at the field's peak speed". The relative
//    reading is preserved exactly (twice the speed still moves twice as far); only the absolute
//    rate is a choice, and it is the one a human tunes by looking.
//
// 2. NOT isotropic by accident. uv.x and uv.y span different TRUE distances — a cell 2° wide and
//    1° tall is not square on the ground, and a degree of longitude shrinks by cos(latitude).
//    Dividing both axes by the same number would shear the flow: a current heading northeast
//    would drift at the wrong angle. The aspect is folded in below, which is why stepX and stepY
//    differ even for a square grid away from the equator.

/** The four floats the advect shader reads, in its uniform's own order. */
export interface FlowAdvectParams {
  /** uv.x displacement per frame at a normalized east component of 1. */
  stepX: number
  /** uv.y displacement per frame at a normalized north component of 1. */
  stepY: number
  /** Multiplier applied to the advected history each frame — the trail's decay. */
  decay: number
  /** Weight of the freshly injected noise each frame. */
  inject: number
}

export interface FlowAdvectInput {
  /** Grid extent in degrees: [lonSpan, latSpan] = size × spacing. */
  spanDeg: readonly [number, number]
  /** Latitude at the middle of the cell, degrees — the cos() the longitude span is scaled by. */
  midLatDeg: number
  /** Seconds since the previous advection step. */
  dtSeconds: number
  /** Display rate: uv travelled per second at the field's peak speed. */
  ratePerSec: number
  decay: number
  inject: number
}

const DEG2RAD = Math.PI / 180

/** Longitude spans collapse toward the poles; clamped so a cell touching 90° cannot divide by
 *  zero and fling the whole field across the grid in one frame. cos(89.9°) ≈ 1.7e-3, still a
 *  ~570× amplification, which the caller's `ratePerSec` is expected to be sane about. */
const MIN_COS_LAT = Math.cos(89.9 * DEG2RAD)

/** A frame delta this long is treated as a hitch (tab restored, GC pause) rather than as real
 *  elapsed time. Advecting by it would teleport the field and destroy the history in one step;
 *  a recursive filter cannot recover from that the way a stateless one would. */
export const FLOW_MAX_DT_SECONDS = 0.1

export function flowAdvectParams(input: FlowAdvectInput): FlowAdvectParams {
  const [spanLon, spanLat] = input.spanDeg
  const dt = Math.min(Math.max(input.dtSeconds, 0), FLOW_MAX_DT_SECONDS)
  const travel = input.ratePerSec * dt

  // True-distance spans, in units of "degrees of latitude" (the common 111 km factor cancels,
  // because only the RATIO between the two axes shapes the flow — the absolute scale lives in
  // ratePerSec).
  const cosLat = Math.max(Math.abs(Math.cos(input.midLatDeg * DEG2RAD)), MIN_COS_LAT)
  const trueLon = Math.abs(spanLon) * cosLat
  const trueLat = Math.abs(spanLat)

  return {
    stepX: trueLon > 0 ? travel / trueLon : 0,
    stepY: trueLat > 0 ? travel / trueLat : 0,
    decay: input.decay,
    inject: input.inject,
  }
}
