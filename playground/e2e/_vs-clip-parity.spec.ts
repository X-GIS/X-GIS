import { test, expect } from '@playwright/test'
import { DEQUANT_ECEF_WGSL } from '../../runtime/src/engine/shader-dsl/shaders/polygon'
import { dequantVertexF32, mulMat4Vec4F32, POLYGON_FILL_FORMAT } from '@xgis/compiler'

// ═══ vs_main_ecef clip-space parity: GPU f32 (dequant→MVP→clip) ≡ CPU fround ═══
//
// Extends the dequant parity (_dequant-parity) by one step: the full COORDINATE
// CORE of vs_main_ecef — `clip = mvp * vec4(dequant_ecef(q), 1)` (polygon.ts).
// This is where projection lives: the CPU camera (getECEFFrameView) bakes each
// projection into the mvp, and the vertex shader just applies `mvp * pos`. So
// proving the GPU's mvp-application f32 matches the CPU mirror is the second of
// the two projection-accuracy axes (the first — that getECEFFrameView builds
// the CORRECT mvp per projection — is the lon/lat→clip oracle, a follow-up).
//
// Runs in a compute pass (no rasterization), reusing the shared dequant_ecef
// DSL fn + the WGSL `*` operator the real VS uses. CPU side: dequantVertexF32
// → mulMat4Vec4F32 (same fround model). Unlike the single-mul dequant (bit-
// exact), the 4-term mat4 row may fma-fuse on hardware, so tolerance is a few
// ULP relative + a small floor.

const SOFTWARE_GPU = process.env.XGIS_SOFTWARE_GPU === '1'

// Per-tile dequant ranges (z0 coarse → z22 fine), as in _dequant-parity.
const HALVES = [1.0e7, 4.0e4, 3.0e2, 2.0e0]

// MVP cases (column-major, m[c*4+r]). Identity, a scale+translate, and a
// perspective-ish frustum row to exercise the w channel + mixed magnitudes.
const MVPS: ReadonlyArray<{ label: string; m: number[] }> = [
  { label: 'identity', m: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] },
  { label: 'scale+xlate', m: [3e-7,0,0,0, 0,3e-7,0,0, 0,0,3e-7,0, 0.1,-0.2,0.3,1] },
  { label: 'perspective', m: [1.2,0,0,0, 0,1.6,0,0, 0,0,-1.0002,-1, 0,0,-0.2,0] },
]

const N = 1500  // vertices per (half × mvp) cell

function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x1_0000_0000 }
}

const COMPUTE_WGSL = `
${DEQUANT_ECEF_WGSL}
// params.x = dequant scale, params.y = half. Scalars are packed into a vec4
// (not loose f32 fields) — std140 uniform alignment puts loose f32 members on
// 16-byte boundaries in some drivers (SwiftShader read u.half as NaN when they
// were separate fields). The renderer's real Uniforms struct does the same.
struct U { params: vec4<f32>, mvp: mat4x4<f32> }
@group(0) @binding(0) var<storage, read> inp: array<u32>;        // 6 u32 per vertex
@group(0) @binding(1) var<storage, read_write> outp: array<vec4<f32>>; // clip
@group(0) @binding(2) var<uniform> u: U;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i * 6u + 5u >= arrayLength(&inp)) { return; }
  let b = i * 6u;
  let q_xy = vec4<u32>(inp[b], inp[b + 1u], inp[b + 2u], inp[b + 3u]);
  let q_z = vec2<u32>(inp[b + 4u], inp[b + 5u]);
  let rtc = dequant_ecef(q_xy, q_z, u.params.x, u.params.y);
  outp[i] = u.mvp * vec4<f32>(rtc, 1.0);
}
`

