// ═══ The family base, and the premise that lets ONE writer serve five layouts ═══
//
// `retained-pack-common.ts` folded four things each of the five retained packers had
// written itself (#2534 audit S11). Two jobs here:
//
// A. THE PREMISE. `packGeoPointDsfun` writes `feat[base+0 .. base+11]` by NUMERIC offset,
//    which is only correct because all five *_RETAINED_FEAT layouts open with the same
//    twelve slots in the same order. That was true when the copies were written and
//    NOTHING checked it — each copy just happened to agree. Arm A checks it against the
//    slot tables themselves, so a layout that reorders, renames or splits the block fails
//    here instead of packing garbage into a shader that reads it verbatim. Same for the
//    tint stride: five layouts declare it, one writer assumes it.
//
// B. THE MOVE CHANGED NOTHING. The retired bodies are kept verbatim below and differenced
//    against the helpers. Arm B is the proof the fold was exact, not a rewrite.

import { describe, it, expect } from 'vitest'
import { lonLatToECEF } from '@xgis/shared'
import { latToMercatorY } from '@xgis/geo'
import { worldCopyMercX } from '../render/point-feature-packer'
import { hexToRgba } from '../feature-helpers'
import {
  ARROW_RETAINED_FEAT,
  ARROW_RETAINED_TINT_STRIDE,
} from '../shaders/dsl/arrow-retained-feat-layout'
import {
  CIRCLE_RETAINED_FEAT,
  CIRCLE_RETAINED_TINT_STRIDE,
} from '../shaders/dsl/circle-retained-feat-layout'
import {
  ICON_RETAINED_FEAT,
  ICON_RETAINED_TINT_STRIDE,
} from '../shaders/dsl/icon-retained-feat-layout'
import {
  PARTICLE_RETAINED_FEAT,
  PARTICLE_RETAINED_TINT_STRIDE,
} from '../shaders/dsl/particle-retained-feat-layout'
import {
  TEXT_RETAINED_FEAT,
  TEXT_RETAINED_TINT_STRIDE,
} from '../shaders/dsl/text-retained-feat-layout'
import type { IconColor, Packed } from './graphics-types'
import {
  DSFUN_ANCHOR_SLOTS,
  RETAINED_TINT_STRIDE,
  WHITE_RGBA,
  normColor,
  packGeoPointDsfun,
  packRetainedTint,
  resolve,
} from './retained-pack-common'

/** The block `packGeoPointDsfun` writes, in the order it writes it. */
const ANCHOR_ORDER = [
  'ecef_x_h',
  'ecef_y_h',
  'ecef_z_h',
  'ecef_x_l',
  'ecef_y_l',
  'ecef_z_l',
  'abs_lon',
  'abs_lat',
  'merc_x_h',
  'merc_x_l',
  'merc_y_h',
  'merc_y_l',
] as const

const LAYOUTS = [
  ['arrow', ARROW_RETAINED_FEAT, ARROW_RETAINED_TINT_STRIDE],
  ['circle', CIRCLE_RETAINED_FEAT, CIRCLE_RETAINED_TINT_STRIDE],
  ['icon', ICON_RETAINED_FEAT, ICON_RETAINED_TINT_STRIDE],
  ['particle', PARTICLE_RETAINED_FEAT, PARTICLE_RETAINED_TINT_STRIDE],
  ['text', TEXT_RETAINED_FEAT, TEXT_RETAINED_TINT_STRIDE],
] as const satisfies readonly (readonly [
  string,
  { readonly stride: number; readonly slot: Readonly<Record<string, number>> },
  number,
])[]

// ── the retired bodies, verbatim ────────────────────────────────────────────────────────
// As they stood across the five packers at 60c50de7. `retiredResolve` was byte-identical in
// all five; `retiredNormColor` is the circle's (the only parameterised one — the other four
// were its `[1,1,1,1]` case); `retiredPackGeoPoint` is arrow's, which particle's matched
// byte for byte and which text's `writeAnchorDsfun` matched modulo naming its slots.

