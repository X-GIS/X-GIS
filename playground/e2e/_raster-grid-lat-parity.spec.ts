import { test, expect } from '@playwright/test'
import { lonLatToMercF64, tileEcefCenterFromMerc } from '@xgis/compiler'

// ═══ #2137 raster/drape grid vertex: GPU position ≡ CPU f64 truth ═══
//
// THE GAP THIS CLOSES. The RASTER GRID vertex arm — `raster.ts:265-292`, which
// positions every DRAPED tile vertex and every globe BASEMAP tile vertex —
// builds the ABSOLUTE ECEF from angles, on the GPU, in f32:
//
//     normalLatRad = 2 * atan(exp(mercYAbs)) - PI/2
//     ecef         = lonlatToEcef(lonRad, latRad, 0)      // sin/cos/sqrt, f32
//
// Every transcendental on that path multiplies the EARTH RADIUS, so a backend's
// relative trig error lands as metres of ground displacement. Measured as ~2 px
// of drape-vs-direct registration offset at the #2053 repro camera.
//
// WHAT THE FIRST RUN OF THIS GATE REFUTED. The migration was first designed as
// "hand the shader a CPU-exact LATITUDE table" — on the assumption that
// `atan(exp())` was the culprit. This gate killed that: feeding the exact
// latitude changed the error by nothing at all (cur and fix both 1.17e+3 m),
// because `lonlat_to_ecef`'s OWN sin/cos/sqrt dominate. The error is not in
// deriving latitude; it is in forming a ~6.4e6 m vector from angles in f32.
// That is also why #2089 worked where this would not have: its ENU sin/cos
// scale the small corner OFFSET, never R.
//
// THE GATE. A standalone COMPUTE pass (the `_line-ecef-lane-parity` pattern)
// runs BOTH arms on the real GPU and compares each against f64 CPU truth:
//   CUR = lonlat_to_ecef(lon, 2*atan(exp(mercY/R)) - PI/2)   ← what ships today
//   FIX = N*cosφ*cosλ, N*cosφ*sinλ, N(1-e²)*sinφ             ← sinφ/cosφ/N/sinλ/cosλ
//                                                              supplied CPU-exact;
//                                                              pure multiplies
// Both then subtract the tile SW anchor, exactly as `vs_tile` does.
//
// Asserted:
//   • CUR is within the f32 floor. This is the PRODUCTION assertion and is RED
//     until #2137 lands. Do not relax it — it is the whole point of the gate.
//   • FIX is within that floor — the WITNESS that the bound is reachable, so a
//     red CUR cannot be dismissed as an impossible tolerance. Measured 3.87e-1 m
//     against a 2 m bound, versus CUR's 1.17e+3 m: a ~3000x separation.
//   • TEETH — CUR is displaced far beyond FIX at the SAME point. Without this a
//     backend whose trig happens to be exact would green the gate while proving
//     nothing about the migration.
//
// THE BOUND IS DERIVED, NOT ROUND. `vs_tile` forms the absolute ECEF (~6.4e6 m)
// in f32 and only then subtracts the anchor, so the f32 quantization of that
// magnitude survives: ulp(6.4e6) = 2^(22-23) = 0.5 m per component. #2089's
// gate had to learn the same lesson — its first run refuted a sub-millimetre
// tolerance for exactly this structural reason.

const SOFTWARE_GPU = process.env.XGIS_SOFTWARE_GPU === '1'

const WGS84_A = 6378137
const WGS84_E2 = 0.0066943799901413165
const EARTH_R = 6378137 // Web-Mercator sphere radius (the DSL's EARTH_R)

/** f64 WGS84 ECEF from lon/lat radians — the CPU truth chain. */
function ecefF64(lonRad: number, latRad: number, h = 0): [number, number, number] {
  const s = Math.sin(latRad)
  const c = Math.cos(latRad)
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s)
  return [
    (N + h) * c * Math.cos(lonRad),
    (N + h) * c * Math.sin(lonRad),
    (N * (1 - WGS84_E2) + h) * s,
  ]
}

