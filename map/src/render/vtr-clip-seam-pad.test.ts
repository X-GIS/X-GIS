// ═══ #1087 — fallback clip-window overlap pad: no background seam on shared boundaries ═══
//
// Globe fallback (ancestor) tiles draw as chord meshes whose fragments are masked by a
// per-draw `clip_bounds` Mercator rect confined to each missing-child window
// (vector-tile-renderer.ts, the real-window arm inside renderTileKeys). Adjacent fallback
// child windows share EXACT boundary values (Mercator y=0 at the equator; the z-row/column
// seams). The polygon/line fragment shader reconstructs `abs_merc_x/y` per-fragment in f32
// from EACH DRAW'S OWN vertex data, so the same screen pixel can evaluate y = B-ε in the
// north draw (discarded: `< clip.y = B`) AND y = B+ε' in the south draw (discarded:
// `> clip.w = B`) — discarded by BOTH → a 1-px background-coloured dashed line along the
// shared boundary (the reported "white line along the equator").
//
// Fix (CPU-side only, no shader change): inflate each real window outward by one CSS pixel
// of Mercator metres so adjacent windows OVERLAP; every boundary fragment then survives in
// at least one draw. This pins the INVARIANT at the CPU level and a source gate ties the
// pack site to it. The invariant halves are pure math (they PROVE the mechanism + the fix);
// the source gate is the fail-before lever (pristine source has no `clipPad` → RED).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EARTH } from '@xgis/shared'

// ── Shader discard predicate, emulated in plain JS (same strict inequalities + gate) ──
type Clip = { x: number; y: number; z: number; w: number }
const clipValid = (c: Clip): boolean => c.x > -1e29 && c.z > c.x && c.w > c.y
const discards = (c: Clip, fx: number, fy: number): boolean => {
  if (!clipValid(c)) return false
  if (fx < c.x) return true
  if (fx > c.z) return true
  if (fy < c.y) return true
  if (fy > c.w) return true
  return false
}

// One CSS pixel of Mercator metres at `zoom` — mirrors the source pad formula
// `(2 * Math.PI * R) / (512 * Math.pow(2, zoom))` with R = activeBody().sphereR (EARTH here).
const padMeters = (zoom: number): number =>
  (2 * Math.PI * EARTH.sphereR) / (512 * Math.pow(2, zoom))

// A few f32 ULPs of B (the per-draw reconstruction noise). B = 0 (equator) → smallest subnormal.
const f32Ulp = (x: number): number => {
  const xf = Math.fround(x)
  if (xf === 0) return 2 ** -149
  const bigger = Math.fround(xf + Math.abs(xf) * 2 ** -23)
  const d = Math.abs(bigger - xf)
  return d > 0 ? d : Math.abs(xf) * 2 ** -23
}

