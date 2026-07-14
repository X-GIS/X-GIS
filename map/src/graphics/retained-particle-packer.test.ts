import { describe, it, expect } from 'vitest'
import { lonLatToECEF } from '@xgis/shared'
import {
  packRetainedParticleFeat,
  packRetainedParticleTint,
  allocateParticleCounts,
  resolveParticleInstanceCount,
} from './retained-particle-packer'
import {
  PARTICLE_RETAINED_FEAT,
  PARTICLE_RETAINED_TINT_STRIDE,
} from '../shaders/dsl/particle-retained-feat-layout'
import type { ParticleFlowDrawSpec } from './graphics-types'

const F = PARTICLE_RETAINED_FEAT.slot
const S = PARTICLE_RETAINED_FEAT.stride
const DEG2RAD = Math.PI / 180
const TIP_STEP_DEG = 0.02 // mirrors the packer's private constant
const M_PER_DEG = 111320

interface Cell {
  name: string
  lon: number
  lat: number
  bearing: number
  vol: number
}
const seoul: Cell[] = [
  { name: 'a', lon: 126.98, lat: 37.57, bearing: 0, vol: 100 },
  { name: 'b', lon: 127.03, lat: 37.5, bearing: 90, vol: 300 },
  { name: 'c', lon: 126.9, lat: 37.53, bearing: 45, vol: 600 },
]

function pspec(overrides: Partial<ParticleFlowDrawSpec<Cell>> = {}): ParticleFlowDrawSpec<Cell> {
  return {
    type: 'particle-flow',
    data: seoul,
    getPosition: (c) => [c.lon, c.lat],
    getBearing: (c) => c.bearing,
    getVolume: (c) => c.vol,
    ...overrides,
  }
}

describe('#826 retained-particle-flow packer — density ∝ volume allocation (§2.3)', () => {
  it('allocates n_i ∝ raw volume (a busier gu seeds MORE particles)', () => {
    // vol [1,2,4] over N=7000 with no floor ⇒ exactly [1000,2000,4000].
    const counts = allocateParticleCounts(
      pspec({
        data: [
          { name: 'a', lon: 0, lat: 0, bearing: 0, vol: 1 },
          { name: 'b', lon: 0, lat: 0, bearing: 0, vol: 2 },
          { name: 'c', lon: 0, lat: 0, bearing: 0, vol: 4 },
        ],
        particleCount: 7000,
        minPerCell: 0,
      }),
    )
    expect(counts).toEqual([1000, 2000, 4000])
    // A 4× busier gu shows 4× the particles — the honest volume encoding (§2.3, §5-Q3).
    expect(counts[2]).toBe(4 * counts[0]!)
  })

  it('sums to EXACTLY the fixed instance count (largest-remainder, no drift)', () => {
    for (const pc of [777, 4096, 10001]) {
      const spec = pspec({ particleCount: pc })
      const counts = allocateParticleCounts(spec)
      const total = counts.reduce((a, b) => a + b, 0)
      expect(total).toBe(resolveParticleInstanceCount(spec))
    }
  })

  it('honours the per-gu floor so the quietest gu still shows motion (§5-Q4)', () => {
    // Only gu 0 has volume; the two quiet gu still get exactly minPerCell.
    const counts = allocateParticleCounts(
      pspec({
        data: [
          { name: 'busy', lon: 0, lat: 0, bearing: 0, vol: 1000 },
          { name: 'q1', lon: 0, lat: 0, bearing: 0, vol: 0 },
          { name: 'q2', lon: 0, lat: 0, bearing: 0, vol: 0 },
        ],
        particleCount: 100,
        minPerCell: 8,
      }),
    )
    expect(counts).toEqual([84, 8, 8])
  })

  it('a zero-volume field falls back to an even split (no divide-by-zero)', () => {
    const counts = allocateParticleCounts(
      pspec({
        data: seoul.map((c) => ({ ...c, vol: 0 })),
        particleCount: 99,
        minPerCell: 0,
      }),
    )
    expect(counts.reduce((a, b) => a + b, 0)).toBe(99)
    expect(counts).toEqual([33, 33, 33])
  })
})

