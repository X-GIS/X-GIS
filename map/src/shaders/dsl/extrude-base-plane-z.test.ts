// #1342 — `fill-extrusion-base` on the FLAT projection arms.
//
// The 3D (ECEF) arm reads the pre-lifted position the wall-mesh baked, so it
// saw a base at all. The FLAT arms do NOT: they re-project the vertex from
// abs_lon/abs_lat and synthesize plane-z from the extrusion attributes. Their
// pre-fix spelling was `wall_height * is_top`, which has no term for the base
// at all — every wall bottom snapped to z = 0.
//
// Mapbox treats `fill-extrusion-height` and `-base` as BOTH absolute altitudes:
// a wall spans [base, height], and height is NOT a thickness above the base.
// The wall-mesh extruded to `base + height`, which on the London Eye's rim
// (base 128 m, height 132 m) produced a 132 m slab instead of a 4 m capsule.
//
// Real-world witness: OSM maps the London Eye as ~145 `building:part` pieces
// whose `render_min_height` runs up to 132 m (rim segments, spokes, capsules).
// On the flat Mercator arm each was extruded from the GROUND to its top height,
// so the union of those slabs filled the wheel's interior solid instead of
// leaving an open ring. OFM Liberty's `building-3d` layer is exactly this
// style: `fill-extrusion-base: ["get", "render_min_height"]`.
//
// The same expression also carries the Mercator plane scale: plane metres are
// ground metres / cos(lat), so an unscaled altitude renders cos(lat)× short
// (62 % of true height at London's 51.5°). Measured at the London Eye at z16 /
// pitch 0 with a uniform 200 m extrusion, mask IoU vs MapLibre is 0.985 scaled
// and 0.921 unscaled.

import { describe, it, expect } from 'vitest'
import { emitPolygonWgsl } from './polygon'
import { generateWallMeshExtrudedECEF } from '../../core/polygon-mesh'
import { POLYGON_EXTRUDED_FORMAT, vertexField } from '@xgis/compiler'

const wgsl = emitPolygonWgsl(null, false)

/** Body of the `vs_main_ecef_extruded` entry (up to the next `@vertex`/`@fragment`). */
function extrudedEntry(src: string): string {
  const start = src.indexOf('fn vs_main_ecef_extruded')
  expect(start).toBeGreaterThan(-1)
  const rest = src.slice(start)
  const end = rest.search(/\n@(vertex|fragment|compute)/)
  return end === -1 ? rest : rest.slice(0, end)
}

/** Inline every `let _cseN = …;` binding so an assertion can be made against
 *  the resolved expression instead of CSE-assigned temp names. */
function resolveCse(body: string, expr: string): string {
  const bindings = new Map<string, string>()
  for (const m of body.matchAll(/let (_\w+) = (.+);$/gm)) bindings.set(m[1], m[2])
  let out = expr
  for (let i = 0; i < 12; i++) {
    const next = out.replace(/_\w+/g, (name) => bindings.get(name) ?? name)
    if (next === out) break
    out = next
  }
  return out
}

