// #1342 — `fill-extrusion-base` on the FLAT projection arms.
//
// The 3D (ECEF) arm reads the pre-lifted position the wall-mesh baked, so it
// always honoured the base. The FLAT arms do NOT: they re-project the vertex
// from abs_lon/abs_lat and synthesize plane-z from the extrusion attributes.
// Their pre-fix spelling was `wall_height * is_top`, which has no term for the
// base at all — every wall bottom snapped to z = 0.
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
// (62 % of true height at London's 51.5°).

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
    // The flat-Mercator arm is the `project(...) - u.tile_origin_merc` branch;
    // its vec4 z channel is the 3rd argument.
    const merc = body.match(
      /vec4<f32>\((?:[^;]*?)\.x \+ \(\(\(floor\([^;]*?\)\), (?:_\w+)\.y, ([^,]+), 1\.0\)/,
    )
    expect(merc, 'flat-Mercator extruded vec4 not found').not.toBeNull()
    const z = resolveCse(body, merc![1])
    // Base term present (the whole point of #1342) …
    expect(z).toContain('wall_base')
    // … added to the per-vertex wall lift …
    expect(z).toContain('(wall_height * is_top)')
    // … and divided by cos of the Mercator-clamped latitude.
    expect(z.replace(/\s+/g, '')).toContain(
      'cos(radians(clamp(abs_lat,(-MERCATOR_LAT_LIMIT),MERCATOR_LAT_LIMIT)))',
    )
    expect(z).toMatch(/\/ cos\(/)
  })

  it('flat non-Mercator plane-z carries the base with no Mercator scale', () => {
    // The `flat_rel(abs_lon, abs_lat, …)` arm: a true-metre plane metric, so
    // the base must be added but the cos(lat) divide must NOT be.
    const geo = body.match(/vec4<f32>\((?:_\w+)\.x, (?:_\w+)\.y, ([^,]+), 1\.0\)/)
    expect(geo, 'flat non-Mercator extruded vec4 not found').not.toBeNull()
    const z = resolveCse(body, geo![1])
    expect(z).toContain('wall_base')
    expect(z).toContain('(wall_height * is_top)')
    expect(z).not.toMatch(/cos\(/)
  })
})

describe('#1342 — the wall mesh publishes fill-extrusion-base per vertex', () => {
  const STRIDE = POLYGON_EXTRUDED_FORMAT.stride / 4
  const BASE_SLOT = vertexField(POLYGON_EXTRUDED_FORMAT, 'wall_base').offset / 4
  const HEIGHT_SLOT = vertexField(POLYGON_EXTRUDED_FORMAT, 'wall_height').offset / 4
  const IS_TOP_SLOT = vertexField(POLYGON_EXTRUDED_FORMAT, 'is_top').offset / 4

  // One square, absolute Mercator metres near (0°, 0°); base 128 m, height 4 m
  // — a London-Eye rim capsule's proportions.
  const ring = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]
  const mesh = generateWallMeshExtrudedECEF(
    [{ rings: [ring], featId: 7 }],
    new Map([[7, 4]]),
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
      expect(mesh.vertices[v * STRIDE + HEIGHT_SLOT]).toBe(4)
    }
  })

  it('base + height·is_top reproduces the altitude the mesh baked into ECEF', () => {
    const n = mesh.vertices.length / STRIDE
    for (let v = 0; v < n; v++) {
      const o = v * STRIDE
      const alt =
        mesh.vertices[o + BASE_SLOT] +
        mesh.vertices[o + HEIGHT_SLOT] * mesh.vertices[o + IS_TOP_SLOT]
      expect(alt).toBe(mesh.vertices[o + IS_TOP_SLOT] === 1 ? 132 : 128)
    }
  })

  it('a base-less feature keeps the pre-#1342 altitude (regression guard)', () => {
    const flat = generateWallMeshExtrudedECEF(
      [{ rings: [ring], featId: 7 }],
      new Map([[7, 4]]),
      undefined,
      0,
      0,
      [6378137, 0, 0],
    )
    const n = flat.vertices.length / STRIDE
    for (let v = 0; v < n; v++) expect(flat.vertices[v * STRIDE + BASE_SLOT]).toBe(0)
  })
})
