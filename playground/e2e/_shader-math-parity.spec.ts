// ═══ Shader-math parity: executed WGSL vs TS mirror ═══
//
// Closes the gap the deep-dive architecture review (2026-05-25) flagged as
// finding #1: NO automated test executes WGSL shader math. The existing
// projection-wgsl-consistency.test.ts compares the TS mirror against the
// CPU canonical — both TypeScript. It never runs the actual WGSL string
// that compiles on the GPU, so a drift edit to `WGSL_PROJECTION_FNS`
// (drop a `- PI/2`, change a constant) leaves every test green and ships
// the bug as a user-visible "geometry detaches under projection X".
//
// This spec EXECUTES the real `WGSL_PROJECTION_FNS` string in a WebGPU
// compute pass and diffs `project()` against the TS mirror `projectWgsl()`
// over a front-hemisphere lon/lat grid for projection types 0–6. It runs
// in the same Chromium the other e2e use; compute (pure arithmetic) works
// under SwiftShader in CI even though the raster pipeline does not, so this
// is the CI-viable shader-correctness gate.
//
// Tolerance: 100 m absolute. WGSL uses f32 and truncated constants
// (DEG2RAD=0.01745329, PI=3.14159265) so it diverges from the f64 mirror
// by ~5–10 m at Mercator scale (±2e7 m). A real math drift is kilometres+,
// far outside 100 m — the gate distinguishes f32 rounding from a wrong
// formula without flapping. The front-hemisphere grid (|lon|,|lat| ≤ 75 with
// centre 0,0) keeps every projection finite, avoiding the back-hemisphere
// cull divergence that projection-wgsl-consistency.test.ts pins separately.

import { test, expect } from '@playwright/test'
import { WGSL_PROJECTION_CONSTS, WGSL_PROJECTION_FNS } from '../../runtime/src/engine/shaders/projection'
import { projectWgsl, invMercLatRad, configureProjections } from '../../runtime/src/engine/shaders/dsl'
import { PROJECTIONS } from '../../runtime/src/engine/projection/projections-table'

// shader-dsl projections are host-injected — configure before any emit / cpu use.
configureProjections(PROJECTIONS)

const PROJ_NAMES = [
  'mercator', 'equirectangular', 'natural_earth',
  'orthographic', 'azimuthal_equidistant', 'stereographic', 'oblique_mercator',
] as const

// Front-hemisphere grid (centre 0,0): every projection returns finite.
const CLON = 0, CLAT = 0
const GRID: Array<[number, number]> = []
for (let lon = -75; lon <= 75; lon += 15) {
  for (let lat = -75; lat <= 75; lat += 15) GRID.push([lon, lat])
}

// Tolerance, by GPU class:
//   Hardware (local / pre-push): 100 m absolute. f32 + the WGSL's truncated
//   constants diverge only ~5–10 m at Mercator scale, so this catches even
//   a sub-permille formula drift — full sensitivity.
//   SwiftShader (CI software WebGPU, XGIS_SOFTWARE_GPU=1): its software
//   transcendentals (log/tan/sin/cos) are far weaker — measured ~3e-4
//   relative (stereographic's 2/(1+cos_c) amplifies it to ~2.7 km at 9.5e6 m).
//   So CI uses 2e-3 relative (+3 km floor): ~6× above SwiftShader noise, and
//   well below any GROSS formula drift (a dropped term / wrong sign / wrong
//   constant is whole-percent → hundreds of km). Net contract: CI catches
//   gross shader-math breakage; the tight hardware gate (pre-push) catches
//   the subtle drift SwiftShader is too imprecise to see.
const SOFTWARE_GPU = process.env.XGIS_SOFTWARE_GPU === '1'
const tolFor = (cpuVal: number): number =>
  SOFTWARE_GPU ? Math.max(3000, Math.abs(cpuVal) * 2e-3) : 100

// Compute WGSL: shared consts + the real projection block + a kernel that
// calls the actual `project()` over the grid for one projType.
const COMPUTE_WGSL = `
${WGSL_PROJECTION_CONSTS()}
${WGSL_PROJECTION_FNS()}
struct In { lon: f32, lat: f32 }
@group(0) @binding(0) var<storage, read> inp: array<In>;
@group(0) @binding(1) var<storage, read_write> outp: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> pp: vec4<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&inp)) { return; }
  outp[i] = project(inp[i].lon, inp[i].lat, pp);
}
`