describe('#826 retained-particle-flow packer — fixed instance count (§5-Q6)', () => {
  it('N is the clamped particleCount, INDEPENDENT of the volume distribution', () => {
    expect(resolveParticleInstanceCount(pspec({ particleCount: 5000 }))).toBe(5000)
    // A different-hour field (different vols) keeps the SAME total — a per-hour re-pack never
    // resizes the batch (the fixed-size update()/DPR guards hold).
    const morning = resolveParticleInstanceCount(pspec({ particleCount: 5000 }))
    const evening = resolveParticleInstanceCount(
      pspec({ particleCount: 5000, data: seoul.map((c) => ({ ...c, vol: c.vol * 7 })) }),
    )
    expect(morning).toBe(evening)
  })

  it('clamps to the hard ceiling and defaults to 4096; empty field ⇒ 0', () => {
    expect(resolveParticleInstanceCount(pspec({ particleCount: 20000, maxParticles: 16384 }))).toBe(
      16384,
    )
    expect(resolveParticleInstanceCount(pspec())).toBe(4096)
    expect(resolveParticleInstanceCount(pspec({ data: [] }))).toBe(0)
  })
})

describe('#826 retained-particle-flow packer — deterministic seeding (§5 reproducibility)', () => {
  it('the same spec packs the byte-IDENTICAL feat buffer (pinned-t probe reproducible)', () => {
    const a = packRetainedParticleFeat(pspec({ particleCount: 256, seed: 42 }), 1)
    const b = packRetainedParticleFeat(pspec({ particleCount: 256, seed: 42 }), 1)
    expect(a).toEqual(b)
  })

  it('a different seed moves the jitter/phase (the seed actually drives the PRNG)', () => {
    const a = packRetainedParticleFeat(pspec({ particleCount: 256, seed: 1 }), 1)
    const b = packRetainedParticleFeat(pspec({ particleCount: 256, seed: 2 }), 1)
    expect(a).not.toEqual(b)
  })

  it('phase offsets are all in [0, 1) — a full loop, no clustering at 0', () => {
    const feat = packRetainedParticleFeat(pspec({ particleCount: 512, seed: 7 }), 1)
    const n = feat.length / S
    for (let i = 0; i < n; i++) {
      const ph = feat[i * S + F.phase_norm]!
      expect(ph).toBeGreaterThanOrEqual(0)
      expect(ph).toBeLessThan(1)
    }
  })

  it('every particle origin lies within seedRadiusMeters of its gu centroid (§5-Q5)', () => {
    const R = 800
    const feat = packRetainedParticleFeat(
      pspec({ data: [seoul[0]!], particleCount: 400, seedRadiusMeters: R, minPerCell: 0 }),
      1,
    )
    const n = feat.length / S
    const { lon: clon, lat: clat } = seoul[0]!
    for (let i = 0; i < n; i++) {
      const lon = feat[i * S + F.abs_lon]!
      const lat = feat[i * S + F.abs_lat]!
      const dy = (lat - clat) * M_PER_DEG
      const dx = (lon - clon) * M_PER_DEG * Math.cos(clat * DEG2RAD)
      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(R + 1) // ≤ R (+1 m f32 slack)
    }
  })
})

