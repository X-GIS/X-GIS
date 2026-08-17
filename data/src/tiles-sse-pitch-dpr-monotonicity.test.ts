// ═══ SSE selector — pitch/DPR monotonicity (#1379 closure) ═══
//
// #1379 was filed as "tile selection swings 3x on 1-degree pitch steps at
// high pitch". Root-caused (issue comment 5106897620, backed by
// `scripts/probe-tile-selection-dpr.ts`, landed #1756): at FIXED dpr the
// selector is essentially monotone in pitch (41->84 deg: 1 decrease in 43
// transitions, magnitude 1). The swing was the adaptive-quality ladder
// changing DPR during the repro's ~1.1s settle window (same root cause as
// the closed #1479) — selection genuinely IS sensitive to DPR (measured
// ~4x at pitch 70, dpr 1->3), by design (retina wants more detail), and the
// repro's sweep silently compared frames rendered at different DPRs.
//
// This file pins the three facts the diagnosis established, driving
// `visibleTilesSSE` directly (pure CPU — camera, projection, maxZ, canvas,
// dpr; no archive, no GPU, no browser):
//
//   (a) at fixed dpr/CSS-viewport, sweeping pitch is near-monotone.
//   (b) selection IS sensitive to dpr by construction — pitch 70 selects
//       more than 2x as many tiles at dpr=3 as at dpr=1.
//   (c) FAIL-BEFORE witness: driving the SAME pitch sweep with dpr
//       alternating 0.85/0.7 (the adaptive ladder's actual notch pair, per
//       the issue) blows through (a)'s bound and reproduces a >=40% swing —
//       proving the gate in (a) distinguishes the ladder artifact from the
//       fixed-dpr truth, rather than passing either way.
//
// The camera fixture reproduces #1379's exact repro camera
// (`physical_map` #10.35/30.94337/118.42256/356.5) with a REAL perspective
// MVP — mirrors `map/src/camera/view-matrix.ts`'s `horizonBoundedFar` +
// the flat-Mercator branch of `buildRTCMatrix` — rather than a synthetic
// flat one, because the bug lived in the interaction between
// pitch-dependent altitude/far and dpr; a placeholder MVP would not
// reproduce it. Duplicated, not imported: `@xgis/data` must not depend on
// `@xgis/map` (see `TileSelectionCamera`'s doc comment in
// tile-select-types.ts), so the pure matrix math is mirrored here instead.
// Cross-checked standalone against the issue's own reported numbers (pitch
// 70: dpr 1 -> 26, dpr 3 -> 104; pitch sweep: 1 decrease of magnitude 1)
// before being folded into this suite.

import { describe, it, expect } from 'vitest'
import { visibleTilesSSE } from './tiles-sse'
import { mercator, lonLatToMercator, WORLD_MERC, TILE_PX } from '@xgis/geo'
import { CAMERA_FOV_DEG, mul4, perspectiveMatrix } from '@xgis/shared'
import type { TileSelectionCamera } from './tile-select-types'

// ── #1379's repro camera (matches scripts/probe-tile-selection-dpr.ts) ──
const LAT = 30.94337
const LON = 118.42256
const ZOOM = 10.35
const BEARING = 356.5
const CSS_W = 430
const CSS_H = 715
const MAX_Z = 12
const [CENTER_X, CENTER_Y] = lonLatToMercator(LON, LAT)

// ── Pure camera-matrix math, mirrored from map/src/camera/view-matrix.ts
// (`horizonBoundedFar` + the flat-Mercator branch of `buildRTCMatrix`).
// Not re-derived — copied so a drift from the real camera math is a
// decision, not an accident.

const MAX_MERCATOR_HORIZON_ANGLE_RAD = (89.25 * Math.PI) / 180
const MIN_FOV_CENTER_TO_HORIZON_RAD = ((90 - 89.25) * Math.PI) / 180
const clampAngle = (a: number): number => Math.min(Math.PI - 0.01, Math.max(0.01, a))