const COMPUTE_WGSL = `
const PI: f32 = 3.14159265;
const EARTH_R: f32 = 6378137.0;
const WGS84_A: f32 = 6378137.0;
const WGS84_E2: f32 = 0.0066943799901413165;
fn lonlat_to_ecef(lon_rad: f32, lat_rad: f32, height: f32) -> vec3<f32> {
  let s = sin(lat_rad);
  let c = cos(lat_rad);
  let n = WGS84_A / sqrt(1.0 - WGS84_E2 * s * s);
  return vec3<f32>((n + height) * c * cos(lon_rad), (n + height) * c * sin(lon_rad), (n * (1.0 - WGS84_E2) + height) * s);
}
// anchor padded to vec4 — loose vec2/f32 uniform members land on 16-byte
// boundaries in some drivers (SwiftShader read them as NaN).
struct U { anchor: vec4<f32>, anchor2: vec4<f32> }
@group(0) @binding(0) var<storage, read> inp: array<f32>;        // 7/sample
@group(0) @binding(1) var<storage, read_write> outp: array<f32>; // 6/sample
@group(0) @binding(2) var<uniform> u: U;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i * 7u + 6u >= arrayLength(&inp)) { return; }
  let b = i * 7u;
  let merc_y_abs = inp[b];       // absolute Mercator Y (metres)
  let lon_rad    = inp[b + 1u];  // longitude (radians)
  // CPU-f64 trig + prime-vertical radius, rounded to f32. Supplying these is
  // what makes the FIX arm free of any transcendental that multiplies R.
  let sin_lat = inp[b + 2u];
  let cos_lat = inp[b + 3u];
  let n_rad   = inp[b + 4u];
  let sin_lon = inp[b + 5u];
  let cos_lon = inp[b + 6u];

  let anchor = vec3<f32>(u.anchor.x, u.anchor.y, u.anchor.z);

  // ── CUR — what raster.ts:265-267 ships today: latitude from atan(exp()),
  // then lonlat_to_ecef, whose OWN sin/cos/sqrt multiply the Earth radius. ──
  let lat_cur = 2.0 * atan(exp(merc_y_abs / EARTH_R)) - PI / 2.0;
  let cur_rtc = lonlat_to_ecef(lon_rad, lat_cur, 0.0) - anchor;

  // ── FIX — pure multiplies. No transcendental anywhere on this path, so no
  // backend's atan/exp/sin/cos error can be scaled by ~6.4e6 m. ──
  let fix_ecef = vec3<f32>(
    n_rad * cos_lat * cos_lon,
    n_rad * cos_lat * sin_lon,
    n_rad * (1.0 - WGS84_E2) * sin_lat,
  );
  let fix_rtc = fix_ecef - anchor;

  let o = i * 6u;
  outp[o] = cur_rtc.x;      outp[o + 1u] = cur_rtc.y;      outp[o + 2u] = cur_rtc.z;
  outp[o + 3u] = fix_rtc.x; outp[o + 4u] = fix_rtc.y;      outp[o + 5u] = fix_rtc.z;
}
`

// The #2053 repro parent tile: z2 x3 y1 (west 90°, south 0°) — the tile the
// demotiles mirror stretches at camera z9 over the Korea east coast.
const TILE_WEST = 90
const TILE_SOUTH = 0
// Grid-row latitudes are what the shader derives, so sample across the LATITUDE
// span: the atan(exp()) error is latitude-dependent, and a single mid-latitude
// sample could not distinguish a latitude-dependent mistake from a constant one.
const POINTS: ReadonlyArray<{ label: string; lon: number; lat: number }> = [
  { label: 'korea-east-coast', lon: 129.35, lat: 37.5 },
  { label: 'busan', lon: 129.05, lat: 35.1 },
  { label: 'equator-edge', lon: 95.0, lat: 0.4 },
  { label: 'mid-lat', lon: 120.0, lat: 55.0 },
  { label: 'high-lat', lon: 140.0, lat: 78.0 },
]

