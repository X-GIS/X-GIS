// ═══ The unified compute runner — tier resolution + CPU-tier value parity (#1903) ═══
//
// What this file can and cannot prove, stated up front so the coverage is not mistaken for
// more than it is. Node has no WebGL2 context and no WebGPU device, so the GPU tiers are
// exercised here only through their REJECTION paths; their value parity is the e2e gate's
// job (`playground/e2e/_compute-runner-parity.spec.ts`, real WebGL2 under SwiftShader).
// What IS decidable here is everything that decides which tier runs, plus the CPU tier's
// numbers against the interpreter oracle — and those are the parts a consumer's build
// breaks on, not the raster.

import { describe, it, expect } from 'vitest'
import {
  fn,
  module,
  If,
  Return,
  storageBuffer,
  resource,
  builtin,
  bitcastU32,
  pack4x8unorm,
  vec4,
  compileModule,
  f32T,
  u32T,
  vec3uT,
  vec4uT,
  type ModuleDecl,
} from '../../index.js'
import { createComputeRunner } from '../../compute.js'

/** The gather-only shape, built fresh per call: `module()` collects declarator handles, so
 *  two modules must not share them. */
function makeKernel(opts?: { portable?: boolean; name?: string }): ModuleDecl {
  const featData = storageBuffer('feat_data', f32T, { group: 0, binding: 0, access: 'read' })
  const outValue = storageBuffer('out_value', u32T, { group: 0, binding: 1, access: 'read_write' })
  const dispatchU = resource('u_dispatch', vec4uT, { group: 0, binding: 2 })
  const kernel = fn(
    opts?.name ?? 'scale_features',
    { gid: builtin('global_invocation_id', vec3uT) },
    ({ gid }) => {
      const i = gid.x
      If(i.ge(dispatchU.node.x), () => {
        Return()
      })
      outValue.at(i).assign(bitcastU32(featData.at(i).mul(2).add(1)))
    },
    { stage: 'compute', workgroupSize: 64, portable: opts?.portable ?? true },
  )
  return module({
    bindings: [featData.binding, outValue.binding, dispatchU.binding],
    funcs: [kernel],
  })
}

/** A colour-packing kernel — the shape the compute paint path actually runs, and the one
 *  that proves the u32 output is a CONTAINER rather than an integer-only limit. */
function makePaintKernel(): ModuleDecl {
  const featData = storageBuffer('feat_data', f32T, { group: 0, binding: 0, access: 'read' })
  const outColor = storageBuffer('out_color', u32T, { group: 0, binding: 1, access: 'read_write' })
  const uCount = resource('u_count', vec4uT, { group: 0, binding: 2 })
  const kernel = fn(
    'paint',
    { gid: builtin('global_invocation_id', vec3uT) },
    ({ gid }) => {
      const i = gid.x
      If(i.ge(uCount.node.x), () => {
        Return()
      })
      outColor.at(i).assign(pack4x8unorm(vec4(featData.at(i), 0, 0, 1)))
    },
    { stage: 'compute', workgroupSize: 64, portable: true },
  )
  return module({
    bindings: [featData.binding, outColor.binding, uCount.binding],
    funcs: [kernel],
  })
}

/** The independent mirror: the ORIGINAL @compute kernel on the tree-walk interpreter.
 *  Deliberately `compileModule`, not the `compileModuleJs` the CPU tier uses — otherwise
 *  the arms would share an implementation and the comparison would distinguish nothing. */
function oracle(m: ModuleDecl, entry: string, names: [string, string, string], data: Float32Array) {
  const [readName, outName, uniformName] = names
  const n = data.length
  const out = new Array<number>(n).fill(0)
  const cm = compileModule(m)
  cm.setBinding(readName, Array.from(data))
  cm.setBinding(uniformName, [n, 0, 0, 0])
  cm.setBinding(outName, out)
  for (let i = 0; i < n; i++) (cm.fns[entry] as (g: number[]) => unknown)([i, 0, 0])
  return Uint32Array.from(out)
}

const RAMP = new Float32Array(Array.from({ length: 10 }, (_, i) => ((i * 7) % 11) / 11 - 0.5))

