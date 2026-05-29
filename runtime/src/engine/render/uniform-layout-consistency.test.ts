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
//      the renderer's uniform ring slot is allocated for (post PR 2d.5
//      closeout: legacy Mercator `mvp` retired, struct shrunk 256 → 192).
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
// Phase 2 PR 2d.5 closeout: legacy Mercator `mvp` slot retired; the
// surviving `mvp` field IS the ECEF-MVP (formerly named `mvp_ecef`).
// All fields after mvp shifted -16 f32 slots (-64 bytes). Struct
// size shrunk 256 → 192 bytes; the ≤256 guard below is updated to ≤192.
const EXPECTED_F32_OFFSET: Record<string, number> = {
  mvp: 0,
  fill_color: 16,
  stroke_color: 20,
  proj_params: 24,
  cam_h: 28,
  cam_l: 30,
  tile_origin_merc: 32,
  opacity: 34,
  log_depth_fc: 35,
  pick_id: 36,
  layer_depth_offset: 37,
  tile_extent_m: 38,
  extrude_height_m: 39,
  clip_bounds: 40,
  zoom: 44,
  extrude_base_m: 45,
  fill_translate_x: 46,
  fill_translate_y: 47,
  // Phase 2 PR 2f — per-tile quantized-position dequant params.
  tile_dequant_scale: 48,
  tile_dequant_half: 49,
  // Camera-relative RTC fix — DSFUN hi/lo offset (tileEcefCenter − cameraCenter),
  // vec4 each, 16-byte aligned after the two dequant scalars (50/51 pad → 52).
  cam_ecef_off_h: 52,
  cam_ecef_off_l: 56,
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

  it('struct fits in the 240-byte uniform-ring slot', () => {
    // Camera-relative RTC fix added cam_ecef_off_h/l (vec4×2 = 32B at f32
    // 52/56) → 60 f32 = 240 bytes. Still within the 256-byte ring slot
    // (UNIFORM_SLOT), so no ring-stride change was needed.
    expect(sizeBytes).toBeLessThanOrEqual(240)
  })

  it('CPU pack indices in vector-tile-renderer match parsed offsets', () => {
    const vtr = readFileSync(join(HERE, 'vector-tile-renderer.ts'), 'utf8')
    // mvp: uf.set(mvp, 0) — post PR 2d.5 closeout this is the ECEF-MVP
    expect(vtr).toMatch(/uf\.set\(mvp,\s*0\)/)
    // fill_color CPU write at uf[16] (post PR 2d.5: -16 from former uf[32])
    expect(vtr).toMatch(/uf\[16\]\s*=.*(?:cachedFillColor|patternUV)/)
    // stroke_color CPU write at uf[20]
    expect(vtr).toMatch(/uf\[20\]\s*=/)
    // proj_params CPU write at uf[24]
    expect(vtr).toMatch(/uf\[24\]\s*=\s*projType/)
    // Cross-check: the WGSL struct offsets for those fields.
    expect(EXPECTED_F32_OFFSET.fill_color).toBe(16)
    expect(EXPECTED_F32_OFFSET.stroke_color).toBe(20)
    expect(EXPECTED_F32_OFFSET.proj_params).toBe(24)
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
