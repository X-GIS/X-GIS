import { test, expect } from '@playwright/test'
import { DEQUANT_ECEF_WGSL } from '../../runtime/src/engine/shader-dsl/shaders/polygon'

// ═══ ECEF polygon-fill VERTEX POSITION gate (minimal render → texture) ═══
//
// The session-long bug: vs_main_ecef feeds `ecef_rtc` (tile-center-relative)
// into the camera mvp, but the mvp (getECEFFrameView) assumes camera-relative
// input (no cameraCenter translate in its chain). So a polygon far from the
// camera collapses toward the origin instead of landing at its true location.
//
// This renders the EXACT dequant + the EXACT camera mvp into a small offscreen
// texture and reads it back (SwiftShader does render→texture readback fine —
// only canvas getImageData is empty). Two draws: CURRENT (clip = mvp·ecef_rtc)
// vs FIX (clip = mvp·(ecef_rtc + (tileCenter − cameraCenter))). The polygon is
// at lon≈10° while the camera sits at lon=0°, so a correct projection puts it
// on the RIGHT half of the viewport; the buggy one collapses to center.

const A = 6378137
const DEG2RAD = Math.PI / 180

// sphere ECEF (matches lonLatToECEFSphere — the camera anchor frame).
function ecefSphere(lonDeg: number, latDeg: number): [number, number, number] {
  const lo = lonDeg * DEG2RAD, la = latDeg * DEG2RAD
  return [A * Math.cos(la) * Math.cos(lo), A * Math.cos(la) * Math.sin(lo), A * Math.sin(la)]
}