function horizonBoundedFar(altitude: number, pitchRad: number, halfFovRad: number): number {
  const limitedPitch = Math.min(pitchRad, MAX_MERCATOR_HORIZON_ANGLE_RAD)
  const centreDistance = altitude
  const groundAngle = Math.PI / 2 + limitedPitch
  const horizonOverCentre = Math.min(
    Math.tan(Math.PI / 2 - pitchRad) * 0.85,
    Math.tan(MAX_MERCATOR_HORIZON_ANGLE_RAD - pitchRad),
  )
  const fovCentreToHorizon = Math.max(Math.atan(horizonOverCentre), MIN_FOV_CENTER_TO_HORIZON_RAD)
  const topHalfToHorizon =
    (Math.sin(fovCentreToHorizon) * centreDistance) /
    Math.sin(clampAngle(Math.PI - groundAngle - fovCentreToHorizon))
  const topHalfToFovEdge =
    (Math.sin(halfFovRad) * centreDistance) /
    Math.sin(clampAngle(Math.PI - groundAngle - halfFovRad))
  return (
    (Math.sin(limitedPitch) * Math.min(topHalfToHorizon, topHalfToFovEdge) + centreDistance) * 1.01
  )
}

function buildRTCMatrix(
  pitchDeg: number,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number,
): { matrix: Float32Array; far: number } {
  const metersPerPixel = WORLD_MERC / TILE_PX / Math.pow(2, ZOOM)
  const fovRad = (CAMERA_FOV_DEG * Math.PI) / 180
  const halfFov = fovRad / 2
  const aspect = canvasWidth / canvasHeight
  const pitchRad = (pitchDeg * Math.PI) / 180
  const bearingRad = (BEARING * Math.PI) / 180

  const rawViewHeightMeters = (canvasHeight / dpr) * metersPerPixel
  const viewHeightMeters = Math.min(rawViewHeightMeters, WORLD_MERC)
  const altitude = viewHeightMeters / 2 / Math.tan(halfFov)

  const near = Math.max(1.0, altitude * 0.01)
  const far = horizonBoundedFar(altitude, pitchRad, halfFov)

  const f = 1 / Math.tan(halfFov)
  const P = perspectiveMatrix(f, near, far, aspect, new Array(16).fill(0))

  const T = new Array(16).fill(0)
  T[0] = 1
  T[5] = 1
  T[10] = 1
  T[15] = 1
  T[14] = -altitude

  const cp = Math.cos(-pitchRad)
  const sp = Math.sin(-pitchRad)
  const Rx = new Array(16).fill(0)
  Rx[0] = 1
  Rx[5] = cp
  Rx[6] = sp
  Rx[9] = -sp
  Rx[10] = cp
  Rx[15] = 1

  const cb = Math.cos(bearingRad)
  const sb = Math.sin(bearingRad)
  const Rz = new Array(16).fill(0)
  Rz[0] = cb
  Rz[1] = sb
  Rz[4] = -sb
  Rz[5] = cb
  Rz[10] = 1
  Rz[15] = 1

  const t1 = new Array(16).fill(0)
  const t2 = new Array(16).fill(0)
  const t3 = new Array(16).fill(0)
  mul4(t1, Rx, Rz)
  mul4(t2, T, t1)
  mul4(t3, P, t2)
  return { matrix: Float32Array.from(t3), far }
}

/** The issue's repro camera at a given pitch — a real perspective MVP, not a
 *  placeholder, so pitch/dpr/altitude/far interact exactly as they do live. */
function repoCamera(pitch: number): TileSelectionCamera {
  return {
    zoom: ZOOM,
    centerX: CENTER_X,
    centerY: CENTER_Y,
    pitch,
    getFrameView: (w: number, h: number, dpr = 1) => buildRTCMatrix(pitch, w, h, dpr),
  } as unknown as TileSelectionCamera
}

