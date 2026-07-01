import { test, expect } from '@playwright/test'
import { DEQUANT_ECEF_WGSL } from '@xgis/map'
import { generateWallMeshExtrudedECEF } from '@xgis/map'
import { lonLatToECEF } from '../../engine/src/projection/ecef'
import { dequantVertexF32, mulMat4Vec4F32, type QuantizedDecode } from '@xgis/compiler'
import type { RingPolygon } from '@xgis/compiler'

// ═══ globe(7) EXTRUDED VERTEX-POSITION gate — REAL-GPU render → texture ═══
//
// HARDWARE / PRE-PUSH GATE — NOT a GitHub-CI render-gate. Like its sibling
// _ecef-render-position.spec.ts, this drives a real WebGPU render pipeline and
// reads the rendered texture back. On the GitHub-CI runner (no GPU →
// SwiftShader) `createRenderPipeline` of a real vertex shader times out, so this
// spec only runs green on a machine with a hardware GPU (the playground default:
// HEADED, system D3D/Vulkan adapter, NO XGIS_SOFTWARE_GPU). Run it before push.
//
// WHAT IT PROVES — the GPU-render counterpart to G7
// (extruded-globe-recenter.test.ts, a CPU sim). #198 fixed the extruded-globe
// collapse: the 3D (else) arm of emitPolygonProjectionLadder now recentres the
// dequantized `ecef_rtc` by `cam_ecef_off_h + cam_ecef_off_l`
// (= tileEcefCenter − cameraCenter), so an extruded tile FAR from the camera
// lands at its TRUE screen position on projType 7 (globe) pitch>0 instead of
// collapsing onto the camera-origin tile. G7 is a CPU mirror of that arm; this
// spec closes G7's mirror-drift blind spot by executing the REAL emitted WGSL
// (the shared `dequant_ecef` fn that vs_main_ecef_extruded actually calls, plus
// the +cam_ecef_off recentre that #198 added) on real hardware.
//
// MINIMAL-PIPELINE FALLBACK (as in _ecef-render-position): rather than wire a
// full extruded tile through the production renderer, we drive a tiny pipeline
// with the REAL `DEQUANT_ECEF_WGSL` + the exact else-arm body
// (`ecef_cam = dequant_ecef(...) + cam_ecef_off_h + cam_ecef_off_l;
//   clip = mvp * vec4(ecef_cam, 1)`) and a vertex buffer of GENUINE production
// bytes (generateWallMeshExtrudedECEF's quantized output). The 3D arm applies
// NO per-vertex z-lift — the wall-mesh pre-lifts roof vertices into ECEF — so
// the else arm is identical for fill and extruded, and this minimal VS is a
// faithful execution of the production extruded 3D path. Two draws compare
// CURRENT (bare ecef_rtc, the bug) vs FIX (+ cam_ecef_off, #198).
//
// THE ORACLE — same chain the fixed shader uses, via the production mirrors the
// compute-parity harness validates against the real GPU:
//   dequantVertexF32 (GPU dequant_ecef f32 semantics) → + cam_ecef_off (hi+lo)
//   → Camera.getECEFFrameView(globe, projType7, pitch55) MVP → NDC → pixel.
// FIX must match the FIXED oracle within a few px; CURRENT (and the BUGGY
// oracle) land far away — the collapse signature.

const DEG2RAD = Math.PI / 180
const A = 6378137
const W = 512
const H = 512

// The extruded tile (mid-Atlantic, TILE_WEST/TILE_SOUTH); the camera sits a
// continent away (10° east) at low zoom so the FAR tile is still inside the
// visible globe disc AND ~1.09 Mm (> 1000 km) of ECEF separation makes the
// collapse-to-camera-origin error unmistakable on a 512² viewport. Tuned via a
// projection probe: at z3 / pitch55 / 10° offset the FIXED (true) centroid lands
// at ≈(175,243) — on-screen — while the BUGGY (collapsed) path sits ≈113 px away
// near viewport-centre. A higher zoom (z14, as in the G7 CPU sim) would push the
// FAR tile entirely off the canvas — fine for a clip-space CPU test, but a RENDER
// test needs the true geometry to actually paint, so we render at globe-disc zoom.
const TILE_WEST = -30.0
const TILE_SOUTH = 10.0
const CAM_LON = TILE_WEST + 10   // −20°: a continent east of the tile
const CAM_LAT = TILE_SOUTH       // same parallel as the tile
const ZOOM = 3
const PITCH = 55
const BEARING = 0
const HEIGHT_M = 60_000   // exaggerated extrusion so the walls paint at z3

