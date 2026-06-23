import { test, expect } from '@playwright/test'
import { lonLatToMercF64, splitF64, packECEFPolygonVertices, tileEcefCenterFromMerc } from '@xgis/compiler'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ═══ polygon FILL flat-Mercator arm: GPU position ≡ f64 truth (the outline) ═══
//
// THE GAP THIS CLOSES. The deep-zoom "fill displaced from its outline" bug
// (OFM Bright #20.55/37.58481/126.87814, Seoul) recurred THREE times
// (#387 → #389 → #392) because the only render gates that run in CI are
// COMPUTE-pass parity checks (_vs-clip-parity / _dequant-parity), and those
// cover the ECEF/globe vertex arm only (`proj_params.x >= 0.5`). The bug lived
// in the *flat-Mercator* fill arm (`proj_params.x < 0.5`) of `vs_main_ecef`,
// which had ZERO compute-parity coverage — so a unit suite that never executes
// a shader, plus a CI with no GPU, let it ship every time.
//
// THE BUG. Pre-#392 the polygon fill's two f32 tail slots stored ABSOLUTE
// lon/lat DEGREES, and the flat arm re-projected them: `project(abs_lon,
// abs_lat)`. A single f32 holding |lon|≈127° (≈1.4e7 m once projected) has
// ~1.5 m granularity — magnified ~20 px/m at z20.55 → a visible fill/outline
// split. The outline (line VS) kept DSFUN precision and stayed put. #392 stores
// TILE-LOCAL Mercator in those slots instead (magnitude ≤ tile extent → a
// single f32 is sub-mm at every zoom), and the flat arm reads it directly:
//   vs_main_ecef:  rel2d_local = ((vec2<f32>(abs_lon, abs_lat) - cam_h) - cam_l)
// mirroring the line/outline path, so fill coincides with outline by construction.
//
// THE GATE. A standalone COMPUTE pass (SwiftShader-safe, runs in CI like
// _vs-clip-parity) runs BOTH arms on the real GPU for points inside the actual
// z14 over-zoom-parent tile at Seoul:
//   NEW = (local_merc - cam_h) - cam_l          ← the #392 fill arm, fed the
//                                                 REAL packECEFPolygonVertices
//                                                 tail slots.
//   OLD = (proj_mercator(lon,lat) - origin)     ← the pre-#392 fill arm (still
//             - cam_h - cam_l                      present as the vs_main stroke
//                                                  arm); the f32-degree path.
// Both are compared to the f64 camera-relative Mercator position — which is
// exactly what the DSFUN outline computes. The gate asserts:
//   • NEW coincides with the outline to sub-millimetre / sub-pixel (the fix),
//   • OLD is physically displaced > 0.5 m / > 5 px (TEETH: the gate provably
//     detects the bug it guards — revert the packing to degrees and NEW fails
//     too, because the tail slots would no longer be tile-local Mercator).
// A snapshot-token check additionally pins the emitted fill arm against an
// arm-only revert (packing unchanged, shader reverted to `project(`).

const SOFTWARE_GPU = process.env.XGIS_SOFTWARE_GPU === '1'

const EARTH_R = 6378137
const Z_REPORT = 20.55 // the camera zoom the bug was reported at
// Web-Mercator pixels-per-metre at the report zoom (512-px tiles, MapLibre
// parity). The metre assertions are the scale-independent gate; px is the
// human-facing translation of the symptom ("~10 px split").
const PX_PER_M = (512 * 2 ** Z_REPORT) / (2 * Math.PI * EARTH_R)

/** Slippy z14 tile bounds (deg) containing (lon,lat) — the over-zoom PARENT
 *  tile OFM (maxzoom 14) stretches at z20.55 (no generateSubTile). */
function tileBounds(lon: number, lat: number, z: number) {
  const n = 2 ** z
  const tx = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const ty = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n)
  const lat2deg = (yy: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI
  return {
    westLon: (tx / n) * 360 - 180,
    eastLon: ((tx + 1) / n) * 360 - 180,
    northLat: lat2deg(ty),
    southLat: lat2deg(ty + 1),
  }
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x1_0000_0000 }
}

// Deep-zoom cells: the reported Seoul view + a high-|lon| control (the f32
// absolute-Mercator grain — hence the OLD displacement — grows with |lon|).
const CELLS: ReadonlyArray<{ label: string; lon: number; lat: number }> = [
  { label: 'seoul', lon: 126.87814, lat: 37.58481 },
  { label: 'near-antimeridian', lon: 178.42, lat: -36.85 },
]
const N = 2000 // vertices per cell