test.describe('shader-math parity (executed WGSL vs TS mirror)', () => {
  test('WGSL project() matches projectWgsl() for projType 0–6', async ({ page }) => {
    test.setTimeout(60_000)
    // A minimal page just to get a WebGPU-capable browser context. Any
    // demo works; `minimal` is the lightest and is the webServer warmup URL.
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    // Run the real WGSL string on the GPU for all 7 projTypes. Returns,
    // per projType, the flat [x0,y0,x1,y1,...] output array (or null on
    // adapter failure / shader compile error, with the message).
    const gpu = await page.evaluate(async (args: {
      wgsl: string; grid: Array<[number, number]>; clon: number; clat: number
    }) => {
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
      const fatals = info.messages.filter(m => m.type === 'error')
      if (fatals.length > 0) {
        return { error: 'compile: ' + fatals.map(m => `${m.lineNum}:${m.message}`).join(' | ') }
      }
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      })

      const n = args.grid.length
      // Input buffer: 2 f32 per point (lon, lat).
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
        const bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: inBuf } },
            { binding: 1, resource: { buffer: outBuf } },
            { binding: 2, resource: { buffer: ppBuf } },
          ],
        })
        const enc = device.createCommandEncoder()
        const pass = enc.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bind)
        pass.dispatchWorkgroups(Math.ceil(n / 64))
        pass.end()
        enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, n * 2 * 4)
        device.queue.submit([enc.finish()])
        await readBuf.mapAsync(GPUMapMode.READ)
        out[projType] = Array.from(new Float32Array(readBuf.getMappedRange().slice(0)))
        readBuf.unmap()
      }
      return { out, errors }
    }, { wgsl: COMPUTE_WGSL, grid: GRID, clon: CLON, clat: CLAT })

    expect(gpu, `GPU compute failed: ${'error' in gpu ? gpu.error : ''}`).not.toHaveProperty('error')
    if ('error' in gpu) return
    expect(gpu.errors, `uncaptured GPU errors: ${gpu.errors.join(' | ')}`).toEqual([])

    // Diff every grid point against the TS mirror, per projType.
    const failures: string[] = []
    let compared = 0
    for (let projType = 0; projType <= 6; projType++) {
      const flat = gpu.out[projType]
      for (let i = 0; i < GRID.length; i++) {
        const [lon, lat] = GRID[i]
        const gx = flat[i * 2], gy = flat[i * 2 + 1]
        const [cx, cy] = projectWgsl(projType, lon, lat, CLON, CLAT)
        if (!Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(cx) || !Number.isFinite(cy)) continue
        compared++
        const dx = Math.abs(gx - cx), dy = Math.abs(gy - cy)
        if (dx > tolFor(cx) || dy > tolFor(cy)) {
          failures.push(
            `${PROJ_NAMES[projType]} (${lon},${lat}): WGSL=(${gx.toFixed(1)},${gy.toFixed(1)}) ` +
            `mirror=(${cx.toFixed(1)},${cy.toFixed(1)}) Δ=(${dx.toFixed(1)},${dy.toFixed(1)})m`,
          )
        }
      }
    }
    // Guard against a silent no-op (e.g. all-NaN output skipping every point).
    expect(compared, 'no finite point pairs were compared — kernel likely produced no output').toBeGreaterThan(300)
    expect(failures, `executed WGSL project() drifted from the TS mirror beyond tolerance (${SOFTWARE_GPU ? 'software' : 'hardware'} GPU):\n${failures.slice(0, 20).join('\n')}`).toEqual([])
  })

  test('WGSL inv_merc_lat_rad matches invMercLatRad (inverse Mercator)', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    // Input grid: Mercator-y metres spanning ±85° (forward-projected here so
    // the inputs are realistic absolute-Mercator values the shaders see).
    const ys: number[] = []
    for (let lat = -85; lat <= 85; lat += 5) {
      ys.push(Math.log(Math.tan(Math.PI / 4 + (lat * (Math.PI / 180)) / 2)) * 6378137)
    }
    const wgsl = `
${WGSL_PROJECTION_CONSTS()}
${WGSL_PROJECTION_FNS()}
@group(0) @binding(0) var<storage, read> inp: array<f32>;
@group(0) @binding(1) var<storage, read_write> outp: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&inp)) { return; }
  outp[i] = inv_merc_lat_rad(inp[i]);
}`

    const gpu = await page.evaluate(async (args: { wgsl: string; ys: number[] }) => {
      const nav = navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }
      if (!nav.gpu) return { error: 'no navigator.gpu' as const }
      const adapter = await (nav.gpu.requestAdapter() as Promise<GPUAdapter | null>)
      if (!adapter) return { error: 'no adapter' as const }
      const device = await adapter.requestDevice()
      const module = device.createShaderModule({ code: args.wgsl })
      const info = await module.getCompilationInfo()
      const fatals = info.messages.filter(m => m.type === 'error')
      if (fatals.length > 0) return { error: 'compile: ' + fatals.map(m => m.message).join(' | ') }
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } })
      const n = args.ys.length
      const inBuf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(inBuf, 0, new Float32Array(args.ys))
      const outBuf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
      const readBuf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } }],
      })
      const enc = device.createCommandEncoder()
      const pass = enc.beginComputePass()
      pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(Math.ceil(n / 64)); pass.end()
      enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, n * 4)
      device.queue.submit([enc.finish()])
      await readBuf.mapAsync(GPUMapMode.READ)
      const out = Array.from(new Float32Array(readBuf.getMappedRange().slice(0)))
      readBuf.unmap()
      return { out }
    }, { wgsl, ys })

    expect(gpu, `GPU compute failed: ${'error' in gpu ? gpu.error : ''}`).not.toHaveProperty('error')
    if ('error' in gpu) return

    // Latitude is in radians (~±1.48). SwiftShader's exp/atan are weaker, so
    // a looser radian tol there; both far below any real formula drift.
    const tolRad = SOFTWARE_GPU ? 1e-3 : 1e-5
    const failures: string[] = []
    for (let i = 0; i < ys.length; i++) {
      const g = gpu.out[i], c = invMercLatRad(ys[i])
      if (!Number.isFinite(g) || !Number.isFinite(c)) continue
      if (Math.abs(g - c) > tolRad) failures.push(`y=${ys[i].toFixed(0)}: WGSL=${g.toFixed(6)} mirror=${c.toFixed(6)} Δ=${Math.abs(g - c).toExponential(2)}`)
    }
    expect(failures, `executed WGSL inv_merc_lat_rad drifted from the mirror (${SOFTWARE_GPU ? 'software' : 'hardware'} GPU):\n${failures.join('\n')}`).toEqual([])
  })
})
