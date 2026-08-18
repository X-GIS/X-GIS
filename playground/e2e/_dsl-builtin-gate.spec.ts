// ═══ DSL builtin gate: the 2026-08 builtin batch on REAL drivers ═══
//
// The unit suite (stdlib-builtins-extended.test.ts) pins the WGSL/GLSL SPELLINGS
// and the CPU-oracle semantics of the new builtins (the six hyperbolics,
// saturate, the six 2×16 pack/unpacks, round→roundEven on GLSL) — but a spelling
// can be exactly what the registry intends and still be rejected or mis-rounded
// by a real compiler (§5: verified-by-construction claims about drivers have
// been wrong before). This spec closes that hole on BOTH targets:
//
//   WGSL — emits the builtin wrappers through the real emitModule pipeline,
//   compiles them with the browser's own WGSL compiler (Tint), EXECUTES a
//   compute pass over fixed inputs, and diffs every lane against the CPU f64
//   oracle running the SAME module: transcendentals under a SwiftShader-safe
//   tolerance, saturate/round/pack/unpack lanes BIT-EXACT (their math is exact
//   integer/representable arithmetic, so any deviation is a semantics bug —
//   including a driver that rounds `round(2.5)` away from even).
//
//   GLSL — emits a vertex+fragment pair whose fragment exercises every new id,
//   asserts the GLSL-side spellings landed (packHalf2x16 / roundEven / clamp —
//   and no WGSL-ism leaked), then compileShader+linkProgram on a REAL WebGL2
//   context with zero info-log errors. Numeric semantics on GLSL ride the
//   native ES 3.00 functions these ids rename to, so compile+link is the gate.
//
// Runs headlessly under SwiftShader (XGIS_SOFTWARE_GPU=1) — compute is pure
// arithmetic and WebGL2 needs no WebGPU adapter, same contract as
// _shader-math-parity.spec.ts / _glsl-compile-gate.spec.ts.

import { test, expect } from '@playwright/test'
// Relative deep import (charter): Playwright transpiles specs in raw Node — the
// @xgis/* workspace alias does not resolve here (see _glsl-compile-gate.spec.ts).
import {
  module as buildModule,
  fn,
  f32T,
  u32T,
  vec2fT,
  vec4fT,
  structT,
  member,
  vec2,
  vec4,
  f32,
  sinh,
  cosh,
  tanh,
  asinh,
  acosh,
  atanh,
  saturate,
  round,
  pack2x16float,
  pack2x16unorm,
  pack2x16snorm,
  unpack2x16float,
  unpack2x16unorm,
  unpack2x16snorm,
  emitModule,
  emitGlslModule,
  compileModule,
  type StructDecl,
} from '../../shader-dsl/src/index'

test.describe.configure({ timeout: 120_000 })

// ── the shared builtin-wrapper module (CPU oracle + WGSL compute both run it) ──
const M = buildModule({
  funcs: [
    fn('f_sinh', { x: f32T }, ({ x }) => sinh(x)),
    fn('f_cosh', { x: f32T }, ({ x }) => cosh(x)),
    fn('f_tanh', { x: f32T }, ({ x }) => tanh(x)),
    fn('f_asinh', { x: f32T }, ({ x }) => asinh(x)),
    fn('f_acosh', { x: f32T }, ({ x }) => acosh(x)),
    fn('f_atanh', { x: f32T }, ({ x }) => atanh(x)),
    fn('f_saturate', { x: f32T }, ({ x }) => saturate(x)),
    fn('f_round', { x: f32T }, ({ x }) => round(x)),
    fn('p_float', { v: vec2fT }, ({ v }) => pack2x16float(v)),
    fn('p_unorm', { v: vec2fT }, ({ v }) => pack2x16unorm(v)),
    fn('p_snorm', { v: vec2fT }, ({ v }) => pack2x16snorm(v)),
    fn('up_float', { u: u32T }, ({ u }) => unpack2x16float(u)),
    fn('up_unorm', { u: u32T }, ({ u }) => unpack2x16unorm(u)),
    fn('up_snorm', { u: u32T }, ({ u }) => unpack2x16snorm(u)),
  ],
})

