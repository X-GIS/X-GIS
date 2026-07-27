// By-construction gate for the declarative arrow layer's packer (#1302). The
// strongest guarantee: the compiled packer is BYTE-IDENTICAL to the already-
// proven retained-arrow packer (#824/#825) for equivalent inputs, so the
// declarative `| arrow bearing-[.dir]` layer orients/sizes/colours exactly like
// a `map.graphics.add({ type:'arrow' })` batch — no GPU needed to prove it.
import { describe, it, expect } from 'vitest'
import {
  packRetainedArrowFeat,
  packRetainedArrowTint,
  packCompiledArrowFeat,
  packCompiledArrowTint,
} from './retained-arrow-packer'
import { ARROW_RETAINED_FEAT } from '../shaders/dsl/arrow-retained-feat-layout'
import type { ArrowDrawSpec } from './graphics-types'

const F = ARROW_RETAINED_FEAT.slot
const S = ARROW_RETAINED_FEAT.stride

// Parallel per-feature arrays (index = feature) — as the rebuildLayers arrow
// fork will bake them from the source features' evaluated .dir / size / fill.
const lons = [10, -30, 126.98, -76.0]
const lats = [20, 45, 37.57, 38.0]
const bearings = [0, 90, 45, 210]
const sizes = [12, 20, 16, 34]
const rgba: Array<[number, number, number, number]> = [
  [1, 0, 0, 1],
  [0, 1, 0, 0.5],
  [0.2, 0.3, 0.4, 1],
  [0.9, 0.7, 0.1, 0.8],
]
const DPR = 2

