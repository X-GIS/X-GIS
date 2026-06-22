// ═══ Absorbed-fn parity: executed WGSL vs the CPU f64 oracle ═══
//
// ecef.ts (lonlat_to_ecef) and raster-color.ts (raster_color_adjust) were absorbed from
// hand-written WGSL strings into DSL fn()s; the *_WGSL_* exports are now DERIVED by emitting
// them. That absorption is NOT byte-identical to the old raw strings, so the unit gate is a
// CPU f64 math-oracle (ecef-dsl.test.ts / raster-color-dsl.test.ts). The critic review noted
// the gap: the f64 oracle is blind to the f32-GPU result, and NO test executes the actual
// emitted WGSL of these two fns. A future edit could reassociate the ops (f64-equal, f32-
// different) with every unit test still green.
//
// This spec closes that gap exactly like _shader-math-parity does for project(): it EXECUTES
// the real emitted ECEF_WGSL_FNS / RASTER_COLOR_WGSL_FNS in a WebGPU compute pass and diffs
// against the CPU f64 oracle (compileModule). Compute is SwiftShader-viable, so it is a CI gate.

import { test, expect } from '@playwright/test'
import { compileModule } from '../../shader-dsl/src/core/oracle'
import { module } from '../../shader-dsl/src/core/ir'
import { ECEF_WGSL_CONSTS, ECEF_WGSL_FNS, ECEF_CONSTS, ECEF_FUNCS } from '../../shader-dsl/src/shaders/ecef'
import { RASTER_COLOR_WGSL_FNS, RASTER_COLOR_FUNCS } from '../../shader-dsl/src/shaders/raster-color'

const SOFTWARE_GPU = process.env.XGIS_SOFTWARE_GPU === '1'

// CPU f64 oracles — the same compiled modules the unit tests assert against.
const ecefM = compileModule(module({ consts: ECEF_CONSTS, funcs: ECEF_FUNCS }))
const rcM = compileModule(module({ consts: ECEF_CONSTS, funcs: RASTER_COLOR_FUNCS }))

// Dispatch a flat-f32-in / flat-f32-out compute kernel on the real GPU; returns the output
// array (or { error } on adapter/compile failure). The kernel reads/writes flat f32 arrays
// (no vec storage alignment to reason about).
async function runCompute(page: import('@playwright/test').Page, wgsl: string, inData: number[], outLen: number) {
  return page.evaluate(async (args: { wgsl: string; inData: number[]; outLen: number }) => {
    const nav = navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }
    if (!nav.gpu) return { error: 'no navigator.gpu' as const }
    const adapter = await (nav.gpu.requestAdapter() as Promise<GPUAdapter | null>)
    if (!adapter) return { error: 'no adapter' as const }
    const device = await adapter.requestDevice()
    const errors: string[] = []
    device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message))
    const mod = device.createShaderModule({ code: args.wgsl })
    const info = await mod.getCompilationInfo()
    const fatals = info.messages.filter((m) => m.type === 'error')
    if (fatals.length > 0) return { error: 'compile: ' + fatals.map((m) => `${m.lineNum}:${m.message}`).join(' | ') }
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } })
    const inArr = new Float32Array(args.inData)
    const inBuf = device.createBuffer({ size: inArr.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(inBuf, 0, inArr)
    const outBytes = args.outLen * 4
    const outBuf = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
    const readBuf = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } }],
    })
    const enc = device.createCommandEncoder()
    const pass = enc.beginComputePass()
    pass.setPipeline(pipeline); pass.setBindGroup(0, bind)
    pass.dispatchWorkgroups(Math.ceil(args.outLen / 64)); pass.end()
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, outBytes)
    device.queue.submit([enc.finish()])
    await readBuf.mapAsync(GPUMapMode.READ)
    const out = Array.from(new Float32Array(readBuf.getMappedRange().slice(0)))
    readBuf.unmap()
    return { out, errors }
  }, { wgsl, inData, outLen })
}

