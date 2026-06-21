import { test, expect } from '@playwright/test'
import { DEQUANT_ECEF_WGSL } from '@xgis/shader-dsl/shaders/polygon'
import { dequantVertexF32, POLYGON_FILL_FORMAT } from '@xgis/compiler'

// ═══ dequant_ecef compute parity: GPU f32 ≡ CPU fround mirror ═══
//
// Proof B→A of the CPU-side coordinate-verification path. The polygon vertex
// shaders (vs_main_ecef / _extruded) decode quantized position via the shared
// DSL fn `dequant_ecef`. This spec runs that EXACT fn (DEQUANT_ECEF_WGSL,
// emitted from the same IR) in a WebGPU COMPUTE pass — no rasterization, so
// SwiftShader's inability to render the line/polygon raster path is irrelevant;
// coordinate decode is a pre-rasterization step. It then asserts the GPU's f32
// output equals the CPU mirror `dequantVertexF32` (Math.fround model) used by
// ecef-precision-fuzz.
//
// Why this matters: it validates that the CPU fround model FAITHFULLY
// represents real GPU f32 arithmetic. Once proven, the CPU mirror can gate
// precision in CI without a GPU — the whole point of "CPU-side verification".
// (A residual gap remains: GPU drivers may fuse mul+add into fma, diverging
// from the CPU's separated fround by ~1 ULP. The tolerance below absorbs that
// while still catching any real formula/precision divergence.)
//
// Inputs: random u16 position lanes across the per-tile (scale, half) ranges
// from z=0 (half ~1e7 m, coarse) to z=22 (half ~10 m, fine). dequant_ecef is a
// pure function, so random quantized inputs exercise it as faithfully as real
// packed tiles — and cover more of the u32 range.

const SOFTWARE_GPU = process.env.XGIS_SOFTWARE_GPU === '1'

// Per-tile symmetric half-range + step, spanning the real zoom range. scale =
// span / 0xFFFFFFFF mirrors packECEFPolygonVertices.
const CASES = [
  { label: 'z0',  half: 1.0e7 },
  { label: 'z8',  half: 4.0e4 },
  { label: 'z15', half: 3.0e2 },
  { label: 'z22', half: 2.0e0 },
] as const

const N = 2000  // vertices per case

// Deterministic RNG so failures reproduce.
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x1_0000_0000 }
}

const COMPUTE_WGSL = `
${DEQUANT_ECEF_WGSL}
@group(0) @binding(0) var<storage, read> inp: array<u32>;       // 6 u32 (u16 lanes) per vertex
@group(0) @binding(1) var<storage, read_write> outp: array<vec4<f32>>; // ecef_rtc.xyz + pad
@group(0) @binding(2) var<uniform> pp: vec4<f32>;               // scale, half, _, _
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i * 6u + 5u >= arrayLength(&inp)) { return; }
  let b = i * 6u;
  let q_xy = vec4<u32>(inp[b], inp[b + 1u], inp[b + 2u], inp[b + 3u]);
  let q_z = vec2<u32>(inp[b + 4u], inp[b + 5u]);
  let rtc = dequant_ecef(q_xy, q_z, pp.x, pp.y);
  outp[i] = vec4<f32>(rtc, 0.0);
}
`

