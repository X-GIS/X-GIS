// AC2c.3.7 — synthetic earth-surface dispatch routes through standard fs_overdraw
//
// Verifies that SyntheticEarthSurfaceBackend emits vertices that are
// consumed by the standard VTR polygon dispatch path — the same path
// that opaque-pass.ts overrides with fillPipelineOverdraw / fs_overdraw
// when DEBUG_OVERDRAW is active. Because the synthetic backend produces
// a standard BackendTileResult (same shape as any polygon tile), the
// overdraw accumulator sees exactly one additive r16float write per
// rasterised fragment — identical to any regular polygon layer.
//
// Test strategy: structural + unit (no GPU required).
//   T1: SyntheticEarthSurfaceBackend.buildResult produces a valid
//       BackendTileResult whose vertex count and index count match the
//       expected 32×16 mesh geometry.
//   T2: The synthetic ShowCommand returned by buildSyntheticEarthSurfaceShow
//       carries extrude.kind === 'none' — it routes through the opaque
//       2D-ground fill path (not the extruded path), which is the same
//       drawShow() branch opaque-pass.ts subjects to the
//       fillPipelineOverdraw override.
//   T3: The overdraw dispatch logic in opaque-pass.ts selects the
//       fillPipelineOverdraw (or fillPipelineOverdrawFeature) override
//       uniformly for EVERY show in the group — no special-case guard
//       excludes the synthetic show. Confirmed by source inspection.
//   T4: The polygon DSL emits fs_overdraw as a standard fragment entry
//       sharing the same WGSL module as vs_main_ecef, so the pipeline
//       layout matches the synthetic show's bind group.
//   T5: opaque-pass clearValue in overdraw mode is { r:0, g:0, b:0, a:0 }
//       so the accumulator starts at zero — synthetic z=0 fragments add
//       exactly +1.0 per covered pixel (one layer, one increment).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { SyntheticEarthSurfaceBackend } from '../../../data/sources/synthetic-earth-surface-backend'
import {
  buildSyntheticEarthSurfaceShow,
  SYNTHETIC_EARTH_SURFACE_SOURCE,
  SYNTHETIC_EARTH_SURFACE_LAYER,
} from '../../synthetic-earth-surface-show'
import { emitPolygonWgsl } from '../../shader-dsl/shaders/polygon'

// Source files for structural dispatch-path analysis
const OPAQUE_PASS_SRC = readFileSync(
  resolve(__dirname, 'opaque-pass.ts'),
  'utf8',
)

// ─────────────────────────────────────────────────────────────────────────────
// T1 — BackendTileResult geometry matches 32×16 earth-surface mesh
// ─────────────────────────────────────────────────────────────────────────────

