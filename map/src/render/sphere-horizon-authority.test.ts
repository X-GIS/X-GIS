// ═══ Sphere-horizon (front-hemisphere) authority — the drift guard for #1052 ═══
//
// The `dot(e, eye) > R·|e|` visibility predicate had THREE independent inlines
// (label projector, globe tile selector, GPU fragment-cull uniform), all
// re-deriving `eyeN = normalize(eye)` and `horizonCos = EARTH_R / |eye|` with
// nothing enforcing they agree. #1052 routes all three through the single
// authority `eyeHorizon(eye, EARTH_R)` in @xgis/shared. This test pins TWO
// things (the tile-camera-anchor-authority.test.ts pattern, #1044):
//
//   Part 1 — bit-equality: for a sweep of camera positions (poles, antipode,
//     near-limb, inside-sphere, high orbit, exact-zero axes) each site's OLD
//     inline formula is recomputed here and asserted Object.is-equal — lane for
//     lane, including −0/NaN — to what `eyeHorizon` returns. Same op order
//     (hypot → divide), so the derived floats are identical, not merely close.
//     The boolean predicate and the guard branches are pinned too.
//
//   Part 2 — the source-authority gate: a text fact about the three sites —
//     each routes through `eyeHorizon(` exactly once and no longer inlines the
//     `EARTH_R / |eye|` cosine — plus the authority body itself. Re-inlining the
//     derivation at any site trips the gate red (proven by reverting a site).
//
// GPU-free; rides the `test (map)` CI leg like the co-located #1044 authority.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eyeHorizon } from '@xgis/shared'
import { EARTH_R } from '@xgis/geo'

const DEG = Math.PI / 180
const HERE = dirname(fileURLToPath(import.meta.url))

/** ECEF eye at (lon, lat) degrees, |eye| = radius. */
function eyeAt(lonDeg: number, latDeg: number, radius: number): [number, number, number] {
  const lon = lonDeg * DEG
  const lat = latDeg * DEG
  const cl = Math.cos(lat)
  return [radius * cl * Math.cos(lon), radius * cl * Math.sin(lon), radius * Math.sin(lat)]
}

/** Surface point on the sphere (|P| = EARTH_R) — the exact globeForward form the
 *  tile selector samples (data/src/globe-visible-tiles.ts). */
function surfAt(lonDeg: number, latDeg: number): [number, number, number] {
  const lon = lonDeg * DEG
  const lat = latDeg * DEG
  const cl = Math.cos(lat)
  return [EARTH_R * cl * Math.cos(lon), EARTH_R * cl * Math.sin(lon), EARTH_R * Math.sin(lat)]
}

const DIRS: readonly [number, number, string][] = [
  [0, 0, 'lon0/lat0'],
  [45, 30, 'mid-NE'],
  [-120, -60, 'mid-SW'],
  [179.9, 85, 'near-antimeridian high-lat'],
  [180, -85, 'antimeridian south'],
  [18.7, 15.4, 'Chad-ish (#1042 probe)'],
  [37, 55, 'arbitrary'],
  [0, 90, 'north pole'],
  [0, -90, 'south pole'],
]

// Radii spanning the guard domains: inside the sphere (label-limb guard fires),
// at the surface, a hair above the limb, and typical → far globe orbit.
const RADII: readonly [number, string][] = [
  [EARTH_R * 0.5, 'inside sphere'],
  [EARTH_R, 'at surface'],
  [EARTH_R * (1 + 1e-9), 'near-limb'],
  [EARTH_R * 1.0000001, 'just above'],
  [EARTH_R * 1.5, 'low orbit'],
  [EARTH_R * 2.5, 'mid orbit'],
  [EARTH_R * 7, 'high orbit'],
  [EARTH_R * 20, 'far'],
]

// Raw eyes with EXACT zero / negative-zero components — stresses sign-of-zero
// lanes that Object.is (not ===) distinguishes.
const RAW_EYES: readonly [[number, number, number], string][] = [
  [[EARTH_R * 2, 0, 0], '+X axis'],
  [[0, EARTH_R * 2, 0], '+Y axis'],
  [[0, 0, EARTH_R * 2], '+Z axis'],
  [[-EARTH_R * 2, 0, 0], '−X axis'],
  [[-0, EARTH_R * 3, -0], '±0 components'],
  [[EARTH_R * 1.2, -EARTH_R * 3.4, EARTH_R * 0.7], 'generic off-axis'],
]

