// ═══ @xgis/shader-dsl example — fp64 Web-Mercator tile pyramid ═══
//
// The actual tile-engine computation, at the zoom levels where f32 dies: a
// normalized Web-Mercator coordinate (Seoul, x ≈ 0.85272) is multiplied by
// 2^z and split with floor/fract into (tile index, in-tile uv). One f32 ulp
// of 0.85 is ~6e-8 — at tile-z 21 that is 27 PIXELS of a 640-px half, so the
// plain-f32 left half renders the city as blocky smears while the f64 right
// half keeps crisp tile borders through z 23. The scale 2^z is built by
// EXACT repeated doubling (a power of two is exact in f32; pow(2, z) need not
// be), so the multiply itself never eats the df64 budget. Tile indices at
// z ≤ 23 fit f32 integers (< 2^24) — only the FRACTION ever needed f64.
//
// The `_fp64` guard uniform is auto-injected by the lowering; the render
// harnesses bind it to 1.0f by probing the program for the Fp64Guard block.

import {
  fn,
  module,
  vec2,
  vec3,
  vec4,
  f32,
  floor,
  fract,
  sin,
  dot,
  min,
  mix,
  step,
  smoothstep,
  toF32,
  toF64,
  f32T,
  u32,
  vec2fT,
  vec2f64T,
  Loop,
  Var,
  Let,
  uniformStruct,
  splitF64,
} from '../src/index.ts'
import { VsOut, vs } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'

// Seoul in normalized Web-Mercator ([0,1)² — x = (lon+180)/360).
const SEOUL_X = 0.8527166666666667
const SEOUL_Y = 0.3872522862452674
const TILES_ACROSS = 3 // view width in tiles, per half

const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'u' },
  {
    center: vec2f64T, // one DF64Vec2 slot — host packs [hi.x, hi.y, lo.x, lo.y]
    resolution: vec2fT,
    tile_z: f32T, // integer tile-pyramid level (slider, step 1)
    fp64: f32T, // toggle: 1 = split-screen f32 | f64 (canonical), 0 = all-f32
  },
)

