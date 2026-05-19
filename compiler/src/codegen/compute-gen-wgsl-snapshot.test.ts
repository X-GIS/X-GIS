// Plan §12.1 follow-up: lock the FULL emitted WGSL for the three
// compute-gen kernel emitters on canonical inputs. The existing
// compute-gen.test.ts uses structural assertions (bindings,
// workgroup-size, ordering); this gate snapshots the raw WGSL so a
// silent reformatter / token-rename inside the emitter produces a
// visible diff. Reviewers regenerate with `vitest -u` when intentional.
//
// Each snapshot is the (wgsl + entryPoint + dispatchSize +
// featureStrideF32 + fieldOrder) tuple so any single piece drifting
// surfaces — not just the WGSL body.

import { describe, expect, it } from 'vitest'
import {
  emitInterpolateComputeKernel,
  emitMatchComputeKernel,
  emitTernaryComputeKernel,
} from './compute-gen'

describe('compute-gen WGSL snapshot — match kernel', () => {
  it('canonical match() with 3 arms + transparent default', () => {
    const k = emitMatchComputeKernel({
      fieldName: 'class',
      arms: [
        { pattern: 'school',   colorHex: '#f0e8f8' },
        { pattern: 'cemetery', colorHex: '#aaddaa' },
        { pattern: 'hospital', colorHex: '#f5deb3' },
      ],
      defaultColorHex: '#00000000',
    })
    expect({
      wgsl: k.wgsl,
      entryPoint: k.entryPoint,
      dispatchSize: k.dispatchSize,
      featureStrideF32: k.featureStrideF32,
      fieldOrder: k.fieldOrder,
    }).toMatchSnapshot()
  })

  it('canonical match() with single arm + opaque default', () => {
    const k = emitMatchComputeKernel({
      fieldName: 'kind',
      arms: [{ pattern: 'park', colorHex: '#88cc88' }],
      defaultColorHex: '#666666',
    })
    expect({
      wgsl: k.wgsl,
      entryPoint: k.entryPoint,
    }).toMatchSnapshot()
  })
})

describe('compute-gen WGSL snapshot — ternary (case) kernel', () => {
  it('canonical case() with 3 predicates + default', () => {
    const k = emitTernaryComputeKernel({
      fields: ['cls'],
      branches: [
        { pred: 'v_cls == 0.0', colorHex: '#ff0000' },
        { pred: 'v_cls == 1.0', colorHex: '#00ff00' },
        { pred: 'v_cls == 2.0', colorHex: '#0000ff' },
      ],
      defaultColorHex: '#888888',
    })
    expect({
      wgsl: k.wgsl,
      entryPoint: k.entryPoint,
      fieldOrder: k.fieldOrder,
    }).toMatchSnapshot()
  })

  it('canonical case() with compound predicate (multi-field)', () => {
    const k = emitTernaryComputeKernel({
      fields: ['rank', 'class'],
      branches: [
        { pred: 'v_rank == 0.0 && v_class == 1.0', colorHex: '#ff00ff' },
      ],
      defaultColorHex: '#000000',
    })
    expect({
      wgsl: k.wgsl,
      entryPoint: k.entryPoint,
      fieldOrder: k.fieldOrder,
    }).toMatchSnapshot()
  })
})

describe('compute-gen WGSL snapshot — interpolate kernel', () => {
  // emitInterpolateComputeKernel is linear-only per its spec; the
  // exponential / cubic-bezier curve forms are handled by paint.ts's
  // compile-time densification before reaching the compute emitter.
  it('canonical interpolate-linear with 3 colour stops', () => {
    const k = emitInterpolateComputeKernel({
      fieldName: 'rank',
      stops: [
        { input: 0, colorHex: '#ffffff' },
        { input: 5, colorHex: '#888888' },
        { input: 10, colorHex: '#000000' },
      ],
    })
    expect({
      wgsl: k.wgsl,
      entryPoint: k.entryPoint,
      fieldOrder: k.fieldOrder,
    }).toMatchSnapshot()
  })

  it('canonical interpolate-linear with 2 stops (degenerate-but-valid)', () => {
    const k = emitInterpolateComputeKernel({
      fieldName: 'mag',
      stops: [
        { input: 1, colorHex: '#ffff00' },
        { input: 8, colorHex: '#ff0000' },
      ],
    })
    expect({
      wgsl: k.wgsl,
      entryPoint: k.entryPoint,
      fieldOrder: k.fieldOrder,
    }).toMatchSnapshot()
  })
})