// A LARGE ~4°-wide synthetic footprint near the tile SW corner, in ABSOLUTE
// Mercator metres (the ring convention generateWallMeshExtrudedECEF consumes).
// A real ~100 m building is a sub-pixel speck at z3 (the whole globe is ~512 px)
// and paints zero fragments — useless for a render readback. We blow the
// footprint up to several degrees so it covers tens of pixels; its true ECEF
// location (and thus the recentre + collapse signature) is unaffected by the
// size — only whether it paints visibly.
const FOOT_DEG = 4
const buildingLonLat: Array<[number, number]> = [
  [TILE_WEST + 0.5, TILE_SOUTH + 0.5],
  [TILE_WEST + 0.5 + FOOT_DEG, TILE_SOUTH + 0.5],
  [TILE_WEST + 0.5 + FOOT_DEG, TILE_SOUTH + 0.5 + FOOT_DEG],
  [TILE_WEST + 0.5, TILE_SOUTH + 0.5 + FOOT_DEG],
]

// Ellipsoid tileEcefCenter — mirrors vector-tile-renderer.ts (the tile corner
// via lonLatToECEF, height 0), the frame generateWallMeshExtrudedECEF RTCs in.
function tileEcefCenterFor(westDeg: number, southDeg: number): [number, number, number] {
  const e = lonLatToECEF(westDeg, southDeg, 0)
  return [e[0], e[1], e[2]]
}

// Production extruded mesh for the far tile (G7's buildMesh, verbatim).
function buildMesh(): {
  mesh: ReturnType<typeof generateWallMeshExtrudedECEF>
  tileEcefCenter: [number, number, number]
} {
  const ring: Array<[number, number]> = buildingLonLat.map(([lon, lat]) => [
    lon * DEG2RAD * A,                                              // abs Mercator x
    A * Math.log(Math.tan(Math.PI / 4 + lat * DEG2RAD / 2)),       // abs Mercator y
  ])
  const polygons: RingPolygon[] = [{ featId: 1, rings: [ring] }]
  const heights = new Map<number, number>([[1, HEIGHT_M]])
  const tileEcefCenter = tileEcefCenterFor(TILE_WEST, TILE_SOUTH)
  const tileMx = TILE_WEST * DEG2RAD * A
  const tileMy = A * Math.log(Math.tan(Math.PI / 4 + TILE_SOUTH * DEG2RAD / 2))
  const mesh = generateWallMeshExtrudedECEF(polygons, heights, undefined, tileMx, tileMy, tileEcefCenter)
  return { mesh, tileEcefCenter }
}

// dequantVertexF32 hardcodes the stride-24 FILL layout (u16 lane = vi*12). The
// EXTRUDED mesh is stride-44 (11 floats = 22 u16 lanes/vertex) with the SAME
// q_xy/q_z position in its first 12 bytes. Slice this vertex's 6 position u16
// lanes into a fresh stride-24-shaped buffer and run the production f32 dequant
// on lane index 0 — reuses the exact GPU-validated fround mirror on the correct
// lanes (the GPU reads them itself via arrayStride 44; this matches it).
const EXT_STRIDE_FLOATS = 11
function dequantExtruded(mesh: { vertices: Float32Array; dequantScale: number; dequantHalf: number }, vi: number): [number, number, number] {
  const srcU16 = new Uint16Array(mesh.vertices.buffer, mesh.vertices.byteOffset)
  const base = vi * EXT_STRIDE_FLOATS * 2   // 22 u16 lanes per vertex; pos = first 6
  // stride-24 fill view: 12 u16 lanes (6 position + 6 zero tail) so vi=0 hits pos.
  const fill = new Float32Array(6)
  const fillU16 = new Uint16Array(fill.buffer)
  for (let k = 0; k < 6; k++) fillU16[k] = srcU16[base + k]!
  const quant: QuantizedDecode = { vertices: fill, dequantScale: mesh.dequantScale, dequantHalf: mesh.dequantHalf }
  return dequantVertexF32(quant, 0)
}

