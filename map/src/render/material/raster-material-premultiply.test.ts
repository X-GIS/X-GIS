// ═══ #2134 — raster/drape double-premultiply darkening: descriptor + emit gate ═══
//
// The bug: the vector-drape bake stores PREMULTIPLIED texels (bake RT clears to
// transparent, fill/line FS emit non-premultiplied (C,α) onto it → stored (C·α,α)),
// but RasterDraper's colour target blended STRAIGHT alpha ('alpha' = BLEND_ALPHA,
// srcFactor 'src-alpha') — the GPU then multiplied by α a SECOND time, darkening
// every AA-partial / translucent draped texel toward the destination.
//
// The fix has two parts that must BOTH hold, checked here as two separate facts:
//   1. RasterDraper's colour target (plain AND pick material) now blends
//      PREMULTIPLIED ('premult' = BLEND_ALPHA_PREMULT, srcFactor 'one') — GPU-free,
//      pipeline-descriptor level, in the style of extrude-front-shell.test.ts.
//   2. fs_tile (raster.ts) now always emits premultiplied colour, and the NEW
//      raster_params.y lane decides whether that premultiply is a real texel
//      multiply (the bake, y=1) or a no-op mix(c.a,1,0)=c.a (every straight-alpha
//      source, y=0) — i.e. the SAME texel must emit a DIFFERENT rgb depending on
//      that lane.
//
// Part 2 is a TEXT assertion on the emitted WGSL, not a numeric CPU evaluation —
// say why, per CLAUDE.md §12 ("count on the IR, never the text" is the stronger
// default). fs_tile's rgb term reads `textureSample(tex, tex_sampler, ...).w` for
// its alpha lane, and the CPU oracle's opt-in texture stub is a FIXED, uncontrollable
// placeholder: `GPU_STUBS.textureSample = () => [0, 0, 0, 1]` (shader-dsl/src/core/
// cpu-runtime.ts:434) — alpha is pinned to 1, so `mix(c.a, 1.0, premul)` degenerates
// to `mix(1, 1, premul) = 1` for EITHER premul value. No numeric CPU evaluation of
// fs_tile can distinguish the two source kinds; the same reason text-dsl.test.ts
// gives for its sibling premultiply check ("It is not cpu-evaluated (texture
// sample)"). So this mirrors that file's technique instead: resolve the emitter's
// CSE'd `let` bindings via a capture group + backreference rather than pinning
// their `_cseN` numbers, which the CLAUDE.md §12 "count on the IR" entry singles
// out as the fragile way to do it.

import { describe, it, expect } from 'vitest'
import type { RhiDevice, RhiRenderPass } from '@xgis/engine'
import { RasterDraper } from './raster-material'
import { emitRasterWgsl } from '../../shaders/dsl/raster'

// ── Part 1: RasterDraper's colour-target blend state ──

interface CapturedPipeline {
  label?: string
  colorTargets: ReadonlyArray<{ format: string; blend?: string }>
}

/** Fake RhiDevice: RasterDraper's constructor eagerly builds the plain Material
 *  (createPipeline once); the PICK Material is lazy (built on the first pick
 *  draw — raster-material.ts `pickMat()`), so it is reached via `draw(..., pick:
 *  true)` with an EMPTY tile list — `executeItems` then loops zero times and
 *  never touches `pass`, so a bare `{}` stands in for it. `caps.shaderLanguage:
 *  'wgsl'` makes `glslStagesFor` return `{}` without emitting GLSL at all
 *  (wgsl-for.ts) — only the WGSL half (already baked by `bake:shaders`) is read. */
function captureRasterPipelines(): CapturedPipeline[] {
  const captured: CapturedPipeline[] = []
  const rhi = {
    caps: { shaderLanguage: 'wgsl' as const },
    createSampler: () => ({}),
    createBindGroupLayout: () => ({}),
    createBuffer: () => ({}),
    writeBuffer: () => {},
    createPipeline: (d: CapturedPipeline) => {
      captured.push(d)
      return {}
    },
  } as unknown as RhiDevice
  const draper = new RasterDraper(rhi, 'bgra8unorm', 4)
  // writeGlobal just forwards the buffer to the fake writeBuffer above, which
  // ignores it — any BufferSource stands in for the real 176 B global uniform.
  draper.draw({} as RhiRenderPass, new Float32Array(4), [], false, true, 0)
  return captured
}

