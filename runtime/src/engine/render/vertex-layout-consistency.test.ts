// iter-320 — GPU-upload correctness: vertex attribute-layout
// consistency. Companion to iter-319 (uniforms).
//
// Each render pipeline binds a GPUVertexBufferLayout whose
// `attributes[].shaderLocation` set MUST cover every `@location(N)`
// the bound vertex entry point reads. A missing location → the GPU
// reads an undefined attribute (validation error or garbage
// vertex). A wrong offset / format → vertices land at the wrong
// byte → smeared geometry. A wrong arrayStride vs the CPU pack
// stride → every vertex after the first is misaligned.
//
// This gate parses both the WGSL @location inputs and the
// GPUVertexBufferLayout descriptors from renderer.ts source and
// asserts coverage + offset/stride sanity against the canonical
// contract (which the CPU packers in vector-tiler.ts produce).
//
// Phase 2 PR 2c.2 transition note: the polygon pipeline migrated
// from Mercator-DSFUN quantized stride-8 (+ parallel extrudedZBufferLayout
// stride-16) to a unified ECEF-DSFUN layout (stride-36 flat-fill,
// stride-56 extruded). Layout assertions below target the new
// ECEF semantics. The polygon-DSL VS rewrite + renderer.ts pipeline
// binding swaps land in companion sub-tasks of the same PR; until
// every sub-task is integrated the layout const names may not yet
// be present in renderer.ts. The describe block skips gracefully
// when that's the case so the rest of the suite stays green.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emitPolygonWgsl } from '../shader-dsl/shaders/polygon'
import { POLYGON_FILL_FORMAT, POLYGON_EXTRUDED_FORMAT } from '@xgis/compiler'
import { specShaderMismatches } from './__vertex-format-crosscheck'

const HERE = dirname(fileURLToPath(import.meta.url))
// GPUVertexBufferLayout consts stay in renderer.ts; the WGSL (with the
// vs_main* @location signatures) now comes from the polygon DSL
// composer's emit. Phase 2.5 US-008 + US-010 retired renderer-shaders.ts.
const SRC = readFileSync(join(HERE, 'renderer.ts'), 'utf8')
const SHADER_SRC = emitPolygonWgsl(null, false)

// GPUVertexFormat → byte width.
const FORMAT_BYTES: Record<string, number> = {
  uint16x2: 4, uint16x4: 8, float32: 4, float32x2: 8, float32x3: 12, float32x4: 16,
  uint32: 4, sint16x2: 4,
}

interface Attr { location: number; offset: number; format: string }
interface Layout { stride: number; attrs: Attr[] }

/** Parse a named GPUVertexBufferLayout const from renderer.ts. Returns
 *  `null` when the const is absent (PR 2c.2 transition guard — sibling
 *  sub-tasks may retire / rename layouts independently). */
function tryParseLayout(constName: string): Layout | null {
  const re = new RegExp(`const ${constName}\\s*:\\s*GPUVertexBufferLayout\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\}`)
  const m = SRC.match(re)
  if (!m) return null
  const body = m[1]!
  const strideM = body.match(/arrayStride:\s*(\d+)/)
  if (!strideM) return null
  const stride = parseInt(strideM[1]!, 10)
  const attrs: Attr[] = []
  const attrRe = /shaderLocation:\s*(\d+),\s*offset:\s*(\d+),\s*format:\s*'(\w+)'/g
  let a: RegExpExecArray | null
  while ((a = attrRe.exec(body)) !== null) {
    attrs.push({ location: parseInt(a[1]!, 10), offset: parseInt(a[2]!, 10), format: a[3]! })
  }
  return { stride, attrs }
}

/** Parse the @location(N) inputs a WGSL fn reads from its param list. */
function tryParseFnLocations(fnName: string): number[] | null {
  const re = new RegExp(`fn ${fnName}\\s*\\(([\\s\\S]*?)\\)\\s*->`)
  const m = SHADER_SRC.match(re)
  if (!m) return null
  const params = m[1]!
  const locs: number[] = []
  const locRe = /@location\((\d+)\)/g
  let l: RegExpExecArray | null
  while ((l = locRe.exec(params)) !== null) locs.push(parseInt(l[1]!, 10))
  return locs.sort((x, y) => x - y)
}

function assertLayoutSane(layout: Layout, ctx: string): void {
  for (const at of layout.attrs) {
    const w = FORMAT_BYTES[at.format]
    expect(w, `${ctx} unknown format ${at.format}`).not.toBe(undefined)
    // Attribute must fit within the stride.
    expect(at.offset + w!, `${ctx} loc${at.location} overruns stride`).toBeLessThanOrEqual(layout.stride)
  }
}