// Fixed inputs, f32-rounded so GPU and oracle see identical operands. Pack-lane
// inputs avoid the ⌊0.5+x⌋ halfway cases DELIBERATELY: the WGSL formula pins
// them but Vulkan's packUnorm/Snorm round() leaves the tie direction open, so a
// halfway input would gate on driver choice, not on our semantics (the halfway
// pins live in the unit suite, against the WGSL formula).
const I = [
  Math.LN2, // 0: sinh/cosh/tanh operand (0.75 / 1.25 / 0.6 family)
  0.75, // 1: asinh operand
  1.25, // 2: acosh operand
  0.6, // 3: atanh operand
  1.5, // 4: saturate→1; pack2x16float c0 (exact in f16)
  -0.5, // 5: saturate→0
  2.5, // 6: round→2 (ties-to-even)
  3.5, // 7: round→4
  -2.25, // 8: pack2x16float c1 (exact in f16); snorm clamp-binding lane (→ −1)
  0.75, // 9: unorm c0 (49151.25 — unambiguous)
  0.25, // 10: unorm/snorm c1 (16383.75 / 8191.75 — unambiguous)
].map(Math.fround)

const N_OUT = 19

const KERNEL_WGSL = `
${emitModule(M)}
@group(0) @binding(0) var<storage, read> inp: array<f32>;
@group(0) @binding(1) var<storage, read_write> outp: array<u32>;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x > 0u) { return; }
  outp[0] = bitcast<u32>(f_sinh(inp[0]));
  outp[1] = bitcast<u32>(f_cosh(inp[0]));
  outp[2] = bitcast<u32>(f_tanh(inp[0]));
  outp[3] = bitcast<u32>(f_asinh(inp[1]));
  outp[4] = bitcast<u32>(f_acosh(inp[2]));
  outp[5] = bitcast<u32>(f_atanh(inp[3]));
  outp[6] = bitcast<u32>(f_saturate(inp[4]));
  outp[7] = bitcast<u32>(f_saturate(inp[5]));
  outp[8] = bitcast<u32>(f_round(inp[6]));
  outp[9] = bitcast<u32>(f_round(inp[7]));
  outp[10] = p_float(vec2<f32>(inp[4], inp[8]));
  outp[11] = p_unorm(vec2<f32>(inp[9], inp[10]));
  outp[12] = p_snorm(vec2<f32>(inp[8], inp[10]));
  let uf = up_float(0x3E002E66u);
  outp[13] = bitcast<u32>(uf.x);
  outp[14] = bitcast<u32>(uf.y);
  let uu = up_unorm(0xFFFF0000u);
  outp[15] = bitcast<u32>(uu.x);
  outp[16] = bitcast<u32>(uu.y);
  let us = up_snorm(0x7FFF8001u);
  outp[17] = bitcast<u32>(us.x);
  outp[18] = bitcast<u32>(us.y);
}
`