test.describe('vs_main_ecef clip parity (GPU dequant→MVP ≡ CPU fround)', () => {
  test('GPU clip-space matches the CPU fround mirror across z-range × MVPs', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    // Build cells: each (half, mvp) pair with random u16 position lanes.
    const cells = []
    let seed = 0xC10
    for (const half of HALVES) {
      const scale = (2 * half) / 0xFFFFFFFF
      for (const mvp of MVPS) {
        const rng = makeRng(seed++)
        // Stride from the SINGLE-SOURCE polygon fill format (stride 28 = 14 u16;
        // position is lanes 0..5 + f32 tail) so the synthetic buffer strides
        // EXACTLY like dequantVertexF32 reads it. Hardcoding 12 u16 drifted when
        // the stride grew 24→28 — the cause of the red dequant/clip render-gate.
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
        cells.push({ label: `h${half}/${mvp.label}`, half, scale, mvp: mvp.m, verts, inU32 })
      }
    }

    const gpu = await page.evaluate(async (args: {
      wgsl: string
      cells: Array<{ label: string; scale: number; half: number; mvp: number[]; inU32: number[] }>
    }) => {
      const nav = navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }
      if (!nav.gpu) return { error: 'no navigator.gpu' as const }
      const adapter = await (nav.gpu.requestAdapter() as Promise<GPUAdapter | null>)
      if (!adapter) return { error: 'no adapter' as const }
      const device = await adapter.requestDevice()
      const errors: string[] = []
      device.addEventListener('uncapturederror', (e) => { errors.push((e as GPUUncapturedErrorEvent).error.message) })

      const module = device.createShaderModule({ code: args.wgsl })
      const info = await module.getCompilationInfo()
      const fatals = info.messages.filter(m => m.type === 'error')
      if (fatals.length > 0) return { error: 'compile: ' + fatals.map(m => `${m.lineNum}:${m.message}`).join(' | ') }
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } })

      const out: Record<string, number[]> = {}
      for (const c of args.cells) {
        const n = c.inU32.length / 6
        const inData = new Uint32Array(c.inU32)
        const inBuf = device.createBuffer({ size: inData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
        device.queue.writeBuffer(inBuf, 0, inData)
        const outBuf = device.createBuffer({ size: n * 4 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
        const readBuf = device.createBuffer({ size: n * 4 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        // Uniform: vec4(scale,half,_,_) + mat4 = 16 + 64 = 80 bytes.
        const uData = new Float32Array(20)
        uData[0] = c.scale; uData[1] = c.half
        for (let k = 0; k < 16; k++) uData[4 + k] = c.mvp[k]
        const uBuf = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
        device.queue.writeBuffer(uBuf, 0, uData)
        const bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: inBuf } },
            { binding: 1, resource: { buffer: outBuf } },
            { binding: 2, resource: { buffer: uBuf } },
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
    }, { wgsl: COMPUTE_WGSL, cells: cells.map(c => ({ label: c.label, scale: c.scale, half: c.half, mvp: c.mvp, inU32: Array.from(c.inU32) })) })

    expect(gpu, `GPU compute failed: ${'error' in gpu ? gpu.error : ''}`).not.toHaveProperty('error')
    if ('error' in gpu) return
    expect(gpu.errors, `uncaptured GPU errors: ${gpu.errors.join(' | ')}`).toEqual([])

    const failures: string[] = []
    let worstRel = 0
    let compared = 0
    for (const c of cells) {
      const flat = gpu.out[c.label]
      const quant = { vertices: c.verts, dequantScale: c.scale, dequantHalf: c.half }
      for (let i = 0; i < N; i++) {
        const [rx, ry, rz] = dequantVertexF32(quant, i)
        const cpu = mulMat4Vec4F32(c.mvp, [rx, ry, rz, 1])
        for (let comp = 0; comp < 4; comp++) {
          const g = flat[i * 4 + comp], cv = cpu[comp]
          if (!Number.isFinite(g) || !Number.isFinite(cv)) continue
          compared++
          const d = Math.abs(g - cv)
          const tol = Math.abs(cv) * 8e-6 + 1e-4  // few ULP (fma headroom) + floor
          const rel = d / (Math.abs(cv) + 1e-9)
          if (rel > worstRel) worstRel = rel
          if (d > tol) {
            failures.push(`${c.label} v${i}[${'xyzw'[comp]}]: GPU=${g} CPU=${cv} Δ=${d.toExponential(3)} (tol ${tol.toExponential(3)})`)
          }
        }
      }
    }
    console.log(`[clip parity] worst relative GPU-vs-CPU-fround delta: ${worstRel.toExponential(4)} (${SOFTWARE_GPU ? 'software' : 'hardware'} GPU), ${compared} components`)
    expect(compared, 'no finite pairs compared').toBeGreaterThan(50000)
    expect(failures, `GPU dequant→MVP→clip drifted from the CPU fround mirror:\n${failures.slice(0, 15).join('\n')}`).toEqual([])
  })
})
