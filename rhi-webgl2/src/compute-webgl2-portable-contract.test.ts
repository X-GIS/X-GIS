// ═══ Portable-tier dispatch contract (#1823) ═══
//
// dispatchComputeKernelWebGl2 used to emit its kernel through the deprecated emit-site
// flag (`{ emulateCompute: true }`); since #1812 every kernel the compiler hands it is
// DECLARED `portable: true`, and the declaration — not this call site — is the source of
// dispatch eligibility. The two halves of that contract, pinned:
//
//   1. an UNDECLARED compute kernel FAIL-CLOSES at emit, BEFORE the device is touched —
//      it is never silently rewritten into a draw its author did not declare. The remedy
//      is in the thrown message's capability diagnosis and AUTHORING §10 (declare
//      `portable: true`).
//   2. the DECLARED kernel passes the dispatcher's emit — driven through the REAL
//      dispatcher with a probe device, it gets past the emit and dies only at the first
//      device member, which proves the option-free spelling engaged the lowering — and
//      the emitted source is a lowered fragment program. The auto ≡ flag BYTE pin
//      deliberately lives elsewhere (portable-kernel.test.ts and _compute-parity own
//      it — one authority).
//
// Fail-first: arm 1 was RED against the flag path — the flag lowered the undeclared
// kernel and the call died LATER, on the probe device ('device touched:
// createBindGroupLayout') — and went green with the flip to the option-free emit.

import { describe, expect, it } from 'vitest'
import {
  builtin,
  emitGlslModule,
  fn,
  If,
  module,
  pack4x8unorm,
  resource,
  Return,
  storageBuffer,
  vec4,
  f32T,
  u32T,
  vec3uT,
  vec4uT,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import type { WebGl2Device } from '@xgis/rhi-webgl2'
import { dispatchComputeKernelWebGl2 } from './compute-webgl2'

/** The dispatcher-shaped kernel (compute-gen's gather-only form), with and without the
 *  tier declaration. Declarators are built per call — module() collects their binding
 *  decls, so two modules must not share handles. */
const kernelModule = (portable: boolean): ModuleDecl => {
  const featData = storageBuffer('feat_data', f32T, { group: 0, binding: 0, access: 'read' })
  const outColor = storageBuffer('out_color', u32T, { group: 0, binding: 1, access: 'read_write' })
  const uCount = resource('u_count', vec4uT, { group: 0, binding: 2 })
  return module({
    uses: [featData, outColor, uCount],
    funcs: [
      fn(
        'paint',
        { gid: builtin('global_invocation_id', vec3uT) },
        ({ gid }) => {
          const i = gid.x
          If(i.ge(uCount.node.x), () => {
            Return()
          })
          outColor.at(i).assign(pack4x8unorm(vec4(featData.at(i), 0, 0, 1)))
        },
        { stage: 'compute', workgroupSize: 64, ...(portable ? { portable: true } : {}) },
      ),
    ],
  })
}

/** A device probe that names the first member the dispatcher reaches for — so a
 *  fail-closed emit (which must throw BEFORE any device work) is distinguishable from a
 *  lowering that went ahead and only died on the fake device. */
const probeDevice = (): WebGl2Device =>
  new Proxy(
    {},
    {
      get: (_t, p) => {
        throw new Error(`device touched: ${String(p)}`)
      },
    },
  ) as WebGl2Device

describe('dispatchComputeKernelWebGl2 — the portable declaration is the gate (#1823)', () => {
  it('fail-closes on an UNDECLARED compute kernel before touching the device', () => {
    expect(() =>
      dispatchComputeKernelWebGl2(
        probeDevice(),
        { module: kernelModule(false), featureStrideF32: 1 },
        new Float32Array([0]),
      ),
    ).toThrow(/missing capabilities:[\s\S]*compute/)
  })

  it('the DECLARED kernel gets past the dispatcher emit — dying only at the device', () => {
    // The same call, same probe device, ONE difference: the declaration. Reaching
    // `createBindGroupLayout` means the option-free emit engaged the lowering.
    expect(() =>
      dispatchComputeKernelWebGl2(
        probeDevice(),
        { module: kernelModule(true), featureStrideF32: 1 },
        new Float32Array([0]),
      ),
    ).toThrow(/device touched: createBindGroupLayout/)
  })

  it('the DECLARED kernel emits through the option-free auto path as a lowered fragment', () => {
    const fs = emitGlslModule(kernelModule(true), 'fragment')
    expect(fs).toContain('void main()')
    expect(fs).toContain('uniform uvec4 u_count;')
    expect(fs).toMatch(/layout\(location = 0\) out uint \w+;/)
  })
})
