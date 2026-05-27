// iter-319 — GPU-upload correctness: uniform byte-layout consistency.
//
// The CPU packs a Float32Array (`uf[...]` in vector-tile-renderer)
// that must align BYTE-FOR-BYTE with the WGSL `struct Uniforms`
// (renderer.ts). WGSL applies std140-ish alignment: vec2→8,
// vec4/mat4→16, scalar→4, and rounds the struct size up to its
// largest member alignment (16). If a field is reordered or a
// scalar inserted before a vec4, WGSL inserts padding → every
// subsequent CPU `uf[i]` write lands at the WRONG byte → the shader
// reads garbage → corrupt render (the class memory
// project_projection_divergences flagged "aligned but no automated
// check").
//
// This test:
//   1. Parses the WGSL struct field list from renderer.ts source.
//   2. Computes each field's f32-offset via WGSL alignment rules.
//   3. Asserts the offsets match the canonical contract below.
//   4. Asserts the struct fits in 192 bytes (48 f32) — the size
//      the renderer's uniform ring slot is allocated for.
//   5. Asserts the CPU write indices documented in
//      vector-tile-renderer.ts (uf[0]=mvp, uf[16]=fill_color,
//      uf[20]=stroke_color, uf[24]=proj_params) match the parsed
//      offsets.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emitPolygonWgsl } from '../shader-dsl/shaders/polygon'

const HERE = dirname(fileURLToPath(import.meta.url))

// WGSL type → [sizeBytes, alignBytes].
const WGSL_TYPES: Record<string, [number, number]> = {
  'mat4x4<f32>': [64, 16],
  'vec4<f32>': [16, 16],
  'vec3<f32>': [12, 16],
  'vec2<f32>': [8, 8],
  'f32': [4, 4],
  'u32': [4, 4],
  'i32': [4, 4],
}

interface Field { name: string; type: string; byteOffset: number }

/** Parse `struct Uniforms { ... }` from the polygon DSL composer's
 *  emit, strip comments, compute WGSL-aligned byte offsets.
 *  Phase 2.5 US-008 + US-010 retired renderer-shaders.ts; the
 *  Uniforms struct is now authored in `shader-dsl/shaders/polygon.ts`
 *  and emitted via `emitPolygonWgsl`. */
function parseUniformStruct(): { fields: Field[]; sizeBytes: number } {
  const src = emitPolygonWgsl(null, false)
  const m = src.match(/struct Uniforms \{([\s\S]*?)\n\}/)
  if (!m) throw new Error('struct Uniforms not found in polygon DSL emit')
  const body = m[1]!
  const fields: Field[] = []
  let cursor = 0
  let maxAlign = 1
  for (const rawLine of body.split('\n')) {
    // Strip line comments + whitespace.
    const line = rawLine.replace(/\/\/.*$/, '').trim()
    if (!line) continue
    // Field shape: `name: type,`
    const fm = line.match(/^(\w+)\s*:\s*([\w<>]+)\s*,?$/)
    if (!fm) continue
    const [, name, type] = fm
    const spec = WGSL_TYPES[type!]
    if (!spec) throw new Error(`unknown WGSL type "${type}" for field "${name}"`)
    const [size, align] = spec
    // Round cursor up to the field's alignment.
    cursor = Math.ceil(cursor / align) * align
    fields.push({ name: name!, type: type!, byteOffset: cursor })
    cursor += size
    if (align > maxAlign) maxAlign = align
  }
  // Struct size rounds up to largest member alignment.
  const sizeBytes = Math.ceil(cursor / maxAlign) * maxAlign
  return { fields, sizeBytes }
}