const fsTiles = fn(
  'fs_tiles',
  { vo: VsOut },
  (p) => {
    // 2^z by exact repeated doubling — every step is a power of two, exact in
    // f32 up to 2^127; pow(2.0, z) is implementation-defined precision.
    const scale = Var(f32(1))
    Loop(
      u32(0),
      (j) => toF32(j).lt(U.field.tile_z),
      () => {
        scale.assign(scale.mul(2.0))
      },
    )
    const span = Let(f32(TILES_ACROSS).div(scale)) // world units per half-width

    const halfUv = Let(p.vo.uv.x.mul(2.0))
    const sx = Let(halfUv.sub(p.vo.uv.x.lt(0.5).select(0.0, 1.0)))
    const dx = Let(sx.sub(0.5).mul(span))
    const dy = Let(
      p.vo.uv.y.sub(0.5).mul(span).mul(U.field.resolution.y.div(U.field.resolution.x).mul(2.0)),
    )

    const isF32 = Let(p.vo.uv.x.lt(0.5).or(U.field.fp64.lt(0.5)))
    // f64 path — the multiply by an exact power of two costs nothing; floor
    // and fract on the f64 type split tile index from in-tile position.
    const tx = Let(U.field.center.x.add(toF64(dx)).mul(scale))
    const ty = Let(U.field.center.y.add(toF64(dy)).mul(scale))
    const tix64 = Let(toF32(floor(tx))) // < 2^24 at z ≤ 23 — exact as f32
    const tiy64 = Let(toF32(floor(ty)))
    const lx64 = Let(toF32(fract(tx)))
    const ly64 = Let(toF32(fract(ty)))
    // Checker parity in f64: at z 23 the SUM of the two indices can pass 2^24,
    // so fold to 0/1 before narrowing.
    const par64 = Let(toF32(fract(floor(tx).add(floor(ty)).mul(0.5))).mul(2.0))
    // f32 twin — SAME formulas, coordinate narrowed first: the in-tile
    // fraction moves in ulp(0.85)·2^z jumps (27 px at z 21).
    const tx32 = Let(toF32(U.field.center.x).add(dx).mul(scale))
    const ty32 = Let(toF32(U.field.center.y).add(dy).mul(scale))
    const tix32 = Let(floor(tx32))
    const tiy32 = Let(floor(ty32))
    const lx32 = Let(fract(tx32))
    const ly32 = Let(fract(ty32))
    const par32 = Let(fract(tix32.add(tiy32).mul(0.5)).mul(2.0))

    const tix = Let(isF32.select(tix32, tix64))
    const tiy = Let(isF32.select(tiy32, tiy64))
    const lx = Let(isF32.select(lx32, lx64))
    const ly = Let(isF32.select(ly32, ly64))
    const par = Let(isF32.select(par32, par64))

    // Map-ish styling: a per-tile pastel wash (hash of the tile index), the
    // checker parity as a second tone, crisp tile borders, and an in-tile
    // gradient so the interior visibly flows (or, on the left, visibly jumps).
    const h = Let(fract(sin(dot(vec2(tix, tiy), vec2(127.1, 311.7))).mul(43758.5453)))
    const tint = Let(
      mix(vec3(0.78, 0.84, 0.88), vec3(0.9, 0.87, 0.78), h).mul(mix(f32(0.88), f32(1.0), par)),
    )
    const grad = Let(mix(f32(0.92), f32(1.05), lx.mul(0.6).add(ly.mul(0.4))))
    const edge = Let(min(min(lx, f32(1).sub(lx)), min(ly, f32(1).sub(ly))))
    const pixw = Let(f32(TILES_ACROSS).div(U.field.resolution.x.mul(0.5))) // tile units / px
    const border = Let(smoothstep(f32(0), pixw.mul(1.6).add(1e-9), edge))
    const inkline = Let(step(edge, pixw.mul(6.0))) // wider label-side rule
    const rgb = tint
      .mul(grad)
      .mul(mix(f32(0.45), f32(1.0), border))
      .sub(vec3(0.05, 0.04, 0.02).mul(inkline))
    return vec4(rgb, f32(1))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// `_fp64` guard lands at (group 0, binding 1) automatically.
const fp64MercatorTilesModule = module({
  funcs: [vs, fsTiles],
  uses: [U, VsOut],
})

// DF64Vec2 std140 buffer order is PLANE-major: [hi.x, hi.y, lo.x, lo.y].
const [HX, LX] = splitF64(SEOUL_X)
const [HY, LY] = splitF64(SEOUL_Y)

export const fp64MercatorTiles: ShaderExample = {
  id: 'fp64-mercator-tiles',
  title: 'fp64 Mercator tiles',
  blurb:
    'The tile-engine formula itself: normalized Web-Mercator (Seoul) × 2^z, floor → tile index, fract → in-tile uv. One f32 ulp of x ≈ 0.85 is 27 px at tile-z 21, so the plain-f32 left half smears tiles into blocks while the f64 right half keeps crisp borders through z 23. The 2^z scale is built by exact repeated doubling — the multiply is free; only the fraction ever needed extended precision. Wheel through zoom levels and flip the fp64 toggle to compare.',
  category: 'cartographic',
  file: 'fp64-mercator-tiles.ts',
  module: fp64MercatorTilesModule,
  renderable: true,
  splitLabels: ['f32', 'f64 (emulated)'],
  controls: {
    center: { kind: 'const', value: [HX, HY, LX, LY] },
    resolution: { kind: 'resolution' },
    tile_z: {
      kind: 'slider',
      label: 'Tile zoom z',
      min: 12,
      max: 23,
      step: 1,
      value: 16,
      wheel: true,
    },
    fp64: { kind: 'toggle', label: 'fp64 emulation', value: true },
  },
}
