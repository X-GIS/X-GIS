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
})
