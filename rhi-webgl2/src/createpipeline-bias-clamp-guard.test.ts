// ═══ createPipeline depth-bias clamp guard (#1049 item 2) ═══
//
// WebGPU applies depthStencil.bias.clamp (`depthBiasClamp`), but WebGL2's
// gl.polygonOffset takes only (factor, units) — there is NO clamp parameter (no
// core or extension equivalent). The clamp was copied into Gl2Pipeline yet never
// read, so a nonzero clamp was SILENTLY dropped. createPipeline now fail-louds on a
// nonzero clamp instead (the issue's "validate-reject" option). The sole caller
// (map/src/render/material/point-material.ts) passes clamp:0, so this is
// behaviour-preserving today — it only stops a future nonzero clamp from vanishing.
//
// The guard is pure `desc`-field logic and fires before any GL call, so a bare fake
// context suffices (mirrors createpipeline-dual-source-guard.test.ts).

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

// GLSL halves present so the desc clears the vsCode/fsCode guard and reaches the
// clamp guard; both fire before any real GL work.
const BASE: RhiPipelineDesc = {
  code: 'wgsl-source',
  vsCode: '#version 300 es\nvoid main(){}',
  fsCode: '#version 300 es\nvoid main(){}',
  vsEntry: 'vs_main',
  fsEntry: 'fs_main',
  bindGroupLayouts: [],
  colorTargets: [{ format: 'bgra8unorm' }],
}

// The point-material bias shape, parameterised on clamp.
const withClamp = (clamp: number): RhiPipelineDesc => ({
  ...BASE,
  depthStencil: {
    format: 'depth24plus-stencil8',
    write: true,
    compare: 'less-equal',
    bias: { constant: -10, slopeScale: -1, clamp },
  },
})

describe('WebGl2Device.createPipeline depth-bias clamp guard (#1049)', () => {
  it('throws a named error when depthStencil.bias.clamp is nonzero', () => {
    expect(() => device().createPipeline(withClamp(0.5))).toThrow(
      /depthStencil\.bias\.clamp is unsupported/,
    )
  })

  it('reports the offending clamp value in the message', () => {
    expect(() => device().createPipeline(withClamp(-2))).toThrow(/got -2/)
  })

  it('does NOT fire the clamp guard when clamp is 0 (reaches shader compilation)', () => {
    // clamp:0 clears the guard, so execution proceeds past it into compile(), which
    // the bare fake context fails at createShader — proving clamp:0 was let through.
    expect(() => device().createPipeline(withClamp(0))).not.toThrow(/clamp/)
    expect(() => device().createPipeline(withClamp(0))).toThrow(/createShader/)
  })

  it('does NOT fire the clamp guard when the pipeline has no bias at all', () => {
    const noBias: RhiPipelineDesc = {
      ...BASE,
      depthStencil: { format: 'depth24plus-stencil8', write: false, compare: 'less-equal' },
    }
    expect(() => device().createPipeline(noBias)).not.toThrow(/clamp/)
    expect(() => device().createPipeline(noBias)).toThrow(/createShader/)
  })
})