describe('#826 retained-particle-flow packer — geographic direction + layout', () => {
  it('steps the TIP one bearing-step along the outflow direction (0=N, CW)', () => {
    // seedRadius 0 pins the origin to the centroid, isolating the tip step.
    const north = packRetainedParticleFeat(
      pspec({
        data: [{ name: 'n', lon: 0, lat: 0, bearing: 0, vol: 1 }],
        particleCount: 1,
        minPerCell: 1,
        seedRadiusMeters: 0,
      }),
      1,
    )
    expect(north[F.abs_lat]).toBeCloseTo(0, 6)
    expect(north[F.tip_abs_lat]! - north[F.abs_lat]!).toBeCloseTo(TIP_STEP_DEG, 6) // +lat
    expect(north[F.tip_abs_lon]! - north[F.abs_lon]!).toBeCloseTo(0, 6)

    const east = packRetainedParticleFeat(
      pspec({
        data: [{ name: 'e', lon: 0, lat: 0, bearing: 90, vol: 1 }],
        particleCount: 1,
        minPerCell: 1,
        seedRadiusMeters: 0,
      }),
      1,
    )
    expect(east[F.tip_abs_lon]! - east[F.abs_lon]!).toBeCloseTo(TIP_STEP_DEG, 6) // cos(lat 0)=1 → +lon
    expect(east[F.tip_abs_lat]! - east[F.abs_lat]!).toBeCloseTo(0, 6)
  })

  it('origin ECEF DSFUN hi/lo reconstructs the double-precision anchor (shared ladder)', () => {
    const feat = packRetainedParticleFeat(
      pspec({
        data: [{ name: 'x', lon: 126.98, lat: 37.57, bearing: 0, vol: 1 }],
        particleCount: 1,
        minPerCell: 1,
        seedRadiusMeters: 0,
      }),
      1,
    )
    const ecef = lonLatToECEF(126.98, 37.57)
    expect(feat[F.ecef_x_h]).toBe(Math.fround(ecef[0]))
    expect(feat[F.ecef_x_h]! + feat[F.ecef_x_l]!).toBeCloseTo(ecef[0], 6)
  })

  it('bakes radius/drift with DPR but keeps lifetime in seconds', () => {
    const feat = packRetainedParticleFeat(
      pspec({
        data: [seoul[0]!],
        particleCount: 4,
        minPerCell: 4,
        particleRadiusPx: 3,
        driftPx: 40,
        lifetimeSeconds: 2.5,
      }),
      2, // dpr
    )
    expect(feat[F.radius_px]).toBe(6) // 3 × dpr 2
    expect(feat[F.drift_px]).toBe(80) // 40 × dpr 2
    expect(feat[F.lifetime_s]).toBe(2.5) // seconds — NOT dpr-scaled
  })

  it('runs getPosition / getBearing / getVolume ONCE per gu cell (no per-frame closure)', () => {
    let posCalls = 0
    let brgCalls = 0
    let volCalls = 0
    const spec = pspec({
      getPosition: (c) => {
        posCalls++
        return [c.lon, c.lat]
      },
      getBearing: (c) => {
        brgCalls++
        return c.bearing
      },
      getVolume: (c) => {
        volCalls++
        return c.vol
      },
      particleCount: 300,
    })
    packRetainedParticleFeat(spec, 1)
    const g = seoul.length
    expect(posCalls).toBe(g)
    expect(brgCalls).toBe(g)
    expect(volCalls).toBe(g) // once per cell in the allocation
  })
})

describe('#826 retained-particle-flow packer — tint', () => {
  it('packs one rgba per particle, each inheriting its home-gu colour', () => {
    const spec = pspec({
      data: [
        { name: 'red', lon: 0, lat: 0, bearing: 0, vol: 1 },
        { name: 'blue', lon: 0, lat: 0, bearing: 0, vol: 1 },
      ],
      getColor: (c) => (c.name === 'red' ? '#ff0000' : '#0000ff'),
      particleCount: 8,
      minPerCell: 4,
    })
    const counts = allocateParticleCounts(spec) // [4, 4]
    const tint = packRetainedParticleTint(spec)
    expect(tint.length).toBe(8 * PARTICLE_RETAINED_TINT_STRIDE)
    // First cell's particles are red, second cell's are blue (allocation order).
    expect(tint[0]).toBeCloseTo(1, 5)
    expect(tint[2]).toBeCloseTo(0, 5)
    const secondStart = counts[0]! * PARTICLE_RETAINED_TINT_STRIDE
    expect(tint[secondStart]).toBeCloseTo(0, 5) // red channel of the blue cell
    expect(tint[secondStart + 2]).toBeCloseTo(1, 5) // blue channel
  })

  it('defaults to white and aligns 1:1 with the feat particle count', () => {
    const spec = pspec({ particleCount: 300 })
    const feat = packRetainedParticleFeat(spec, 1)
    const tint = packRetainedParticleTint(spec)
    expect(tint.length / PARTICLE_RETAINED_TINT_STRIDE).toBe(feat.length / S)
    const white = packRetainedParticleTint(
      pspec({ data: [seoul[0]!], particleCount: 1, minPerCell: 1 }),
    )
    expect([white[0], white[1], white[2], white[3]]).toEqual([1, 1, 1, 1])
  })
})