test.describe('DSL builtin gate — WGSL (Tint compile + compute execution vs CPU oracle)', () => {
  test('every new builtin compiles and its executed value matches the oracle', async ({ page }) => {
    // The emitted WGSL keeps the WGSL-side spellings (a GLSL name here would
    // mean the registry columns swapped).
    expect(KERNEL_WGSL).toContain('saturate(')
    expect(KERNEL_WGSL).toContain('pack2x16float(')
    expect(KERNEL_WGSL).not.toContain('packHalf2x16(')

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const gpu = await page.evaluate(
      async (args: { wgsl: string; inputs: number[]; nOut: number }) => {
        const nav = navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }
        if (!nav.gpu) return { error: 'no navigator.gpu' as const }
        const adapter = await (nav.gpu.requestAdapter() as Promise<GPUAdapter | null>)
        if (!adapter) return { error: 'no adapter' as const }
        const device = await adapter.requestDevice()
        const errors: string[] = []
        device.addEventListener('uncapturederror', (e) => {
          errors.push((e as GPUUncapturedErrorEvent).error.message)
        })

        const module = device.createShaderModule({ code: args.wgsl })
        const info = await module.getCompilationInfo()
        const fatals = info.messages.filter((m) => m.type === 'error')
        if (fatals.length > 0) {
          return { error: 'compile: ' + fatals.map((m) => `${m.lineNum}:${m.message}`).join(' | ') }
        }
        const pipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module, entryPoint: 'main' },
        })
        const inData = new Float32Array(args.inputs)
        const inBuf = device.createBuffer({
          size: inData.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })
        device.queue.writeBuffer(inBuf, 0, inData)
        const outBuf = device.createBuffer({
          size: args.nOut * 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        })
        const readBuf = device.createBuffer({
          size: args.nOut * 4,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        const bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: inBuf } },
            { binding: 1, resource: { buffer: outBuf } },
          ],
        })
        const enc = device.createCommandEncoder()
        const pass = enc.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bind)
        pass.dispatchWorkgroups(1)
        pass.end()
        enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, args.nOut * 4)
        device.queue.submit([enc.finish()])
        await readBuf.mapAsync(GPUMapMode.READ)
        const raw = readBuf.getMappedRange().slice(0)
        readBuf.unmap()
        return { u32: Array.from(new Uint32Array(raw)), errors }
      },
      { wgsl: KERNEL_WGSL, inputs: I, nOut: N_OUT },
    )

    expect(gpu, `GPU leg failed: ${'error' in gpu ? gpu.error : ''}`).not.toHaveProperty('error')
    if ('error' in gpu) return
    expect(gpu.errors, `uncaptured GPU errors: ${gpu.errors.join(' | ')}`).toEqual([])

    const gpuU32 = gpu.u32
    const asF32 = (u: number): number => {
      const dv = new DataView(new ArrayBuffer(4))
      dv.setUint32(0, u >>> 0, true)
      return dv.getFloat32(0, true)
    }

    // The CPU oracle runs the SAME module on the SAME f32-rounded inputs.
    const cpu = compileModule(M).fns
    const n = (v: unknown): number => v as number
    const v2 = (v: unknown): number[] => v as number[]

    // Lanes 0–5: transcendentals — SwiftShader's software transcendentals sit
    // well inside 2e-3 relative (the shader-math-parity CI bound); a wrong
    // FUNCTION is O(1) off.
    const trans = [
      n(cpu.f_sinh(I[0]!)),
      n(cpu.f_cosh(I[0]!)),
      n(cpu.f_tanh(I[0]!)),
      n(cpu.f_asinh(I[1]!)),
      n(cpu.f_acosh(I[2]!)),
      n(cpu.f_atanh(I[3]!)),
    ]
    trans.forEach((want, i) => {
      const got = asF32(gpuU32[i]!)
      expect(
        Math.abs(got - want),
        `lane ${i} (transcendental): gpu ${got} vs oracle ${want}`,
      ).toBeLessThanOrEqual(Math.max(1e-4, Math.abs(want) * 2e-3))
    })

    // Lanes 6–9: saturate / round — exact arithmetic, BIT-exact against the
    // oracle (round(2.5)=2 / round(3.5)=4 is the ties-to-even semantic pin).
    const exactF = [
      n(cpu.f_saturate(I[4]!)),
      n(cpu.f_saturate(I[5]!)),
      n(cpu.f_round(I[6]!)),
      n(cpu.f_round(I[7]!)),
    ]
    exactF.forEach((want, k) => {
      const lane = 6 + k
      expect(asF32(gpuU32[lane]!), `lane ${lane} (saturate/round, exact)`).toBe(Math.fround(want))
    })

    // Lanes 10–12: packs — u32-exact (f16 components chosen exactly
    // representable; unorm/snorm inputs away from the round() tie).
    const packs = [
      n(cpu.p_float([I[4]!, I[8]!])),
      n(cpu.p_unorm([I[9]!, I[10]!])),
      n(cpu.p_snorm([I[8]!, I[10]!])),
    ]
    packs.forEach((want, k) => {
      const lane = 10 + k
      expect(gpuU32[lane]!, `lane ${lane} (pack, u32-exact)`).toBe(want >>> 0)
    })

    // Lanes 13–18: unpacks — every expected value is exactly f32-representable.
    const unpacks = [
      ...v2(cpu.up_float(0x3e002e66)),
      ...v2(cpu.up_unorm(0xffff0000)),
      ...v2(cpu.up_snorm(0x7fff8001)),
    ]
    unpacks.forEach((want, k) => {
      const lane = 13 + k
      expect(asF32(gpuU32[lane]!), `lane ${lane} (unpack, exact)`).toBe(Math.fround(want))
    })
  })
})

// ── GLSL leg: a vertex+fragment pair exercising every new id ──
const VsIn: StructDecl = {
  name: 'VsIn',
  fields: [{ name: 'pos', type: vec2fT, attr: '@location(0)', location: 0 }],
}
const VsOut: StructDecl = {
  name: 'VsOut',
  fields: [
    { name: 'position', type: vec4fT, attr: '@builtin(position)', builtin: 'position' },
    { name: 'uv', type: vec2fT, attr: '@location(0)', location: 0 },
  ],
}
const FsOut: StructDecl = {
  name: 'FsOut',
  fields: [{ name: 'color', type: vec4fT, attr: '@location(0)', location: 0 }],
}

