// ═══ Globe-horizon (front-hemisphere) authority — the drift guard (#1052 / #1152 INC-3) ═══
//
// The globe visibility predicate had THREE independent inlines (label projector,
// globe tile selector, GPU fragment-cull uniform); #1052 routed all three through
// the single authority `eyeHorizon` in @xgis/shared. #1152 INC-3 moved that authority
// from a SPHERE to the WGS84 ELLIPSOID — `eyeHorizon(eye, a, b)` z-stretches the eye
// into the sphere-of-radius-a frame (b = a ⇒ inert), returning `eyeN = normalize(qE)`
// and `horizonCos = a/|qE|`. This test pins TWO things (the #1044 pattern):
//
//   Part 1 — bit-equality: the authority reproduces the z-stretch reference lane-for-
//     lane over a camera sweep (Earth AND a sphere body), degenerates bit-for-bit to
//     the retired sphere formula when b = a, is inert to a/b for an equatorial eye,
//     and the one directly-callable site (`globeEyeUniform`) packs the authority's
//     exact floats.
//
//   Part 2 — the source-authority gate: each of the three sites routes through
//     `eyeHorizon(` exactly once and inlines no horizon cosine; the authority body
//     lives once in shared/src/ecef.ts. Re-inlining the derivation trips the gate red.
//
// GPU-free; rides the `test (map)` CI leg. (The tile-selector / label-limb per-sample
// SIGN correctness is proven in shared/src/eye-horizon-ellipsoid.test.ts.)

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EARTH, MOON, eyeHorizon } from '@xgis/shared'
import { globeEyeUniform } from './globe-eye-uniform'

const DEG = Math.PI / 180
const HERE = dirname(fileURLToPath(import.meta.url))
const A = EARTH.a
const B = EARTH.b

/** ECEF eye at (lon, lat) degrees, geocentric magnitude = radius. */
function eyeAt(lonDeg: number, latDeg: number, radius: number): [number, number, number] {
  const lon = lonDeg * DEG
  const lat = latDeg * DEG
  const cl = Math.cos(lat)
  return [radius * cl * Math.cos(lon), radius * cl * Math.sin(lon), radius * Math.sin(lat)]
}

const DIRS: readonly [number, number, string][] = [
  [0, 0, 'lon0/lat0'],
  [45, 30, 'mid-NE'],
  [-120, -60, 'mid-SW'],
  [179.9, 85, 'near-antimeridian high-lat'],
  [180, -85, 'antimeridian south'],
  [37, 55, 'arbitrary'],
  [0, 90, 'north pole'],
  [0, -90, 'south pole'],
]
const RADII: readonly [number, string][] = [
  [A * (1 + 1e-9), 'near-limb'],
  [A * 1.5, 'low orbit'],
  [A * 2.5, 'mid orbit'],
  [A * 7, 'high orbit'],
  [A * 20, 'far'],
]
const RAW_EYES: readonly [[number, number, number], string][] = [
  [[A * 2, 0, 0], '+X axis'],
  [[0, A * 2, 0], '+Y axis'],
  [[0, 0, A * 2], '+Z axis'],
  [[-A * 2, 0, 0], '−X axis'],
  [[A * 1.2, -A * 3.4, A * 0.7], 'generic off-axis'],
]
const EYES: readonly [[number, number, number], string][] = [
  ...DIRS.flatMap(([lon, lat, dl]) =>
    RADII.map(
      ([r, rl]) => [eyeAt(lon, lat, r), `${dl} @ ${rl}`] as [[number, number, number], string],
    ),
  ),
  ...RAW_EYES,
]

const bitEq = (a: number, b: number): boolean => Object.is(a, b)

/** Reference z-stretch derivation — the authority's contract, spelled independently. */
function refHorizon(eye: readonly [number, number, number], a: number, b: number) {
  const qEz = eye[2] * (a / b)
  const eyeLen = Math.hypot(eye[0], eye[1], qEz)
  return { eyeLen, eyeN: [eye[0] / eyeLen, eye[1] / eyeLen, qEz / eyeLen], horizonCos: a / eyeLen }
}

