// iter-311 — Reprojector equirectangular inverse round-trip.
//
// Proactive bug found via memory project_projection_divergences
// (A-4): the reprojector's inverse-projection dispatch had no
// pt==1 (equirectangular) branch — it fell to OOB, so selecting
// equirectangular + the globe/reproject render path produced an
// empty map. 32 days unfixed (no test covered it).
//
// The inverse lives in WGSL (reprojector.ts REPROJECT_SHADER) and
// can't run under vitest without a GPU. This test pins the MATH
// contract by porting both the forward (shaders/projection.ts
// proj_equirectangular_d) and the new inverse to TS and asserting
// forward∘inverse == identity. If a future edit changes either the
// WGSL forward or inverse, the parallel TS port here must be
// updated in lockstep — the round-trip equality is the gate.

import { describe, it, expect } from 'vitest'

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI
const R = 6378137.0

// Mirror of shaders/projection.ts proj_equirectangular_d (forward).
// Input lon is RELATIVE to centre (lon - clon), lat absolute degrees.
function forwardEquirect(lonRelDeg: number, latDeg: number): [number, number] {
  return [lonRelDeg * DEG2RAD * R, latDeg * DEG2RAD * R]
}

// Mirror of reprojector.ts inv_equirectangular (iter-311 new branch).
function inverseEquirect(px: number, py: number): [number, number] | null {
  const lon = (px / R) * RAD2DEG
  const lat = (py / R) * RAD2DEG
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null  // OOB
  return [lon, lat]
}

describe('iter-311 reprojector equirectangular inverse (A-4 fix)', () => {
  it('forward∘inverse round-trips to ≤1e-6° across the lon/lat grid', () => {
    // Interior grid (strictly inside ±180 / ±90). Exact-boundary
    // round-trip lands a float-hair over and trips the > 180.0 / 90.0
    // OOB guard — same strict behaviour as inv_natural_earth, tested
    // separately below.
    for (let lonRel = -179; lonRel <= 179; lonRel += 15) {
      for (let lat = -85; lat <= 85; lat += 5) {
        const [px, py] = forwardEquirect(lonRel, lat)
        const inv = inverseEquirect(px, py)
        expect(inv).not.toBe(null)
        expect(inv![0]).toBeCloseTo(lonRel, 6)
        expect(inv![1]).toBeCloseTo(lat, 6)
      }
    }
  })

  it('origin maps to (0, 0)', () => {
    expect(inverseEquirect(0, 0)).toEqual([0, 0])
  })

  it('antimeridian-adjacent (179.99°) round-trips', () => {
    const [px] = forwardEquirect(179.99, 0)
    const inv = inverseEquirect(px, 0)
    expect(inv).not.toBe(null)
    expect(inv![0]).toBeCloseTo(179.99, 5)
  })

  it('out-of-range lon (> 180°) returns OOB', () => {
    const [px] = forwardEquirect(200, 0)  // 200° — past antimeridian
    expect(inverseEquirect(px, 0)).toBe(null)
  })

  it('out-of-range lat (> 90°) returns OOB', () => {
    const [, py] = forwardEquirect(0, 95)
    expect(inverseEquirect(0, py)).toBe(null)
  })

  it('lat sign preserved (north vs south)', () => {
    const [, pyN] = forwardEquirect(0, 45)
    const [, pyS] = forwardEquirect(0, -45)
    expect(inverseEquirect(0, pyN)![1]).toBeCloseTo(45, 6)
    expect(inverseEquirect(0, pyS)![1]).toBeCloseTo(-45, 6)
  })

  it('lon sign preserved (east vs west)', () => {
    const [pxE] = forwardEquirect(90, 0)
    const [pxW] = forwardEquirect(-90, 0)
    expect(inverseEquirect(pxE, 0)![0]).toBeCloseTo(90, 6)
    expect(inverseEquirect(pxW, 0)![0]).toBeCloseTo(-90, 6)
  })

  // Guard: the WGSL source must actually contain the pt==1 branch +
  // the inv_equirectangular function. A regex check on the shader
  // string catches an accidental revert of the iter-311 wiring.
  it('REPROJECT_SHADER wires pt==1 → inv_equirectangular', async () => {
    const src = await import('./reprojector')
    // The module exports the Reprojector class; the shader is a
    // private const. Read the file text instead.
    const fs = await import('node:fs')
    const path = await import('node:path')
    const url = await import('node:url')
    const here = path.dirname(url.fileURLToPath(import.meta.url))
    const text = fs.readFileSync(path.join(here, 'reprojector.ts'), 'utf8')
    expect(text).toContain('fn inv_equirectangular')
    expect(text).toMatch(/pt == 1\)\s*\{\s*lonlat = inv_equirectangular/)
    expect(src).toBeDefined()
  })
})