const vs = fn(
  'vs',
  { inp: structT('VsIn') },
  structT('VsOut'),
  ({ inp }, b) => {
    const out = b.var('out', structT('VsOut'))
    const p = member(inp, 'pos', vec2fT)
    b.assign(member(out, 'position', vec4fT), vec4(p, f32(0), f32(1)))
    b.assign(member(out, 'uv', vec2fT), p)
    b.ret(out)
  },
  { stage: 'vertex' },
)
const fs = fn(
  'fs',
  { inp: structT('VsOut') },
  structT('FsOut'),
  ({ inp }, b) => {
    const ux = b.let('ux', member(inp, 'uv', vec2fT).x)
    const uy = b.let('uy', member(inp, 'uv', vec2fT).y)
    const hyp = b.let(
      'hyp',
      sinh(ux)
        .add(cosh(uy))
        .add(tanh(ux))
        .add(asinh(uy))
        .add(acosh(ux.add(1.5)))
        .add(atanh(ux.mul(0.25))),
    )
    const pf = b.let('pf', pack2x16float(vec2(ux, uy)))
    const pu = b.let('pu', pack2x16unorm(vec2(ux, uy)))
    const ps = b.let('ps', pack2x16snorm(vec2(ux, uy)))
    const s = b.let(
      's',
      unpack2x16float(pf).x.add(unpack2x16unorm(pu).y).add(unpack2x16snorm(ps).x),
    )
    // The PORTABLE fragment-coordinate read — @builtin(position) on the fragment
    // input, spelled gl_FragCoord by the GLSL writer. This is the form the retired
    // `frag_coord` alias's remedy points authors at, so the gate proves it compiles
    // on both real drivers (mind the y-origin difference when consuming .y).
    const fcx = b.let('fcx', member(inp, 'position', vec4fT).x.mul(0.0001))
    const out = b.var('out', structT('FsOut'))
    b.assign(
      member(out, 'color', vec4fT),
      vec4(saturate(hyp).add(fcx), s, round(uy.mul(4)), f32(1)),
    )
    b.ret(out)
  },
  { stage: 'fragment' },
)
const GLSL_MOD = buildModule({ structs: [VsIn, VsOut, FsOut], funcs: [vs, fs] })

test.describe('DSL builtin gate — GLSL ES 3.00 (real WebGL2 compile + link)', () => {
  test('the fragment exercising every new id compiles and links cleanly', async ({ page }) => {
    const vertex = emitGlslModule(GLSL_MOD, 'vertex')
    const fragment = emitGlslModule(GLSL_MOD, 'fragment')

    // The GLSL spellings landed — and no WGSL-ism leaked through the registry.
    for (const s of [
      'sinh(',
      'cosh(',
      'tanh(',
      'asinh(',
      'acosh(',
      'atanh(',
      'roundEven(',
      'packHalf2x16(',
      'packUnorm2x16(',
      'packSnorm2x16(',
      'unpackHalf2x16(',
      'unpackUnorm2x16(',
      'unpackSnorm2x16(',
      'gl_FragCoord', // the fragment-input position read — the portable frag_coord form
    ]) {
      expect(fragment, `fragment GLSL must contain ${s}`).toContain(s)
    }
    expect(fragment).not.toContain('saturate(')
    expect(fragment).not.toContain('pack2x16')

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const result = await page.evaluate(
      ({ vertex, fragment }) => {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl2')
        if (!gl) return { fatal: 'no webgl2 context' as const }
        const compile = (type: number, src: string): { ok: boolean; log: string } => {
          const sh = gl.createShader(type)!
          gl.shaderSource(sh, src)
          gl.compileShader(sh)
          return {
            ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean,
            log: gl.getShaderInfoLog(sh) ?? '',
          }
        }
        const vsr = compile(gl.VERTEX_SHADER, vertex)
        const fsr = compile(gl.FRAGMENT_SHADER, fragment)
        let linkOk = false
        let linkLog = ''
        if (vsr.ok && fsr.ok) {
          const prog = gl.createProgram()!
          const vsh = gl.createShader(gl.VERTEX_SHADER)!
          gl.shaderSource(vsh, vertex)
          gl.compileShader(vsh)
          const fsh = gl.createShader(gl.FRAGMENT_SHADER)!
          gl.shaderSource(fsh, fragment)
          gl.compileShader(fsh)
          gl.attachShader(prog, vsh)
          gl.attachShader(prog, fsh)
          gl.linkProgram(prog)
          linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
          linkLog = gl.getProgramInfoLog(prog) ?? ''
        }
        return { vs: vsr, fs: fsr, linkOk, linkLog }
      },
      { vertex, fragment },
    )

    expect(result, `WebGL2 unavailable`).not.toHaveProperty('fatal')
    if ('fatal' in result) return
    expect(
      result.vs.ok,
      `vertex shader failed to compile:\n${result.vs.log}\n--- GLSL ---\n${vertex}`,
    ).toBe(true)
    expect(
      result.fs.ok,
      `fragment shader failed to compile:\n${result.fs.log}\n--- GLSL ---\n${fragment}`,
    ).toBe(true)
    expect(result.linkOk, `program failed to link:\n${result.linkLog}`).toBe(true)
  })
})
