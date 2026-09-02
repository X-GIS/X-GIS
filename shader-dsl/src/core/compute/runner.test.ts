// ═══ The unified compute runner — tier resolution + CPU-tier value parity (#1903) ═══
//
// What this file can and cannot prove, stated up front so the coverage is not mistaken for
// more than it is. Node has no WebGL2 context and no WebGPU device, so the GPU tiers are
// exercised here only through RESOLUTION — which tier is chosen, why the others were not,
// and what is handed to the device at construction. Their VALUE parity is the e2e gate's
// job (`playground/e2e/_compute-runner-parity.spec.ts`, real WebGL2 and real WebGPU under
// SwiftShader), and nothing here substitutes for it: the stub device below is deliberately
// never `run()` against, because a dispatch recorded by a stub succeeds identically
// whether or not it would have computed anything (CLAUDE.md §12 — the pipeline that was
// right somewhere else). What IS decidable here is everything that decides which tier
// runs, plus the CPU tier's numbers against the interpreter oracle — and those are the
// parts a consumer's build breaks on, not the raster.

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
import { createComputeRunner, type GpuDeviceLike } from '../../compute.js'

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

/** What the runner asked the device for at construction. The stub records rather than
 *  simulates: it answers every factory call with an inert handle, so it can prove WHICH
 *  source and WHICH entry point were compiled and nothing at all about the numbers. */
function stubDevice(): { device: GpuDeviceLike; seen: { code?: string; entryPoint?: string } } {
  const seen: { code?: string; entryPoint?: string } = {}
  const device = {
    createShaderModule(d: { code: string }) {
      seen.code = d.code
      return {}
    },
    createComputePipeline(d: { compute: { entryPoint: string } }) {
      seen.entryPoint = d.compute.entryPoint
      return { getBindGroupLayout: () => ({}) }
    },
    createBuffer: () => ({}),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({}),
    queue: {},
  }
  return { device, seen }
}

/** The same kernel one declaration off the WebGPU tier: every binding in `@group(1)`.
 *  Legal in the portable tier (the analyzer constrains shapes, not group numbers) and
 *  legal on WebGL2 and CPU, which flatten groups away — so this is the case that must
 *  fall THROUGH rather than throw. */