test.describe('#2137 raster grid latitude — GPU vertex ≡ CPU f64 truth', () => {
  test('the grid arm must not derive latitude through f32 atan(exp())', async ({ page }) => {
    test.setTimeout(90_000)
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const [tileMx, tileMy] = lonLatToMercF64(TILE_WEST, TILE_SOUTH)
    const anchor = tileEcefCenterFromMerc(tileMx, tileMy)

    const inp: number[] = []
    const truth: [number, number, number][] = []
    const meta: { label: string; lat: number }[] = []
    for (const p of POINTS) {
      const [, my] = lonLatToMercF64(p.lon, p.lat)
      const lonRad = (p.lon * Math.PI) / 180
      // The exact latitude for this Mercator Y, in f64 — this is what the CPU
      // would hand the shader as a per-row table entry once #2137 lands.
      const latExact = 2 * Math.atan(Math.exp(my / EARTH_R)) - Math.PI / 2
      const sLat = Math.sin(latExact)
      const cLat = Math.cos(latExact)
      const nRad = WGS84_A / Math.sqrt(1 - WGS84_E2 * sLat * sLat)
      inp.push(
        Math.fround(my),
        Math.fround(lonRad),
        Math.fround(sLat),
        Math.fround(cLat),
        Math.fround(nRad),
        Math.fround(Math.sin(lonRad)),
        Math.fround(Math.cos(lonRad)),
      )
      const [ex, ey, ez] = ecefF64(lonRad, latExact)
      truth.push([ex - anchor[0], ey - anchor[1], ez - anchor[2]])
      meta.push({ label: p.label, lat: p.lat })
    }

    const res = await page.evaluate(
      async ({ wgsl, inp, count, anchor }) => {
        const nav = navigator as unknown as {
          gpu?: {
            requestAdapter: () => Promise<{ requestDevice: () => Promise<GPUDevice> } | null>
          }
        }
        if (!nav.gpu) return { ok: false as const, why: 'no navigator.gpu' }
        const adapter = await nav.gpu.requestAdapter()
        if (!adapter) return { ok: false as const, why: 'no adapter' }
        const device = await adapter.requestDevice()
        const errs: string[] = []
        device.pushErrorScope('validation')

        const inBuf = device.createBuffer({
          size: inp.length * 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })
        device.queue.writeBuffer(inBuf, 0, new Float32Array(inp))
        const outBytes = count * 6 * 4
        const outBuf = device.createBuffer({
          size: outBytes,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        })
        const readBuf = device.createBuffer({
          size: outBytes,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        })
        const uni = device.createBuffer({
          size: 32,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        device.queue.writeBuffer(
          uni,
          0,
          new Float32Array([anchor[0], anchor[1], anchor[2], 0, 0, 0, 0, 0]),
        )

        const mod = device.createShaderModule({ code: wgsl })
        const pipe = device.createComputePipeline({
          layout: 'auto',
          compute: { module: mod, entryPoint: 'main' },
        })
        const bg = device.createBindGroup({
          layout: pipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: inBuf } },
            { binding: 1, resource: { buffer: outBuf } },
            { binding: 2, resource: { buffer: uni } },
          ],
        })
        const enc = device.createCommandEncoder()
        const pass = enc.beginComputePass()
        pass.setPipeline(pipe)
        pass.setBindGroup(0, bg)
        pass.dispatchWorkgroups(Math.ceil(count / 64))
        pass.end()
        enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, outBytes)
        device.queue.submit([enc.finish()])
        await readBuf.mapAsync(GPUMapMode.READ)
        const out = Array.from(new Float32Array(readBuf.getMappedRange().slice(0)))
        readBuf.unmap()
        const scope = await device.popErrorScope()
        if (scope) errs.push(String((scope as { message?: string }).message ?? scope))
        return { ok: true as const, out, errs }
      },
      {
        wgsl: COMPUTE_WGSL,
        inp,
        count: inp.length / 7,
        anchor: [Math.fround(anchor[0]), Math.fround(anchor[1]), Math.fround(anchor[2])] as [
          number,
          number,
          number,
        ],
      },
    )

    expect(res.ok, `compute pass unavailable: ${res.ok ? '' : res.why}`).toBe(true)
    if (!res.ok) return
    expect(res.errs, 'no WebGPU validation errors').toEqual([])

    const dist = (a: number[], b: readonly number[]) =>
      Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)

    // The floor this formulation cannot beat: vs_tile builds the ABSOLUTE ECEF
    // (~6.4e6 m) in f32 before subtracting the anchor, so the f32 ulp at that
    // magnitude survives the subtraction. Derived, per sample, not a round
    // number — the #2089 lesson.
    const ecefMag = Math.hypot(anchor[0], anchor[1], anchor[2])
    const ulp = Math.pow(2, Math.floor(Math.log2(Math.max(ecefMag, 1))) - 23)
    const bound = 4 * ulp // 3 components + the subtraction, each ≤ 1 ulp

    let worstCur = 0
    let worstFix = 0
    let worstLabel = ''
    for (let i = 0; i < meta.length; i++) {
      const o = i * 6
      const cur = dist(res.out.slice(o, o + 3), truth[i]!)
      const fix = dist(res.out.slice(o + 3, o + 6), truth[i]!)
      if (cur > worstCur) {
        worstCur = cur
        worstLabel = meta[i]!.label
      }
      worstFix = Math.max(worstFix, fix)
    }

    console.log(
      `[grid-lat] cur=${worstCur.toExponential(2)} m (worst @ ${worstLabel}), ` +
        `fix=${worstFix.toExponential(2)} m, bound=${bound.toExponential(2)} m (software=${SOFTWARE_GPU})`,
    )

    // WHAT THIS GATE CAN AND CANNOT SEE. It runs a standalone compute pass over a
    // TRANSCRIPTION of the two formulations — it does not execute the emitted
    // `vs_tile`, so it cannot observe whether the shipped shader uses the table.
    // That wiring proof is `raster-grid-trig-wiring.test.ts`, which asserts the
    // emitted WGSL reads `row_trig`/`col_trig` and was RED before #2137 landed.
    // Kept separate on purpose: conflating "the math is right" with "the shader
    // uses it" is how a gate ends up measuring something its assertion does not own.

    // The TABLE formulation — what #2137 ships — lands inside the f32 floor. This
    // is the WITNESS that the bound is reachable, so the angle arm's displacement
    // below cannot be waved off as an impossible tolerance.
    expect(worstFix, 'the CPU-trig table must land inside the f32 floor').toBeLessThanOrEqual(bound)

    // TEETH — the retired angle-derived formulation must be displaced by orders
    // more at the SAME points. Without this a backend whose trig happened to be
    // exact would green this gate while proving nothing about the migration.
    expect(
      worstCur,
      'the angle-derived formulation must be measurably worse — otherwise this gate is vacuous on this backend',
    ).toBeGreaterThan(Math.max(50 * worstFix, bound))
  })
})