const COMPUTE_WGSL = `
const PI: f32 = 3.14159265;
const DEG2RAD: f32 = 0.01745329;
const EARTH_R: f32 = 6378137.0;
const MERCATOR_LAT_LIMIT: f32 = 85.051129;
// Byte-identical to the emitted polygon shader's proj_mercator (snapshot l.20).
fn proj_mercator(lon_deg: f32, lat_deg: f32) -> vec2<f32> {
  let lat = clamp(lat_deg, (-MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT);
  let x = ((lon_deg * DEG2RAD) * EARTH_R);
  let y = (log(tan(((PI / 4.0) + ((lat * DEG2RAD) / 2.0)))) * EARTH_R);
  return vec2<f32>(x, y);
}
// cam_h/cam_l/origin are padded to vec4 — loose f32/vec2 uniform members land
// on 16-byte boundaries in some drivers (SwiftShader read them as NaN); the
// real Uniforms struct pads the same way. Only .xy is used.
struct U { cam_h: vec4<f32>, cam_l: vec4<f32>, origin: vec4<f32> }
@group(0) @binding(0) var<storage, read> inp: array<f32>;        // 4/vert: localX, localY, lonDeg, latDeg
@group(0) @binding(1) var<storage, read_write> outp: array<f32>; // 4/vert: relNewX, relNewY, relOldX, relOldY
@group(0) @binding(2) var<uniform> u: U;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i * 4u + 3u >= arrayLength(&inp)) { return; }
  let b = i * 4u;
  let local = vec2<f32>(inp[b], inp[b + 1u]);
  let lon = inp[b + 2u];
  let lat = inp[b + 3u];
  // NEW (#392 vs_main_ecef flat arm): tail slots hold tile-local Mercator.
  let rel_new = ((local - u.cam_h.xy) - u.cam_l.xy);
  // OLD (pre-#392 fill arm == current vs_main stroke arm): project f32 degrees.
  let p2d = proj_mercator(lon, lat);
  let rel_old = (((p2d - u.origin.xy) - u.cam_h.xy) - u.cam_l.xy);
  outp[b]      = rel_new.x;
  outp[b + 1u] = rel_new.y;
  outp[b + 2u] = rel_old.x;
  outp[b + 3u] = rel_old.y;
}
`