function makeGroup1Kernel(): ModuleDecl {
  const featData = storageBuffer('feat_data', f32T, { group: 1, binding: 0, access: 'read' })
  const outValue = storageBuffer('out_value', u32T, { group: 1, binding: 1, access: 'read_write' })
  const dispatchU = resource('u_dispatch', vec4uT, { group: 1, binding: 2 })
  const kernel = fn(
    'scale_features',
    { gid: builtin('global_invocation_id', vec3uT) },
    ({ gid }) => {
      const i = gid.x
      If(i.ge(dispatchU.node.x), () => {
        Return()
      })
      outValue.at(i).assign(bitcastU32(featData.at(i).mul(2).add(1)))
    },
    { stage: 'compute', workgroupSize: 64, portable: true },
  )
  return module({
    bindings: [featData.binding, outValue.binding, dispatchU.binding],
    funcs: [kernel],
  })
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

  it('a device present resolves the webgpu tier, on the NATIVE @compute source', async () => {
    const { device, seen } = stubDevice()
    const r = await createComputeRunner(makeKernel(), { prefer: ['webgpu'], device })
    expect(r.backend).toBe('webgpu')
    expect(r.rejected).toEqual([])
    // Both emits are imported by the same module, so "which one did the webgpu tier
    // reach for" is a live question: the portable declaration costs zero bytes here and
    // must NOT go through the compute→fragment lowering.
    expect(seen.code).toMatch(/@compute @workgroup_size\(64\)/)
    expect(seen.code).not.toMatch(/#version 300 es/)
    expect(seen.entryPoint).toBe('scale_features')
  })

  it('a binding outside @group(0) REJECTS webgpu and falls through — it does not throw', async () => {
    // `layout: 'auto'` can only hand back a layout the pipeline derived, and the tier reads
    // group 0. The other two tiers flatten groups away, so the right answer is a reported
    // rejection and a working runner, not a hard failure.
    const { device } = stubDevice()
    const r = await createComputeRunner(makeGroup1Kernel(), { prefer: ['webgpu', 'cpu'], device })
    expect(r.backend).toBe('cpu')
    expect(r.rejected.map((x) => x.backend)).toEqual(['webgpu'])
    expect(r.rejected[0]!.reason).toMatch(/@group\(1\)[\s\S]*getBindGroupLayout\(0\)/)
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

// ── #2362 — n === 0 is a steady state on ALL THREE tiers ──────────────────────────────
//
// This is the one place the WebGL2 tier is driven through `run()`, and it is NOT value
// coverage — see the file header: a dispatch recorded by a stub succeeds whether or not it
// would have computed anything. What is decidable here is CONTROL FLOW: whether an empty
// frame reaches GL at all. The stub is inert everywhere except `checkFramebufferStatus`,
// which implements the one spec rule the defect turned on (GLES 3.0 §4.4.4.2 — an
// attachment of width or height 0 is not framebuffer-attachment-complete). Pre-fix the
// first test below threw `R32UI framebuffer incomplete` while the CPU tier, given the same
// input, resolved to an empty array.

const FB_COMPLETE = 0x8cd5
const FB_INCOMPLETE_ATTACHMENT = 0x8cd6

/** A WebGL2 context stub: every entry point is a no-op, every unknown constant is a
 *  distinct number, and the ONLY modelled driver behaviour is attachment completeness. */
function glStub(): { gl: WebGL2RenderingContext; calls: string[] } {
  const calls: string[] = []
  const dims = new WeakMap<object, { w: number; h: number }>()
  let bound: object | null = null
  let attached: object | null = null
  let nextConst = 0x1000
  const consts = new Map<string, number>([
    ['FRAMEBUFFER_COMPLETE', FB_COMPLETE],
    ['COMPILE_STATUS', 0x8b81],
    ['LINK_STATUS', 0x8b82],
  ])
  const api: Record<string, (...args: never[]) => unknown> = {
    createShader: () => ({}),
    createProgram: () => ({}),
    createTexture: () => ({}),
    createFramebuffer: () => ({}),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => ({}),
    getParameter: () => new Int32Array([0, 0, 1, 1]),
    bindTexture: (...a: never[]) => {
      bound = (a[1] as object | null) ?? null
    },
    texImage2D: (...a: never[]) => {
      if (bound) dims.set(bound, { w: a[3] as unknown as number, h: a[4] as unknown as number })
    },
    framebufferTexture2D: (...a: never[]) => {
      attached = (a[3] as object | null) ?? null
    },
    checkFramebufferStatus: () => {
      const d = attached ? dims.get(attached) : undefined
      return d && (d.w === 0 || d.h === 0) ? FB_INCOMPLETE_ATTACHMENT : FB_COMPLETE
    },
  }
  const gl = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in api) {
          const f = api[prop]!
          return (...args: never[]) => {
            calls.push(prop)
            return f(...args)
          }
        }
        // An UPPERCASE name is a GL enum; anything else is an entry point we do not model.
        if (/^[A-Z0-9_]+$/.test(prop)) {
          if (!consts.has(prop)) consts.set(prop, nextConst++)
          return consts.get(prop)
        }
        return (...args: never[]) => {
          calls.push(prop)
          void args
          return undefined
        }
      },
    },
  ) as unknown as WebGL2RenderingContext
  return { gl, calls }
}

describe('createComputeRunner — an empty dispatch is a steady state on every tier (#2362)', () => {
  it('webgl2 resolves to an empty Uint32Array, the same as cpu', async () => {
    const { gl } = glStub()
    const webgl2 = await createComputeRunner(makeKernel(), { prefer: ['webgl2'], gl })
    expect(webgl2.backend).toBe('webgl2')
    const cpu = await createComputeRunner(makeKernel(), { prefer: ['cpu'] })

    const empty = new Float32Array(0)
    expect(await webgl2.run(empty)).toEqual(new Uint32Array(0))
    expect(await cpu.run(empty)).toEqual(new Uint32Array(0))
  })

  it('the short-circuit targets n === 0 ONLY — a real dispatch still reaches GL', async () => {
    // The control that separates "empty frames are handled" from "the tier stopped
    // drawing": with one invocation the GL path must still run end to end.
    const { gl, calls } = glStub()
    const r = await createComputeRunner(makeKernel(), { prefer: ['webgl2'], gl })

    calls.length = 0
    await r.run(new Float32Array(0))
    expect(calls).toEqual([]) // not one GL call for an empty frame

    calls.length = 0
    await r.run(new Float32Array([0.25]))
    expect(calls).toContain('drawArrays')
    expect(calls).toContain('readPixels')
  })

  it('an explicit `invocations` of 0 over a non-empty input is the same steady state', async () => {
    // `n` is `invocations ?? input.length`, so the guard must key on n, not on the input.
    const { gl, calls } = glStub()
    const r = await createComputeRunner(makeKernel(), { prefer: ['webgl2'], gl })
    calls.length = 0
    expect(await r.run(RAMP, 0)).toEqual(new Uint32Array(0))
    expect(calls).toEqual([])
  })
})

