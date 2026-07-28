// ═══ ONE arrow batch per region, static or drifting — never both (#1449) ═══
//
// The advected field IS the catalogue portrayal, drifting: same glyph, same banded ramp, same
// scale rule, seeded so frame 0 is exactly the static placement. Arming the static batch as
// well draws one symbology twice. When this landed it was worse than redundant: the two paths
// thinned to different ceilings (COVERAGE_ARROW_MAX = 100 000 vs the state texture's fixed
// 16 384), so a CBOFS-sized cell came out at stride 1 against stride 5 — different cells,
// different speeds, different bands, visibly different colours from the first frame. That is
// what S-111 Live showed with `| arrow | flow` declared. #1450 A then closed the density gap
// (the state texture sizes itself to the batch), which leaves the suppression standing on the
// simpler reason: one portrayal, drawn once.
//
// These tests drive `armCoverageArrows` — the single decision point the three arm sites now
// call — and count the batches that reach the graphics manager.

import { describe, expect, it } from 'vitest'
import { coverageFromGrids, type CoverageInput } from '@xgis/data/coverage'
import { armCoverageArrows, type CoverageArmHost } from './coverage-arm'
import { ARROW_ADVECT_MAX_COUNT } from './render/arrow-advect-state'
import { COVERAGE_ARROW_MAX } from './coverage-arrow-show'
import type { ShowCommand } from './render/renderer-types'

/** 3×2 north-up S-111-like cell, the same fixture shape `coverage-arrow-show.test.ts` uses. */
function s111Handle() {
  const input: CoverageInput = {
    product: 's111',
    origin: [10, 50],
    spacing: [1, 1],
    size: [3, 2],
    vertical: { datumCode: null, sign: 'up' },
    bands: [
      {
        name: 'surfaceCurrentSpeed',
        unit: 'knots',
        kind: 'f32',
        nodata: -9999,
        values: Float32Array.from([0.3, 0, NaN, 2.5, 5.0, 20.0]),
      },
      {
        name: 'surfaceCurrentDirection',
        unit: 'arc-degrees',
        kind: 'f32',
        nodata: -9999,
        values: Float32Array.from([90, 0, 0, 180, 270, 45]),
      },
    ],
  }
  return coverageFromGrids(input)
}

/** `uploaded` = the region's velocity field is resident, which is what lets the advected arm
 *  read a peak speed. A region armed before its upload has none — the case the fallback in
 *  `armCoverageArrows` exists for. */
function makeHost(uploaded: boolean): {
  host: CoverageArmHost
  batches: Array<{ advected: boolean }>
} {
  const batches: Array<{ advected: boolean }> = []
  const host = {
    graphics: {
      addCompiledArrowLayer: (
        _lons: Float64Array,
        _lats: Float64Array,
        _bearings: Float32Array,
        _sizes: Float32Array,
        _colors: unknown,
        _strokeUnits?: number,
        _region?: string,
        advected?: unknown,
      ) => void batches.push({ advected: advected != null }),
    },
    coverageRenderer: {
      flowField: () =>
        uploaded
          ? {
              u: {},
              v: {},
              scale: 2.5,
              width: 3,
              height: 2,
              spanDeg: [3, 2] as const,
              midLatDeg: 50.5,
            }
          : null,
    },
  } as unknown as CoverageArmHost
  return { host, batches }
}

const show = (extra: Record<string, unknown>) =>
  ({ ramp: 's111-speed', ...extra }) as unknown as ShowCommand

describe('armCoverageArrows — one batch, static or drifting (#1449)', () => {
  it('`| arrow | flow` arms the DRIFTING batch alone — not one of each', () => {
    // The shipped defect: both were armed, at 5× different densities, disagreeing about colour.
    const { host, batches } = makeHost(true)
    armCoverageArrows(host, show({ isArrow: true, isFlow: true }), s111Handle(), 'r')
    expect(batches).toEqual([{ advected: true }])
  })

  it('`| arrow` alone stays exactly as it was — the strict catalogue portrayal', () => {
    const { host, batches } = makeHost(true)
    armCoverageArrows(host, show({ isArrow: true }), s111Handle(), 'r')
    expect(batches).toEqual([{ advected: false }])
  })

  it('`| flow` alone arms the drifting batch, with no `| arrow` declared', () => {
    const { host, batches } = makeHost(true)
    armCoverageArrows(host, show({ isFlow: true }), s111Handle(), 'r')
    expect(batches).toEqual([{ advected: true }])
  })

  it('`| flow-streaks` leaves the arrows to `| arrow` — the IBFV drape is a different layer', () => {
    const { host, batches } = makeHost(true)
    armCoverageArrows(
      host,
      show({ isArrow: true, isFlow: true, flowPortrayal: 'streaks' }),
      s111Handle(),
      'r',
    )
    expect(batches).toEqual([{ advected: false }])
  })

  it('before the velocity upload, `| arrow | flow` falls back to the STATIC batch', () => {
    // A region is armed once before its field is resident. Drawing nothing there would blank
    // the catalogue field until the next rebuild; drawing the static one keeps the portrayal on
    // screen and the rebuild after the upload swaps it for the drifting one. Something is
    // always on screen, and never two things.
    const { host, batches } = makeHost(false)
    armCoverageArrows(host, show({ isArrow: true, isFlow: true }), s111Handle(), 'r')
    expect(batches).toEqual([{ advected: false }])
  })

  it('`| flow` with no `| arrow` and no upload yet arms NOTHING — there is no static fallback to make', () => {
    const { host, batches } = makeHost(false)
    armCoverageArrows(host, show({ isFlow: true }), s111Handle(), 'r')
    expect(batches).toEqual([])
  })

  it('the two paths now thin to ONE ceiling — the density gap is closed (#1450 A)', () => {
    // This assertion is the inverse of the one it replaces. The suppression above shipped while
    // the advected ceiling was 16 384 against the static path's 100 000, and this said so; the
    // state texture now sizes itself to the batch, so the two are congruent and the ONLY reason
    // the static batch is still suppressed is that drawing one portrayal twice is pointless —
    // not that the two disagree.
    expect(ARROW_ADVECT_MAX_COUNT).toBe(COVERAGE_ARROW_MAX)
  })
})