test.describe('absorbed-fn parity (executed WGSL vs CPU f64 oracle)', () => {
  test('WGSL lonlat_to_ecef matches the CPU oracle over a lon/lat/height grid', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    // lon/lat in RADIANS (the fn's contract) + height in metres. 3 f32 per point.
    const pts: Array<[number, number, number]> = []
    for (let lonDeg = -180; lonDeg <= 180; lonDeg += 45) {
      for (let latDeg = -85; latDeg <= 85; latDeg += 20) {
        for (const h of [0, 100, 1000, -50]) {
          pts.push([(lonDeg * Math.PI) / 180, (latDeg * Math.PI) / 180, h])
        }
      }
    }
    const inData = pts.flat()
    const wgsl = `
${ECEF_WGSL_CONSTS}
${ECEF_WGSL_FNS}
@group(0) @binding(0) var<storage, read> inp: array<f32>;
@group(0) @binding(1) var<storage, read_write> outp: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&inp) / 3u) { return; }
  let e = lonlat_to_ecef(inp[i*3u], inp[i*3u+1u], inp[i*3u+2u]);
  outp[i*3u] = e.x; outp[i*3u+1u] = e.y; outp[i*3u+2u] = e.z;
}`
    const gpu = await runCompute(page, wgsl, inData, pts.length * 3)
    expect(gpu, `GPU compute failed: ${'error' in gpu ? gpu.error : ''}`).not.toHaveProperty('error')
    if ('error' in gpu) return
    expect(gpu.errors, `uncaptured GPU errors: ${gpu.errors.join(' | ')}`).toEqual([])

    // ECEF magnitudes are ~6.4e6 m. f32 ulp there is ~0.5 m; sin/cos/sqrt add a few m on
    // hardware. A real formula drift is km+. SwiftShader's transcendentals are far weaker.
    const failures: string[] = []
    let compared = 0
    for (let i = 0; i < pts.length; i++) {
      const ref = ecefM.fns.lonlat_to_ecef(pts[i][0], pts[i][1], pts[i][2]) as number[]
      for (let k = 0; k < 3; k++) {
        const g = gpu.out[i * 3 + k], c = ref[k]
        if (!Number.isFinite(g) || !Number.isFinite(c)) continue
        compared++
        const tol = SOFTWARE_GPU ? Math.max(2000, Math.abs(c) * 2e-3) : 50
        if (Math.abs(g - c) > tol) failures.push(`pt${i}[${k}]: WGSL=${g.toFixed(1)} oracle=${c.toFixed(1)} Δ=${Math.abs(g - c).toFixed(1)}m`)
      }
    }
    expect(compared, 'no finite ECEF components compared').toBeGreaterThan(300)
    expect(failures, `executed WGSL lonlat_to_ecef drifted from the CPU oracle (${SOFTWARE_GPU ? 'software' : 'hardware'} GPU):\n${failures.slice(0, 20).join('\n')}`).toEqual([])
  })

  test('WGSL raster_color_adjust matches the CPU oracle across colour-paint cases', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    // Each case = rgb(3) + p0(4: hueDeg,bMin,bMax,sat) + p1(4: contrast,0,0,0) = 11 f32.
    const cases: Array<{ rgb: number[]; p0: number[]; p1: number[] }> = []
    const rgbs = [[0.5, 0.6, 0.7], [0.2, 0.4, 0.8], [0.1, 0.9, 0.3], [0, 0, 0], [1, 1, 1]]
    const paints = [
      [0, 0, 1, 0], [90, 0, 1, 0], [180, 0, 1, 0], [0, 0.1, 0.9, 0],
      [0, 0, 1, 0.5], [0, 0, 1, -0.5], [30, 0.2, 0.8, 0.3],
    ]
    const contrasts = [0, 0.5, -0.5]
    for (const rgb of rgbs) for (const p0 of paints) for (const c of contrasts) cases.push({ rgb, p0, p1: [c, 0, 0, 0] })
    const inData = cases.flatMap((cs) => [...cs.rgb, ...cs.p0, ...cs.p1])
    const wgsl = `
${ECEF_WGSL_CONSTS}
${RASTER_COLOR_WGSL_FNS}
@group(0) @binding(0) var<storage, read> inp: array<f32>;
@group(0) @binding(1) var<storage, read_write> outp: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&inp) / 11u) { return; }
  let b = i*11u;
  let rgb = vec3<f32>(inp[b], inp[b+1u], inp[b+2u]);
  let p0 = vec4<f32>(inp[b+3u], inp[b+4u], inp[b+5u], inp[b+6u]);
  let p1 = vec4<f32>(inp[b+7u], inp[b+8u], inp[b+9u], inp[b+10u]);
  let o = raster_color_adjust(rgb, p0, p1);
  outp[i*3u] = o.x; outp[i*3u+1u] = o.y; outp[i*3u+2u] = o.z;
}`
    const gpu = await runCompute(page, wgsl, inData, cases.length * 3)
    expect(gpu, `GPU compute failed: ${'error' in gpu ? gpu.error : ''}`).not.toHaveProperty('error')
    if ('error' in gpu) return
    expect(gpu.errors, `uncaptured GPU errors: ${gpu.errors.join(' | ')}`).toEqual([])

    // Colour is clamped to [0,1]; f32 vs f64 diverges by <1 ulp. Tolerance well below the
    // 1/255 (~0.0039) framebuffer quantization floor — catches a real formula drift, not rounding.
    const failures: string[] = []
    let compared = 0
    for (let i = 0; i < cases.length; i++) {
      const ref = rcM.fns.raster_color_adjust(cases[i].rgb, cases[i].p0, cases[i].p1) as number[]
      for (let k = 0; k < 3; k++) {
        const g = gpu.out[i * 3 + k], c = ref[k]
        if (!Number.isFinite(g) || !Number.isFinite(c)) continue
        compared++
        const tol = SOFTWARE_GPU ? 5e-3 : 1e-3
        if (Math.abs(g - c) > tol) failures.push(`case${i}[${k}] rgb=${cases[i].rgb} p0=${cases[i].p0}: WGSL=${g.toFixed(4)} oracle=${c.toFixed(4)} Δ=${Math.abs(g - c).toExponential(2)}`)
      }
    }
    expect(compared, 'no finite colour components compared').toBeGreaterThan(100)
    expect(failures, `executed WGSL raster_color_adjust drifted from the CPU oracle (${SOFTWARE_GPU ? 'software' : 'hardware'} GPU):\n${failures.slice(0, 20).join('\n')}`).toEqual([])
  })
})
