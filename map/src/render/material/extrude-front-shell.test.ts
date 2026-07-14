// ═══ #1080 — translucent fill-extrusion FRONT-SHELL descriptor + wiring gate ═══
//
// Issue #1080: a translucent extruded show drawn as a single two-sided
// (cullMode 'none') alpha-blend + depth-test/write pass over-blends its back /
// interior walls, so overlapping buildings look too opaque and show their far
// faces through the front. MapLibre draws a FRONT SHELL for
// fill-extrusion-opacity < 1 (back-face cull). X-GIS matches that behaviour
// WITHOUT dropping concave interiors, via a DEPTH PREPASS in the main opaque
// target (no new render target): the per-feature extrude mesh is drawn twice —
//   • prepass  (variant +4): colorWriteMask NONE, depth write ON  → per-pixel
//     front-most depth (same fs_fill_extrude, so the SAME frag_depth dither).
//   • colour   (variant +2): depthCompare 'less-equal', depth write OFF → only
//     the front-most surface per pixel blends, exactly once.
// Opaque extrusions (alpha == 1) keep the single variant-0/1 draw, byte-identical.
//
// This is the DESCRIPTOR / WIRING gate (GPU-free; rides `test (map)`). It proves,
// at the pipeline-descriptor level, that the prepass + colour variants exist with
// the right depth/colour state, and (source-gate, Part 2 style) that the two-draw
// dispatch + the resolved-alpha gate are wired. The real GPU A/B (front shell vs
// back-face show-through) is the orchestrator's follow-up.
//
// FAIL-BEFORE: on origin/main buildExtrudeMaterial builds ONLY 2 variants
// (write/test), both depth-write ON + full colour write, and recordFillDraw
// issues a single executeItems — so `expect 6 variants`, the `depthprepass` /
// `frontshell` label lookups, and the `variant + 4` / `variant + 2` source
// assertions all fail until this fix lands.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RhiDevice } from '@xgis/engine'
import { buildExtrudeMaterial } from './polygon-fill-material'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Fake RhiDevice: buildExtrudeMaterial → new Material() calls rhi.createPipeline
 *  once per variant. The bind-group layout enters pre-wrapped (a non-array group),
 *  so createBindGroupLayout is never hit; only createPipeline is exercised. */
interface CapturedPipeline {
  label?: string
  depthStencil?: {
    write?: boolean
    compare?: string
    stencil?: { compare: string; passOp: string; writeMask: number; readMask: number }
  }
  colorTargets: ReadonlyArray<{ format: string; blend?: string; writeMask?: number }>
}

function captureExtrudeVariants(pickEnabled: boolean): CapturedPipeline[] {
  const captured: CapturedPipeline[] = []
  const rhi = {
    createPipeline: (d: CapturedPipeline) => {
      captured.push(d)
      return {}
    },
  } as unknown as RhiDevice
  buildExtrudeMaterial({
    rhi,
    shader: 'STUB_WGSL',
    format: 'bgra8unorm',
    sampleCount: 4,
    // A dummy native layout — wrapWebGpuBindGroupLayout just boxes it as { native }.
    bindGroupLayout: {} as unknown as GPUBindGroupLayout,
    vertexLayout: {
      arrayStride: 56,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
    } as unknown as GPUVertexBufferLayout,
    pickEnabled,
  })
  return captured
}

const byLabel = (caps: CapturedPipeline[], needle: string): CapturedPipeline => {
  const hit = caps.find((c) => (c.label ?? '').includes(needle))
  if (!hit) throw new Error(`no extrude variant labelled *${needle}* (found: ${caps.map((c) => c.label).join(', ')})`)
  return hit
}