describe('iter-320 vertex attribute-layout consistency (CPU pack ↔ WGSL @location)', () => {
  const line = tryParseLayout('lineVertexBufferLayout')

  it('line layout: stride 36 (ECEF-DSFUN stride-9), loc0 pos_h@0 + loc1 pos_l@12 + loc2 fid@24 + loc3 abs_lon@28 + loc4 abs_lat@32', () => {
    if (!line) {
      // Line pipeline preserved; layout MUST exist.
      throw new Error('lineVertexBufferLayout not found in renderer.ts')
    }
    // PR 2d.1D: migrated from DSFUN stride-24 to ECEF-DSFUN stride-36.
    // Matches vertexBufferLayout (polygon ECEF). Consumer: vs_main (graticule).
    expect(line.stride).toBe(36)
    const byLoc = new Map(line.attrs.map(a => [a.location, a]))
    expect(byLoc.get(0)).toEqual({ location: 0, offset:  0, format: 'float32x3' })
    expect(byLoc.get(1)).toEqual({ location: 1, offset: 12, format: 'float32x3' })
    expect(byLoc.get(2)).toEqual({ location: 2, offset: 24, format: 'float32' })
    expect(byLoc.get(3)).toEqual({ location: 3, offset: 28, format: 'float32' })
    expect(byLoc.get(4)).toEqual({ location: 4, offset: 32, format: 'float32' })
    assertLayoutSane(line, 'line')
  })

  // PR 2f single-source: the polygon fill/extruded GPUVertexBufferLayouts in
  // renderer.ts now DERIVE from POLYGON_FILL_FORMAT / POLYGON_EXTRUDED_FORMAT
  // (@xgis/compiler) via toVertexBufferLayout(), and the packer derives its
  // byte offsets from the SAME specs. So instead of re-parsing renderer.ts
  // literals (which no longer exist), we (1) pin the spec to the canonical
  // contract and (2) cross-check the spec against the WGSL @location the
  // shader actually reads — closing the layout↔shader drift that the PR-2f
  // variant bug exploited.

  it('polygon fill spec is PR 2f quantized ECEF (stride 24: uint16x4 + uint16x2 + 3×f32)', () => {
    expect(POLYGON_FILL_FORMAT.stride).toBe(24)
    expect(POLYGON_FILL_FORMAT.fields.map(f => [f.location, f.offset, f.vbFormat])).toEqual([
      [0,  0, 'uint16x4'],
      [1,  8, 'uint16x2'],
      [2, 12, 'float32'],
      [3, 16, 'float32'],
      [4, 20, 'float32'],
    ])
    for (const f of POLYGON_FILL_FORMAT.fields) expect(f.offset % 4).toBe(0)
  })

  it('polygon extruded spec is PR 2f quantized ECEF (stride 44)', () => {
    expect(POLYGON_EXTRUDED_FORMAT.stride).toBe(44)
    expect(POLYGON_EXTRUDED_FORMAT.fields.map(f => [f.location, f.offset, f.vbFormat])).toEqual([
      [0,  0, 'uint16x4'],
      [1,  8, 'uint16x2'],
      [2, 12, 'float32'],
      [3, 16, 'float32'],
      [4, 20, 'float32'],
      [5, 24, 'float32x3'],
      [6, 36, 'float32'],
      [7, 40, 'float32'],
    ])
    for (const f of POLYGON_EXTRUDED_FORMAT.fields) expect(f.offset % 4).toBe(0)
  })

  it('polygon fill spec ↔ vs_main_ecef WGSL @location types match exactly', () => {
    expect(specShaderMismatches(POLYGON_FILL_FORMAT, SHADER_SRC, 'vs_main_ecef')).toEqual([])
  })

  it('polygon extruded spec ↔ vs_main_ecef_extruded WGSL @location types match exactly', () => {
    expect(specShaderMismatches(POLYGON_EXTRUDED_FORMAT, SHADER_SRC, 'vs_main_ecef_extruded')).toEqual([])
  })

  it('vs_main (line path): every @location covered by the line layout', () => {
    if (!line) {
      throw new Error('lineVertexBufferLayout not found in renderer.ts')
    }
    const need = tryParseFnLocations('vs_main')  // [0, 1, 2]
    if (!need) {
      // `vs_main` is the LINE pipeline VS entry — preserved across PR 2c.2.
      throw new Error('vs_main not found in polygon DSL emit')
    }
    const provided = new Set(line.attrs.map(a => a.location))
    for (const loc of need) {
      expect(provided.has(loc), `vs_main reads @location(${loc}) — not in lineVertexBufferLayout`).toBe(true)
    }
  })
})
