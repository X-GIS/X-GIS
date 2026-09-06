// ═══ DEM decode parity: executed WGSL vs the CPU f64 oracle (D5 INC-2, #2532) ═══
//
// `dem_decode` (dem-elevation.ts) is the ONE formula turning a DEM texel into
// metres, and every consumer — hillshade's fragment today, the displacing vertex
// stage in INC-3 — reaches it through a thin sampling wrapper. The unit gate
// (`dem-elevation.test.ts`) proves the math on the f64 oracle; that oracle is
// blind to f32 reassociation, so this spec EXECUTES the emitted WGSL in a real
// compute pass and diffs, exactly as `_absorbed-fn-parity.spec.ts` does for
// lonlat_to_ecef. Compute is SwiftShader-viable, so this is a CI gate.
//
// The sweep includes the (128,128,128) mid-grey #2003 used — terrarium 128.5 m vs
// the mapbox formula's ~842 150 m — because that pair is what makes a wrong
// unpack loud rather than subtle.

import { test, expect } from '@playwright/test'
// Relative deep import (charter): Playwright transpiles specs in raw Node — the @xgis/*
// workspace alias does not resolve here, so specs import package SOURCES relatively.
import { compileModule } from '../../shader-dsl/src/core/oracle'
import { module } from '../../shader-dsl/src/core/ir'
import {
  DEM_ELEVATION_FUNCS,
  DEM_ELEVATION_WGSL_FNS,
} from '../../map/src/shaders/dsl/dem-elevation'

const SOFTWARE_GPU = !!process.env.XGIS_SOFTWARE_GPU

const M = compileModule(module({ funcs: DEM_ELEVATION_FUNCS }))

/** Flat-f32-in / flat-f32-out compute kernel on the real GPU (the
 *  `_absorbed-fn-parity` harness, verbatim). */
async function runCompute(
  page: import('@playwright/test').Page,
  wgsl: string,
  inData: number[],
  outLen: number,
) {
  return page.evaluate(
    async (args: { wgsl: string; inData: number[]; outLen: number }) => {
      const nav = navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }
      if (!nav.gpu) return { error: 'no navigator.gpu' as const }
      const adapter = await (nav.gpu.requestAdapter() as Promise<GPUAdapter | null>)
      if (!adapter) return { error: 'no adapter' as const }
      const device = await adapter.requestDevice()
      const errors: string[] = []
      device.addEventListener('uncapturederror', (e) =>
        errors.push((e as GPUUncapturedErrorEvent).error.message),
      )
      const mod = device.createShaderModule({ code: args.wgsl })
      const info = await mod.getCompilationInfo()
      const fatals = info.messages.filter((m) => m.type === 'error')
      if (fatals.length > 0)
        return { error: 'compile: ' + fatals.map((m) => `${m.lineNum}:${m.message}`).join(' | ') }
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: mod, entryPoint: 'main' },
      })
      const inArr = new Float32Array(args.inData)
      const inBuf = device.createBuffer({
        size: inArr.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(inBuf, 0, inArr)
      const outBytes = args.outLen * 4
      const outBuf = device.createBuffer({
        size: outBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      })
      const readBuf = device.createBuffer({
        size: outBytes,
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
      pass.dispatchWorkgroups(Math.ceil(args.outLen / 64))
      pass.end()
      enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, outBytes)
      device.queue.submit([enc.finish()])
      await readBuf.mapAsync(GPUMapMode.READ)
      const out = Array.from(new Float32Array(readBuf.getMappedRange().slice(0)))
      readBuf.unmap()
      return { out, errors }
    },
    { wgsl, inData, outLen },
  )
}

