// ═══ Shader DSL — raster colour-adjustment helpers (DSL-authored) ═══
//
// Mapbox `raster-*` colour paint applied to the sampled texel: hue-rotate,
// brightness min/max, saturation, contrast. Math mirrors MapLibre's
// raster.fragment.glsl; the per-show FACTORS are derived on the GPU from the raw
// param values (uniform carries [hueDeg, bMin, bMax, saturation] + [contrast]).
// DEFAULTS are a hard no-op (hue=0 / bmin=0,bmax=1 / sat=0 / contrast=0 → texel
// unchanged). Authored as DSL fns (was hand-written WGSL); RASTER_COLOR_WGSL_FNS is
// now derived by emitting them — raster.ts imports the same name, no call-site change.
// Reads DEG2RAD_F (declared by ECEF_CONSTS, emitted before this block in raster.ts).

import {
  fn, f32, f32T, vec3, vec3fT, vec4fT, sin, cos, dot, select, clamp, constRef,
  Let, Var, assign, callFn,
  type FuncDecl,
} from '../core/ir'
import { emitFuncsCsed } from '../core/backends/wgsl'

const rasterSpinWeights = fn('raster_spin_weights', { angle_rad: f32T }, vec3fT, (p, _b) => {
  const s = sin(p.angle_rad)
  const c = cos(p.angle_rad)
  const sqrt3 = f32(1.7320508075688772)
  const w0 = f32(2).mul(c).add(1).div(3)
  const w1 = sqrt3.neg().mul(s).sub(c).add(1).div(3)
  const w2 = sqrt3.mul(s).sub(c).add(1).div(3)
  return vec3(w0, w1, w2)
})

const rasterColorAdjust = fn('raster_color_adjust', { rgb_in: vec3fT, p0: vec4fT, p1: vec4fT }, vec3fT, (p, _b) => {
  const hueDeg = p.p0.x
  const brightnessLow = p.p0.y
  const brightnessHigh = p.p0.z
  const saturation = p.p0.w
  const contrast = p.p1.x
  const rgb = Var('rgb', vec3fT, p.rgb_in)

  // Hue rotate — spin the RGB vector by the w.xyz / w.zxy / w.yzx swizzle weights.
  const w = callFn('raster_spin_weights', vec3fT, hueDeg.mul(constRef('DEG2RAD_F')))
  assign(rgb, vec3(dot(rgb, w), dot(rgb, w.zxy), dot(rgb, w.yzx)))

  // Brightness remap — low + (high-low)*rgb (per component). Expanded rather than mix()
  // because the DSL mix() interpolant is typed scalar, not a vec. f64-equivalent to WGSL
  // mix(low,high,rgb); the f32 result may differ by <1 ulp (mix may fma), far below the
  // 1/255 framebuffer quantization floor, so it cannot move a rendered pixel.
  assign(rgb, vec3(brightnessLow).add(vec3(brightnessHigh).sub(vec3(brightnessLow)).mul(rgb)))

  // Saturation — rgb += (average - rgb) * factor; factor 0 (default) is the identity.
  const satFactor = select(saturation.gt(0), f32(1).sub(f32(1).div(f32(1.001).sub(saturation))), saturation.neg())
  const avg = Let('avg', rgb.x.add(rgb.y).add(rgb.z).div(3))
  assign(rgb, rgb.add(vec3(avg).sub(rgb).mul(satFactor)))

  // Contrast — factor 1 (default) is the identity.
  const contrastFactor = select(contrast.gt(0), f32(1).div(f32(1).sub(contrast)), f32(1).add(contrast))
  assign(rgb, rgb.sub(vec3(f32(0.5))).mul(contrastFactor).add(vec3(f32(0.5))))

  return clamp(rgb, vec3(f32(0)), vec3(f32(1)))
})

export const RASTER_COLOR_FUNCS: FuncDecl[] = [rasterSpinWeights, rasterColorAdjust]

export const RASTER_COLOR_WGSL_FNS = `${emitFuncsCsed(RASTER_COLOR_FUNCS)}\n`