test.describe('polygon fill flat-Mercator arm parity (GPU position ≡ outline)', () => {
  test('the #392 fill arm coincides with the f64 outline; the pre-#392 arm splits', async ({ page }) => {
    test.setTimeout(60_000)
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    // ── Build cells on the CPU: real packECEFPolygonVertices tail slots +
    //    the renderer's exact cam_h/cam_l split, plus the f64 truth position.
    const cells = CELLS.map((c) => {
      const tb = tileBounds(c.lon, c.lat, 14)
      const [tileMx, tileMy] = lonLatToMercF64(tb.westLon, tb.southLat)
      const ecefCenter = tileEcefCenterFromMerc(tileMx, tileMy)
      const [camMx, camMy] = lonLatToMercF64(c.lon, c.lat)
      const [camHx, camLx] = splitF64(camMx - tileMx)
      const [camHy, camLy] = splitF64(camMy - tileMy)

      const rng = makeRng(0xF111 ^ Math.floor(c.lon * 1000))
      const scratch: number[] = []
      const lons: number[] = []
      const lats: number[] = []
      const truth: Array<[number, number]> = []
      for (let i = 0; i < N; i++) {
        const lon = tb.westLon + rng() * (tb.eastLon - tb.westLon)
        const lat = tb.southLat + rng() * (tb.northLat - tb.southLat)
        const [mx, my] = lonLatToMercF64(lon, lat)
        scratch.push(mx, my, i + 1)
        lons.push(lon); lats.push(lat)
        truth.push([mx - camMx, my - camMy]) // f64 camera-relative = the outline position
      }
      // Pack through the REAL fill packer with the same origin the renderer
      // writes to tile_origin_merc → tail slots 4/5 = tile-local Mercator.
      const packed = packECEFPolygonVertices(scratch, ecefCenter, [tileMx, tileMy])
      const inp = new Float32Array(N * 4)
      for (let i = 0; i < N; i++) {
        inp[i * 4] = packed.vertices[i * 7 + 4]     // local_merc_x (slot FILL_LON_FLOAT; fill stride 7 floats post-#398)
        inp[i * 4 + 1] = packed.vertices[i * 7 + 5] // local_merc_y (slot FILL_LAT_FLOAT)
        inp[i * 4 + 2] = lons[i]
        inp[i * 4 + 3] = lats[i]
      }
      const uni = new Float32Array(12)
      uni[0] = camHx; uni[1] = camHy           // cam_h.xy
      uni[4] = camLx; uni[5] = camLy           // cam_l.xy
      uni[8] = tileMx; uni[9] = tileMy         // origin.xy (truncated to f32 on store, as the real uniform)
      return { label: c.label, inp: Array.from(inp), uni: Array.from(uni), truth }
    })

    const gpu = await page.evaluate(async (args: {
      wgsl: string
      cells: Array<{ label: string; inp: number[]; uni: number[] }>
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
      const fatals = info.messages.filter((m) => m.type === 'error')
      if (fatals.length > 0) return { error: 'compile: ' + fatals.map((m) => `${m.lineNum}:${m.message}`).join(' | ') }
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } })

      const out: Record<string, number[]> = {}
      for (const c of args.cells) {
        const n = c.inp.length / 4
        const inData = new Float32Array(c.inp)
        const inBuf = device.createBuffer({ size: inData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
        device.queue.writeBuffer(inBuf, 0, inData)
        const outBuf = device.createBuffer({ size: n * 4 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
        const readBuf = device.createBuffer({ size: n * 4 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        const uBuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
        device.queue.writeBuffer(uBuf, 0, new Float32Array(c.uni))
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
    }, { wgsl: COMPUTE_WGSL, cells: cells.map((c) => ({ label: c.label, inp: c.inp, uni: c.uni })) })

    expect(gpu, `GPU compute failed: ${'error' in gpu ? gpu.error : ''}`).not.toHaveProperty('error')
    if ('error' in gpu) return
    expect(gpu.errors, `uncaptured GPU errors: ${gpu.errors.join(' | ')}`).toEqual([])

    let worstNewM = 0, worstNewPx = 0, worstOldM = 0, worstOldPx = 0
    let compared = 0
    for (const c of cells) {
      const flat = gpu.out[c.label]
      for (let i = 0; i < N; i++) {
        const [tx, ty] = c.truth[i]
        const newDx = flat[i * 4] - tx, newDy = flat[i * 4 + 1] - ty
        const oldDx = flat[i * 4 + 2] - tx, oldDy = flat[i * 4 + 3] - ty
        if (![newDx, newDy, oldDx, oldDy].every(Number.isFinite)) continue
        compared++
        const newM = Math.hypot(newDx, newDy)
        const oldM = Math.hypot(oldDx, oldDy)
        if (newM > worstNewM) worstNewM = newM
        if (oldM > worstOldM) worstOldM = oldM
      }
    }
    worstNewPx = worstNewM * PX_PER_M
    worstOldPx = worstOldM * PX_PER_M
    console.log(
      `[fill-flat parity] ${SOFTWARE_GPU ? 'software' : 'hardware'} GPU, ${compared} verts | ` +
      `NEW(#392) worst ${worstNewM.toExponential(3)} m = ${worstNewPx.toExponential(3)} px | ` +
      `OLD(pre-#392) worst ${worstOldM.toFixed(4)} m = ${worstOldPx.toFixed(2)} px @ z${Z_REPORT}`
    )

    expect(compared, 'no finite vertices compared').toBeGreaterThan(N) // both cells contributed

    // The #392 fill arm reconstructs the outline position to sub-mm / sub-px.
    expect(worstNewM, `#392 fill arm drifted from the f64 outline: ${worstNewM.toExponential(3)} m`).toBeLessThan(2e-3)
    expect(worstNewPx, `#392 fill arm split from the outline on screen: ${worstNewPx.toExponential(3)} px`).toBeLessThan(0.5)

    // TEETH: the pre-#392 f32-degree arm is provably displaced — so a packing
    // revert (tail slots back to degrees) makes NEW fail this very gate too.
    expect(worstOldM, `pre-#392 arm should be physically displaced (gate has no teeth): ${worstOldM} m`).toBeGreaterThan(0.5)
    expect(worstOldPx, `pre-#392 arm should be visibly split (the ~10px symptom): ${worstOldPx} px`).toBeGreaterThan(5)
  })

  test('emitted polygon fill arm still reads tile-local Mercator (arm-revert pin)', () => {
    // Pins the FILL arm against a shader-only revert to `project(abs_lon,
    // abs_lat)` (packing unchanged): the regenerated snapshots would drop the
    // tile-local-Mercator token. `rel2d_local` is unique to vs_main_ecef — the
    // stroke arm uses `rel2d` + `project(`.
    const here = dirname(fileURLToPath(import.meta.url))
    const snapDir = join(here, '..', '..', 'runtime', 'src', 'engine', 'shaders', 'dsl', '__polygon-variant-snapshots__')
    const TOKEN = 'rel2d_local = ((vec2<f32>(abs_lon, abs_lat) - u.cam_h) - u.cam_l)'
    const files = readdirSync(snapDir).filter((f) => f.endsWith('.wgsl'))
    expect(files.length, `no polygon snapshots in ${snapDir}`).toBeGreaterThan(0)
    const withToken = files.filter((f) => readFileSync(join(snapDir, f), 'utf8').includes(TOKEN))
    expect(
      withToken.length,
      `no emitted polygon fill arm reads tile-local Mercator (token "${TOKEN}") — vs_main_ecef may have reverted to project(abs_lon, abs_lat)`,
    ).toBeGreaterThan(0)
  })
})