describe('#1080 fill-extrusion front-shell — pipeline descriptors', () => {
  it('builds SIX variants: opaque write/test + front-shell colour + depth prepass (×2)', () => {
    const caps = captureExtrudeVariants(true)
    // 2 (opaque) on origin/main; the front-shell fix adds 4 (colour ×2, prepass ×2).
    expect(caps.length).toBe(6)
    for (const needle of [
      'fill-extrude-write-rhi',
      'fill-extrude-test-rhi',
      'fill-extrude-frontshell-write-rhi',
      'fill-extrude-frontshell-test-rhi',
      'fill-extrude-depthprepass-write-rhi',
      'fill-extrude-depthprepass-test-rhi',
    ]) {
      expect(caps.some((c) => c.label === needle), `variant ${needle} missing`).toBe(true)
    }
  })

  it('OPAQUE variants (write/test) are unchanged: depth write ON, full colour write', () => {
    const caps = captureExtrudeVariants(true)
    for (const needle of ['fill-extrude-write-rhi', 'fill-extrude-test-rhi']) {
      const v = byLabel(caps, needle)
      expect(v.depthStencil?.write, `${needle} depth write`).toBe(true)
      expect(v.depthStencil?.compare, `${needle} depth compare`).toBe('less-equal')
      // No writeMask override → the colour attachment writes (full).
      expect(v.colorTargets[0]?.writeMask, `${needle} colour writeMask`).toBeUndefined()
    }
  })

  it('DEPTH PREPASS variants: colorWriteMask NONE (every target) + depth write ON', () => {
    const caps = captureExtrudeVariants(true)
    for (const needle of ['depthprepass-write', 'depthprepass-test']) {
      const v = byLabel(caps, needle)
      expect(v.depthStencil?.write, `${needle} must write depth`).toBe(true)
      expect(v.depthStencil?.compare, `${needle} depth compare`).toBe('less-equal')
      // colorWriteMask none: EVERY colour target masked to 0 (colour AND pick).
      expect(v.colorTargets.length).toBe(2)
      for (const t of v.colorTargets) expect(t.writeMask, `${needle} target writeMask`).toBe(0)
    }
  })

  it('front-shell COLOUR variants: depth-`less-equal`, depth write OFF, colour writes', () => {
    const caps = captureExtrudeVariants(true)
    for (const needle of ['frontshell-write', 'frontshell-test']) {
      const v = byLabel(caps, needle)
      // "pairs equal/less-equal with no depth write" — less-equal is exact here:
      // the prepass wrote the per-pixel minimum, so only the front surface passes.
      expect(['equal', 'less-equal']).toContain(v.depthStencil?.compare)
      expect(v.depthStencil?.write, `${needle} must NOT write depth`).toBe(false)
      // The colour attachment is NOT masked (it must actually blend the shell)…
      expect(v.colorTargets[0]?.writeMask, `${needle} colour target writes`).not.toBe(0)
      // …and the pick attachment still stamps the front-most feature id (0xf).
      expect(v.colorTargets[1]?.writeMask, `${needle} pick writeMask`).toBe(0xf)
    }
  })

  it('prepass masks the single colour target when picking is OFF', () => {
    const caps = captureExtrudeVariants(false)
    const v = byLabel(caps, 'depthprepass-write')
    expect(v.colorTargets.length).toBe(1)
    expect(v.colorTargets[0]?.writeMask).toBe(0)
    expect(v.depthStencil?.write).toBe(true)
  })
})

// ── Source-authority gate (Part 2 style, modelled on tile-camera-anchor-authority) ──
// The GPU A/B can only run if the two-draw dispatch + the resolved-alpha gate stay
// wired. Freeze those seams so a refactor can't silently drop them.
const FILL_MAT = readFileSync(join(HERE, 'polygon-fill-material.ts'), 'utf8')
const VTR = readFileSync(join(HERE, '..', 'vector-tile-renderer.ts'), 'utf8')

describe('#1080 front-shell — dispatch + gate wiring', () => {
  it('recordFillDraw issues the two-draw prepass(+4) then colour(+2) for translucent extrude', () => {
    expect(FILL_MAT).toContain('translucentFrontShell && extrudeSolid')
    expect(FILL_MAT).toContain('variant + 4') // depth prepass
    expect(FILL_MAT).toContain('variant + 2') // front-shell colour
  })

  it('the two-draw runs ONLY for the solid extrude twin (extrudeSolid is set there only)', () => {
    // `extrudeSolid = true` is assigned exactly at the four e.mat / e.matNoPick arms,
    // never in the pattern-extrude or flat-fill arms.
    const n = (FILL_MAT.match(/extrudeSolid = true/g) ?? []).length
    expect(n, `expected 4 extrudeSolid=true arms (write/test × pick/nopick); got ${n}`).toBe(4)
  })

  it('VTR resolves the front-shell gate from the resolved fill alpha and passes it only for per-feature extrude', () => {
    expect(VTR).toContain('this._extrudeTranslucentFrontShell = extrudeFillAlpha < 0.999')
    // Gated on the per-feature extruded pipe (not OIT / not debug-overdraw).
    expect(VTR).toContain('useExtrudedPipe &&')
    expect(VTR).toContain('this._extrudeTranslucentFrontShell,')
  })
})