/** Primary (non-fallback) selected tile count — what `frameTileCache().tiles`
 *  reports and what the issue's tables counted. Device canvas = CSS * dpr, as
 *  the renderer sizes it — the "hold the device canvas fixed" trap
 *  `probe-tile-selection-dpr.ts` documents does NOT model a real dpr change. */
function select(pitch: number, dpr = 1): number {
  const tiles = visibleTilesSSE(
    repoCamera(pitch),
    mercator,
    MAX_Z,
    CSS_W * dpr,
    CSS_H * dpr,
    0,
    dpr,
    {},
  )
  return tiles.filter((t) => !t.fallbackOnly).length
}

function countDecreases(counts: number[]): { decreases: number; maxMagnitude: number } {
  let decreases = 0
  let maxMagnitude = 0
  for (let i = 1; i < counts.length; i++) {
    const drop = counts[i - 1]! - counts[i]!
    if (drop > 0) {
      decreases++
      maxMagnitude = Math.max(maxMagnitude, drop)
    }
  }
  return { decreases, maxMagnitude }
}

const PITCH_MIN = 41
const PITCH_MAX = 84

describe('visibleTilesSSE — pitch/DPR monotonicity (#1379)', () => {
  it('is near-monotone in pitch at FIXED dpr (the axis the issue blamed)', () => {
    const counts: number[] = []
    for (let p = PITCH_MIN; p <= PITCH_MAX; p++) counts.push(select(p, 1))
    const { decreases, maxMagnitude } = countDecreases(counts)
    // Bounds loosened from the probe's measured 1 decrease / magnitude 1
    // (scripts/probe-tile-selection-dpr.ts, issue comment 5106897620) — some
    // slack so this isn't brittle to an unrelated tuning change, tight enough
    // that the ladder-notch case (c) below cannot pass it.
    expect(decreases).toBeLessThanOrEqual(2)
    expect(maxMagnitude).toBeLessThanOrEqual(2)
  })

  it('IS sensitive to dpr by construction — retina asks for more detail', () => {
    const atDpr1 = select(70, 1)
    const atDpr3 = select(70, 3)
    // Measured 26 -> 104 (4x). This is the positive half of the fact the
    // narrowed comment at tiles-sse.ts:287 now states: selection as a whole
    // is deliberately NOT dpr-invariant, only the altitude term is.
    expect(atDpr3).toBeGreaterThan(2 * atDpr1)
  })

  it('FAIL-BEFORE: alternating dpr per pitch step reproduces the reported swing', () => {
    // Simulates the adaptive-quality ladder taking its DPR notch mid-settle —
    // #1379's actual mechanism, shared with the closed #1479 — by driving the
    // SAME pitch sweep as case (a) with dpr alternating 0.85/0.7 per step.
    const counts: number[] = []
    let alt = true
    for (let p = PITCH_MIN; p <= PITCH_MAX; p++, alt = !alt) {
      counts.push(select(p, alt ? 0.85 : 0.7))
    }
    const { decreases, maxMagnitude } = countDecreases(counts)
    // Blows through the fixed-dpr bound from case (a) — proves the gate
    // there distinguishes the ladder artifact from the fixed-dpr truth,
    // rather than being satisfiable either way (CLAUDE.md §12: an assertion
    // must distinguish the states it's meant to tell apart).
    expect(decreases > 2 || maxMagnitude > 2).toBe(true)
    // And the shape itself matches the issue's reported class of swing:
    // >=40% between some pair of adjacent 1-degree steps.
    let maxSwing = 0
    for (let i = 1; i < counts.length; i++) {
      const a = counts[i - 1]!
      const b = counts[i]!
      maxSwing = Math.max(maxSwing, Math.abs(a - b) / Math.max(a, b))
    }
    expect(maxSwing).toBeGreaterThanOrEqual(0.4)
  })
})