describe('#1087 fallback clip-window overlap pad — CPU invariant', () => {
  // Each case: a boundary B shared by two adjacent windows, per-draw straddle ±eps, at a zoom.
  // eps is either "a few f32 ULPs of B" (the real reconstruction noise) or "half a pad".
  const yCases: { name: string; B: number; zoom: number }[] = [
    { name: 'equator (Mercator y=0) — the reported symptom', B: 0, zoom: 4 },
    { name: 'equator at detail zoom', B: 0, zoom: 15 },
    { name: 'mid-latitude z-row seam (B≈5e6 m)', B: 5_000_000, zoom: 15 },
  ]

  for (const { name, B, zoom } of yCases) {
    const H = 2_000_000 // window half-extent on the boundary axis (fragment stays interior otherwise)
    const W = -8_000_000
    const E = 8_000_000
    const pad = padMeters(zoom)
    const epses = [f32Ulp(B) * 3, pad / 2]

    for (const eps of epses) {
      it(`shared-Y ${name}: unpadded double-discards, padded keeps (eps=${eps.toExponential(2)})`, () => {
        expect(eps).toBeLessThan(pad) // fix regime: the pad covers the reconstruction noise
        const fx = 0 // interior on the x axis
        const fyNorth = B - eps // north draw reconstructs just below B  → discarded by `< clip.y`
        const fySouth = B + eps // south draw reconstructs just above B  → discarded by `> clip.w`

        // Pre-fix (unpadded): the same boundary pixel is discarded by BOTH draws.
        const north = { x: W, y: B, z: E, w: B + H }
        const south = { x: W, y: B - H, z: E, w: B }
        expect(discards(north, fx, fyNorth)).toBe(true)
        expect(discards(south, fx, fySouth)).toBe(true)

        // Post-fix (padded): at least one draw keeps it (here the interior draw keeps it).
        const northP = { x: W - pad, y: B - pad, z: E + pad, w: B + H + pad }
        const southP = { x: W - pad, y: B - H - pad, z: E + pad, w: B + pad }
        const kept = !discards(northP, fx, fyNorth) || !discards(southP, fx, fySouth)
        expect(kept).toBe(true)
      })
    }
  }

  it('shared-X vertical seam: unpadded double-discards, padded keeps', () => {
    const Bx = 3_000_000
    const zoom = 15
    const pad = padMeters(zoom)
    const eps = pad / 2
    const S = -8_000_000
    const N = 8_000_000
    const fy = 0 // interior on the y axis
    const fxWest = Bx + eps // west draw reconstructs just east of its east edge → `> clip.z`
    const fxEast = Bx - eps // east draw reconstructs just west of its west edge → `< clip.x`

    const west = { x: -8_000_000, y: S, z: Bx, w: N }
    const east = { x: Bx, y: S, z: 8_000_000, w: N }
    expect(discards(west, fxWest, fy)).toBe(true)
    expect(discards(east, fxEast, fy)).toBe(true)

    const westP = { x: -8_000_000 - pad, y: S - pad, z: Bx + pad, w: N + pad }
    const eastP = { x: Bx - pad, y: S - pad, z: 8_000_000 + pad, w: N + pad }
    const kept = !discards(westP, fxWest, fy) || !discards(eastP, fxEast, fy)
    expect(kept).toBe(true)
  })

  it('sentinel window (-1e30, 0, 0, 0) is a no-clip pass-through (never padded, never discards)', () => {
    const sentinel = { x: -1e30, y: 0, z: 0, w: 0 }
    expect(clipValid(sentinel)).toBe(false)
    // No fragment is ever discarded by the sentinel, at any coordinate.
    for (const [fx, fy] of [
      [0, 0],
      [1e7, -1e7],
      [-5e6, 5e6],
    ]) {
      expect(discards(sentinel, fx, fy)).toBe(false)
    }
  })
})

// ── Source gate: the real-window arm applies the pad; every sentinel arm stays unpadded. ──
// This is the fail-before lever: pristine vector-tile-renderer.ts has no `clipPad`, so the
// two `clipPad` assertions go RED under `git stash` of the source fix.
describe('#1087 source gate — pack site vs sentinels', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'vector-tile-renderer.ts'),
    'utf8',
  )

  it('real-window arm computes the 1-CSS-px Mercator pad from the in-scope R + camera zoom', () => {
    expect(src).toMatch(
      /const clipPad = \(2 \* Math\.PI \* R\) \/ \(512 \* Math\.pow\(2, this\.currentCameraZoom\)\)/,
    )
  })

  it('real-window arm inflates the clip rect outward (min edges -pad, max edges +pad)', () => {
    expect((src.match(/- clipPad/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect((src.match(/\+ clipPad/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('every sentinel arm stays the unpadded no-clip constant (byte-identical)', () => {
    // 3 pre-pass sentinels + the real-window else arm = 4 exact `(-1e30, 0, 0, 0)` packs.
    expect((src.match(/clip_bounds\(-1e30, 0, 0, 0\)/g) ?? []).length).toBe(4)
    // and no sentinel line carries the pad.
    expect(src).not.toMatch(/clip_bounds\(-1e30, 0, 0, 0\).*clipPad/)
  })
})
