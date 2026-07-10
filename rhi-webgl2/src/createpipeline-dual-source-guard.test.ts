// ═══ createPipeline dual-source contract (#783) ═══
//
// RhiPipelineDesc carries `code` (ONE WGSL module, read by WebGpuDevice) AND the
// optional split `vsCode`/`fsCode` (GLSL ES 3.00 per-stage, read by WebGl2Device)
// so the SAME Material builds on EITHER backend. A lang-discriminated union was
// REFUTED for this issue — it forces one language and breaks that dual-backend
// portability. The footgun ("a `code`-only desc silently makes NO WebGL2
// pipeline") is instead closed at the seam: WebGl2Device.createPipeline fail-louds
// when the GLSL halves are absent, so a WGSL-only desc throws a NAMED error at the
// boundary rather than dereferencing undefined GLSL downstream. This pins that
// throw (the guard is pure `desc`-field logic — it fires before any GL call, so a
// bare fake context suffices).

import { describe, expect, it } from 'vitest'
import type { RhiPipelineDesc } from '@xgis/rhi'
import { WebGl2Device } from './rhi-webgl2'

function device(): WebGl2Device {
  // The vsCode/fsCode guard is the first statement in createPipeline and touches
  // no gl; the constructor only reads a few enum constants off the context.
  return new WebGl2Device({
    createSampler: () => ({}),
    samplerParameteri: () => {},
    NEAREST: 0x2600,
    LINEAR: 0x2601,
  } as unknown as WebGL2RenderingContext)
}

// A WGSL-only desc (the WebGPU shape): `code` present, GLSL halves absent.
const WGSL_ONLY: RhiPipelineDesc = {
  code: 'wgsl-source',
  vsEntry: 'vs_main',
  fsEntry: 'fs_main',
  bindGroupLayouts: [],
  colorTargets: [{ format: 'bgra8unorm' }],
}

describe('WebGl2Device.createPipeline dual-source guard (#783)', () => {
  it('throws a named error when BOTH GLSL vsCode and fsCode are absent', () => {
    expect(() => device().createPipeline(WGSL_ONLY)).toThrow(/requires GLSL vsCode\/fsCode/)
  })

  it('throws when only vsCode is supplied (fsCode still missing)', () => {
    expect(() =>
      device().createPipeline({ ...WGSL_ONLY, vsCode: '#version 300 es\nvoid main(){}' }),
    ).toThrow(/requires GLSL vsCode\/fsCode/)
  })

  it('throws when only fsCode is supplied (vsCode still missing)', () => {
    expect(() =>
      device().createPipeline({ ...WGSL_ONLY, fsCode: '#version 300 es\nvoid main(){}' }),
    ).toThrow(/requires GLSL vsCode\/fsCode/)
  })
})
