import { test, expect } from '@playwright/test'
import {
  PROJECTION_WGSL_CONSTS,
  PROJECTION_WGSL_FNS,
} from '../../runtime/src/engine/shader-dsl/shaders/projections'

// ═══ Flat Mercator display FLATNESS gate (minimal render → texture) ═══
//
// projection-display-layer-restore: flat Mercator (projType 0) must render a
// FLAT 2D plane, not a globe. The vertex shaders reproject per vertex:
//   clip = mvp_flat * vec4(project(lon, lat, proj_params) − cam_merc, 0, 1)
// where mvp_flat = Camera.getViewForProjection(0, …) is the flat 2D-plane MVP.
//
// This compiles the EXACT projection WGSL (PROJECTION_WGSL_FNS, the same block
// prepended into polygon/line/point/raster) + the flat-clip math on SwiftShader
// and renders one marker per test point into an offscreen texture. The points
// share a latitude but span longitude. On a FLAT map they land at the SAME
// screen-Y; a globe would curve them. It also proves `project()` compiles in
// the real GPU pipeline. (Mirror of _ecef-render-position.spec.ts.)

const A = 6378137
const DEG2RAD = Math.PI / 180
function merc(lonDeg: number, latDeg: number): [number, number] {
  return [lonDeg * DEG2RAD * A, Math.log(Math.tan(Math.PI / 4 + latDeg * DEG2RAD / 2)) * A]
}

test('flat Mercator: same-latitude points render at the same screen-Y', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as any).__xgisReady === true, { timeout: 20_000 })

  // Camera at lon 0, lat 20, low zoom (so ±20° longitude is on-screen), top-down.
  const setup = await page.evaluate(() => {
    const cam = (window as any).__xgisMap.camera
    cam.centerX = 0
    const EARTH_R = 6378137
    cam.centerY = Math.log(Math.tan(Math.PI / 4 + 20 * (Math.PI / 180) / 2)) * EARTH_R
    cam.zoom = 2; cam.bearing = 0; cam.pitch = 0; cam.globeMode = false
    const frame = cam.getViewForProjection(0, 512, 512, 1)
    return { mvp: Array.from(frame.matrix as Float32Array), camX: cam.centerX, camY: cam.centerY }
  })

  const LAT = 20
  const LONS = [-20, 0, 20]

  const out = await page.evaluate(async (args: {
    consts: string; fns: string; mvp: number[]; camX: number; camY: number; lons: number[]; lat: number
  }) => {
    const adapter = await (navigator as any).gpu.requestAdapter()
    const device = await adapter.requestDevice()
    const W = 512, H = 512
    // A unit quad (6 verts) expanded a few pixels in screen-space around the anchor.
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1])
    const vbuf = device.createBuffer({ size: quad.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(vbuf, 0, quad)

    const code = `
      ${args.consts}
      ${args.fns}
      struct U {
        mvp: mat4x4<f32>, proj_params: vec4<f32>,
        cam: vec2<f32>, anchor: vec2<f32>,
      }
      @group(0) @binding(0) var<uniform> u: U;
      @vertex fn vs(@location(0) corner: vec2<f32>) -> @builtin(position) vec4<f32> {
        let p2d = project(u.anchor.x, u.anchor.y, u.proj_params);
        let rel = p2d - u.cam;
        var clip = u.mvp * vec4<f32>(rel.x, rel.y, 0.0, 1.0);
        clip = clip + vec4<f32>(corner * 0.025 * clip.w, 0.0, 0.0);
        return clip;
      }
      @fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }`
    const mod = device.createShaderModule({ code })
    const info = await mod.getCompilationInfo()
    const err = info.messages.filter((m: any) => m.type === 'error')
    if (err.length) throw new Error('compile: ' + err.map((m: any) => m.message).join('|'))
    const pipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs', buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }] },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })

    async function draw(anchorLon: number, anchorLat: number): Promise<{ cx: number; cy: number; count: number }> {
      const uarr = new Float32Array(24)
      uarr.set(args.mvp, 0)
      uarr[16] = 0; uarr[17] = 0; uarr[18] = 0; uarr[19] = 0  // proj_params (projType 0)
      uarr[20] = args.camX; uarr[21] = args.camY               // cam (Mercator)
      uarr[22] = anchorLon; uarr[23] = anchorLat               // anchor (lon, lat deg)
      const ubuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
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
      let sx = 0, sy = 0, count = 0
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (d[y * bpr + x * 4]! > 128) { sx += x; sy += y; count++ }
      }
      return { cx: count ? sx / count : -1, cy: count ? sy / count : -1, count }
    }

    const pts: { cx: number; cy: number; count: number }[] = []
    for (const lon of args.lons) pts.push(await draw(lon, args.lat))
    return pts
  }, { consts: PROJECTION_WGSL_CONSTS, fns: PROJECTION_WGSL_FNS, mvp: setup.mvp, camX: setup.camX, camY: setup.camY, lons: LONS, lat: LAT })

  for (let i = 0; i < LONS.length; i++) {
    console.log(`[flat-flatness] lon=${LONS[i]} → cx=${out[i]!.cx.toFixed(1)} cy=${out[i]!.cy.toFixed(1)} count=${out[i]!.count}`)
    expect(out[i]!.count, `lon ${LONS[i]} drew nothing`).toBeGreaterThan(10)
  }

  const ys = out.map(p => p.cy)
  const xs = out.map(p => p.cx)
  // FLATNESS: same latitude → same screen-Y. A globe would curve them by tens
  // of pixels; the flat plane keeps them within rasterization noise.
  const ySpread = Math.max(...ys) - Math.min(...ys)
  expect(ySpread, 'same-latitude points must share screen-Y (flat, not globe)').toBeLessThan(3)
  // The points span longitude → screen-X spreads, and the far points do NOT
  // collapse toward the centre (a horizon-collapse would bunch them).
  expect(xs[0]! < xs[1]! && xs[1]! < xs[2]!, 'screen-X must increase with longitude').toBe(true)
  expect(Math.abs(xs[2]! - xs[0]!), 'longitude span must produce real screen-X separation').toBeGreaterThan(80)
})