test.describe('dequant_ecef compute parity (GPU f32 ≡ CPU fround mirror)', () => {
  test('GPU dequant_ecef matches dequantVertexF32 across the z-range', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    // Build per-case inputs: random u16 position lanes + scale/half.
    const cases = CASES.map(({ label, half }, ci) => {
      const scale = (2 * half) / 0xFFFFFFFF
      const rng = makeRng(0xD0 + ci)
      // Stride from the SINGLE-SOURCE polygon fill format (stride 28 = 14 u16;
      // the u16×6 position is lanes 0..5, the rest is the f32 tail) so the
      // synthetic buffer strides EXACTLY like dequantVertexF32 reads it
      // (`vi * POLYGON_FILL_FORMAT.stride/2`). Hardcoding 12 u16 drifted when a
      // tail slot grew the stride 24→28 — the dequant/clip render-gate has been
      // red on every main run because of that off-by-2-u16 misread.
      const u16PerVert = POLYGON_FILL_FORMAT.stride / 2
      const verts = new Float32Array(N * (POLYGON_FILL_FORMAT.stride / 4))
      const u16 = new Uint16Array(verts.buffer)
      const inU32 = new Uint32Array(N * 6)
      for (let i = 0; i < N; i++) {
        for (let k = 0; k < 6; k++) {
          const v = Math.floor(rng() * 0x10000) & 0xFFFF
          u16[i * u16PerVert + k] = v
          inU32[i * 6 + k] = v
        }
      }
      return { label, half, scale, verts, inU32 }
    })

    const gpu = await page.evaluate(async (args: {
      wgsl: string
      cases: Array<{ label: string; half: number; scale: number; inU32: number[] }>
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
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } })

      const out: Record<string, number[]> = {}
      for (const c of args.cases) {
        const n = c.inU32.length / 6
        const inData = new Uint32Array(c.inU32)
        const inBuf = device.createBuffer({ size: inData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
        device.queue.writeBuffer(inBuf, 0, inData)
        const outBuf = device.createBuffer({ size: n * 4 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
        const readBuf = device.createBuffer({ size: n * 4 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        const ppBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
        device.queue.writeBuffer(ppBuf, 0, new Float32Array([c.scale, c.half, 0, 0]))
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
        enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, n * 4 * 4)
        device.queue.submit([enc.finish()])
        await readBuf.mapAsync(GPUMapMode.READ)
        out[c.label] = Array.from(new Float32Array(readBuf.getMappedRange().slice(0)))
        readBuf.unmap()
      }
      return { out, errors }
    }, { wgsl: COMPUTE_WGSL, cases: cases.map(c => ({ label: c.label, half: c.half, scale: c.scale, inU32: Array.from(c.inU32) })) })

    expect(gpu, `GPU compute failed: ${'error' in gpu ? gpu.error : ''}`).not.toHaveProperty('error')
    if ('error' in gpu) return
    expect(gpu.errors, `uncaptured GPU errors: ${gpu.errors.join(' | ')}`).toEqual([])

    // Compare GPU f32 dequant against the CPU fround mirror. Exact equality is
    // expected modulo fma fusion; tolerance = a few ULP relative + tiny floor.
    const failures: string[] = []
    let worstRel = 0
    let compared = 0
    for (const c of cases) {
      const flat = gpu.out[c.label]
      const quant = { vertices: c.verts, dequantScale: c.scale, dequantHalf: c.half }
      for (let i = 0; i < N; i++) {
        const [cx, cy, cz] = dequantVertexF32(quant, i)
        const gx = flat[i * 4], gy = flat[i * 4 + 1], gz = flat[i * 4 + 2]
        for (const [g, cpu, axis] of [[gx, cx, 'x'], [gy, cy, 'y'], [gz, cz, 'z']] as const) {
          if (!Number.isFinite(g) || !Number.isFinite(cpu)) continue
          compared++
          const d = Math.abs(g - cpu)
          const tol = Math.abs(cpu) * 4e-6 + 1e-3  // ~few ULP at f32 + 1mm floor
          const rel = d / (Math.abs(cpu) + 1e-9)
          if (rel > worstRel) worstRel = rel
          if (d > tol) {
            failures.push(`${c.label} v${i}.${axis}: GPU=${g} CPU=${cpu} Δ=${d.toExponential(3)} (tol ${tol.toExponential(3)})`)
          }
        }
      }
    }
    console.log(`[dequant parity] worst relative GPU-vs-CPU-fround delta: ${worstRel.toExponential(4)} (${SOFTWARE_GPU ? 'software' : 'hardware'} GPU), ${compared} axes compared`)
    expect(compared, 'no finite pairs compared — kernel produced no output').toBeGreaterThan(20000)
    expect(failures, `GPU dequant_ecef drifted from the CPU fround mirror:\n${failures.slice(0, 15).join('\n')}`).toEqual([])
  })
})