describe('#1342 — fill-extrusion-base reaches the FLAT projection arms', () => {
  const body = extrudedEntry(wgsl)

  it('vs_main_ecef_extruded takes wall_base at @location(8)', () => {
    expect(body).toMatch(/@location\(8\)\s*wall_base\s*:\s*f32/)
    expect(vertexField(POLYGON_EXTRUDED_FORMAT, 'wall_base').location).toBe(8)
  })

  it('flat-Mercator plane-z is (wall_base + wall_height·is_top) / cos(lat)', () => {
    // The flat-Mercator arm positions from `(local_merc - cam_h) - cam_l`;
    // its vec4 z channel is the 3rd argument.
    const merc = body.match(/_av0 = \(u\.mvp \* vec4<f32>\((_\w+)\.x, \1\.y, ([^,]+), 1\.0\)\);/)
    expect(merc, 'flat-Mercator extruded vec4 not found').not.toBeNull()
    expect(resolveCse(body, merc![1])).toContain('local_merc')
    const z = resolveCse(body, merc![2])
    // Base term present (the whole point of #1342) …
    expect(z).toContain('wall_base')
    // … interpolated to the ABSOLUTE top by is_top (not base + height) …
    expect(z.replace(/\s+/g, '')).toContain('max((wall_height-wall_base),0.0)')
    expect(z).toContain('is_top')
    // … and divided by cos of the Mercator-clamped latitude.
    expect(z.replace(/\s+/g, '')).toContain(
      'cos(radians(clamp(abs_lat,(-MERCATOR_LAT_LIMIT),MERCATOR_LAT_LIMIT)))',
    )
    expect(z).toMatch(/\/ cos\(/)
  })

  it('flat non-Mercator plane-z carries the base with no Mercator scale', () => {
    // The `flat_rel(abs_lon, abs_lat, …)` arm: a true-metre plane metric, so
    // the base must be added but the cos(lat) divide must NOT be.
    const geo = body.match(
      /\} else if [\s\S]*?_av0 = \(u\.mvp \* vec4<f32>\((_\w+)\.x, \1\.y, ([^,]+), 1\.0\)\);/,
    )
    expect(geo, 'flat non-Mercator extruded vec4 not found').not.toBeNull()
    expect(resolveCse(body, geo![1])).toContain('flat_rel(')
    const z = resolveCse(body, geo![2])
    expect(z).toContain('wall_base')
    expect(z.replace(/\s+/g, '')).toContain('max((wall_height-wall_base),0.0)')
    expect(z).not.toMatch(/cos\(/)
  })
})

describe('#1342 — the wall mesh publishes fill-extrusion-base per vertex', () => {
  const STRIDE = POLYGON_EXTRUDED_FORMAT.stride / 4
  const BASE_SLOT = vertexField(POLYGON_EXTRUDED_FORMAT, 'wall_base').offset / 4
  const HEIGHT_SLOT = vertexField(POLYGON_EXTRUDED_FORMAT, 'wall_height').offset / 4
  const IS_TOP_SLOT = vertexField(POLYGON_EXTRUDED_FORMAT, 'is_top').offset / 4

  // One square, absolute Mercator metres near (0°, 0°); base 128 m, top 132 m
  // — a London-Eye rim capsule's proportions.
  const ring = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]
  const mesh = generateWallMeshExtrudedECEF(
    [{ rings: [ring], featId: 7 }],
    new Map([[7, 132]]),
    new Map([[7, 128]]),
    0,
    0,
    [6378137, 0, 0],
  )

  it('every vertex carries base 128 — walls, wall-tops and roof alike', () => {
    const n = mesh.vertices.length / STRIDE
    expect(n).toBeGreaterThan(0)
    for (let v = 0; v < n; v++) {
      expect(mesh.vertices[v * STRIDE + BASE_SLOT]).toBe(128)
      expect(mesh.vertices[v * STRIDE + HEIGHT_SLOT]).toBe(132)
    }
  })

  it('the wall spans [base, height] — an absolute top, not base + height', () => {
    const n = mesh.vertices.length / STRIDE
    for (let v = 0; v < n; v++) {
      const o = v * STRIDE
      const b = mesh.vertices[o + BASE_SLOT]
      const h = mesh.vertices[o + HEIGHT_SLOT]
      const alt = b + Math.max(h - b, 0) * mesh.vertices[o + IS_TOP_SLOT]
      // 128 m base, 132 m top — a 4 m rim capsule, NOT a 132 m slab.
      expect(alt).toBe(mesh.vertices[o + IS_TOP_SLOT] === 1 ? 132 : 128)
    }
  })

  it('a base-less feature keeps the pre-#1342 altitude (regression guard)', () => {
    const flat = generateWallMeshExtrudedECEF(
      [{ rings: [ring], featId: 7 }],
      new Map([[7, 132]]),
      undefined,
      0,
      0,
      [6378137, 0, 0],
    )
    const n = flat.vertices.length / STRIDE
    for (let v = 0; v < n; v++) expect(flat.vertices[v * STRIDE + BASE_SLOT]).toBe(0)
  })
})