describe('globe-horizon authority: eyeHorizon bit-equals the z-stretch reference (#1152 INC-3)', () => {
  it('authority === z-stretch reference lane-for-lane (Earth a,b + a sphere body)', () => {
    const bad: string[] = []
    for (const [a, b, bl] of [
      [A, B, 'Earth'],
      [MOON.a, MOON.b, 'Moon'],
    ] as const)
      for (const [eye, label] of EYES) {
        const h = eyeHorizon(eye, a, b)
        const r = refHorizon(eye, a, b)
        if (
          !bitEq(h.eyeLen, r.eyeLen) ||
          !bitEq(h.eyeN[0], r.eyeN[0]) ||
          !bitEq(h.eyeN[1], r.eyeN[1]) ||
          !bitEq(h.eyeN[2], r.eyeN[2]) ||
          !bitEq(h.horizonCos, r.horizonCos)
        )
          bad.push(`${bl}: ${label}`)
      }
    expect(bad, `authority diverged from reference at: ${bad.join('; ')}`).toEqual([])
  })

  it('b = a degenerates bit-for-bit to the retired sphere formula { |eye|, eye/|eye|, r/|eye| }', () => {
    const bad: string[] = []
    for (const [eye, label] of EYES) {
      const r = A
      const h = eyeHorizon(eye, r, r)
      const eyeLen = Math.hypot(eye[0], eye[1], eye[2])
      if (
        !bitEq(h.eyeLen, eyeLen) ||
        !bitEq(h.eyeN[0], eye[0] / eyeLen) ||
        !bitEq(h.eyeN[1], eye[1] / eyeLen) ||
        !bitEq(h.eyeN[2], eye[2] / eyeLen) ||
        !bitEq(h.horizonCos, r / eyeLen)
      )
        bad.push(label)
    }
    expect(bad, `sphere reduction diverged at: ${bad.join('; ')}`).toEqual([])
  })

  it('equatorial eye (eye.z = 0): a/b is inert — ellipsoid lanes === sphere lanes', () => {
    const bad: string[] = []
    for (const [eye] of RAW_EYES.filter(([e]) => e[2] === 0)) {
      const ell = eyeHorizon(eye, A, B)
      const sph = eyeHorizon(eye, A, A)
      if (
        !bitEq(ell.eyeLen, sph.eyeLen) ||
        !bitEq(ell.eyeN[0], sph.eyeN[0]) ||
        !bitEq(ell.eyeN[1], sph.eyeN[1]) ||
        !bitEq(ell.eyeN[2], sph.eyeN[2]) ||
        !bitEq(ell.horizonCos, sph.horizonCos)
      )
        bad.push(eye.join(','))
    }
    expect(bad).toEqual([])
  })

  it('site 3 (GPU uniform, globe-eye-uniform.ts) packs the authority floats lane-for-lane', () => {
    const bad: string[] = []
    for (const [eye, label] of EYES) {
      const h = eyeHorizon(eye, A, B)
      const packed = globeEyeUniform(eye)
      if (
        !bitEq(packed[0], h.eyeN[0]) ||
        !bitEq(packed[1], h.eyeN[1]) ||
        !bitEq(packed[2], h.eyeN[2]) ||
        !bitEq(packed[3], h.horizonCos)
      )
        bad.push(label)
    }
    expect(bad, `uniform pack diverged from eyeHorizon at: ${bad.join('; ')}`).toEqual([])
    // The disc/flat zero-pack path (no eye) stays all-zero.
    expect([...globeEyeUniform(undefined)]).toEqual([0, 0, 0, 0])
  })
})

// ── Part 2 — source-authority gate ──
const SITES: Record<string, string> = {
  'render-loop-helpers.ts': join(HERE, '..', 'render-loop-helpers.ts'),
  'globe-eye-uniform.ts': join(HERE, 'globe-eye-uniform.ts'),
  'globe-visible-tiles.ts': join(HERE, '..', '..', '..', 'data', 'src', 'globe-visible-tiles.ts'),
}
const HELPER = join(HERE, '..', '..', '..', 'shared', 'src', 'ecef.ts')

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length