function retiredResolve<T, D>(acc: Packed<T, D> | undefined, d: D, i: number): T | undefined {
  return typeof acc === 'function' ? (acc as (d: D, i: number) => T)(d, i) : acc
}

function retiredNormColor(
  c: IconColor | undefined,
  dflt: [number, number, number, number],
): [number, number, number, number] {
  if (c === undefined) return dflt
  if (typeof c === 'string') {
    const parsed = hexToRgba(c)
    return parsed ? [parsed[0], parsed[1], parsed[2], parsed[3]] : dflt
  }
  return [c[0], c[1], c[2], c[3] ?? 1]
}

function retiredPackGeoPoint(feat: Float32Array, base: number, lon: number, lat: number): void {
  const ecef = lonLatToECEF(lon, lat)
  const exH = Math.fround(ecef[0])
  const eyH = Math.fround(ecef[1])
  const ezH = Math.fround(ecef[2])
  feat[base + 0] = exH
  feat[base + 1] = eyH
  feat[base + 2] = ezH
  feat[base + 3] = ecef[0] - exH
  feat[base + 4] = ecef[1] - eyH
  feat[base + 5] = ecef[2] - ezH
  feat[base + 6] = lon
  feat[base + 7] = lat
  const mx = worldCopyMercX(lon, 0)
  const my = latToMercatorY(lat)
  const mxH = Math.fround(mx)
  const myH = Math.fround(my)
  feat[base + 8] = mxH
  feat[base + 9] = Math.fround(mx - mxH)
  feat[base + 10] = myH
  feat[base + 11] = Math.fround(my - myH)
}

/** Positions chosen to exercise the parts of the split that a single point cannot: a
 *  Mercator pole clamp, the antimeridian, the equator/prime-meridian zero, and a
 *  high-magnitude ECEF where the hi/lo remainder is actually nonzero. */
const PROBE_POSITIONS: readonly (readonly [number, number])[] = [
  [0, 0],
  [127.0246, 37.5326], // Seoul — the ordinary case
  [-180, 0],
  [179.999999, 0],
  [0, 89.9], // beyond the ±85.051129 Mercator clamp
  [0, -89.9],
  [-73.9857, 40.7484],
]