// ── #2355 — the WebGL2 tier borrows the HOST's context and must give it back ──────────
//
// `options.gl` is documented "A live WebGL2 context": the caller's, not one this runner
// owns. The dispatch overwrites four pieces of global state and the `finally` restored one
// of them. The viewport already had a snapshot-and-restore, with a comment saying why —
// "without restoring leaves every later draw in the host's frame rendering at the compute
// pass's size" — and BLEND, the current program and the TEXTURE0 binding are the same kind
// of debt, differing only in that a wrong blend enable composites silently instead of
// visibly. This stub's ONLY modelled behaviour is GL's own get/set semantics for those
// four; nothing here asserts a computed value.

const GL_BLEND = 0x0be2
const GL_TEXTURE0 = 0x84c0
const GL_TEXTURE3 = 0x84c3

/** A WebGL2 stub that REMEMBERS enable-state, the current program, the active texture unit
 *  and a per-unit TEXTURE_2D binding — the state the runner is supposed to hand back. */
function statefulGlStub(init: {
  blend: boolean
  program: object | null
  activeUnit?: number
  tex0?: object | null
}) {
  const enabled = new Set<number>(init.blend ? [GL_BLEND] : [])
  const bindings = new Map<number, object | null>()
  let activeUnit = init.activeUnit ?? GL_TEXTURE0
  let program: object | null = init.program
  const calls: string[] = []
  if (init.tex0 !== undefined) bindings.set(GL_TEXTURE0, init.tex0)

  const consts = new Map<string, number>([
    ['BLEND', GL_BLEND],
    ['TEXTURE0', GL_TEXTURE0],
    ['CURRENT_PROGRAM', 0x8b8d],
    ['ACTIVE_TEXTURE', 0x84e0],
    ['TEXTURE_BINDING_2D', 0x8069],
    ['VIEWPORT', 0x0ba2],
    ['FRAMEBUFFER_COMPLETE', FB_COMPLETE],
    ['COMPILE_STATUS', 0x8b81],
    ['LINK_STATUS', 0x8b82],
  ])
  let nextConst = 0x2000
  const api: Record<string, (...args: never[]) => unknown> = {
    createShader: () => ({}),
    createProgram: () => ({ __computeProgram: true }),
    createTexture: () => ({ __tex: true }),
    createFramebuffer: () => ({}),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => ({}),
    checkFramebufferStatus: () => FB_COMPLETE,
    enable: (...a: never[]) => enabled.add(a[0] as unknown as number),
    disable: (...a: never[]) => enabled.delete(a[0] as unknown as number),
    isEnabled: (...a: never[]) => enabled.has(a[0] as unknown as number),
    useProgram: (...a: never[]) => {
      program = (a[0] as object | null) ?? null
    },
    activeTexture: (...a: never[]) => {
      activeUnit = a[0] as unknown as number
    },
    bindTexture: (...a: never[]) => bindings.set(activeUnit, (a[1] as object | null) ?? null),
    getParameter: (...a: never[]) => {
      const pname = a[0] as unknown as number
      if (pname === 0x0ba2) return new Int32Array([0, 0, 640, 480])
      if (pname === 0x8b8d) return program
      if (pname === 0x84e0) return activeUnit
      if (pname === 0x8069) return bindings.get(activeUnit) ?? null
      return 0
    },
  }
  const gl = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in api) {
          const f = api[prop]!
          return (...args: never[]) => {
            calls.push(prop)
            return f(...args)
          }
        }
        if (/^[A-Z0-9_]+$/.test(prop)) {
          if (!consts.has(prop)) consts.set(prop, nextConst++)
          return consts.get(prop)
        }
        return (...args: never[]) => {
          calls.push(prop)
          void args
          return undefined
        }
      },
    },
  ) as unknown as WebGL2RenderingContext
  return {
    gl,
    calls,
    blendEnabled: () => enabled.has(GL_BLEND),
    currentProgram: () => program,
    activeUnit: () => activeUnit,
    bindingOn: (unit: number) => bindings.get(unit) ?? null,
  }
}