describe('source-authority gate: the globe-horizon derivation cannot silently drift (#1152 INC-3)', () => {
  it('each of the three sites routes through eyeHorizon() exactly once', () => {
    // render-loop-helpers builds ONE eyeHorizon per label projector, SHARED between the
    // limb polygon and the per-anchor cull (buildGlobeLimbPolygon takes the precomputed
    // horizon) — so every site is exactly one authority call, no inline re-derivation.
    for (const [name, path] of Object.entries(SITES)) {
      const n = count(stripComments(readFileSync(path, 'utf8')), /eyeHorizon\(/g)
      expect(
        n,
        `${name}: expected exactly 1 eyeHorizon() call; got ${n}. LOWER (0): the derivation ` +
          `was re-inlined — forbidden; route it through eyeHorizon() instead.`,
      ).toBe(1)
    }
  })

  it('no site re-inlines the horizon cosine (a / |eye|)', () => {
    for (const [name, path] of Object.entries(SITES)) {
      const code = stripComments(readFileSync(path, 'utf8'))
      const n = count(code, /(?:EARTH_R|EARTH\.a|\ba)\s*\/\s*(?:eyeLen|len|ql|qLen)\b/g)
      expect(
        n,
        `${name}: found ${n} inline horizon-cosine derivation(s) in code — the cosine is the ` +
          `authority's job now. Read horizonCos off eyeHorizon() instead.`,
      ).toBe(0)
    }
  })

  it('the authority body lives once in shared/src/ecef.ts', () => {
    const src = readFileSync(HELPER, 'utf8')
    expect(
      count(src, /export function eyeHorizon\(/g),
      'shared/src/ecef.ts must export exactly one eyeHorizon — the single authority.',
    ).toBe(1)
    expect(
      count(stripComments(src), /a\s*\/\s*eyeLen/g),
      'the horizon cosine `a / eyeLen` must be derived once, inside eyeHorizon.',
    ).toBe(1)
  })
})

// ── Part 2b — the ellipsoid k-rescale z-lane cannot silently revert to the sphere ──
// The two CPU cull sites rescale a surface point ON the ellipsoid by
// k = (eyeN.x/a, eyeN.y/a, eyeN.z/b) — the z-lane divides by the semi-MINOR axis b.
// eyeHorizon single-sources (eyeN, horizonCos) but NOT this per-site k, so a z-lane
// typo (`eyeN[2] / b` → `eyeN[2] / a`) would collapse the z-stretch back to a sphere
// at high latitude — silently passing every gate above (one eyeHorizon call, no
// `a/eyeLen` inline) AND the math oracles in eye-horizon-ellipsoid.test.ts (which
// compute their OWN k). This source-ratchet pins the z-lane at each production site.
const CPU_K_SITES: Record<string, { path: string; semiMinor: RegExp; semiMajor: RegExp }> = {
  'globe-visible-tiles.ts': {
    path: SITES['globe-visible-tiles.ts']!,
    semiMinor: /eyeN\[2\]\s*\/\s*EARTH_B\b/,
    semiMajor: /eyeN\[2\]\s*\/\s*(?:EARTH_R|EARTH\.a)\b/,
  },
  'render-loop-helpers.ts': {
    path: SITES['render-loop-helpers.ts']!,
    semiMinor: /eyeN\[2\]\s*\/\s*EARTH\.b\b/,
    semiMajor: /eyeN\[2\]\s*\/\s*(?:EARTH_R|EARTH\.a)\b/,
  },
}

describe('k-rescale source-ratchet: the ellipsoid z-lane cannot revert to the sphere (#1152 INC-3)', () => {
  it('each CPU cull site divides eyeN[2] (the k z-lane) by the semi-MINOR axis, never the semi-major', () => {
    for (const [name, { path, semiMinor, semiMajor }] of Object.entries(CPU_K_SITES)) {
      const code = stripComments(readFileSync(path, 'utf8'))
      expect(
        semiMinor.test(code),
        `${name}: the horizon k-rescale z-lane must divide eyeN[2] by the semi-minor axis ` +
          `(the ellipsoid z-stretch). Missing — the z-stretch was dropped or the lane renamed.`,
      ).toBe(true)
      expect(
        semiMajor.test(code),
        `${name}: eyeN[2] is divided by the semi-MAJOR axis — the ellipsoid z-lane silently ` +
          `reverted to the sphere. Divide the k z-lane by the semi-minor (b), not a / EARTH_R.`,
      ).toBe(false)
    }
  })
})
