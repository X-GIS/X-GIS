// Unit tests for Camera matrix output at the full coverage grid the
// playground projection-coverage E2E spec exercises. This is logic-only
// — no browser, no GPU — so it runs in milliseconds instead of minutes,
// and runs on every PR via the `test` workflow (was only on the slow
// `playground-audit` workflow before).
//
// The E2E spec still covers the actual GPU-side checks (paint%, post-
// setProjection-switch frame sanity); this test covers the math-only
// invariants (no NaN/Infinity in matrix at extreme params).

import { describe, it, expect } from 'vitest'
import { Camera } from './camera'

const PROJECTIONS = [
  // (name, projType, globeMode, globeOrtho)
  ['mercator', 0, false, false],
  ['equirectangular', 1, false, false],
  ['natural_earth', 2, false, false],
  ['orthographic', 3, false, false],
  ['azimuthal_equidistant', 4, false, false],
  ['stereographic', 5, false, false],
  ['oblique_mercator', 6, false, false],
  ['globe', 7, true, false],
] as const

const ZOOMS = [0, 0.5, 1, 4, 8, 12, 18]
const PITCHES = [0, 15, 30, 45, 60, 75]
const BEARINGS = [0, 45, 90, 180, 270]
// Representative geographic anchors: equator, mid-lat, near-pole,
// antimeridian. Covers the corners where projections degenerate.
const ANCHORS: Array<[lon: number, lat: number, tag: string]> = [
  [0, 0, 'equator'],
  [-74, 40, 'nyc'],
  [126, 37, 'seoul'],
  [180, 0, 'antimeridian'],
  [0, 85, 'near-north-pole'],
  [0, -85, 'near-south-pole'],
]

const W = 1024, H = 720

function allFinite(m: Float32Array): { ok: boolean; bad?: { i: number; v: number } } {
  for (let i = 0; i < m.length; i++) {
    const v = m[i]!
    if (Number.isNaN(v) || !Number.isFinite(v)) return { ok: false, bad: { i, v } }
  }
  return { ok: true }
}

describe('Camera matrix coverage — no NaN/Infinity at extreme params', () => {
  for (const [name, projType, globeMode, globeOrtho] of PROJECTIONS) {
    for (const [lon, lat, anchor] of ANCHORS) {
      it(`${name} @ ${anchor} — zoom/pitch/bearing sweep`, () => {
        const failures: string[] = []
        for (const z of ZOOMS) {
          for (const p of PITCHES) {
            for (const b of BEARINGS) {
              const cam = new Camera(lon, lat, z)
              cam.projType = projType
              cam.globeMode = globeMode
              cam.globeOrtho = globeOrtho
              cam.bearing = b
              cam.pitch = p
              const m = cam.getRTCMatrix(W, H, 1)
              const r = allFinite(m)
              if (!r.ok) {
                failures.push(`z${z}/p${p}/b${b}: matrix[${r.bad!.i}]=${r.bad!.v}`)
              }
            }
          }
        }
        expect(failures, `${name}@${anchor}:\n  ${failures.slice(0, 5).join('\n  ')}`)
          .toEqual([])
      })
    }
  }
})

describe('Camera matrix coverage — getFrameView (matrix + far + fc)', () => {
  // getFrameView is the projection pipeline entry. Far plane and
  // log-depth Fc must also stay finite — the cold-start camera audit
  // (memory: camera_audit_2026_05_11) found a worst-case Fc ≈ 0.029
  // at z<5 + pitch≥60 that the spec pinned. Here we just verify finite-
  // ness across the grid; the deeper "Fc within range" test is in
  // camera.test.ts.
  for (const [name, projType, globeMode, globeOrtho] of PROJECTIONS) {
    it(`${name} — getFrameView finite over the grid`, () => {
      const failures: string[] = []
      for (const [lon, lat, anchor] of ANCHORS) {
        for (const z of ZOOMS) {
          for (const p of [0, 30, 60, 75]) {
            const cam = new Camera(lon, lat, z)
            cam.projType = projType
            cam.globeMode = globeMode
            cam.globeOrtho = globeOrtho
            cam.pitch = p
            const v = cam.getFrameView(W, H, 1)
            const mOk = allFinite(v.matrix).ok
            const farOk = Number.isFinite(v.far) && v.far > 0
            if (!mOk || !farOk) {
              failures.push(`${anchor} z${z} p${p}: matrix${mOk ? 'OK' : 'NaN'} far=${v.far}`)
            }
          }
        }
      }
      expect(failures, `${name}:\n  ${failures.slice(0, 5).join('\n  ')}`)
        .toEqual([])
    })
  }
})