describe('retained packer family base (#2534 S11)', () => {
  // ── A. the premise: five layouts, one anchor block ──────────────────────────────────
  it('every retained layout opens with the same 12-slot DSFUN block at offsets 0..11', () => {
    for (const [name, layout] of LAYOUTS) {
      const got = ANCHOR_ORDER.map((k) => layout.slot[k])
      expect(got, `${name}: anchor block is not slots 0..11 in packGeoPointDsfun's order`).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ])
    }
    expect(ANCHOR_ORDER.length).toBe(DSFUN_ANCHOR_SLOTS)
  })

  it('arrow and particle repeat the block verbatim at +12 (their direction tip)', () => {
    // Both pass `o + F.tip_ecef_x_h` to the same writer, so the tip block must be the same
    // twelve slots shifted by exactly DSFUN_ANCHOR_SLOTS.
    for (const [name, layout] of [
      ['arrow', ARROW_RETAINED_FEAT],
      ['particle', PARTICLE_RETAINED_FEAT],
    ] as const) {
      const tip = ANCHOR_ORDER.map(
        (k) => (layout.slot as Readonly<Record<string, number>>)[`tip_${k}`],
      )
      expect(tip, `${name}: tip block is not the anchor block shifted by 12`).toEqual(
        ANCHOR_ORDER.map((_, i) => DSFUN_ANCHOR_SLOTS + i),
      )
    }
  })

  it('every retained layout declares the tint stride the shared writer assumes', () => {
    for (const [name, , tintStride] of LAYOUTS) {
      expect(tintStride, `${name}: tint stride diverged from the shared writer`).toBe(
        RETAINED_TINT_STRIDE,
      )
    }
  })

  it('the anchor block fits inside every layout stride, leaving room for its own slots', () => {
    // A layout whose stride shrank below the block would have the writer running off the end
    // of instance i into instance i+1 — silent, and invisible to the offset check above.
    for (const [name, layout] of LAYOUTS) {
      expect(layout.stride, `${name}: stride cannot hold the anchor block`).toBeGreaterThan(
        DSFUN_ANCHOR_SLOTS,
      )
    }
  })

  // ── B. the move changed nothing ─────────────────────────────────────────────────────
  it('packGeoPointDsfun equals the retired body on every probe position', () => {
    for (const [lon, lat] of PROBE_POSITIONS) {
      const got = new Float32Array(DSFUN_ANCHOR_SLOTS)
      const want = new Float32Array(DSFUN_ANCHOR_SLOTS)
      packGeoPointDsfun(got, 0, lon, lat)
      retiredPackGeoPoint(want, 0, lon, lat)
      expect([...got], `lon=${lon} lat=${lat}`).toEqual([...want])
    }
  })

  it('the differential is not vacuous — the probes move every slot of the block', () => {
    // Both equalities above would hold trivially if the writer wrote zeros. Each of the 12
    // slots must take at least two distinct values across the probe set.
    const seen = Array.from({ length: DSFUN_ANCHOR_SLOTS }, () => new Set<number>())
    for (const [lon, lat] of PROBE_POSITIONS) {
      const f = new Float32Array(DSFUN_ANCHOR_SLOTS)
      packGeoPointDsfun(f, 0, lon, lat)
      for (let k = 0; k < DSFUN_ANCHOR_SLOTS; k++) seen[k]!.add(f[k]!)
    }
    for (let k = 0; k < DSFUN_ANCHOR_SLOTS; k++) {
      expect(seen[k]!.size, `slot ${k} (${ANCHOR_ORDER[k]}) never varied`).toBeGreaterThan(1)
    }
  })

  it('writes exactly its 12 slots — never past `base + 11`, never before `base`', () => {
    // The writer is called at `o + F.ecef_x_h` AND at `o + F.tip_ecef_x_h`; a stray write
    // would corrupt the neighbouring block rather than fail anything.
    const GUARD = 7
    const feat = new Float32Array(GUARD + DSFUN_ANCHOR_SLOTS + GUARD).fill(Number.NaN)
    packGeoPointDsfun(feat, GUARD, 127.0246, 37.5326)
    for (let i = 0; i < GUARD; i++) {
      expect(Number.isNaN(feat[i]!), `wrote before base at ${i}`).toBe(true)
      expect(
        Number.isNaN(feat[GUARD + DSFUN_ANCHOR_SLOTS + i]!),
        `wrote past base+11 at +${i}`,
      ).toBe(true)
    }
    for (let i = 0; i < DSFUN_ANCHOR_SLOTS; i++) {
      expect(Number.isNaN(feat[GUARD + i]!), `slot ${i} left unwritten`).toBe(false)
    }
  })

  it('resolve equals the retired body for constants, functions and absence', () => {
    const d = { v: 3 }
    const fn = (x: { v: number }, i: number): number => x.v * 10 + i
    for (const acc of [undefined, 5, fn] as Packed<number, { v: number }>[]) {
      expect(resolve(acc, d, 2)).toBe(retiredResolve(acc, d, 2))
    }
    expect(resolve(fn, d, 2)).toBe(32) // and the index really reaches the accessor
  })

  it('normColor equals the retired body across every colour shape', () => {
    const dflts: [number, number, number, number][] = [
      [1, 1, 1, 1],
      [0, 0, 0, 0],
    ]
    const colors: (IconColor | undefined)[] = [
      undefined,
      '#f00',
      '#f00f',
      '#ff0000',
      '#ff000080',
      'red', // named — unparseable here, so the default runs (#1666)
      'not a color',
      [0.1, 0.2, 0.3, 0.4],
      // A 3-tuple: `IconColor` is typed as a FOUR-tuple, so tsc rules this out — but all
      // five retired copies wrote `c[3] ?? 1`, a runtime defence against a JS caller the
      // type cannot reach. The fold preserved that branch; the cast is how a test reaches
      // it, and it is here so the `?? 1` is not later deleted as dead.
      [0.1, 0.2, 0.3] as unknown as IconColor,
    ]
    for (const dflt of dflts) {
      for (const c of colors) {
        expect(normColor(c, dflt), `${String(c)} / ${dflt.join(',')}`).toEqual(
          retiredNormColor(c, dflt),
        )
      }
    }
  })

  it('normColor does NOT alias the default it is handed', () => {
    // Four of the five copies returned a fresh literal; the circle's returned `dflt` itself,
    // so a caller mutating the result would have poisoned the shared constant. The fold
    // takes the safe form — WHITE_RGBA is now module state, which makes this load-bearing.
    const got = normColor(undefined, WHITE_RGBA)
    got[0] = 0.5
    expect(WHITE_RGBA[0]).toBe(1)
  })

  // ── the tint writer ─────────────────────────────────────────────────────────────────
  it('packs one rgba per datum when no repeat counts are given', () => {
    const data = [{ c: '#ff0000' }, { c: '#00ff00' }, {}]
    const got = packRetainedTint(data, (d: { c?: string }) => d.c ?? '#0000ff', WHITE_RGBA)
    expect(got.length).toBe(3 * RETAINED_TINT_STRIDE)
    expect([...got.slice(0, 4)]).toEqual([1, 0, 0, 1])
    expect([...got.slice(4, 8)]).toEqual([0, 1, 0, 1])
    expect([...got.slice(8, 12)]).toEqual([0, 0, 1, 1])
  })

  it('replicates a datum colour across its instances, in datum order', () => {
    // The alignment text + particle each asserted in prose and nothing enforced: tint slot i
    // describes feat instance i.
    const data = [{ c: '#ff0000' }, { c: '#00ff00' }]
    const got = packRetainedTint(data, (d: { c: string }) => d.c, WHITE_RGBA, [3, 2])
    expect(got.length).toBe(5 * RETAINED_TINT_STRIDE)
    for (let k = 0; k < 3; k++) expect([...got.slice(k * 4, k * 4 + 4)]).toEqual([1, 0, 0, 1])
    for (let k = 3; k < 5; k++) expect([...got.slice(k * 4, k * 4 + 4)]).toEqual([0, 1, 0, 1])
  })

  it('a zero-count datum contributes no instance and does not shift the ones after it', () => {
    const data = [{ c: '#ff0000' }, { c: '#00ff00' }, { c: '#0000ff' }]
    const got = packRetainedTint(data, (d: { c: string }) => d.c, WHITE_RGBA, [1, 0, 1])
    expect(got.length).toBe(2 * RETAINED_TINT_STRIDE)
    expect([...got.slice(0, 4)]).toEqual([1, 0, 0, 1])
    expect([...got.slice(4, 8)]).toEqual([0, 0, 1, 1]) // blue, not green
  })

  it('runs getColor EXACTLY once per contributing datum — the accessor-once contract', () => {
    // The whole retained design rests on this: accessors run at add()/update(), never per
    // frame. A replicating packer that called getColor per INSTANCE would be 4096× off on a
    // particle field and nothing downstream would notice.
    const calls: number[] = []
    packRetainedTint(
      [{}, {}, {}],
      (_d: object, i: number) => {
        calls.push(i)
        return '#ffffff'
      },
      WHITE_RGBA,
      [4096, 0, 7],
    )
    expect(calls).toEqual([0, 2]) // once each for the contributing data, never for the empty one
  })

  it('stops at the shorter of data and repeats, rather than reading past either', () => {
    // particle hands counts from `allocateParticleCounts`, which returns [] for a zero-N
    // spec while `data` is non-empty; text hands a Uint32Array sized to `data`.
    expect(packRetainedTint([{}, {}], () => '#ffffff', WHITE_RGBA, []).length).toBe(0)
    expect(packRetainedTint([], () => '#ffffff', WHITE_RGBA, [3, 3]).length).toBe(0)
  })
})