const EYES: readonly [[number, number, number], string][] = [
  ...DIRS.flatMap(([lon, lat, dl]) =>
    RADII.map(
      ([r, rl]) => [eyeAt(lon, lat, r), `${dl} @ ${rl}`] as [[number, number, number], string],
    ),
  ),
  ...RAW_EYES,
  // Antipode pairs — eye and its exact negation.
  [[EARTH_R * 4, EARTH_R * 2, EARTH_R], 'antipode A'],
  [[-EARTH_R * 4, -EARTH_R * 2, -EARTH_R], 'antipode −A'],
]

const bitEq = (a: number, b: number): boolean => Object.is(a, b)

describe('sphere-horizon authority: eyeHorizon bit-equals each old inline (#1052)', () => {
  it('site 1 (label limb, render-loop-helpers.ts): eyeLen / eyeN / cosH lane-identical', () => {
    const bad: string[] = []
    for (const [eye, label] of EYES) {
      // OLD buildGlobeLimbPolygon derivation (byte-for-byte op order).
      const eyeLen = Math.hypot(eye[0], eye[1], eye[2])
      const ex = eye[0] / eyeLen
      const ey = eye[1] / eyeLen
      const ez = eye[2] / eyeLen
      const cosH = EARTH_R / eyeLen
      const h = eyeHorizon(eye, EARTH_R)
      if (
        !bitEq(h.eyeLen, eyeLen) ||
        !bitEq(h.eyeN[0], ex) ||
        !bitEq(h.eyeN[1], ey) ||
        !bitEq(h.eyeN[2], ez) ||
        !bitEq(h.horizonCos, cosH)
      )
        bad.push(label)
    }
    expect(bad, `label-limb derivation diverged from eyeHorizon at: ${bad.join('; ')}`).toEqual([])
  })

  it('site 2 (tile selector, globe-visible-tiles.ts): horizonCos / eyeN lane-identical (incl. ||1)', () => {
    const bad: string[] = []
    for (const [eye, label] of EYES) {
      // OLD globeVisibleTiles derivation — the `|| 1` degenerate guard included;
      // a no-op for every |eye| > 0 (which every real camera and every swept
      // case is), so the lanes match exactly.
      const eyeLen = Math.hypot(eye[0], eye[1], eye[2]) || 1
      const horizonCos = EARTH_R / eyeLen
      const eyeN: [number, number, number] = [eye[0] / eyeLen, eye[1] / eyeLen, eye[2] / eyeLen]
      const h = eyeHorizon(eye, EARTH_R)
      if (
        !bitEq(h.horizonCos, horizonCos) ||
        !bitEq(h.eyeN[0], eyeN[0]) ||
        !bitEq(h.eyeN[1], eyeN[1]) ||
        !bitEq(h.eyeN[2], eyeN[2])
      )
        bad.push(label)
    }
    expect(bad, `tile-selector derivation diverged from eyeHorizon at: ${bad.join('; ')}`).toEqual(
      [],
    )
  })

  it('site 3 (GPU uniform, globe-eye-uniform.ts): packed lanes + guard branch identical', () => {
    const bad: string[] = []
    for (const [eye, label] of EYES) {
      // OLD globeEyeUniform derivation and its `len <= 0` zero-pack guard.
      const len = Math.hypot(eye[0], eye[1], eye[2])
      const h = eyeHorizon(eye, EARTH_R)
      // Guard branch must fire on the SAME lengths (eyeLen is the identical hypot).
      if (h.eyeLen <= 0 !== len <= 0) {
        bad.push(`${label} (guard branch)`)
        continue
      }
      if (len <= 0) continue // both zero-pack — nothing to compare
      const s0 = eye[0] / len
      const s1 = eye[1] / len
      const s2 = eye[2] / len
      const s3 = EARTH_R / len // the cosine constant the uniform packs
      if (
        !bitEq(h.eyeN[0], s0) ||
        !bitEq(h.eyeN[1], s1) ||
        !bitEq(h.eyeN[2], s2) ||
        !bitEq(h.horizonCos, s3)
      )
        bad.push(label)
    }
    expect(bad, `uniform pack diverged from eyeHorizon at: ${bad.join('; ')}`).toEqual([])
  })

  it('site 1 guard branch (|eye| > R) fires on the identical lengths', () => {
    const bad: string[] = []
    for (const [eye, label] of EYES) {
      const eyeLen = Math.hypot(eye[0], eye[1], eye[2])
      const h = eyeHorizon(eye, EARTH_R)
      // buildGlobeLimbPolygon: `if (!(eyeLen > EARTH_R)) return null`.
      if (h.eyeLen > EARTH_R !== eyeLen > EARTH_R) bad.push(label)
    }
    expect(bad, `label-limb guard branch diverged at: ${bad.join('; ')}`).toEqual([])
    // Non-vacuity: the sweep contains BOTH inside-sphere (guarded null) and
    // above-surface (kept) cameras, so the guard is actually exercised.
    const above = EYES.filter(([e]) => eyeHorizon(e, EARTH_R).eyeLen > EARTH_R).length
    expect(above).toBeGreaterThan(0)
    expect(above).toBeLessThan(EYES.length)
  })

  it('boolean front-hemisphere predicate (site 2 per-sample form) bit-matches the old derivation', () => {
    const pn = 1 / EARTH_R // site 2: P is on the sphere, so 1/|P| = 1/EARTH_R
    const PTS = DIRS.map(([lon, lat]) => surfAt(lon, lat))
    let front = 0
    let back = 0
    const bad: string[] = []
    for (const [eye, label] of EYES) {
      // helper-derived vs old-derived {eyeN, horizonCos}, same per-sample compare.
      const h = eyeHorizon(eye, EARTH_R)
      const eyeLen = Math.hypot(eye[0], eye[1], eye[2]) || 1
      const oN0 = eye[0] / eyeLen
      const oN1 = eye[1] / eyeLen
      const oN2 = eye[2] / eyeLen
      const oCos = EARTH_R / eyeLen
      for (const p of PTS) {
        const fH = (p[0] * h.eyeN[0] + p[1] * h.eyeN[1] + p[2] * h.eyeN[2]) * pn > h.horizonCos
        const fO = (p[0] * oN0 + p[1] * oN1 + p[2] * oN2) * pn > oCos
        if (fH !== fO) bad.push(label)
        if (fH) front++
        else back++
      }
    }
    expect(bad, `predicate diverged (helper vs old) at: ${bad.join('; ')}`).toEqual([])
    // Non-vacuity — the predicate flips across the sweep (not all-front / all-back).
    expect(front).toBeGreaterThan(0)
    expect(back).toBeGreaterThan(0)
  })
})