describe('createComputeRunner — tier resolution', () => {
  it('falls back to cpu when no GPU handle is supplied, and SAYS why', async () => {
    const r = await createComputeRunner(makeKernel())
    expect(r.backend).toBe('cpu')
    // The whole point of `rejected`: three.js's silent WebGPU->WebGL2 drop is the
    // documented hazard this field exists to avoid.
    expect(r.rejected.map((x) => x.backend)).toEqual(['webgpu', 'webgl2'])
    expect(r.rejected[0]!.reason).toMatch(/no WebGPU device/)
    expect(r.rejected[1]!.reason).toMatch(/no WebGL2 context/)
  })

  it('pinning `prefer` to an unavailable tier THROWS instead of degrading', async () => {
    // A consumer who needs the GPU must be able to say so: a silent CPU fallback is
    // ~105 ms at 1M invocations, which is a cliff you cannot debug from the outside.
    await expect(createComputeRunner(makeKernel(), { prefer: ['webgl2'] })).rejects.toThrow(
      /no backend from \[webgl2\][\s\S]*no WebGL2 context/,
    )
  })

  it('resolution is ORDER-driven, not capability-guessed', async () => {
    const r = await createComputeRunner(makeKernel(), { prefer: ['cpu', 'webgl2'] })
    expect(r.backend).toBe('cpu')
    // cpu won on ORDER, so webgl2 was never even considered — nothing to report.
    expect(r.rejected).toEqual([])
  })
})

describe('createComputeRunner — the tier gate is not re-decided here', () => {
  it('rejects a module with no portable-declared compute entry, naming the remedy', async () => {
    await expect(createComputeRunner(makeKernel({ portable: false }))).rejects.toThrow(
      /no `portable: true` compute entry[\s\S]*#1812/,
    )
  })

  it('a tier violation surfaces the ANALYZER’s own sentence, not a shape error', async () => {
    // One binding away from the tier: an f32 output cannot be an R32UI draw buffer.
    const featData = storageBuffer('feat_data', f32T, { group: 0, binding: 0, access: 'read' })
    const outF32 = storageBuffer('out_value', f32T, { group: 0, binding: 1, access: 'read_write' })
    const dispatchU = resource('u_dispatch', vec4uT, { group: 0, binding: 2 })
    const bad = module({
      bindings: [featData.binding, outF32.binding, dispatchU.binding],
      funcs: [
        fn(
          'scale_features',
          { gid: builtin('global_invocation_id', vec3uT) },
          ({ gid }) => {
            const i = gid.x
            If(i.ge(dispatchU.node.x), () => {
              Return()
            })
            outF32.at(i).assign(featData.at(i).mul(2))
          },
          { stage: 'compute', workgroupSize: 64, portable: true },
        ),
      ],
    })
    // The message must come from passes/portable-kernel.ts — the single authority the
    // lint rule also renders as SD0111 — so both writers say the same thing.
    await expect(createComputeRunner(bad)).rejects.toThrow(/array<u32>/)
  })
})

describe('createComputeRunner — cpu tier value parity', () => {
  it('matches the interpreter oracle byte-for-byte (bitcast f32 lane)', async () => {
    const m = makeKernel()
    const r = await createComputeRunner(m, { prefer: ['cpu'] })
    const got = await r.run(RAMP)
    expect(got).toEqual(oracle(m, 'scale_features', ['feat_data', 'out_value', 'u_dispatch'], RAMP))
    expect(got.length).toBe(RAMP.length)
  })

  it('matches the oracle on the PAINT shape (pack4x8unorm — 32 bits as a container)', async () => {
    const m = makePaintKernel()
    const data = new Float32Array([0, 1, 0.5, 0.25, 0.999, 0.001])
    const r = await createComputeRunner(m, { prefer: ['cpu'] })
    expect(await r.run(data)).toEqual(
      oracle(m, 'paint', ['feat_data', 'out_color', 'u_count'], data),
    )
  })

  it('honours an explicit `invocations` count below the input length', async () => {
    // The bounds guard reads u_dispatch.x, so a short count must leave the tail at 0
    // rather than running past it — the same discard contract the GLSL grid has.
    const m = makeKernel()
    const r = await createComputeRunner(m, { prefer: ['cpu'] })
    const got = await r.run(RAMP, 4)
    expect(got.length).toBe(4)
    expect(Array.from(got)).toEqual(
      Array.from(oracle(m, 'scale_features', ['feat_data', 'out_value', 'u_dispatch'], RAMP)).slice(
        0,
        4,
      ),
    )
  })

  it('is reusable: a second run does NOT re-emit or leak the previous result', async () => {
    // The rhi dispatchers cache the pipeline but key it on the emit OUTPUT, so they pay
    // the whole lowering on every dispatch. This runner resolves once; the assertion here
    // is the observable half of that — repeated runs stay correct and independent.
    const m = makeKernel()
    const r = await createComputeRunner(m, { prefer: ['cpu'] })
    const a = await r.run(RAMP)
    const short = new Float32Array([0.25, 0.5])
    const b = await r.run(short)
    expect(b.length).toBe(2)
    expect(b).toEqual(oracle(m, 'scale_features', ['feat_data', 'out_value', 'u_dispatch'], short))
    expect(await r.run(RAMP)).toEqual(a)
  })

  it('dispose() is idempotent and safe on the cpu tier', async () => {
    const r = await createComputeRunner(makeKernel(), { prefer: ['cpu'] })
    r.dispose()
    expect(() => {
      r.dispose()
    }).not.toThrow()
  })
})
