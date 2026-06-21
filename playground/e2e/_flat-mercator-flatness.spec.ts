import { test, expect } from '@playwright/test'
import {
  getProjectionWgslConsts,
  getProjectionWgslFns,
} from '../../runtime/src/engine/shader-dsl/shaders/projections'
import { configureProjections } from '../../runtime/src/engine/shader-dsl'
import { PROJECTIONS } from '../../runtime/src/engine/projection/projections-table'

// shader-dsl projections are host-injected — configure before any emit / cpu use.
configureProjections(PROJECTIONS)

// ═══ Flat display projection FLATNESS gate (minimal render → texture) ═══
//
// projection-display-layer-restore: flat projections (projType 0-6) render a
// FLAT 2D plane over the ECEF data, not a globe. The vertex shaders reproject
// per vertex: clip = mvp_flat * vec4(project[_geom](lon,lat) − project(clon,
// clat), 0, 1), where mvp_flat = Camera.getViewForProjection(<=6) is the flat
// Mercator-metre MVP (same for all flat projTypes) and the camera centre is
// computed in-shader from proj_params.y/z.
//
// This compiles the EXACT projection WGSL (PROJECTION_WGSL_FNS — the block
// prepended into polygon/line/point/raster) + the flat-clip math on the real
// GPU and renders one marker per test point. The cylindrical / pseudocylindrical
// flat projections (Mercator, equirectangular, natural_earth) share the
// property that points at the SAME latitude land at the SAME screen-Y (a globe
// curves them); longitude spreads screen-X without horizon-collapse. It also
// proves project()/project_geom() compile in the real pipeline. (Mirror of
// _ecef-render-position.spec.ts.)

// projType → display name (matches projections-table). Only the same-Y
// (cylindrical/pseudocylindrical) flat projections are asserted here; the
// azimuthal discs (3-5) are flat but not same-Y, and oblique (6) is rotated.
const SAME_Y_PROJ = [
  { projType: 0, name: 'mercator' },
  { projType: 1, name: 'equirectangular' },
  { projType: 2, name: 'natural_earth' },
]
const LAT = 20
const LONS = [-20, 0, 20]

test('flat display: same-latitude points share screen-Y (mercator / equirect / natural_earth)', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as any).__xgisReady === true, { timeout: 20_000 })

  // Camera at lon 0, lat 20, low zoom (so ±20° longitude is on-screen), top-down.
  // The flat MVP is the same Mercator-metre MVP for every flat projType.
  const setup = await page.evaluate(() => {
    const cam = (window as any).__xgisMap.camera
    cam.centerX = 0
    const EARTH_R = 6378137
    cam.centerY = Math.log(Math.tan(Math.PI / 4 + 20 * (Math.PI / 180) / 2)) * EARTH_R
    cam.zoom = 2; cam.bearing = 0; cam.pitch = 0; cam.globeMode = false
    const frame = cam.getViewForProjection(0, 512, 512, 1)
    return { mvp: Array.from(frame.matrix as Float32Array) }
  })

  const out = await page.evaluate(async (args: {
    consts: string; fns: string; mvp: number[]; projTypes: number[]; lons: number[]; lat: number
  }) => {
    const adapter = await (navigator as any).gpu.requestAdapter()
    const device = await adapter.requestDevice()
    const W = 512, H = 512
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1])
    const vbuf = device.createBuffer({ size: quad.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(vbuf, 0, quad)

    const code = `
      ${args.consts}
      ${args.fns}
      struct U { mvp: mat4x4<f32>, proj_params: vec4<f32>, anchor: vec2<f32>, _pad: vec2<f32> }
      @group(0) @binding(0) var<uniform> u: U;
      @vertex fn vs(@location(0) corner: vec2<f32>) -> @builtin(position) vec4<f32> {
        // Camera centre computed in-shader (proj_params.y/z = clon/clat) —
        // identical to the production flat shaders.
        let cam = project(u.proj_params.y, u.proj_params.z, u.proj_params);
        let p2d = project(u.anchor.x, u.anchor.y, u.proj_params);
        let rel = p2d - cam;
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

    async function draw(projType: number, anchorLon: number, anchorLat: number): Promise<{ cx: number; cy: number; count: number }> {
      const uarr = new Float32Array(24)
      uarr.set(args.mvp, 0)
      uarr[16] = projType; uarr[17] = 0; uarr[18] = 20; uarr[19] = 0 // proj_params: type, clon, clat
      uarr[20] = anchorLon; uarr[21] = anchorLat                      // anchor (lon, lat deg)
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

    const byProj: Record<number, { cx: number; cy: number; count: number }[]> = {}
    for (const pt of args.projTypes) {
      byProj[pt] = []
      for (const lon of args.lons) byProj[pt].push(await draw(pt, lon, args.lat))
    }
    return byProj
  }, { consts: getProjectionWgslConsts(), fns: getProjectionWgslFns(), mvp: setup.mvp, projTypes: SAME_Y_PROJ.map(p => p.projType), lons: LONS, lat: LAT })

  for (const { projType, name } of SAME_Y_PROJ) {
    const pts = out[projType]!
    for (let i = 0; i < LONS.length; i++) {
      console.log(`[flat-flatness] ${name} lon=${LONS[i]} → cx=${pts[i]!.cx.toFixed(1)} cy=${pts[i]!.cy.toFixed(1)} count=${pts[i]!.count}`)
      expect(pts[i]!.count, `${name} lon ${LONS[i]} drew nothing`).toBeGreaterThan(10)
    }
    const ys = pts.map(p => p.cy)
    const xs = pts.map(p => p.cx)
    // FLATNESS: same latitude → same screen-Y (a globe curves them tens of px).
    expect(Math.max(...ys) - Math.min(...ys), `${name}: same-lat points must share screen-Y`).toBeLessThan(3)
    // Longitude spreads screen-X monotonically; far points do not collapse.
    expect(xs[0]! < xs[1]! && xs[1]! < xs[2]!, `${name}: screen-X must increase with longitude`).toBe(true)
    expect(Math.abs(xs[2]! - xs[0]!), `${name}: longitude span must produce screen-X separation`).toBeGreaterThan(60)
  }
})
