// ═══ Plan-time by-order ambiguity guard (#783) ═══
//
// WebGL2 reflects bindings BY NAME when `RhiBindLayoutEntry.name` is present
// and falls back to BY-ORDER pairing when absent. The by-order queues are per
// REFLECTION CLASS, not per kind: 'texture' and 'storage' SHARE the
// sampler-uniform queue (storage lowers to a data-texture sampler2D), and
// 'sampler' entries never reflect by name at all (setBindGroup pairs them
// positionally to their texture's unit). One entry per class binds
// unambiguously by order (the documented raster pattern); ≥2 entries of a
// class with any unnamed is a silent mis-bind waiting on GL's reflection
// order. createBindGroupLayout must fail LOUD at plan time in exactly that
// case — pure JS-record logic, no GL calls, so a bare fake context suffices.

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
  it('throws on ≥2 same-class entries when any is unnamed, listing the unnamed bindings', () => {
    expect(() =>
      device().createBindGroupLayout([
        { binding: 0, kind: 'uniform' },
        { binding: 1, kind: 'storage', name: 'feat_data' },
        { binding: 2, kind: 'storage' }, // unnamed sibling → ambiguous by-order
      ]),
    ).toThrow(/2 sampler-uniform.*binding 2 is unnamed/s)
  })

  it('throws on a MIXED texture+storage group with an unnamed entry (one shared queue)', () => {
    // texture and storage consume the SAME sampler-uniform by-order queue —
    // per-kind counting would wave this shape through; per-class must not.
    expect(() =>
      device().createBindGroupLayout([
        { binding: 0, kind: 'texture' },
        { binding: 1, kind: 'storage', name: 'feat_data' },
      ]),
    ).toThrow(/2 sampler-uniform.*binding 0 is unnamed/s)
  })

  it('allows a single entry per class without a name (the raster by-order pattern)', () => {
    expect(() =>
      device().createBindGroupLayout([
        { binding: 0, kind: 'uniform' },
        { binding: 1, kind: 'texture' },
        { binding: 2, kind: 'sampler' },
      ]),
    ).not.toThrow()
  })

  it('exempts sampler entries — they pair positionally, names are never consumed', () => {
    expect(() =>
      device().createBindGroupLayout([
        { binding: 0, kind: 'texture', name: 'atlas_a' },
        { binding: 1, kind: 'sampler' },
        { binding: 2, kind: 'texture', name: 'atlas_b' },
        { binding: 3, kind: 'sampler' }, // two unnamed samplers: fine, positional
      ]),
    ).not.toThrow()
  })

  it('allows multi-same-class groups when every entry is named', () => {
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