describe('createComputeRunner — the WebGL2 tier restores the host context (#2355)', () => {
  const INPUT = new Float32Array([1, 2, 3])

  it('leaves BLEND enabled when the host had it enabled', async () => {
    // Pre-fix: `gl.disable(gl.BLEND)` inside the dispatch with no matching enable, so the
    // host's next alpha-blended draw composited fully opaque, with no error at the site
    // that broke.
    const s = statefulGlStub({ blend: true, program: { __hostProgram: true } })
    const r = await createComputeRunner(makeKernel(), { prefer: ['webgl2'], gl: s.gl })
    await r.run(INPUT)
    expect(s.blendEnabled()).toBe(true)
  })

  it('CONTROL — BLEND the host had DISABLED stays disabled', async () => {
    // An unconditional `gl.enable(gl.BLEND)` restore would pass the test above and break
    // this one: the runner must return the state it found, not a fixed state.
    const s = statefulGlStub({ blend: false, program: null })
    const r = await createComputeRunner(makeKernel(), { prefer: ['webgl2'], gl: s.gl })
    await r.run(INPUT)
    expect(s.blendEnabled()).toBe(false)
  })

  it("restores the host's current program", async () => {
    const hostProgram = { __hostProgram: true }
    const s = statefulGlStub({ blend: false, program: hostProgram })
    const r = await createComputeRunner(makeKernel(), { prefer: ['webgl2'], gl: s.gl })
    await r.run(INPUT)
    expect(s.currentProgram()).toBe(hostProgram)
  })

  it("restores the host's TEXTURE0 binding when the host was on TEXTURE0", async () => {
    const hostTex = { __hostTexture: true }
    const s = statefulGlStub({ blend: false, program: null, tex0: hostTex })
    const r = await createComputeRunner(makeKernel(), { prefer: ['webgl2'], gl: s.gl })
    await r.run(INPUT)
    expect(s.activeUnit()).toBe(GL_TEXTURE0)
    expect(s.bindingOn(GL_TEXTURE0)).toBe(hostTex)
  })

  it('restores the active unit AND TEXTURE0 when the host was on a DIFFERENT unit', async () => {
    // `TEXTURE_BINDING_2D` is per-unit, so a snapshot read off whichever unit happened to be
    // active would record a unit this pass never touches and restore the wrong one. Reading
    // it with TEXTURE0 selected is what makes the restore faithful for any incoming unit —
    // this arm is the one that distinguishes the two readings.
    const hostTex0 = { __hostTexture0: true }
    const s = statefulGlStub({
      blend: false,
      program: null,
      activeUnit: GL_TEXTURE3,
      tex0: hostTex0,
    })
    const r = await createComputeRunner(makeKernel(), { prefer: ['webgl2'], gl: s.gl })
    await r.run(INPUT)
    expect(s.activeUnit()).toBe(GL_TEXTURE3)
    // Not the runner's own data texture: that is private and must not stay visible.
    expect(s.bindingOn(GL_TEXTURE0)).toBe(hostTex0)
  })

  it('CONTROL — the dispatch still runs; the restore is not a short-circuit', async () => {
    // Separates "state is restored" from "the pass stopped drawing", which would restore
    // everything trivially.
    const s = statefulGlStub({ blend: true, program: null })
    const r = await createComputeRunner(makeKernel(), { prefer: ['webgl2'], gl: s.gl })
    s.calls.length = 0
    await r.run(INPUT)
    expect(s.calls).toContain('drawArrays')
    expect(s.calls).toContain('readPixels')
  })
})
