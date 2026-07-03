// iter-340 — camera/globe tilt continuity (recommendation E, redone with
// a VISIBLE metric). The iter-338 attempt used full-matrix L2, which is
// dominated by the translation column (centre in metres ~1e8) and so
// measured position magnitude, not the rotation a "sudden tilt" is.
//
// Correct metric: project a FIXED world point through the matrix each
// step and track its NDC (clip.xy / clip.w) — i.e. where a fixed ground
// feature lands on screen. A smooth pitch/bearing sweep moves it along a
// smooth NDC curve; the user-reported "globe suddenly tilts" is a JUMP
// in that curve. NDC is normalised → host/scale-independent.
//
// getDebugSnapshot now returns the globe-frame matrix in globe mode
// (iter-338), so this directly gates the globe-tilt class. For the flat
// projections (mercator/equirect/natural_earth) the matrix is the full
// transform too. (ortho/stereo/azimuthal apply their projection in the
// shader, so here the matrix is the underlying flat camera — still a
// valid camera-continuity sub-check.)

import { test, expect } from '@playwright/test'

const PROJECTIONS = [
  'mercator',
  'globe',
  'equirectangular',
  'natural_earth',
  'orthographic',
  'stereographic',
  'azimuthal_equidistant',
  'oblique_mercator',
]

test('camera/globe tilt continuity — fixed point moves smoothly under pitch/bearing', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.setViewportSize({ width: 800, height: 800 })
  await page.goto('/debug-labels.html?style=openfreemap-bright#4/30/127', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => !!(window as unknown as { __xgisMap?: unknown }).__xgisMap,
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(6_000)

  const reports = await page.evaluate(async () => {
    const m = (
      window as unknown as {
        __xgisMap: {
          setProjection(n: string): void
          getCamera(): {
            centerX: number
            centerY: number
            zoom: number
            bearing: number
            pitch: number
            maxZoom: number
          }
          markCameraPositioned(): void
          invalidate?(): void
          getCameraDebugSnapshot(w: number, h: number, dpr?: number): { matrix: number[] }
        }
      }
    ).__xgisMap
    const R = 6378137,
      RAD = Math.PI / 180
    const setCam = (zoom: number, bearing: number, pitch: number) => {
      const c = m.getCamera()
      c.zoom = zoom
      c.centerX = 127 * RAD * R
      c.centerY = Math.log(Math.tan(Math.PI / 4 + (30 * RAD) / 2)) * R
      c.bearing = bearing
      c.pitch = pitch
      m.markCameraPositioned()
      m.invalidate?.()
    }
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    // column-major mat4 · vec4 → clip; NDC = xy/w. Point in RTC metres
    // (relative to the view centre).
    const ndc = (M: number[], x: number, y: number, z: number): [number, number] => {
      const cx = M[0]! * x + M[4]! * y + M[8]! * z + M[12]!
      const cy = M[1]! * x + M[5]! * y + M[9]! * z + M[13]!
      const cw = M[3]! * x + M[7]! * y + M[11]! * z + M[15]!
      const w = Math.abs(cw) < 1e-9 ? 1e-9 : cw
      return [cx / w, cy / w]
    }
    // Two fixed ground points 300 km N and 300 km E of centre.
    const D = 3e5
    const sweep = async (kind: 'pitch' | 'bearing', from: number, to: number): Promise<number> => {
      const N = 24
      const traj: [number, number, number, number][] = [] // [northNdcX,Y, eastNdcX,Y]
      for (let i = 0; i <= N; i++) {
        const v = from + (to - from) * (i / N)
        setCam(4, kind === 'bearing' ? v : 0, kind === 'pitch' ? v : 0)
        await sleep(60)
        const M = m.getCameraDebugSnapshot(800, 800, 1).matrix
        const n = ndc(M, 0, D, 0),
          e = ndc(M, D, 0, 0)
        traj.push([n[0], n[1], e[0], e[1]])
      }
      const deltas: number[] = []
      for (let i = 1; i < traj.length; i++) {
        let s = 0
        for (let k = 0; k < 4; k++) {
          const d = traj[i]![k] - traj[i - 1]![k]
          s += d * d
        }
        deltas.push(Math.sqrt(s))
      }
      const sorted = [...deltas].sort((a, b) => a - b)
      const median = Math.max(sorted[Math.floor(sorted.length / 2)] || 1e-9, 1e-6)
      return Math.max(...deltas) / median
    }
    const out: { proj: string; pitch: number; bearing: number; pitch0: number }[] = []
    for (const proj of [
      'mercator',
      'globe',
      'equirectangular',
      'natural_earth',
      'orthographic',
      'stereographic',
      'azimuthal_equidistant',
      'oblique_mercator',
    ]) {
      m.setProjection(proj)
      await sleep(400)
      out.push({
        proj,
        // Pitched range [2,70]: the continuity users actually drag through.
        pitch: await sweep('pitch', 2, 70),
        bearing: await sweep('bearing', 0, 350),
        // pitch-0→2 first step alone — the azimuthal family has a KNOWN
        // discontinuity at the pitch-0 special case (OPEN non_merc_z0
        // class); logged separately, not gated.
        pitch0: await sweep('pitch', 0, 2),
      })
    }
    return out
  })

  const offenders: string[] = []
  for (const r of reports) {
    console.log(
      `[${r.proj}] pitch[2,70] NDC max/median=${r.pitch.toFixed(1)} bearing=${r.bearing.toFixed(1)} | pitch0→2=${r.pitch0.toFixed(1)} (known azimuthal z0 case, logged)`,
    )
    if (r.pitch > 10) offenders.push(`${r.proj} pitch ${r.pitch.toFixed(1)}×`)
    if (r.bearing > 10) offenders.push(`${r.proj} bearing ${r.bearing.toFixed(1)}×`)
  }
  console.log(
    `offenders: ${offenders.length ? offenders.join(' | ') : 'none'}; pageErrors: ${errs.length}`,
  )
  expect(errs, errs.slice(0, 3).join(' | ')).toHaveLength(0)
  // Gate the pitched range (where users drag) + bearing. The pitch-0
  // azimuthal special-case is logged above, tracked in memory
  // (project_live_render_gates / non_merc_z0_pitch), not gated here.
  expect(offenders, 'on-screen position jumps under smooth pitch/bearing (visible tilt)').toEqual(
    [],
  )
})
