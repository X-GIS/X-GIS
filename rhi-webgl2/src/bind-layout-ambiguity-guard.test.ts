// ═══ Plan-time by-order ambiguity guard (#783) ═══
//
// WebGL2 reflects bindings BY NAME when `RhiBindLayoutEntry.name` is present
// and falls back to BY-ORDER pairing when absent. A single entry of a kind
// binds unambiguously by order (the documented raster pattern); ≥2 same-kind
// entries with any unnamed is a silent mis-bind waiting on declaration order.
// createBindGroupLayout must fail LOUD at plan time in exactly that case —
// pure JS-record logic, no GL calls, so a bare fake context suffices.

import { describe, expect, it } from 'vitest'
import { WebGl2Device } from './rhi-webgl2'

function device(): WebGl2Device {
  // createBindGroupLayout builds a plain JS record and never touches gl; the
  // constructor only reads a few enum constants off the context.
  return new WebGl2Device({
    createSampler: () => ({}),
    samplerParameteri: () => {},
    NEAREST: 0x2600,
    LINEAR: 0x2601,
  } as unknown as WebGL2RenderingContext)
}

describe('WebGl2Device.createBindGroupLayout ambiguity guard (#783)', () => {
  it('throws on ≥2 same-kind entries when any is unnamed, naming the bindings', () => {
    expect(() =>
      device().createBindGroupLayout([
        { binding: 0, kind: 'uniform' },
        { binding: 1, kind: 'storage', name: 'feat_data' },
        { binding: 2, kind: 'storage' }, // unnamed sibling → ambiguous by-order
      ]),
    ).toThrow(/2 'storage' entries.*bindings 1, 2/s)
  })

  it('allows a single entry per kind without a name (the raster by-order pattern)', () => {
    expect(() =>
      device().createBindGroupLayout([
        { binding: 0, kind: 'uniform' },
        { binding: 1, kind: 'texture' },
        { binding: 2, kind: 'sampler' },
      ]),
    ).not.toThrow()
  })

  it('allows multi-same-kind groups when every entry is named', () => {
    expect(() =>
      device().createBindGroupLayout([
        { binding: 0, kind: 'uniform' },
        { binding: 1, kind: 'storage', name: 'feat_data' },
        { binding: 2, kind: 'storage', name: 'shapes' },
        { binding: 3, kind: 'storage', name: 'segments' },
      ]),
    ).not.toThrow()
  })
})
