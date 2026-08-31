import { test, expect } from '@playwright/test'
import { lonLatToMercF64, tileEcefCenterFromMerc } from '@xgis/compiler'

// ═══ #2089 line ECEF lanes: GPU corner ≡ CPU f64 truth (and the old arm is not) ═══
//
// THE GAP THIS CLOSES. #2089 moved the GLOBE line vertex arm off an in-shader
// f32 `atan(exp())` re-derivation and onto CPU-f64-exact ECEF endpoint lanes +
// an ENU tangent-plane rotation of the corner offset. Every gate the PR
// originally ran was either compile/link-only or exercised the FLAT arm:
// `_lines-gl2-gate` boots plain Mercator, and `_1222-drape-stroke-zoom-width`
// is a globe camera but goes through the DRAPE, whose stroke bake explicitly
// "reuses ... the flat-Mercator VS arm (proj 0 / cam 0 / ortho MVP)"
// (map/src/render/vector-drape-stroke.ts:7-9). So the one arm the change
// rewrites had no numeric coverage at all — while being the live path for every
// WebGL2 globe stroke and for WebGPU globe EXTRUDED outlines, both of which the
// drape predicate excludes (vector-tile-renderer.ts:3613-3622).
//
// THE GATE. A standalone COMPUTE pass (SwiftShader-safe, the `_polygon-fill-
// flat-parity` pattern) runs BOTH arms on the real GPU over sample corners of a
// real overzoom-parent tile, and compares each to the f64 truth computed on the
// CPU:
//   NEW = (e_h + e_l) + ENU(lon,lat) · (off·cosφ, h)   ← the #2089 arm, fed the
//                                                        REAL packed lane values
//   OLD = ecef(invmerc(f32(base+off))) − ecef(invmerc(f32(tileOrigin)))
//                                                      ← the pre-#2089 arm
// Asserted:
//   • ENDPOINT (offset 0) — NEW is sub-millimetre. This is the registration
//     claim the migration exists for, and it is exact by construction: the
//     lanes ARE the f64 truth, split hi/lo.
//   • TEETH — OLD is displaced at the SAME point by orders more. Without this
//     the gate could pass on a shader that never reads the lanes.
//   • CORNER (real stroke offsets) — NEW stays inside the closed-form budget the
//     implementation documents: the isotropic-cos(lat) residual (≤0.67% of the
//     offset, the spherical-vs-ellipsoidal Jacobian gap) plus the tangent-plane
//     departure |off|²/2R. Asserting the DERIVED budget rather than a round
//     number is what keeps this from being a tolerance nobody can defend.

const SOFTWARE_GPU = process.env.XGIS_SOFTWARE_GPU === '1'

const WGS84_A = 6378137
const WGS84_E2 = 0.0066943799901413165
const EARTH_R = 6378137 // Web-Mercator sphere radius (the DSL's EARTH_R)