// Clip → pixel (NDC → viewport). Y flips (NDC +y up → pixel +y down).
function clipToPx(clip: [number, number, number, number]): [number, number] {
  const x = (clip[0] / clip[3] * 0.5 + 0.5) * W
  const y = (1 - (clip[1] / clip[3] * 0.5 + 0.5)) * H
  return [x, y]
}

test('globe(7) EXTRUDED mesh lands at its true screen position (cam_ecef_off recentre)', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as any).__xgisReady === true, { timeout: 20_000 })

  // Live camera → globe / projType 7 / pitch 55. Return the production ECEF-MVP
  // + the sphere camera-anchor (getECEFCenter), exactly the chain the fixed
  // shader's else arm runs against.
  const setup = await page.evaluate((args: { lon: number; lat: number; zoom: number; pitch: number; bearing: number; w: number; h: number }) => {
    const m = (window as any).__xgisMap
    const cam = m.camera
    cam.centerX = args.lon * Math.PI / 180 * 6378137
    cam.centerY = 6378137 * Math.log(Math.tan(Math.PI / 4 + args.lat * Math.PI / 180 / 2))
    cam.zoom = args.zoom
    cam.pitch = args.pitch
    cam.bearing = args.bearing
    cam.globeMode = true
    cam.projType = 7
    const frame = cam.getECEFFrameView(args.w, args.h, 1)
    const c = cam.getECEFCenter()
    return { mvp: Array.from(frame.matrix) as number[], cameraCenter: [c[0], c[1], c[2]] as number[] }
  }, { lon: CAM_LON, lat: CAM_LAT, zoom: ZOOM, pitch: PITCH, bearing: BEARING, w: W, h: H })

  const { mesh, tileEcefCenter } = buildMesh()
  const cameraCenter = setup.cameraCenter
  const mvp = setup.mvp
  const vertCount = mesh.vertices.length / EXT_STRIDE_FLOATS
  expect(vertCount).toBeGreaterThan(0)

  // cam_ecef_off = tileEcefCenter − cameraCenter, DSFUN-split hi/lo exactly as
  // the uniform writer (vtr.ts:4887-4889) and G7 do.
  const offX = tileEcefCenter[0] - cameraCenter[0]
  const offY = tileEcefCenter[1] - cameraCenter[1]
  const offZ = tileEcefCenter[2] - cameraCenter[2]
  const offMag = Math.hypot(offX, offY, offZ)
  expect(offMag, 'far tile: > 1000 km ECEF separation from camera').toBeGreaterThan(1_000_000)
  const offH: [number, number, number] = [Math.fround(offX), Math.fround(offY), Math.fround(offZ)]
  const offL: [number, number, number] = [
    Math.fround(offX - offH[0]), Math.fround(offY - offH[1]), Math.fround(offZ - offH[2]),
  ]

  // CPU oracle (production mirrors): per-vertex FIXED + BUGGY screen pixels.
  // FIXED  = mvp · (dequant + off_h + off_l)   ← matches #198 shader
  // BUGGY  = mvp · dequant                      ← the pre-#198 collapse
  // Centroid of FIXED is the painted-region target; centroid of BUGGY is the
  // collapse signature the painted result must be FAR from.
  let fSumX = 0, fSumY = 0, fN = 0
  let bSumX = 0, bSumY = 0, bN = 0
  for (let vi = 0; vi < vertCount; vi++) {
    const rtc = dequantExtruded(mesh, vi)
    const ecefCam: [number, number, number] = [
      Math.fround(Math.fround(rtc[0] + offH[0]) + offL[0]),
      Math.fround(Math.fround(rtc[1] + offH[1]) + offL[1]),
      Math.fround(Math.fround(rtc[2] + offH[2]) + offL[2]),
    ]
    const fClip = mulMat4Vec4F32(mvp, [ecefCam[0], ecefCam[1], ecefCam[2], 1])
    if (fClip[3] > 0) { const [px, py] = clipToPx(fClip); fSumX += px; fSumY += py; fN++ }
    const bClip = mulMat4Vec4F32(mvp, [rtc[0], rtc[1], rtc[2], 1])
    if (bClip[3] > 0) { const [px, py] = clipToPx(bClip); bSumX += px; bSumY += py; bN++ }
  }
  expect(fN, 'FIXED oracle: no vertex projects in front of the camera').toBeGreaterThan(0)
  const fixedCx = fSumX / fN, fixedCy = fSumY / fN
  const buggyCx = bN > 0 ? bSumX / bN : NaN, buggyCy = bN > 0 ? bSumY / bN : NaN
  // Non-vacuity guard: the geometry is tuned (offMag > 1 Mm) so the un-recentred
  // bare path collapses to a wrong spot IN FRONT of the camera. If it instead all
  // fell behind (buggyCx = NaN), the fixToBuggy > 60 guard below would pass
  // vacuously — assert the collapse actually paints a finite wrong position.
  expect(Number.isFinite(buggyCx), 'BUGGY oracle vacuous: bare-ecef collapse projected entirely behind the camera').toBe(true)

  // GPU render: real DEQUANT_ECEF_WGSL + the exact else-arm recentre. Two draws
  // (CURRENT bare vs FIX +cam_ecef_off). Vertex buffer = genuine mesh bytes;
  // arrayStride 44 (POLYGON_EXTRUDED_FORMAT), q_xy uint16x4 @0 + q_z uint16x2 @8.
  const out = await page.evaluate(async (a: {
    dequantWgsl: string; verts: number[]; mvp: number[]; scale: number; half: number
    offH: number[]; offL: number[]; w: number; h: number
  }) => {
    const adapter = await (navigator as any).gpu.requestAdapter()
    if (!adapter) throw new Error('no WebGPU adapter (hardware GPU required — do NOT run under SwiftShader)')
    const device = await adapter.requestDevice()
    const u8 = new Uint8Array(a.verts)
    const vbuf = device.createBuffer({ size: u8.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(vbuf, 0, u8)
    const vertN = u8.byteLength / 44

    async function draw(recentre: boolean): Promise<{ cx: number; cy: number; count: number }> {
      const code = `
        ${a.dequantWgsl}
        struct U {
          mvp: mat4x4<f32>,
          scale: f32, half: f32, _p0: f32, _p1: f32,
          offh: vec4<f32>,
          offl: vec4<f32>,
        }
        @group(0) @binding(0) var<uniform> u: U;
        @vertex fn vs(@location(0) q_xy: vec4<u32>, @location(1) q_z: vec2<u32>) -> @builtin(position) vec4<f32> {
          var ecef = dequant_ecef(q_xy, q_z, u.scale, u.half);
          ${recentre
            ? 'ecef = ecef + vec3<f32>(u.offh.x, u.offh.y, u.offh.z) + vec3<f32>(u.offl.x, u.offl.y, u.offl.z);'
            : ''}
          return u.mvp * vec4<f32>(ecef, 1.0);
        }
        @fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }`
      const mod = device.createShaderModule({ code })
      const info = await mod.getCompilationInfo()
      const errs = info.messages.filter((mm) => mm.type === 'error')
      if (errs.length) throw new Error('compile: ' + errs.map((mm) => mm.message).join('|'))
      const pipe = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: mod, entryPoint: 'vs',
          buffers: [{ arrayStride: 44, attributes: [
            { shaderLocation: 0, offset: 0, format: 'uint16x4' },
            { shaderLocation: 1, offset: 8, format: 'uint16x2' },
          ] }],
        },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      })
      // U layout: mat4 (64) + 4 f32 (16) + vec4 (16) + vec4 (16) = 112 bytes.
      const uarr = new Float32Array(28)
      uarr.set(a.mvp, 0)
      uarr[16] = a.scale; uarr[17] = a.half
      uarr.set(a.offH, 20)   // offh at float 20 (byte 80)
      uarr.set(a.offL, 24)   // offl at float 24 (byte 96)
      const ubuf = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(ubuf, 0, uarr)
      const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] })
      const tex = device.createTexture({ size: [a.w, a.h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
      const enc = device.createCommandEncoder()
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] })
      pass.setPipeline(pipe); pass.setBindGroup(0, bind); pass.setVertexBuffer(0, vbuf); pass.draw(vertN); pass.end()
      const bpr = Math.ceil(a.w * 4 / 256) * 256
      const rbuf = device.createBuffer({ size: bpr * a.h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      enc.copyTextureToBuffer({ texture: tex }, { buffer: rbuf, bytesPerRow: bpr }, [a.w, a.h])
      device.queue.submit([enc.finish()])
      await rbuf.mapAsync(GPUMapMode.READ)
      const d = new Uint8Array(rbuf.getMappedRange().slice(0)); rbuf.unmap()
      let sx = 0, sy = 0, count = 0
      for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
        if (d[y * bpr + x * 4]! > 128) { count++; sx += x; sy += y }
      }
      return { cx: count ? sx / count : NaN, cy: count ? sy / count : NaN, count }
    }
    return { current: await draw(false), fix: await draw(true) }
  }, {
    dequantWgsl: DEQUANT_ECEF_WGSL,
    verts: Array.from(new Uint8Array(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength)),
    mvp, scale: mesh.dequantScale, half: mesh.dequantHalf,
    offH, offL, w: W, h: H,
  })

  const fixErr = Math.hypot(out.fix.cx - fixedCx, out.fix.cy - fixedCy)
  const fixToBuggy = Number.isFinite(buggyCx) ? Math.hypot(out.fix.cx - buggyCx, out.fix.cy - buggyCy) : Infinity
  // eslint-disable-next-line no-console
  console.log('[globe-ecef-render] oracle FIXED centroid =', fixedCx.toFixed(1), fixedCy.toFixed(1),
    '| oracle BUGGY centroid =', Number.isFinite(buggyCx) ? `${buggyCx.toFixed(1)},${buggyCy.toFixed(1)}` : 'behind-camera (w<=0)')
  // eslint-disable-next-line no-console
  console.log('[globe-ecef-render] GPU FIX painted =', JSON.stringify(out.fix), '| CURRENT painted =', JSON.stringify(out.current))
  // eslint-disable-next-line no-console
  console.log('[globe-ecef-render] FIX→fixedOracle err =', fixErr.toFixed(2), 'px | FIX→buggyOracle dist =', Number.isFinite(fixToBuggy) ? fixToBuggy.toFixed(2) : 'inf', 'px')

  // 1) FIX actually painted on-screen.
  expect(out.fix.count, 'FIX drew nothing — far extruded tile must land on-screen on globe(7) pitch55').toBeGreaterThan(10)
  // 2) Painted centroid matches the FIXED CPU oracle (real dequant_ecef +
  //    cam_ecef_off + production MVP) within rasterization tolerance.
  expect(fixErr, 'GPU FIX centroid must match the fixed (recentred) CPU oracle').toBeLessThan(12)
  // 3) Collapse-guard: the painted result is FAR from where the un-recentred
  //    (bare-ecef_rtc) path would land — proving the recentre is load-bearing,
  //    not a no-op. If the bug were live the centroid would sit at the buggy spot.
  expect(fixToBuggy, 'GPU FIX must be far from the buggy (collapsed) oracle').toBeGreaterThan(60)
  // 4) The CURRENT (bare) GPU draw — when it paints at all — sits far from the
  //    fixed oracle (the collapse signature, mirrored on real hardware). If the
  //    bare path is entirely off-screen (collapsed behind the camera / clipped),
  //    count==0 is itself the collapse — accept either.
  if (out.current.count > 10) {
    const curErr = Math.hypot(out.current.cx - fixedCx, out.current.cy - fixedCy)
    expect(curErr, 'CURRENT (bare ecef_rtc) must miss the true position — the collapse').toBeGreaterThan(60)
  }
})
