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

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'renderer.ts'), 'utf8')

// GPUVertexFormat → byte width.
const FORMAT_BYTES: Record<string, number> = {
  uint16x2: 4, float32: 4, float32x2: 8, float32x3: 12, float32x4: 16,
  uint32: 4, sint16x2: 4,
}

interface Attr { location: number; offset: number; format: string }
interface Layout { stride: number; attrs: Attr[] }

/** Parse a named GPUVertexBufferLayout const from renderer.ts. */
function parseLayout(constName: string): Layout {
  const re = new RegExp(`const ${constName}\\s*:\\s*GPUVertexBufferLayout\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\}`)
  const m = SRC.match(re)
  if (!m) throw new Error(`layout ${constName} not found`)
  const body = m[1]!
  const strideM = body.match(/arrayStride:\s*(\d+)/)
  if (!strideM) throw new Error(`${constName} has no arrayStride`)
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
function parseFnLocations(fnName: string): number[] {
  const re = new RegExp(`fn ${fnName}\\s*\\(([\\s\\S]*?)\\)\\s*->`)
  const m = SRC.match(re)
  if (!m) throw new Error(`fn ${fnName} not found`)
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
  const quantized = parseLayout('vertexBufferLayout')
  const extrudedZ = parseLayout('extrudedZBufferLayout')
  const line = parseLayout('lineVertexBufferLayout')

  it('quantized polygon layout: stride 8 (= QUANT_POLY_STRIDE_BYTES), loc0 uint16x2@0 + loc2 float32@4', () => {
    expect(quantized.stride).toBe(8)
    const byLoc = new Map(quantized.attrs.map(a => [a.location, a]))
    expect(byLoc.get(0)).toEqual({ location: 0, offset: 0, format: 'uint16x2' })
    expect(byLoc.get(2)).toEqual({ location: 2, offset: 4, format: 'float32' })
    assertLayoutSane(quantized, 'quantized')
  })

  it('extruded-z layout: stride 16, loc3 float32x4@0', () => {
    expect(extrudedZ.stride).toBe(16)
    const byLoc = new Map(extrudedZ.attrs.map(a => [a.location, a]))
    expect(byLoc.get(3)).toEqual({ location: 3, offset: 0, format: 'float32x4' })
    assertLayoutSane(extrudedZ, 'extrudedZ')
  })

  it('line layout: stride 24 (DSFUN stride-6), loc0 pos_h@0 + loc1 pos_l@8 + loc2 fid@16', () => {
    expect(line.stride).toBe(24)
    const byLoc = new Map(line.attrs.map(a => [a.location, a]))
    expect(byLoc.get(0)).toEqual({ location: 0, offset: 0, format: 'float32x2' })
    expect(byLoc.get(1)).toEqual({ location: 1, offset: 8, format: 'float32x2' })
    expect(byLoc.get(2)).toEqual({ location: 2, offset: 16, format: 'float32' })
    // arc_start (offset 20, float 5) intentionally NOT a vertex attr —
    // the SDF LineRenderer reads it via the segment storage buffer.
    assertLayoutSane(line, 'line')
  })

  it('vs_main_quantized: every @location it reads is provided by the quantized layout', () => {
    const need = parseFnLocations('vs_main_quantized')  // [0, 2]
    const provided = new Set(quantized.attrs.map(a => a.location))
    for (const loc of need) {
      expect(provided.has(loc), `vs_main_quantized reads @location(${loc}) — not in vertexBufferLayout`).toBe(true)
    }
  })

  it('vs_main_quantized_extruded: locations covered by [quantized + extrudedZ]', () => {
    const need = parseFnLocations('vs_main_quantized_extruded')  // [0, 2, 3]
    const provided = new Set([
      ...quantized.attrs.map(a => a.location),
      ...extrudedZ.attrs.map(a => a.location),
    ])
    for (const loc of need) {
      expect(provided.has(loc), `vs_main_quantized_extruded reads @location(${loc}) — not in bound layouts`).toBe(true)
    }
  })

  it('vs_main (line path): every @location covered by the line layout', () => {
    const need = parseFnLocations('vs_main')  // [0, 1, 2]
    const provided = new Set(line.attrs.map(a => a.location))
    for (const loc of need) {
      expect(provided.has(loc), `vs_main reads @location(${loc}) — not in lineVertexBufferLayout`).toBe(true)
    }
  })

  it('no two layouts that bind together (quantized + extrudedZ) collide on a shaderLocation', () => {
    // When vs_main_quantized_extruded binds [quantized, extrudedZ],
    // their shaderLocation sets must be DISJOINT — a duplicate
    // location = WebGPU pipeline-creation error.
    const q = new Set(quantized.attrs.map(a => a.location))
    for (const a of extrudedZ.attrs) {
      expect(q.has(a.location), `extrudedZ loc${a.location} collides with quantized`).toBe(false)
    }
  })
})