describe('AC2c.3.7 — SyntheticEarthSurfaceBackend produces standard polygon tile result', () => {
  it('buildResult vertex count matches (32+1)*(16+1) = 561 vertices, stride-9', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    let result: import('../../../data/tile-source').BackendTileResult | null = null
    backend.attach({
      acceptResult: (_key, r) => { result = r },
    } as unknown as import('../../../data/tile-source').TileSourceSink)
    expect(result).not.toBeNull()
    // 32×16 grid: (widthSegs+1)*(heightSegs+1) vertices, stride-9 floats each
    const expectedVertexCount = (32 + 1) * (16 + 1)   // = 561
    expect(result!.vertices.length).toBe(expectedVertexCount * 9)
  })

  it('buildResult index count matches 32*16*6 = 3072 (two triangles per cell)', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    let result: import('../../../data/tile-source').BackendTileResult | null = null
    backend.attach({
      acceptResult: (_key, r) => { result = r },
    } as unknown as import('../../../data/tile-source').TileSourceSink)
    const expectedIndexCount = 32 * 16 * 6  // = 3072
    expect(result!.indices.length).toBe(expectedIndexCount)
  })

  it('vertices are finite floats (no NaN/Inf that would produce degenerate geometry)', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    let result: import('../../../data/tile-source').BackendTileResult | null = null
    backend.attach({
      acceptResult: (_key, r) => { result = r },
    } as unknown as import('../../../data/tile-source').TileSourceSink)
    const verts = result!.vertices
    let nanCount = 0
    for (let i = 0; i < verts.length; i++) {
      if (!Number.isFinite(verts[i])) nanCount++
    }
    expect(nanCount).toBe(0)
  })

  it('lineVertices + lineIndices are empty (no stroke on the bg mesh)', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    let result: import('../../../data/tile-source').BackendTileResult | null = null
    backend.attach({
      acceptResult: (_key, r) => { result = r },
    } as unknown as import('../../../data/tile-source').TileSourceSink)
    expect(result!.lineVertices.length).toBe(0)
    expect(result!.lineIndices.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T2 — Synthetic ShowCommand routes through the 2D-ground (non-extruded) path
// ─────────────────────────────────────────────────────────────────────────────

describe('AC2c.3.7 — buildSyntheticEarthSurfaceShow routes through ground (2D) fill path', () => {
  const rgba: [number, number, number, number] = [0.2, 0.4, 0.6, 1.0]
  const show = buildSyntheticEarthSurfaceShow(rgba)

  it("extrude.kind is 'none' so opaque-pass dispatches via the non-extruded (Phase 1) loop", () => {
    // opaque-pass.ts:188 isExtruded() returns false when
    // ex.kind === undefined || ex.kind === 'none'.
    // The synthetic show must land in the first (non-extruded) loop.
    expect(show.extrude).toBeDefined()
    expect((show.extrude as { kind: string }).kind).toBe('none')
  })

  it('targetName and layerName identify the synthetic source (not a real tile source)', () => {
    expect(show.targetName).toBe(SYNTHETIC_EARTH_SURFACE_SOURCE)
    expect(show.layerName).toBe(SYNTHETIC_EARTH_SURFACE_LAYER)
  })

  it('visible is true so the show is not culled before drawShow()', () => {
    expect(show.visible).toBe(true)
  })

  it('paintShapes.fill is a constant shape matching the constructed RGBA', () => {
    const fill = show.paintShapes?.fill
    expect(fill).toBeDefined()
    expect(fill!.kind).toBe('constant')
    expect((fill as { kind: 'constant'; value: readonly number[] }).value[0]).toBeCloseTo(rgba[0])
    expect((fill as { kind: 'constant'; value: readonly number[] }).value[3]).toBeCloseTo(rgba[3])
  })

  it('opacity paintShape is constant 1 (not data-driven — never triggers featureBindGroupLayout path)', () => {
    // The featureBindGroupLayout vs base-bindGroupLayout branch in
    // opaque-pass.ts:201-204 selects fillPipelineOverdrawFeature when
    // cs.bgl === host.renderer.featureBindGroupLayout. The synthetic
    // show has no per-feature data and must bind to the BASE layout,
    // selecting fillPipelineOverdraw — both share fs_overdraw and the
    // same r16float accumulation semantics.
    const opacity = show.paintShapes?.opacity
    expect(opacity).toBeDefined()
    expect(opacity!.kind).toBe('constant')
    expect((opacity as { kind: 'constant'; value: number }).value).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T3 — opaque-pass overdraw dispatch applies to ALL shows unconditionally
// ─────────────────────────────────────────────────────────────────────────────

describe('AC2c.3.7 — opaque-pass overdraw override is unconditional (no synthetic exclusion)', () => {
  it('drawShow() selects debugFp for every show when DEBUG_OVERDRAW is active', () => {
    // The drawShow closure in opaque-pass.ts reads:
    //   const debugFp = DEBUG_OVERDRAW ? (cs.bgl === featureLayout ? … : …) : null
    // There is NO early-return, layer-name guard, or source-name guard
    // that would bypass the override for the synthetic show.
    // Structural check: no conditional that references SYNTHETIC or __bg.
    expect(OPAQUE_PASS_SRC).not.toContain('SYNTHETIC_EARTH_SURFACE')
    expect(OPAQUE_PASS_SRC).not.toContain('__synthetic')
    expect(OPAQUE_PASS_SRC).not.toContain('skipOverdraw')
    expect(OPAQUE_PASS_SRC).not.toContain('isBackground')
  })

  it('drawShow() replaces fp with debugFp when DEBUG_OVERDRAW is truthy', () => {
    // The pattern: `const fp = debugFp ?? cs.fp` — debugFp shadows cs.fp
    // for every show in the group, including the synthetic one.
    expect(OPAQUE_PASS_SRC).toContain('const fp = debugFp ?? cs.fp')
    expect(OPAQUE_PASS_SRC).toContain('fillPipelineOverdraw')
    expect(OPAQUE_PASS_SRC).toContain('fillPipelineOverdrawFeature')
  })

  it('both non-extruded and extruded loops call drawShow() — synthetic (non-extruded) is covered', () => {
    // opaque-pass.ts emits two loops:
    //   for si in group.shows: if (!isExtruded) drawShow(si)   ← synthetic lands here
    //   for si in group.shows: if ( isExtruded) drawShow(si)   ← buildings
    // Both call the SAME drawShow(), so the override applies equally.
    const nonExtrudedLoop = 'if (!isExtruded(group.shows[si])) drawShow(group.shows[si])'
    const extrudedLoop    = 'if (isExtruded(group.shows[si])) drawShow(group.shows[si])'
    expect(OPAQUE_PASS_SRC).toContain(nonExtrudedLoop)
    expect(OPAQUE_PASS_SRC).toContain(extrudedLoop)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T4 — polygon DSL emits fs_overdraw in the same WGSL module as vs_main_ecef
// ─────────────────────────────────────────────────────────────────────────────

describe('AC2c.3.7 — polygon DSL fs_overdraw shares module with vs_main_ecef (layout compatible)', () => {
  const wgsl = emitPolygonWgsl(null, false)

  it('fs_overdraw and vs_main_ecef are both present in the emitted WGSL module', () => {
    // renderer.ts:960-963 builds fillPipelineOverdraw with:
    //   vertex:   { module: shaderModule, entryPoint: 'vs_main_ecef' }
    //   fragment: { module: shaderModule, entryPoint: 'fs_overdraw' }
    // Both must be in the SAME compiled module — the polygon DSL module.
    expect(wgsl).toContain('fn vs_main_ecef')
    expect(wgsl).toContain('fn fs_overdraw')
  })

  it('fs_overdraw body emits vec4(1,0,0,0) — the r16float additive accumulation write', () => {
    // One write of 1.0 to the red channel per rasterised fragment.
    // An additive blend on r16float accumulates fragment counts.
    // The body must contain the constant literal, not a varying read.
    expect(wgsl).toMatch(/fn fs_overdraw/)
    expect(wgsl).toMatch(/vec4<f32>\(1\.0,\s*0\.0,\s*0\.0,\s*0\.0\)/)
  })

  it('fs_overdraw has @fragment and @location(0) decorators', () => {
    // entryFn in overdraw-fs.ts declares '@location(0)' as the output
    // annotation; the polygon DSL's fsOverdraw mirrors this exactly.
    expect(wgsl).toMatch(/@fragment[\s\S]{0,120}fn fs_overdraw/)
    expect(wgsl).toMatch(/@location\(0\)[\s\S]{0,40}vec4<f32>/)
  })

  it('fs_overdraw does NOT write @builtin(frag_depth) — it skips the variant marker substitution', () => {
    // polygon.ts:712: "NO @builtin(frag_depth) write — debug overdraw
    // doesn't participate in the variant marker substitution."
    // This ensures depth-stencil depthWriteEnabled:false is honoured
    // (no implicit depth side-effect from the fragment stage).
    const afterFsOverdraw = wgsl.slice(wgsl.indexOf('fn fs_overdraw'))
    const beforeNextFn = afterFsOverdraw.slice(0, afterFsOverdraw.indexOf('\nfn ', 1) + 1 || undefined)
    expect(beforeNextFn).not.toContain('frag_depth')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T5 — overdraw accumulator starts at zero (clearValue a:0 in overdraw mode)
// ─────────────────────────────────────────────────────────────────────────────

describe('AC2c.3.7 — overdraw accumulator clear value is a:0 (clean slate per frame)', () => {
  it('opaque-pass clears r16float target to { r:0, g:0, b:0, a:0 } in DEBUG_OVERDRAW mode', () => {
    // The additive blend accumulates from zero; an a:1 clear would
    // bias every pixel with 1 background fragment before any real draw.
    expect(OPAQUE_PASS_SRC).toContain('{ r: 0, g: 0, b: 0, a: 0 }')
  })

  it('overdraw accumulator clear is inside the DEBUG_OVERDRAW ternary branch (not always applied)', () => {
    // The two branches: DEBUG_OVERDRAW ? {a:0} : {a:1}.
    // The a:0 clear is exclusive to overdraw mode — normal mode gets a:1.
    expect(OPAQUE_PASS_SRC).toMatch(/DEBUG_OVERDRAW[\s\S]{0,60}\{ r: 0, g: 0, b: 0, a: 0 \}/)
  })
})