// Canonical contract: field → expected f32 offset (byteOffset / 4).
// This is the layout the CPU packing in vector-tile-renderer.ts
// depends on. Updating the WGSL struct REQUIRES updating both this
// table AND the CPU uf[] writes — this test fails until they agree.
//
// Phase 2 PR 2c.1: mvp_ecef added after mvp (slot reservation only).
// All fields after mvp shifted by +16 f32 slots (64 bytes). Struct
// size grows 192 → 256 bytes; the ≤192 guard below is updated to ≤256.
// CPU uf[] writes are NOT updated in PR 2c.1 — mvp_ecef is not yet
// consumed by any VS and the CPU does not write it yet (zeroed by ring).
const EXPECTED_F32_OFFSET: Record<string, number> = {
  mvp: 0,
  mvp_ecef: 16,
  fill_color: 32,
  stroke_color: 36,
  proj_params: 40,
  cam_h: 44,
  cam_l: 46,
  tile_origin_merc: 48,
  opacity: 50,
  log_depth_fc: 51,
  pick_id: 52,
  layer_depth_offset: 53,
  tile_extent_m: 54,
  extrude_height_m: 55,
  clip_bounds: 56,
  zoom: 60,
  extrude_base_m: 61,
  fill_translate_x: 62,
  fill_translate_y: 63,
}

describe('iter-319 uniform byte-layout consistency (CPU pack ↔ WGSL struct)', () => {
  const { fields, sizeBytes } = parseUniformStruct()

  it('struct parses to the expected field set', () => {
    const names = fields.map(f => f.name)
    expect(names).toEqual(Object.keys(EXPECTED_F32_OFFSET))
  })

  it('every field lands at its contracted f32 offset (WGSL alignment)', () => {
    for (const f of fields) {
      const expectedF32 = EXPECTED_F32_OFFSET[f.name]
      expect(expectedF32, `${f.name} unexpected`).not.toBe(undefined)
      expect(f.byteOffset % 4, `${f.name} byteOffset not f32-aligned`).toBe(0)
      expect(f.byteOffset / 4, `${f.name} float offset drift`).toBe(expectedF32)
    }
  })

  it('clip_bounds (vec4) is 16-byte aligned — no accidental pad shift', () => {
    const cb = fields.find(f => f.name === 'clip_bounds')!
    expect(cb.byteOffset % 16).toBe(0)
  })

  it('struct fits in the 256-byte uniform-ring slot', () => {
    expect(sizeBytes).toBeLessThanOrEqual(256)
  })

  it('CPU pack indices in vector-tile-renderer match parsed offsets', () => {
    const vtr = readFileSync(join(HERE, 'vector-tile-renderer.ts'), 'utf8')
    // mvp: uf.set(mvp, 0)
    expect(vtr).toMatch(/uf\.set\(mvp,\s*0\)/)
    // mvp_ecef: uf.set(mvpEcef, 16) — PR 2c.2 ECEF VS slot
    expect(vtr).toMatch(/uf\.set\(mvpEcef,\s*16\)/)
    // fill_color CPU write at uf[32] (shifted +16 by mvp_ecef insertion)
    expect(vtr).toMatch(/uf\[32\]\s*=.*(?:cachedFillColor|patternUV)/)
    // stroke_color CPU write at uf[36]
    expect(vtr).toMatch(/uf\[36\]\s*=/)
    // proj_params CPU write at uf[40]
    expect(vtr).toMatch(/uf\[40\]\s*=\s*projType/)
    // Cross-check: the WGSL struct offsets for those fields.
    expect(EXPECTED_F32_OFFSET.fill_color).toBe(32)
    expect(EXPECTED_F32_OFFSET.stroke_color).toBe(36)
    expect(EXPECTED_F32_OFFSET.proj_params).toBe(40)
  })

  it('no field overlaps the next (offset + size ≤ next offset)', () => {
    for (let i = 0; i < fields.length - 1; i++) {
      const cur = fields[i]!
      const next = fields[i + 1]!
      const curSize = WGSL_TYPES[cur.type]![0]
      expect(cur.byteOffset + curSize, `${cur.name} overlaps ${next.name}`)
        .toBeLessThanOrEqual(next.byteOffset)
    }
  })
})
