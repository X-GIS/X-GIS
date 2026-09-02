// ═══ createPipeline MRT per-target divergence guard (#1049 item 1) ═══
//
// ES 3.00 has no per-draw-buffer blend/colorMask (that needs
// OES_draw_buffers_indexed), so the WebGL2 backend applies colour target 0's
// blend + writeMask to EVERY draw buffer. A pipeline whose NON-integer colour
// targets diverge in blend or writeMask would silently miscompile — the guard
// fail-louds instead. Integer-format targets (the pick MRT's rg32uint/r32uint
// scratch) are exempt: their divergence is the documented case the
// force-blend-off recording already handles.
//
// Pure `desc`-field logic firing before any GL work — bare fake context
// (mirrors createpipeline-bias-clamp-guard.test.ts).

import { describe, expect, it } from 'vitest'
import type { RhiPipelineDesc } from '@xgis/rhi'
import { WebGl2Device } from './rhi-webgl2'

function device(): WebGl2Device {
  return new WebGl2Device({
    createSampler: () => ({}),
    samplerParameteri: () => {},
    NEAREST: 0x2600,
    LINEAR: 0x2601,
  } as unknown as WebGL2RenderingContext)
}

const base = (colorTargets: RhiPipelineDesc['colorTargets']): RhiPipelineDesc => ({
  code: 'wgsl-source',
  vsCode: '#version 300 es\nvoid main(){}',
  fsCode: '#version 300 es\nvoid main(){}',
  vsEntry: 'vs_main',
  fsEntry: 'fs_main',
  bindGroupLayouts: [],
  colorTargets,
})

describe('WebGl2Device.createPipeline MRT divergence guard (#1049)', () => {
  it('throws when two non-integer targets diverge in blend', () => {
    expect(() =>
      device().createPipeline(
        base([
          { format: 'bgra8unorm', blend: 'alpha' },
          { format: 'rgba8unorm' }, // no blend — diverges
        ]),
      ),
    ).toThrow(/per-target blend\/writeMask divergence/)
  })

  it('throws when two non-integer targets diverge in writeMask', () => {
    expect(() =>
      device().createPipeline(
        base([
          { format: 'bgra8unorm', writeMask: 0xf },
          { format: 'rgba8unorm', writeMask: 0x7 },
        ]),
      ),
    ).toThrow(/per-target blend\/writeMask divergence/)
  })

  it('allows uniform non-integer MRT targets (reaches shader compilation)', () => {
    const uniform = base([
      { format: 'bgra8unorm', blend: 'alpha' },
      { format: 'rgba8unorm', blend: 'alpha' },
    ])
    expect(() => device().createPipeline(uniform)).not.toThrow(/divergence/)
    expect(() => device().createPipeline(uniform)).toThrow(/createShader/)
  })

  it('exempts the pick-MRT shape (colour + integer scratch) — the documented case', () => {
    const pick = base([
      { format: 'bgra8unorm', blend: 'alpha' },
      { format: 'rg32uint' }, // integer target: divergence handled by force-blend-off
    ])
    expect(() => device().createPipeline(pick)).not.toThrow(/divergence/)
    expect(() => device().createPipeline(pick)).toThrow(/createShader/)
  })

  // ── #2349: the integer exemption is a BLEND exemption, not a writeMask one ──────────
  //
  // The guard above filters integer targets out entirely, so a descriptor asking for a
  // per-target writeMask ACROSS that boundary was never examined — `gl.colorMask` is one
  // 4-bool global with no indexed form, and the pipeline derives it from target 0 alone,
  // so the request was dropped with no diagnostic. Not reachable today (WebGL2 sets
  // `presentablePassMrt: false`, and the one two-target descriptor leaves both masks at
  // 0xf), which is exactly why it needs a gate: that safety is a coincidence of two
  // unrelated facts, and neither was asserted anywhere.

  it('#2349 throws when an integer target asks for a writeMask target 0 cannot honour', () => {
    // The executed descriptor from the finding: pre-fix this produced
    // colorMask(true,true,true,true) and did NOT throw — the requested 0 was dropped.
    expect(() =>
      device().createPipeline(
        base([
          { format: 'bgra8unorm', blend: 'alpha' },
          { format: 'rg32uint', writeMask: 0 },
        ]),
      ),
    ).toThrow(/per-target writeMask divergence/)
  })

  it('#2349 names both masks so the message is actionable, not just a refusal', () => {
    expect(() =>
      device().createPipeline(
        base([{ format: 'bgra8unorm' }, { format: 'rg32uint', writeMask: 0x7 }]),
      ),
    ).toThrow(/target 0 resolves to 0xf.*asks for 0x7/)
  })

  it('#2349 CONTROL — the reachable pick descriptor still passes: EXPLICIT masks that AGREE', () => {
    // `ensureFillPickMaterialRhi` passes no `pickWriteMask`, so ct1 is 0xf and ct0 defaults
    // to 0xf. Keying the guard on an explicit mask EQUAL to target 0's is what keeps the one
    // live WebGL2 two-target pipeline green; a guard on presence alone would break it.
    const agreeing = base([
      { format: 'bgra8unorm', blend: 'alpha' },
      { format: 'rg32uint', writeMask: 0xf },
    ])
    expect(() => device().createPipeline(agreeing)).not.toThrow(/divergence/)
    expect(() => device().createPipeline(agreeing)).toThrow(/createShader/)
  })

  it('#2349 CONTROL — an integer target with NO explicit writeMask is still exempt', () => {
    // The per-format DEFAULT for rg32uint is 0, which differs from ct0's 0xf. Keying on the
    // default instead of an explicit request would red the pick path on every frame.
    const implicit = base([{ format: 'bgra8unorm', blend: 'alpha' }, { format: 'rg32uint' }])
    expect(() => device().createPipeline(implicit)).not.toThrow(/divergence/)
    expect(() => device().createPipeline(implicit)).toThrow(/createShader/)
  })

  it('#2349 CONTROL — a single colour target with an explicit mask is untouched', () => {
    // The loop starts at index 1, so the ordinary one-target pipeline never enters it.
    const single = base([{ format: 'bgra8unorm', writeMask: 0 }])
    expect(() => device().createPipeline(single)).not.toThrow(/divergence/)
    expect(() => device().createPipeline(single)).toThrow(/createShader/)
  })
})