describe('#2134 RasterDraper — colour target blends PREMULTIPLIED', () => {
  const caps = captureRasterPipelines()

  it('builds exactly one plain + one pick pipeline', () => {
    expect(caps.length, `expected 2 pipelines (plain, pick); got ${caps.length}`).toBe(2)
  })

  it('the plain (non-pick) material blends premult, not straight alpha', () => {
    const plain = caps[0]!
    expect(plain.colorTargets.length).toBe(1)
    expect(
      plain.colorTargets[0]?.blend,
      'RasterDraper.material must blend premult (#2134) — straight alpha double-' +
        'multiplies a premultiplied drape texel',
    ).toBe('premult')
  })

  it('the pick material blends premult on its colour target too (same fs_tile)', () => {
    const pick = caps[1]!
    expect(pick.colorTargets.length).toBe(2) // colour + rg32uint pick MRT
    expect(pick.colorTargets[0]?.blend, 'pick colour target must match the plain one').toBe(
      'premult',
    )
    expect(pick.colorTargets[1]?.format).toBe('rg32uint')
  })
})

// ── Part 2: fs_tile's emitted rgb term reads the premultiplied-source lane ──

describe('#2134 fs_tile (raster.ts) — rgb term keys off raster_params.y', () => {
  const noPick = emitRasterWgsl(false)
  const fs = noPick.slice(noPick.indexOf('@fragment\nfn fs_tile'))

  it('emits mix(<alpha>, 1.0, u.raster_params.y) and reuses the SAME alpha/f terms in the alpha channel', () => {
    // <alpha> = the textureSample .w lane (c.a); <f> = raster_params.x·rim·pin.vis.
    // The captured names are the emitter's own CSE temps (`_cseN`) — resolved
    // generically via backreference, never pinned to a specific N (CLAUDE.md
    // §12: a CSE-numbered match is a text-shape trap, not a fixed contract).
    // The shape asserted is exactly the fix's algebra: rgb = adjRgb ·
    // mix(c.a,1,premul) · f, alpha = c.a · f — so premul=0 collapses rgb's new
    // factor to c.a (byte-identical to the old adjRgb·(c.a·f) emit under the old
    // straight-alpha blend) and premul=1 collapses it to 1 (adjRgb·f, no second
    // alpha multiply — the drape fix).
    const m = fs.match(/mix\((\w+), 1\.0, u\.raster_params\.y\)\) \* (\w+)\), \(\1 \* \2\)\)/)
    expect(
      m,
      'no mix(<alpha>, 1.0, u.raster_params.y) term reusing the same <alpha>/<f> in the ' +
        `alpha channel was found in fs_tile — the premultiply lane looks ignored. fs_tile: ${fs}`,
    ).not.toBeNull()
  })

  it('vacuity guard: the regex rejects the PRE-#2134 emit shape (fixture below)', () => {
    // Captured VERBATIM from `emitRasterWgsl(false)` with raster.ts's fragment
    // emit reverted to the pre-#2134 straight
    // `vec4(adjRgb, c.a.mul(raster_params.x).mul(rim).mul(pin.vis))` — this is
    // real output, not a hand-derived guess (a hand-derived first attempt at this
    // fixture got the CSE numbering AND parenthesisation wrong, which is the
    // whole reason to capture it rather than reconstruct it by hand). Proves the
    // assertion above is not a pattern that would have matched the bug too. Kept
    // as a literal fixture (not a live git checkout of raster.ts) so this test
    // has no side effect on the working tree.
    const PRE_2134_FS_TILE = `@fragment
fn fs_tile(input: VsOut) -> RasterFragmentOutput {
  let _cse0 = degrees(((2.0 * atan(exp(input.abs_merc_y))) - (PI * 0.5)));
  if ((needs_backface_cull(input.abs_lon, _cse0, u.proj_params, u.globe_eye) < 0.0)) {
    discard;
  }
  let _cse1 = textureSample(tex, tex_sampler, input.uv);
  return RasterFragmentOutput(vec4<f32>(raster_color_adjust(_cse1.rgb, u.raster_color0, u.raster_color1), (((_cse1.w * u.raster_params.x) * rim_alpha(input.abs_lon, _cse0, u.proj_params, u.globe_eye)) * input.vis)), compute_log_frag_depth(input.view_w, u.proj_params.w));
}`
    const m = PRE_2134_FS_TILE.match(
      /mix\((\w+), 1\.0, u\.raster_params\.y\)\) \* (\w+)\), \(\1 \* \2\)\)/,
    )
    expect(m, 'the regex must NOT match the pre-#2134 straight-alpha emit shape').toBeNull()
  })
})
