// ═══ @xgis/shader-dsl example — fp64 world-plane checkerboard ═══
//
// The map-engine failure mode in its purest form: a 1×1-unit checkerboard on
// a world plane, viewed 100 million units from the origin (ulp_f32(1e8) = 8 —
// EIGHT whole cells wide). The tile grid is recovered with floor/fract ON THE
// f64 TYPE (both are in the df64 whitelist): parity = fract((⌊x⌋+⌊y⌋)/2)
// stays exact because ⌊x⌋ at 1e8 does not FIT in an f32 — narrowing first is
// precisely the bug. The plain-f32 left half only ever sees the coordinate in
// 8-cell steps — parity never flips and the checker collapses FLAT; the f64
// right half stays a crisp checkerboard with anti-aliased cell borders.
//
// The `_fp64` guard uniform is auto-injected by the lowering; the render
// harnesses bind it to 1.0f by probing the program for the Fp64Guard block.

import {
  fn,
  module,
  vec3,
  vec4,
  f32,
  pow,
  floor,
  fract,
  min,
  mix,
  step,
  smoothstep,
  toF32,
  toF64,
  f32T,
  vec2fT,
  vec2f64T,
  Let,
  uniformStruct,
} from '../src/index.ts'
import { VsOut, vs } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'

const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'u' },
  {
    center: vec2f64T, // one DF64Vec2 slot — host packs [hi.x, hi.y, lo.x, lo.y]
    resolution: vec2fT,
    zoom_exp: f32T, // view span = 10^-zoom_exp world units (negative = zoom out)
    fp64: f32T, // toggle: 1 = split-screen f32 | f64 (canonical), 0 = all-f32
  },
)

const fsChecker = fn(
  'fs_checker',
  { vo: VsOut },
  (p) => {
    const span = Let(pow(f32(10.0), U.field.zoom_exp.neg()))
    const half = Let(p.vo.uv.x.mul(2.0))
    const sx = Let(half.sub(p.vo.uv.x.lt(0.5).select(0.0, 1.0)))
    const dx = Let(sx.sub(0.5).mul(span))
    const dy = Let(
      p.vo.uv.y.sub(0.5).mul(span).mul(U.field.resolution.y.div(U.field.resolution.x).mul(2.0)),
    )

    const isF32 = Let(p.vo.uv.x.lt(0.5).or(U.field.fp64.lt(0.5)))
    // f64 path — floor/fract in extended precision; only RESULTS narrow
    // (cell parity is 0/0.5 exactly; the in-cell fraction is sub-unit).
    const px = Let(U.field.center.x.add(toF64(dx)))
    const py = Let(U.field.center.y.add(toF64(dy)))
    const par64 = Let(toF32(fract(floor(px).add(floor(py)).mul(0.5))))
    const fx64 = Let(toF32(fract(px)))
    const fy64 = Let(toF32(fract(py)))
    // f32 twin — SAME formulas, world coordinate narrowed first: at 1e8 the
    // coordinate moves in 8-cell steps, so parity NEVER flips (always even)
    // and the fraction is identically 0 — the half renders flat.
    const px32 = Let(toF32(U.field.center.x).add(dx))
    const py32 = Let(toF32(U.field.center.y).add(dy))
    const par32 = Let(fract(floor(px32).add(floor(py32)).mul(0.5)))
    const fx32 = Let(fract(px32))
    const fy32 = Let(fract(py32))

    const par = Let(isF32.select(par32, par64))
    const fx = Let(isF32.select(fx32, fx64))
    const fy = Let(isF32.select(fy32, fy64))

    // Two-tone slate/ivory checker + anti-aliased cell borders. The AA width
    // comes from the analytic pixel size in WORLD units (span / half-width in
    // px) — fwidth(fract(x)) would spike across the cell seam itself.
    const chk = Let(step(0.25, par))
    const edge = Let(min(min(fx, f32(1).sub(fx)), min(fy, f32(1).sub(fy))))
    const pixw = Let(span.div(U.field.resolution.x.mul(0.5)))
    const line = Let(smoothstep(f32(0), pixw.mul(1.5).add(1e-9), edge))
    const ivory = vec3(0.93, 0.9, 0.82)
    const slate = vec3(0.23, 0.29, 0.36)
    const rgb = mix(ivory, slate, chk).mul(mix(f32(0.35), f32(1.0), line))
    return vec4(rgb, f32(1))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// `_fp64` guard lands at (group 0, binding 1) automatically.
const fp64CheckerPlaneModule = module({
  funcs: [vs, fsChecker],
  uses: [U, VsOut],
})

export const fp64CheckerPlane: ShaderExample = {
  id: 'fp64-checker-plane',
  title: 'fp64 checker plane',
  blurb:
    'A 1-unit checkerboard on a world plane. Drag the DISTANCE slider (or wheel) to carry the plane out from the origin: near 10⁶ both halves are a crisp checker, but past ~10⁷·² one f32 ulp grows wider than a cell and the plain-f32 left half collapses flat (parity can no longer flip) — while the f64 right half, doing floor/fract on the emulated-double type, keeps cell parity and anti-aliased borders all the way to 10⁹. Watch the exact distance where f32 gives out; flip the fp64 toggle to collapse the right half too.',
  category: 'cartographic',
  file: 'fp64-checker-plane.ts',
  module: fp64CheckerPlaneModule,
  renderable: true,
  splitLabels: ['f32', 'f64 (emulated)'],
  controls: {
    // Sweep the plane's distance from the origin: base·10^mag + offset (the
    // fractional offset is the sub-cell detail f32 loses first). At mag = 8 this
    // is the classic 10⁸ view; drop to 6 and f32 is fine — the point is the
    // THRESHOLD in between, which the viewer drives.
    center: { kind: 'logmag2d', magField: 'mag', base: [1, 0.5], offset: [0.3, 0.7] },
    resolution: { kind: 'resolution' },
    mag: {
      kind: 'slider',
      label: 'Distance from origin 10^x',
      min: 4,
      max: 9,
      step: 0.02,
      value: 6,
      wheel: true,
    },
    // View span across each half (10^-zoom_exp world units ≈ number of cells).
    zoom_exp: {
      kind: 'slider',
      label: 'Zoom 10^-x',
      min: -2,
      max: 5,
      step: 0.05,
      value: -0.9,
    },
    fp64: { kind: 'toggle', label: 'fp64 emulation', value: true },
  },
}
