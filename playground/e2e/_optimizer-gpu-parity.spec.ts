// ═══ Optimizer GPU parity: executed WGSL of optimize(module) vs CPU oracle ═══
//
// US-11 (P3): the f32 GPU half of the optimizer correctness contract. The CPU
// half (compileModule(optimize(m)) === compileModule(m), oracle value-equality)
// is proven in shader-dsl unit tests; this spec runs the OPTIMIZED module's
// emitted WGSL on a real GPU and diffs it against the f64 oracle of the SAME
// optimized module — proving optimize() -> emitModule() -> real-GPU execution
// is correct, not just oracle-consistent.
//
// Imports shader-dsl via RELATIVE path (not the `@xgis/shader-dsl` package name)
// so the Playwright/node runner resolves it without the workspace symlink.
//
// Tolerance, by GPU class (mirrors _shader-math-parity, same compute pass):
//   Hardware (local / pre-push): 100 m absolute. f32 + truncated WGSL consts
//   diverge only ~5-10 m at Mercator scale (±2e7 m); a real optimizer miscompile
//   is km+, far outside 100 m — full sensitivity.
//   SwiftShader (CI software WebGPU, XGIS_SOFTWARE_GPU=1): its software
//   transcendentals are weaker (~3e-4 relative; stereographic amplifies to ~2.7 km),
//   so CI uses 2e-3 relative (+3 km floor) — well below any gross optimizer
//   miscompile, which is whole-percent. This lets the optimizer gate run in CI
//   alongside _shader-math-parity (both pure compute, SwiftShader-safe).

import { test, expect } from '@playwright/test'
import { emitModule } from '../../shader-dsl/src/core/backends/wgsl'
import { optimize } from '../../shader-dsl/src/core/passes/opt/index'
import { compileModule } from '../../shader-dsl/src/core/oracle'
import { getPROJECTION_MODULE, configureProjections } from '../../runtime/src/engine/shaders/dsl/projections'
import { PROJECTIONS } from '../../engine/src/projection/projections-table'

// shader-dsl projections are host-injected — configure before any emit / cpu use.
configureProjections(PROJECTIONS)

const PROJ_NAMES = ['mercator', 'equirectangular', 'natural_earth', 'orthographic', 'azimuthal_equidistant', 'stereographic', 'oblique_mercator'] as const

const CLON = 0, CLAT = 0
const GRID: Array<[number, number]> = []
for (let lon = -75; lon <= 75; lon += 15) for (let lat = -75; lat <= 75; lat += 15) GRID.push([lon, lat])

const SOFTWARE_GPU = process.env.XGIS_SOFTWARE_GPU === '1'
const tolFor = (cpuVal: number): number =>
  SOFTWARE_GPU ? Math.max(3000, Math.abs(cpuVal) * 2e-3) : 100

// Build the optimized module ONCE; emit it + keep its oracle for the diff.
const optMod = optimize(getPROJECTION_MODULE())
const optCpu = compileModule(optMod)
const OPT_WGSL = `${emitModule(optMod)}
struct In { lon: f32, lat: f32 }
@group(0) @binding(0) var<storage, read> inp: array<In>;
@group(0) @binding(1) var<storage, read_write> outp: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> pp: vec4<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&inp)) { return; }
  outp[i] = project(inp[i].lon, inp[i].lat, pp);
}`

test.describe('optimizer GPU parity (executed optimized WGSL vs CPU oracle)', () => {
  test('optimize(PROJECTION_MODULE) project() matches the oracle on the GPU for projType 0-6', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const gpu = await page.evaluate(async (args: { wgsl: string; grid: Array<[number, number]>; clon: number; clat: number }) => {
      const nav = navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }
      if (!nav.gpu) return { error: 'no navigator.gpu' as const }
      const adapter = await (nav.gpu.requestAdapter() as Promise<GPUAdapter | null>)
      if (!adapter) return { error: 'no adapter' as const }
      const device = await adapter.requestDevice()
      const errors: string[] = []
      device.addEventListener('uncapturederror', (e) => { errors.push((e as GPUUncapturedErrorEvent).error.message) })
      const module = device.createShaderModule({ code: args.wgsl })
      const info = await module.getCompilationInfo()
      const fatals = info.messages.filter((m) => m.type === 'error')
      if (fatals.length > 0) return { error: 'compile: ' + fatals.map((m) => `${m.lineNum}:${m.message}`).join(' | ') }
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } })
      const n = args.grid.length
      const inData = new Float32Array(n * 2)
      for (let i = 0; i < n; i++) { inData[i * 2] = args.grid[i][0]; inData[i * 2 + 1] = args.grid[i][1] }
      const inBuf = device.createBuffer({ size: inData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(inBuf, 0, inData)
      const outBuf = device.createBuffer({ size: n * 2 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
      const readBuf = device.createBuffer({ size: n * 2 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      const ppBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      const out: Record<number, number[]> = {}
      for (let projType = 0; projType <= 6; projType++) {
        device.queue.writeBuffer(ppBuf, 0, new Float32Array([projType, args.clon, args.clat, 0]))
        const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } }, { binding: 2, resource: { buffer: ppBuf } }] })
        const enc = device.createCommandEncoder()
        const pass = enc.beginComputePass()
        pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(Math.ceil(n / 64)); pass.end()
        enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, n * 2 * 4)
        device.queue.submit([enc.finish()])
        await readBuf.mapAsync(GPUMapMode.READ)
        out[projType] = Array.from(new Float32Array(readBuf.getMappedRange().slice(0)))
        readBuf.unmap()
      }
      return { out, errors }
    }, { wgsl: OPT_WGSL, grid: GRID, clon: CLON, clat: CLAT })

    expect(gpu, `GPU compute failed: ${'error' in gpu ? gpu.error : ''}`).not.toHaveProperty('error')
    if ('error' in gpu) return
    expect(gpu.errors, `uncaptured GPU errors: ${gpu.errors.join(' | ')}`).toEqual([])

    const failures: string[] = []
    let compared = 0
    for (let projType = 0; projType <= 6; projType++) {
      const flat = gpu.out[projType]
      for (let i = 0; i < GRID.length; i++) {
        const [lon, lat] = GRID[i]
        const gx = flat[i * 2], gy = flat[i * 2 + 1]
        const c = optCpu.fns.project(lon, lat, [projType, CLON, CLAT, 0]) as number[]
        const cx = c[0], cy = c[1]
        if (![gx, gy, cx, cy].every(Number.isFinite)) continue
        compared++
        if (Math.abs(gx - cx) > tolFor(cx) || Math.abs(gy - cy) > tolFor(cy)) {
          failures.push(`${PROJ_NAMES[projType]} (${lon},${lat}): GPU=(${gx.toFixed(1)},${gy.toFixed(1)}) oracle=(${cx.toFixed(1)},${cy.toFixed(1)})`)
        }
      }
    }
    expect(compared, 'no finite point pairs compared — kernel produced no output').toBeGreaterThan(300)
    expect(failures, `optimized WGSL drifted from the optimized-module oracle beyond tolerance (${SOFTWARE_GPU ? 'software' : 'hardware'} GPU):\n${failures.slice(0, 20).join('\n')}`).toEqual([])
  })
})
