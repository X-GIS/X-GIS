import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// A-5 KNOWN LIMITATION: PointRenderer only supports Mercator.
//
// Point positions are computed CPU-side via `tile_rtc = -project(center)`
// at point-renderer.ts:865-881, using hardcoded Mercator formulas. The
// WGSL shader declares `proj_params: vec4<f32>` in its Uniforms struct
// but does NOT read it — the point vertex shader transforms via the MVP
// matrix only, so the per-projection reprojection available to polygons
// (renderer.ts `fn project(lon, lat)`) is missing for points.
//
// Result: if a map uses any projection other than Mercator (equirect,
// Natural Earth, ortho, azimuthal, stereographic, oblique mercator),
// point layers remain in Mercator world positions while polygon layers
// reproject. Points end up visually misplaced relative to the polygons
// they were supposed to label.
//
// These tests lock in the current limited behavior so a future change
// that adds per-projection support for points (or plumbs projType
// through to the point shader) breaks these assertions in a clearly-
// failing way, prompting the author to delete this file.

const __dirname = dirname(fileURLToPath(import.meta.url))
const POINT_RENDERER = resolve(__dirname, '../engine/point-renderer.ts')

describe('A-5: Point renderer Mercator-only lock-in', () => {
  const source = readFileSync(POINT_RENDERER, 'utf8')

  it('WGSL Uniforms struct declares proj_params but does not read it', () => {
    // The struct declares the field (for future use / uniform layout
    // compatibility with other renderers), but the shader body never
    // references `u.proj_params`. When someone implements per-projection
    // point transforms, the shader will start reading proj_params — this
    // test flags that moment.
    expect(source).toMatch(/proj_params:\s*vec4<f32>/)
    expect(source).not.toMatch(/u\.proj_params\./)
  })

  it('CPU tile_rtc computation hardcodes Mercator projection', () => {
    // tile_rtc (uf[20] = projected_center_lon_in_meters, uf[21] =
    // projected_center_lat_in_mercator_meters). The formulas are the
    // Mercator forward transform inlined — no branch on projType. This
    // is the core reason non-Mercator maps show misplaced points.
    expect(source).toMatch(/uf\[20\]\s*=\s*-projCenterLon\s*\*\s*DEG2RAD\s*\*\s*R/)
    expect(source).toMatch(/uf\[21\]\s*=\s*-Math\.log\(Math\.tan\(/)
  })

  it('proj_params.x is hardcoded to 0 (Mercator enum value)', () => {
    // Both render paths (renderTilePoints, flushTilePoints) write
    // `uf[16] = 0  // Mercator`. When someone accepts a projType
    // parameter and passes it through, uf[16] will become dynamic and
    // the hardcoded `0` assignments should disappear.
    const mercatorLines = source.match(/uf\[16\]\s*=\s*0/g) || []
    expect(mercatorLines.length).toBeGreaterThanOrEqual(2)
  })
})