describe('compiled arrow packer (#1302)', () => {
  it('is byte-identical to the proven retained-arrow packer for equivalent inputs', () => {
    const spec: ArrowDrawSpec<number> = {
      type: 'arrow',
      data: lons.map((_, i) => i),
      getPosition: (i) => [lons[i]!, lats[i]!] as const,
      getBearing: (i) => bearings[i]!,
      getSize: (i) => sizes[i]!,
      getColor: (i) => rgba[i]!,
    }
    expect(packCompiledArrowFeat(lons, lats, bearings, sizes, DPR)).toEqual(
      packRetainedArrowFeat(spec, DPR),
    )
    expect(packCompiledArrowTint(rgba)).toEqual(packRetainedArrowTint(spec))
  })

  it('packs tail = anchor, size = px × dpr, tint = rgba per feature', () => {
    const feat = packCompiledArrowFeat(lons, lats, bearings, sizes, DPR)
    const tint = packCompiledArrowTint(rgba)
    for (let i = 0; i < lons.length; i++) {
      const o = i * S
      // feat/tint are Float32Array — storing applies ToFloat32, so assert exact
      // fround(value), not full-precision closeness (a value like 126.98 or 0.2
      // cannot be held to 6 decimals in f32).
      expect(feat[o + F.abs_lon]).toBe(Math.fround(lons[i]!))
      expect(feat[o + F.abs_lat]).toBe(Math.fround(lats[i]!))
      expect(feat[o + F.size]).toBe(Math.fround(sizes[i]! * DPR))
      for (let k = 0; k < 4; k++) expect(tint[i * 4 + k]).toBe(Math.fround(rgba[i]![k]!))
    }
  })

  it('steps the tip along the bearing (0 = N clockwise)', () => {
    // bearing 90 (east) → tip east of tail, same lat; bearing 0 (north) → tip
    // north of tail, same lon.
    const feat = packCompiledArrowFeat([0, 0], [0, 0], [90, 0], [10, 10], 1)
    expect(feat[0 * S + F.tip_abs_lon]).toBeGreaterThan(feat[0 * S + F.abs_lon]!)
    expect(feat[0 * S + F.tip_abs_lat]).toBeCloseTo(feat[0 * S + F.abs_lat]!, 6)
    expect(feat[1 * S + F.tip_abs_lat]).toBeGreaterThan(feat[1 * S + F.abs_lat]!)
    expect(feat[1 * S + F.tip_abs_lon]).toBeCloseTo(feat[1 * S + F.abs_lon]!, 6)
  })

  // #1333 — the outline stroke_units slot. Documents the INTENTIONAL asymmetry: only the
  // compiled path (S-111's coverage arrow field) can request an outline; the host
  // ArrowDrawSpec/packRetainedArrowFeat path has no accessor for it and always zero-fills the
  // slot (no outline), so every OTHER `| arrow`/`map.graphics.add({type:'arrow'})` consumer
  // (CO-OPS, seoul-arc-multiday, the icon example) is provably unaffected.
  it('stroke_units defaults to 0 (no outline) — byte-identical parity holds with the default omitted', () => {
    const spec: ArrowDrawSpec<number> = {
      type: 'arrow',
      data: lons.map((_, i) => i),
      getPosition: (i) => [lons[i]!, lats[i]!] as const,
      getBearing: (i) => bearings[i]!,
      getSize: (i) => sizes[i]!,
    }
    const feat = packCompiledArrowFeat(lons, lats, bearings, sizes, DPR) // strokeUnits omitted
    for (let i = 0; i < lons.length; i++) expect(feat[i * S + F.stroke_units]).toBe(0)
    expect(feat).toEqual(packRetainedArrowFeat(spec, DPR)) // parity gate still holds
  })

  it('a nonzero compiled outline is written into every instance — the retained path has no equivalent and always stays 0', () => {
    const STROKE = 0.06
    const feat = packCompiledArrowFeat(lons, lats, bearings, sizes, DPR, STROKE)
    for (let i = 0; i < lons.length; i++) {
      expect(feat[i * S + F.stroke_units]).toBe(Math.fround(STROKE))
      // Every OTHER field is unaffected by requesting an outline.
      expect(feat[i * S + F.size]).toBe(Math.fround(sizes[i]! * DPR))
    }
    // packRetainedArrowFeat has no outline accessor at all — confirms the asymmetry is by
    // construction, not an oversight: a host arrow batch can never produce this nonzero slot.
    const spec: ArrowDrawSpec<number> = {
      type: 'arrow',
      data: lons.map((_, i) => i),
      getPosition: (i) => [lons[i]!, lats[i]!] as const,
      getBearing: (i) => bearings[i]!,
      getSize: (i) => sizes[i]!,
    }
    const retainedFeat = packRetainedArrowFeat(spec, DPR)
    for (let i = 0; i < lons.length; i++) expect(retainedFeat[i * S + F.stroke_units]).toBe(0)
  })

  // #1333 — drift: the arrow GLYPH flows along its own bearing instead of sitting pinned.
  describe('drift slots', () => {
    it('omitting drift leaves all three slots 0 — parity with the host path still holds', () => {
      const spec: ArrowDrawSpec<number> = {
        type: 'arrow',
        data: lons.map((_, i) => i),
        getPosition: (i) => [lons[i]!, lats[i]!] as const,
        getBearing: (i) => bearings[i]!,
        getSize: (i) => sizes[i]!,
      }
      const feat = packCompiledArrowFeat(lons, lats, bearings, sizes, DPR) // no drift
      for (let i = 0; i < lons.length; i++) {
        expect(feat[i * S + F.drift_px]).toBe(0)
        expect(feat[i * S + F.lifetime_s]).toBe(0)
        expect(feat[i * S + F.phase_norm]).toBe(0)
      }
      expect(feat).toEqual(packRetainedArrowFeat(spec, DPR)) // byte-identical to a host batch
    })

    it('a PER-INSTANCE driftPx tracks each arrow (dpr-scaled) — drift can encode local speed', () => {
      const perArrow = [10, 20, 30, 40]
      const feat = packCompiledArrowFeat(lons, lats, bearings, sizes, DPR, 0, {
        driftPx: perArrow,
        lifetimeSeconds: 3,
      })
      for (let i = 0; i < lons.length; i++) {
        expect(feat[i * S + F.drift_px]).toBe(Math.fround(perArrow[i]! * DPR))
        expect(feat[i * S + F.lifetime_s]).toBe(3)
      }
    })

    it('a SCALAR driftPx applies one distance to the whole batch', () => {
      const feat = packCompiledArrowFeat(lons, lats, bearings, sizes, DPR, 0, {
        driftPx: 25,
        lifetimeSeconds: 2,
      })
      for (let i = 0; i < lons.length; i++) {
        expect(feat[i * S + F.drift_px]).toBe(Math.fround(25 * DPR))
      }
    })

    it('phases are DE-SYNCED across arrows and in [0,1) — a lockstep field would read as a pulse', () => {
      const many = Array.from({ length: 64 }, (_, i) => i)
      const feat = packCompiledArrowFeat(
        many.map(() => 10),
        many.map(() => 20),
        many.map(() => 0),
        many.map(() => 12),
        1,
        0,
        { driftPx: 30, lifetimeSeconds: 2 },
      )
      const phases = many.map((_, i) => feat[i * S + F.phase_norm]!)
      for (const p of phases) {
        expect(p).toBeGreaterThanOrEqual(0)
        expect(p).toBeLessThan(1)
      }
      // Not all equal — the whole point of the per-arrow offset.
      expect(new Set(phases).size).toBeGreaterThan(many.length / 2)
    })

    it('phases are DETERMINISTIC — the same inputs pack identical bytes (the §5 probe contract)', () => {
      const args = [
        lons,
        lats,
        bearings,
        sizes,
        DPR,
        0,
        { driftPx: 30, lifetimeSeconds: 2 },
      ] as const
      expect(packCompiledArrowFeat(...args)).toEqual(packCompiledArrowFeat(...args))
    })

    it('a different seed yields a different phase field (the de-sync is seedable)', () => {
      const a = packCompiledArrowFeat(lons, lats, bearings, sizes, DPR, 0, {
        driftPx: 30,
        lifetimeSeconds: 2,
        seed: 1,
      })
      const b = packCompiledArrowFeat(lons, lats, bearings, sizes, DPR, 0, {
        driftPx: 30,
        lifetimeSeconds: 2,
        seed: 7,
      })
      const phasesOf = (f: Float32Array): number[] => lons.map((_, i) => f[i * S + F.phase_norm]!)
      expect(phasesOf(a)).not.toEqual(phasesOf(b))
    })
  })
})