test.describe('dem_decode parity (executed WGSL vs CPU f64 oracle)', () => {
  test('WGSL dem_decode matches the oracle over a texel × encoding sweep', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const UNPACKS = [
      [6553.6, 25.6, 0.1, 10000], // mapbox
      [256, 1, 1 / 256, 32768], // terrarium
      [100, 10, 1, 500], // custom
    ]
    // Texels as textureSample returns them (byte / 255). Corners, the #2003 grey,
    // and a spread of mid values so no single lane dominates the dot.
    const bytes = [0, 1, 37, 128, 134, 160, 200, 254, 255]
    const texels: number[][] = [
      [128, 128, 128],
      [1, 134, 160],
    ]
    for (const r of bytes)
      for (const g of [0, 128, 255]) for (const b of [0, 77, 255]) texels.push([r, g, b])

    // Each case = texel(3) + unpack(4) = 7 f32; output 1 f32.
    const cases: Array<{ texel: number[]; unpack: number[] }> = []
    for (const unpack of UNPACKS)
      for (const t of texels) cases.push({ texel: t.map((v) => v / 255), unpack })
    const inData = cases.flatMap((c) => [...c.texel, ...c.unpack])

    const wgsl = `
${DEM_ELEVATION_WGSL_FNS}
@group(0) @binding(0) var<storage, read> inp: array<f32>;
@group(0) @binding(1) var<storage, read_write> outp: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&inp) / 7u) { return; }
  let b = i * 7u;
  outp[i] = dem_decode(
    vec3<f32>(inp[b], inp[b+1u], inp[b+2u]),
    vec4<f32>(inp[b+3u], inp[b+4u], inp[b+5u], inp[b+6u]));
}`
    const gpu = await runCompute(page, wgsl, inData, cases.length)
    expect(gpu, `GPU compute failed: ${'error' in gpu ? gpu.error : ''}`).not.toHaveProperty(
      'error',
    )
    if ('error' in gpu) return
    expect(gpu.errors, `uncaptured GPU errors: ${gpu.errors.join(' | ')}`).toEqual([])

    // WHAT THE 1 m TOLERANCE IS, MEASURED — not guessed. Three perturbations of the
    // EMITTED WGSL were run through this exact harness (#2532, one-off `_tmp-` spec):
    //
    //   A  drop the ×255                    244/249 over 1 m, maxΔ 1 671 142 m
    //   C  baseShift sign flipped           249/249 over 1 m, maxΔ    65 536 m
    //   B  ×255 hoisted outside the dot        0/249 over 1 m, maxΔ       0.15 m
    //
    // So this gate catches FORMULA drift (10⁴–10⁶ m) and deliberately does NOT catch
    // arm B. That is not a hole: `dot(t·255, u)` and `dot(t, u)·255` are the same
    // formula, and 0.15 m is ulp scale — the largest product is 255·6553.6 ≈ 1.67e6,
    // where an f32 ulp is 0.125 m. A driver free to contract the dot into FMAs moves
    // results by exactly this much, so a tolerance under it would red on real hardware
    // while proving nothing about the formula. #2532's own text predicted arm B would
    // fail; measured, it does not, and the number above is why.
    //
    // The observed floor is asserted below, so a future tightening starts from a
    // measurement rather than from this comment.
    const failures: string[] = []
    let compared = 0
    let maxDelta = 0
    for (let i = 0; i < cases.length; i++) {
      const ref = M.fns.dem_decode(cases[i].texel, cases[i].unpack) as number
      const g = gpu.out[i]
      if (!Number.isFinite(g) || !Number.isFinite(ref)) continue
      compared++
      const d = Math.abs(g - ref)
      if (d > maxDelta) maxDelta = d
      if (d > 1.0)
        failures.push(
          `case${i} texel=${cases[i].texel.map((v) => Math.round(v * 255)).join(',')} ` +
            `unpack=[${cases[i].unpack.join(',')}]: WGSL=${g.toFixed(3)} oracle=${ref.toFixed(3)} Δ=${d.toFixed(3)}m`,
        )
    }
    expect(compared, 'no finite elevations compared').toBeGreaterThan(200)
    console.log(`dem_decode parity: ${compared} cases, maxΔ ${maxDelta.toFixed(4)} m`)
    expect(
      failures,
      `executed WGSL dem_decode drifted from the CPU oracle (${SOFTWARE_GPU ? 'software' : 'hardware'} GPU):\n${failures.slice(0, 20).join('\n')}`,
    ).toEqual([])

    // The #2003 witness, by name: the same grey texel through the two unpacks.
    const iTerr = cases.findIndex(
      (c) =>
        c.unpack[3] === 32768 &&
        Math.round(c.texel[0] * 255) === 128 &&
        Math.round(c.texel[1] * 255) === 128,
    )
    const iMap = cases.findIndex(
      (c) =>
        c.unpack[3] === 10000 &&
        Math.round(c.texel[0] * 255) === 128 &&
        Math.round(c.texel[1] * 255) === 128,
    )
    expect(gpu.out[iTerr]).toBeCloseTo(128.5, 1)
    expect(gpu.out[iMap]).toBeGreaterThan(800_000)

    // The same-code noise floor, asserted rather than remembered (§12: measure the
    // floor before trusting any rung). Measured 0.0750 m on SwiftShader; the bound is
    // 0.5 and not 0.1 ON PURPOSE — a driver that contracts the dot into FMAs rounds a
    // few ulps differently at the 1.67e6 magnitude, and pinning this to the software
    // rasterizer's exact floor would make a hardware GPU red on nothing. 0.5 still
    // catches any drift heading for the 1 m gate above.
    expect(maxDelta, 'same-code f32 noise floor moved').toBeLessThan(0.5)
  })
})