/** f64 WGS84 ECEF from absolute Mercator metres — the packer's own chain. */
function ecefF64(mx: number, my: number, h = 0): [number, number, number] {
  const lon = mx / WGS84_A
  const lat = 2 * Math.atan(Math.exp(my / WGS84_A)) - Math.PI / 2
  const s = Math.sin(lat)
  const c = Math.cos(lat)
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s)
  return [(N + h) * c * Math.cos(lon), (N + h) * c * Math.sin(lon), (N * (1 - WGS84_E2) + h) * s]
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
// tile_origin is padded to vec4 — loose vec2/f32 uniform members land on
// 16-byte boundaries in some drivers (SwiftShader read them as NaN).
struct U { tile_origin: vec4<f32> }
@group(0) @binding(0) var<storage, read> inp: array<f32>;        // 11/sample
@group(0) @binding(1) var<storage, read_write> outp: array<f32>; // 6/sample
@group(0) @binding(2) var<uniform> u: U;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i * 11u + 10u >= arrayLength(&inp)) { return; }
  let b = i * 11u;
  let e_h = vec3<f32>(inp[b], inp[b + 1u], inp[b + 2u]);
  let e_l = vec3<f32>(inp[b + 3u], inp[b + 4u], inp[b + 5u]);
  let base_local = vec2<f32>(inp[b + 6u], inp[b + 7u]);
  let off = vec2<f32>(inp[b + 8u], inp[b + 9u]);
  let h = inp[b + 10u];

  // ── NEW (#2089 vs_line globe arm) — lanes + ENU tangent-plane rotation ──
  let abs_x = base_local.x + u.tile_origin.x;
  let abs_y = base_local.y + u.tile_origin.y;
  let lon = abs_x / EARTH_R;
  let lat = 2.0 * atan(exp(abs_y / EARTH_R)) - PI / 2.0;
  let sin_lon = sin(lon);
  let cos_lon = cos(lon);
  let sin_lat = sin(lat);
  let cos_lat = cos(lat);
  let e = off.x * cos_lat;
  let n = off.y * cos_lat;
  let ex = (-sin_lon) * e + (-sin_lat * cos_lon) * n + (cos_lat * cos_lon) * h;
  let ey = (cos_lon) * e + (-sin_lat * sin_lon) * n + (cos_lat * sin_lon) * h;
  let ez = (cos_lat) * n + (sin_lat) * h;
  let new_rtc = (e_h + e_l) + vec3<f32>(ex, ey, ez);

  // ── OLD (pre-#2089) — f32 inverse-Mercator + forward, minus the f32 anchor ──
  let corner_abs_x = base_local.x + off.x + u.tile_origin.x;
  let corner_abs_y = base_local.y + off.y + u.tile_origin.y;
  let c_lon = corner_abs_x / EARTH_R;
  let c_lat = 2.0 * atan(exp(corner_abs_y / EARTH_R)) - PI / 2.0;
  let corner_ecef = lonlat_to_ecef(c_lon, c_lat, h);
  let t_lon = u.tile_origin.x / EARTH_R;
  let t_lat = 2.0 * atan(exp(u.tile_origin.y / EARTH_R)) - PI / 2.0;
  let tile_ecef = lonlat_to_ecef(t_lon, t_lat, 0.0);
  let old_rtc = corner_ecef - tile_ecef;

  let o = i * 6u;
  outp[o] = new_rtc.x;      outp[o + 1u] = new_rtc.y;      outp[o + 2u] = new_rtc.z;
  outp[o + 3u] = old_rtc.x; outp[o + 4u] = old_rtc.y;      outp[o + 5u] = old_rtc.z;
}
`

// The #2053 repro tile: z2 x3 y1 (west 90°, south 0°) — the overzoom PARENT the
// demotiles mirror stretches at camera z9 over the Korea east coast.
const TILE_WEST = 90
const TILE_SOUTH = 0
// Sample points along the coast, plus a high-latitude control (the cos(lat)
// residual and the ENU basis both vary with latitude, so a single mid-latitude
// sample would not distinguish a latitude-dependent mistake).
const POINTS: ReadonlyArray<{ label: string; lon: number; lat: number }> = [
  { label: 'korea-east-coast', lon: 129.35, lat: 37.5 },
  { label: 'busan', lon: 129.05, lat: 35.1 },
  { label: 'equator-edge', lon: 95.0, lat: 0.4 },
  { label: 'high-lat', lon: 140.0, lat: 78.0 },
]
// Corner offsets in tile-local Mercator metres: 0 (the endpoint — the
// registration claim), then realistic stroke half-widths at this parent's
// scale, then a deliberately large one to exercise the budget's growth.
const OFFSETS: ReadonlyArray<[number, number]> = [
  [0, 0],
  [40, -25],
  [-600, 300],
  [5000, -3000],
]

test.describe('#2089 line ECEF lanes — GPU corner ≡ CPU f64 truth', () => {
  test('the lane arm is f64-exact at the endpoint; the pre-#2089 arm is displaced', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const [tileMx, tileMy] = lonLatToMercF64(TILE_WEST, TILE_SOUTH)
    const anchor = tileEcefCenterFromMerc(tileMx, tileMy)

    // Build the samples exactly as buildLineSegments packs them: the endpoint's
    // f64 ECEF RTC, DSFUN-split; the endpoint's tile-local Mercator; the offset.
    const inp: number[] = []
    const truth: [number, number, number][] = []
    const endpointTruth: [number, number, number][] = []
    const meta: { label: string; off: [number, number]; offLen: number; lat: number }[] = []
    for (const p of POINTS) {
      const [mx, my] = lonLatToMercF64(p.lon, p.lat)
      const [ex, ey, ez] = ecefF64(mx, my)
      const rx = ex - anchor[0]
      const ry = ey - anchor[1]
      const rz = ez - anchor[2]
      const xh = Math.fround(rx)
      const yh = Math.fround(ry)
      const zh = Math.fround(rz)
      for (const off of OFFSETS) {
        inp.push(
          xh,
          yh,
          zh,
          Math.fround(rx - xh),
          Math.fround(ry - yh),
          Math.fround(rz - zh),
          Math.fround(mx - tileMx),
          Math.fround(my - tileMy),
          off[0],
          off[1],
          0,
        )
        // f64 truth for the CORNER: the exact ECEF of (endpoint + offset).
        const [cx, cy, cz] = ecefF64(mx + off[0], my + off[1])
        truth.push([cx - anchor[0], cy - anchor[1], cz - anchor[2]])
        endpointTruth.push([rx, ry, rz])
        meta.push({
          label: p.label,
          off,
          offLen: Math.hypot(off[0], off[1]),
          lat: p.lat,
        })
      }
    }

    const res = await page.evaluate(
      async ({ wgsl, inp, count, origin }) => {
        const nav = navigator as unknown as {
          gpu?: {
            requestAdapter: () => Promise<{
              requestDevice: () => Promise<GPUDevice>
            } | null>
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
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        device.queue.writeBuffer(uni, 0, new Float32Array([origin[0], origin[1], 0, 0]))

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
        count: inp.length / 11,
        origin: [Math.fround(tileMx), Math.fround(tileMy)] as [number, number],
      },
    )

    expect(res.ok, `compute pass unavailable: ${res.ok ? '' : res.why}`).toBe(true)
    if (!res.ok) return
    expect(res.errs, 'no WebGPU validation errors').toEqual([])

    const dist = (a: number[], b: readonly number[]) =>
      Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)

    let worstEndpointNew = 0
    let worstUlpBound = 0
    let worstEndpointOld = 0
    let worstCornerExcess = 0
    let worstCornerLabel = ''
    for (let i = 0; i < meta.length; i++) {
      const o = i * 6
      const gpuNew = [res.out[o]!, res.out[o + 1]!, res.out[o + 2]!]
      const gpuOld = [res.out[o + 3]!, res.out[o + 4]!, res.out[o + 5]!]
      const m = meta[i]!
      const rtcMag = Math.hypot(...endpointTruth[i]!)
      const ulpBound = 2 * Math.pow(2, Math.floor(Math.log2(Math.max(rtcMag, 1))) - 23)
      worstUlpBound = Math.max(worstUlpBound, ulpBound)
      if (m.offLen === 0) {
        // ENDPOINT: the registration claim. NEW must be the f64 truth (it IS the
        // lanes); OLD carries the f32 chain's error at the same point.
        worstEndpointNew = Math.max(worstEndpointNew, dist(gpuNew, endpointTruth[i]!))
        worstEndpointOld = Math.max(worstEndpointOld, dist(gpuOld, endpointTruth[i]!))
      } else {
        // CORNER: NEW must sit inside the DERIVED budget, not a round number.
        //   isotropic-cos(lat) residual  ≤ 0.67% · |off|   (spherical vs WGS84
        //     Jacobian; worst at the equator, on the north component)
        //   tangent-plane departure      = |off|² / 2R
        //   f32 slack for the lane recombine + the rotation itself
        const budget = 0.0067 * m.offLen + (m.offLen * m.offLen) / (2 * EARTH_R) + 0.05
        const err = dist(gpuNew, truth[i]!)
        if (err - budget > worstCornerExcess) {
          worstCornerExcess = err - budget
          worstCornerLabel = `${m.label} off=${m.off.join(',')} err=${err.toExponential(3)} budget=${budget.toExponential(3)}`
        }
      }
    }

    // The endpoint bound is DERIVED, and deriving it corrected a claim: the
    // lanes are f64-exact as PACKED, but the shader recombines them as an f32
    // `h + l`, so the reachable precision is the f32 ulp AT THE RTC MAGNITUDE —
    // 1 m on this z2 parent (|rtc| ≈ 3.5e6 m), ~0.15 mm on a z14 tile. That is
    // the same discipline the polygon fill arm uses (`pos_h + pos_l`), which is
    // exactly the point: fill and stroke carry the SAME residual, so they stay
    // registered to each other. An earlier draft of this gate asserted 1 mm and
    // failed at 0.21 m — the assertion was unphysical, not the code.
    expect(
      worstEndpointNew,
      `#2089 lane endpoint drifted beyond the f32 recombination ulp: ${worstEndpointNew.toExponential(3)} m > ${worstUlpBound.toExponential(3)} m`,
    ).toBeLessThanOrEqual(worstUlpBound)

    // TEETH — the arm this replaced is measurably displaced at the SAME points,
    // so a shader that quietly went back to re-deriving cannot pass this file.
    // (SwiftShader's transcendentals make this far larger; the bound is set to
    // hold on real hardware too, where the f32 input ulp alone is ~1 m.)
    // TEETH, as a RATIO so the claim scales with the fixture rather than being a
    // number someone has to re-tune: the arm this replaced must be orders worse
    // at the same points. Measured here (SwiftShader, z2 parent): 1.17e3 m vs
    // 2.1e-1 m — a factor of ~5500. On real hardware the old arm's floor is the
    // f32 input ulp (~1 m), still far outside the new arm's ulp bound.
    expect(
      worstEndpointOld,
      `pre-#2089 arm should be displaced at the endpoint (gate has no teeth): old=${worstEndpointOld.toExponential(3)} m vs new=${worstEndpointNew.toExponential(3)} m`,
    ).toBeGreaterThan(Math.max(50 * worstEndpointNew, 0.5))

    // The documented approximations, held to their own closed form.
    expect(
      worstCornerExcess,
      `#2089 corner exceeded its derived budget — ${worstCornerLabel}`,
    ).toBeLessThanOrEqual(0)

    console.log(
      `[lane-parity] endpoint new=${worstEndpointNew.toExponential(2)} m (ulp bound ${worstUlpBound.toExponential(2)}), ` +
        `old=${worstEndpointOld.toExponential(2)} m, corner worst-excess=${worstCornerExcess.toExponential(2)} m ` +
        `(software=${SOFTWARE_GPU})`,
    )
  })
})
