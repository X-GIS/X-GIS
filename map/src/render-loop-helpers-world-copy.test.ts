// ═══ projectMercAny world-copy index (#727 C) ═══
//
// Tile LINE labels fan out across visible world copies by passing the copy
// INDEX through projectMercAny (label-pass.ts); the projector arm applies its
// own period (Mercator metres vs projected-x), mirroring projectLonLatCopies.
// This pins the contract the label pass now relies on:
//   1. merc arm: copy index k ≡ projectMerc's worldMercatorOffset k·WORLD_MERC
//      ≡ projecting the point pre-shifted by k·WORLD_MERC (the rtcX identity);
//   2. the default (k = 0) is byte-identical to the pre-#727(C) two-arg call;
//   3. globe arm: the index is ignored — lonLatToECEF(lon ± 360°) is the same
//      point, so copies collapse (a copy loop over the globe is a no-op).

import { describe, it, expect } from 'vitest'
import { WORLD_MERC } from '@xgis/geo'
import { Camera } from './camera'
import { makeLabelProjectors } from './render-loop-helpers'
import { lineLabelCopyKey } from './render/passes/line-label-dedupe'

const W = 800,
  H = 600

// A point near the view centre at z0 (whole world in frame, so the ±1
// copies land inside the projector's NDC ±1.5 acceptance window).
const MX = WORLD_MERC * 0.05
const MY = WORLD_MERC * 0.03

function flatMercProjectors() {
  const cam = new Camera(0, 0, 0)
  cam.projType = 0
  const view = cam.getViewForProjection(0, W, H, 1)
  return makeLabelProjectors(view.matrix, W, H, {
    projType: 0,
    ccx: 0,
    ccy: 0,
    centerLon: 0,
    centerLat: 0,
    visibleWorldCopies: [-1, 0, 1],
  })
}

const snap = (p: [number, number] | null): [number, number] | null => (p ? [p[0], p[1]] : null) // copy out of the shared scratch before the next call

describe('projectMercAny(sx, sy, worldCopy) — #727 (C) contract', () => {
  it('merc arm: copy index k ≡ worldMercatorOffset k·WORLD_MERC ≡ pre-shifted x', () => {
    const proj = flatMercProjectors()
    let projectedCopies = 0
    for (const k of [-1, 1]) {
      // The three spellings must agree EXACTLY — including agreeing on a cull
      // (a copy outside the NDC ±1.5 acceptance is null through all three).
      const viaIndex = snap(proj.projectMercAny(MX, MY, k))
      const viaOffset = snap(proj.projectMerc(MX, MY, k * WORLD_MERC))
      const viaShift = snap(proj.projectMercAny(MX + k * WORLD_MERC, MY, 0))
      expect(viaIndex).toEqual(viaOffset)
      expect(viaIndex).toEqual(viaShift)
      if (viaIndex) {
        projectedCopies++
        // And it genuinely moved — a copy is a different screen position.
        const canonical = snap(proj.projectMercAny(MX, MY, 0))!
        expect(viaIndex[0]).not.toBeCloseTo(canonical[0], 3)
      }
    }
    // Non-vacuous: at this z0 fixture at least one wrapped copy is on-screen
    // (k=-1 lands at ~-170px, inside the ±1.5-NDC label acceptance window).
    expect(projectedCopies).toBeGreaterThanOrEqual(1)
  })

  it('default copy (0) is byte-identical to the two-arg call (pre-#727(C) path)', () => {
    const proj = flatMercProjectors()
    expect(snap(proj.projectMercAny(MX, MY, 0))).toEqual(snap(proj.projectMercAny(MX, MY)))
  })

  it('globe arm ignores the copy index (world copies collapse on ECEF)', () => {
    const cam = new Camera(3.6, 2.8, 1)
    cam.projType = 7
    cam.globeMode = true
    const view = cam.getViewForProjection(7, W, H, 1)
    const proj = makeLabelProjectors(view.matrix, W, H, undefined, view.eye, cam.getECEFCenter())
    const at = (k?: number) => snap(proj.projectMercAny(WORLD_MERC * 0.01, WORLD_MERC * 0.008, k))
    const base = at(0)
    expect(base).not.toBeNull()
    expect(at(1)).toEqual(base)
    expect(at(-1)).toEqual(base)
    expect(at(undefined)).toEqual(base)
  })
})

describe('lineLabelCopyKey — copy-suffixed dedupe keys (#727 C)', () => {
  it('canonical copy and empty keys pass through unchanged; wrapped copies get distinct key spaces', () => {
    expect(lineLabelCopyKey('I-82', 0)).toBe('I-82')
    expect(lineLabelCopyKey('', 1)).toBe('') // icon-only symbols never text-dedupe
    const w1 = lineLabelCopyKey('I-82', 1)
    const wm1 = lineLabelCopyKey('I-82', -1)
    expect(w1).not.toBe('I-82')
    expect(wm1).not.toBe('I-82')
    expect(w1).not.toBe(wm1) // each copy is its own dedupe space
    expect(w1.startsWith('I-82')).toBe(true) // readable prefix, NUL-separated suffix
  })
})