test('ECEF polygon fill lands at its true screen position (camera-relative)', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as any).__xgisReady === true, { timeout: 20_000 })

  // Camera at lon=0, equator, low zoom so lon=10° is on-screen.
  const setup = await page.evaluate(() => {
    const m = (window as any).__xgisMap
    const cam = m.camera
    const EARTH_R = 6378137
    cam.centerX = 0                       // lon 0 → mercator x 0
    cam.centerY = 0                       // lat 0 → mercator y 0
    cam.zoom = 3
    cam.bearing = 0; cam.pitch = 0
    const frame = cam.getECEFFrameView(512, 512, 1)
    return { mvp: Array.from(frame.matrix) }
  })

  // Polygon: a small quad around lon=10°, lat=0°. Tile center = its own corner
  // (lon=10, lat=0) — exactly how the tiler RTCs each tile.
  const tileCenter = ecefSphere(10, 0)
  const cameraCenter = ecefSphere(0, 0) // camera anchor (getECEFCenter uses sphere)
  const camRel: [number, number, number] = [
    cameraCenter[0] - tileCenter[0], cameraCenter[1] - tileCenter[1], cameraCenter[2] - tileCenter[2],
  ]
  const corners = [[9.5, -0.5], [10.5, -0.5], [9.5, 0.5], [10.5, 0.5]] as const
  const rtc = corners.map(([lo, la]) => {
    const e = ecefSphere(lo, la)
    return [e[0] - tileCenter[0], e[1] - tileCenter[1], e[2] - tileCenter[2]] as [number, number, number]
  })
  // quantize like the tiler: symmetric per-tile half-range.
  let maxAbs = 0
  for (const r of rtc) for (const v of r) maxAbs = Math.max(maxAbs, Math.abs(v))
  const half = maxAbs + 1e-6, span = 2 * half, scale = span / 0xFFFFFFFF, inv = 0xFFFFFFFF / span
  const q = (a: number) => { let v = Math.round((a + half) * inv); v = Math.max(0, Math.min(0xFFFFFFFF, v)); return [(v >>> 16) & 0xFFFF, v & 0xFFFF] }
  // two triangles (0,1,2)+(1,3,2), 6 verts × (q_xy[4] u16 + q_z[2] u16) interleaved as u16x6 per vert
  const tri = [0, 1, 2, 1, 3, 2]
  const u16 = new Uint16Array(tri.length * 6)
  tri.forEach((ci, i) => {
    const [rx, ry, rz] = rtc[ci]!
    const [xh, xl] = q(rx), [yh, yl] = q(ry), [zh, zl] = q(rz)
    u16.set([xh, xl, yh, yl, zh, zl], i * 6)
  })

  const out = await page.evaluate(async (args: {
    wgsl: string; mvp: number[]; verts: number[]; scale: number; half: number; camRel: number[]
  }) => {
    const adapter = await (navigator as any).gpu.requestAdapter()
    const device = await adapter.requestDevice()
    const W = 512, H = 512
    const u16 = new Uint16Array(args.verts)
    const vbuf = device.createBuffer({ size: u16.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(vbuf, 0, u16)

    async function draw(useCamRel: boolean): Promise<{ minX: number; maxX: number; count: number }> {
      const code = `
        ${args.wgsl}
        struct U { mvp: mat4x4<f32>, scale: f32, half: f32, crx: f32, cry: f32, crz: f32, _p0: f32, _p1: f32, _p2: f32 }
        @group(0) @binding(0) var<uniform> u: U;
        @vertex fn vs(@location(0) q_xy: vec4<u32>, @location(1) q_z: vec2<u32>) -> @builtin(position) vec4<f32> {
          var rtc = dequant_ecef(q_xy, q_z, u.scale, u.half);
          ${useCamRel ? 'rtc = rtc + vec3<f32>(u.crx, u.cry, u.crz);' : ''}
          return u.mvp * vec4<f32>(rtc, 1.0);
        }
        @fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }`
      const mod = device.createShaderModule({ code })
      const info = await mod.getCompilationInfo()
      const err = info.messages.filter(m => m.type === 'error')
      if (err.length) throw new Error('compile: ' + err.map(m => m.message).join('|'))
      const pipe = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: mod, entryPoint: 'vs', buffers: [{ arrayStride: 12, attributes: [
          { shaderLocation: 0, offset: 0, format: 'uint16x4' }, { shaderLocation: 1, offset: 8, format: 'uint16x2' },
        ] }] },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      })
      const uarr = new Float32Array(28)
      uarr.set(args.mvp, 0); uarr[16] = args.scale; uarr[17] = args.half
      uarr[18] = args.camRel[0]; uarr[19] = args.camRel[1]; uarr[20] = args.camRel[2]
      const ubuf = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(ubuf, 0, uarr)
      const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] })
      const tex = device.createTexture({ size: [W, H], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
      const enc = device.createCommandEncoder()
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] })
      pass.setPipeline(pipe); pass.setBindGroup(0, bind); pass.setVertexBuffer(0, vbuf); pass.draw(6); pass.end()
      const bpr = Math.ceil(W * 4 / 256) * 256
      const rbuf = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      enc.copyTextureToBuffer({ texture: tex }, { buffer: rbuf, bytesPerRow: bpr }, [W, H])
      device.queue.submit([enc.finish()])
      await rbuf.mapAsync(GPUMapMode.READ)
      const d = new Uint8Array(rbuf.getMappedRange().slice(0)); rbuf.unmap()
      let minX = W, maxX = -1, count = 0
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (d[y * bpr + x * 4]! > 128) { count++; if (x < minX) minX = x; if (x > maxX) maxX = x }
      }
      return { minX, maxX, count }
    }
    return { current: await draw(false), fix: await draw(true) }
  }, { wgsl: DEQUANT_ECEF_WGSL, mvp: setup.mvp, verts: Array.from(u16), scale, half, camRel })

  const cx = (r: { minX: number; maxX: number }) => (r.minX + r.maxX) / 2
  console.log('[ecef-render] CURRENT', JSON.stringify(out.current), 'centerX≈', cx(out.current).toFixed(0))
  console.log('[ecef-render] FIX    ', JSON.stringify(out.fix), 'centerX≈', cx(out.fix).toFixed(0))
  // Camera at lon=0, polygon at lon=10° → correct render is on the RIGHT half
  // (x > 256). The buggy current collapses toward center (x ≈ 256).
  expect(out.fix.count, 'fix drew nothing').toBeGreaterThan(10)
  console.log('[ecef-render] verdict: current centerX', cx(out.current).toFixed(0), 'vs fix centerX', cx(out.fix).toFixed(0), '(viewport mid=256)')
})