// ── Part 2 — source-authority gate ──
// Resolve each site relative to THIS file (mirrors the #1044 ratchet convention).
const SITES: Record<string, string> = {
  'render-loop-helpers.ts': join(HERE, '..', 'render-loop-helpers.ts'),
  'globe-eye-uniform.ts': join(HERE, 'globe-eye-uniform.ts'),
  'globe-visible-tiles.ts': join(HERE, '..', '..', '..', 'data', 'src', 'globe-visible-tiles.ts'),
}
const HELPER = join(HERE, '..', '..', '..', 'shared', 'src', 'ecef.ts')

// Strip block + line comments so prose mentions of the formula (frequent — it is
// heavily documented) don't trip the gate; only CODE re-inlines count.
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length

describe('source-authority gate: the sphere-horizon derivation cannot silently drift (#1052)', () => {
  it('each of the three sites routes through eyeHorizon() exactly once', () => {
    for (const [name, path] of Object.entries(SITES)) {
      const n = count(readFileSync(path, 'utf8'), /eyeHorizon\(/g)
      expect(
        n,
        `${name}: expected exactly 1 eyeHorizon() call; got ${n}. HIGHER: a new consumer ` +
          `consciously routing through the authority — bump this expectation. LOWER (0): the ` +
          `derivation was re-inlined — forbidden (#1052); route it through eyeHorizon() instead.`,
      ).toBe(1)
    }
  })

  it('no site re-inlines the horizon cosine (EARTH_R / |eye|)', () => {
    for (const [name, path] of Object.entries(SITES)) {
      const code = stripComments(readFileSync(path, 'utf8'))
      const n = count(code, /EARTH_R\s*\/\s*(?:eyeLen|len)\b/g)
      expect(
        n,
        `${name}: found ${n} inline EARTH_R/|eye| cosine derivation(s) in code — the horizon ` +
          `cosine is the authority's job now (#1052). Read horizonCos off eyeHorizon() instead.`,
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
      count(stripComments(src), /earthR\s*\/\s*eyeLen/g),
      'the horizon cosine `earthR / eyeLen` must be derived once, inside eyeHorizon.',
    ).toBe(1)
  })
})
