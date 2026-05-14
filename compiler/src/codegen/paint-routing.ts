// ═══════════════════════════════════════════════════════════════════
// Paint routing analyzer — pick execution path per paint value
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 4 step 2 (wild-finding-starlight). Consolidates the
// decision "where does this paint value get evaluated?" into one
// pure function. Every consumer (shader-gen variant emit, runtime
// per-frame resolve, future P4 compute kernel dispatch) consults
// the same route enum so the four execution paths stay disjoint:
//
//   - InlineConstant — `deps == NONE`. Value is bakedin as a WGSL
//     literal at shader compile time. No per-frame work.
//
//   - PaletteZoom — `deps ⊆ {ZOOM}` AND the palette pool actually
//     contains this gradient (P3 Step 1 collected it). Fragment
//     shader samples the rgba16float atlas via textureSampleLevel.
//     No CPU resolve.
//
//   - ComputeFeature — `deps` includes FEATURE. The full P4 vision
//     dispatches a compute kernel per show + binds the output to
//     the fragment shader. Today the router emits the route signal
//     but the runtime still uses the legacy fragment-side feat_data
//     path; the signal is here so shader-gen can flip to compute
//     emission when the runtime wiring lands.
//
//   - CpuUniform — `deps` includes TIME / zoom-time / conditional /
//     anything else not handled above. Bucket-scheduler's
//     `resolveColorShape` evaluates per frame; CPU writes the
//     result into `u.fill_color` / `u.stroke_color`. Slowest path
//     but covers every Mapbox spec construct.
//
// Decision precedence (first match wins):
//
//   1. ColorValue.kind === 'none'    → InlineConstant (alpha 0)
//   2. ColorValue.kind === 'constant'→ InlineConstant
//   3. deps includes FEATURE         → ComputeFeature
//   4. deps === ZOOM && palette hit  → PaletteZoom
//   5. otherwise                     → CpuUniform
//
// FEATURE wins over ZOOM because zoom × feature interp is the same
// implementation as feature-only — the kernel reads `u.zoom` as a
// uniform alongside `feat_data[fid]`. PaletteZoom is a strict
// subset that needs no per-feature lookup, so it can use the
// gradient atlas exclusively.
//
// What this module does NOT do:
//
//   - Emit any WGSL. shader-gen / compute-gen consume the route and
//     produce the actual code.
//   - Decide CSE membership. P0 cse.ts identifies shared subtrees;
//     paint-routing decides the per-paint-axis path.
//   - Mutate the IR. Pure derivation from input.

import type { ColorValue } from '../ir/render-node'
import type { PropertyShape } from '../ir/property-types'
import type { Palette } from './palette'
import {
  Dep,
  DEPS_ZOOM,
  hasDep,
  getColorDeps,
  getPropertyShapeDeps,
  type DepBits,
} from '../ir/deps'

/** Discriminated route signal. `kind` picks the execution path;
 *  the additional fields carry the data downstream emitters need
 *  (palette gradient index for PaletteZoom, etc.). */
export type PaintRoute =
  | { kind: 'inline-constant'; deps: DepBits }
  | { kind: 'palette-zoom'; gradientIndex: number; deps: DepBits }
  | { kind: 'compute-feature'; deps: DepBits }
  | { kind: 'cpu-uniform'; deps: DepBits }

/** Route a ColorValue. Caller MUST pass the scene-level Palette if
 *  it wants `palette-zoom` to fire; omitting it forces the legacy
 *  `cpu-uniform` path for zoom-interpolated colours. */
export function routeColorValue(
  value: ColorValue,
  palette?: Palette,
): PaintRoute {
  const deps = getColorDeps(value)

  if (value.kind === 'none' || value.kind === 'constant') {
    return { kind: 'inline-constant', deps }
  }

  // Precedence: FEATURE beats ZOOM. Compute kernel reads both
  // feat_data + uniform zoom in one pass; PaletteZoom skips the
  // per-feature lookup entirely.
  if (hasDep(deps, Dep.FEATURE)) {
    return { kind: 'compute-feature', deps }
  }

  if (deps === DEPS_ZOOM && value.kind === 'zoom-interpolated' && palette) {
    const idx = palette.findColorGradient({
      stops: value.stops,
      base: value.base ?? 1,
    })
    if (idx >= 0) return { kind: 'palette-zoom', gradientIndex: idx, deps }
  }

  return { kind: 'cpu-uniform', deps }
}

/** Route a numeric PropertyShape (opacity / strokeWidth / size /
 *  haloWidth / haloBlur / fontWeight). Scalar palette routing is
 *  not wired yet (P3 ships colour atlas only — scalar atlas
 *  deferred until r32float-vs-filterable lands), so the only path
 *  for ZOOM-only scalars today is `cpu-uniform`. The router
 *  surfaces the analysis so shader-gen + future compute paths
 *  agree without recomputing deps. */
export function routePropertyShape<T>(
  shape: PropertyShape<T>,
): PaintRoute {
  const deps = getPropertyShapeDeps(shape)

  if (shape.kind === 'constant') {
    return { kind: 'inline-constant', deps }
  }

  if (hasDep(deps, Dep.FEATURE)) {
    return { kind: 'compute-feature', deps }
  }

  // No scalar palette atlas yet — ZOOM-only stays on CPU.
  return { kind: 'cpu-uniform', deps }
}

/** Convenience predicate: true when the route would benefit from
 *  P4 compute kernel emission. Used to gate scene-wide
 *  ComputeDispatcher setup ("is any paint axis feature-driven?"). */
export function routeIsCompute(route: PaintRoute): boolean {
  return route.kind === 'compute-feature'
}

/** Convenience predicate: true when this route reads from the P3
 *  palette atlas. Used by bind-group construction to decide whether
 *  the palette texture + sampler must be attached. */
export function routeIsPalette(route: PaintRoute): boolean {
  return route.kind === 'palette-zoom'
}
