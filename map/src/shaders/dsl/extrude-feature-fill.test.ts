// #1252 — data-driven fill + extrusion. The extrude colour is computed in the
// VERTEX shader (vs_main_ecef_extruded bakes u.fill_color × MapLibre lighting
// into v_color), while data-driven colour lives in the FRAGMENT (feat_data[fid]
// via variant.fillExpr). This gate pins the composer seam that bridges them:
// fs_fill_extrude carries a 'fill-extrude-return' placeholder swapped to either
//   - the constant pass-through (default: out.color = v_ext_color), OR
//   - the data-driven re-lighting (variant: fillExpr base × interpolated
//     geometric shade), which is what lets a gradient()/match() fill extrude.
//
// A regression here is exactly the pre-#1252 failure mode (feature bind group
// against a base-layout extruded pipeline → per-frame validation flood, black
// layer), so freezing the emitted shape keeps the fix wired.

import { describe, it, expect } from 'vitest'
import { emitPolygonWgsl, type PolygonVariantSpec } from './polygon'
import { vec4, f32 } from '@xgis/shader-dsl'

/** Extract the body of a WGSL `fn <entry>(...)` by brace-matching. */
function fnBody(wgsl: string, entry: string): string {
  const i = wgsl.indexOf(`fn ${entry}(`)
  if (i < 0) return `(no ${entry})`
  let depth = 0
  let j = wgsl.indexOf('{', i)
  const start = j
  for (; j < wgsl.length; j++) {
    if (wgsl[j] === '{') depth++
    else if (wgsl[j] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return wgsl.slice(start, j + 1)
}

// A non-null fillExpr is all the extrude return path needs to take the
// data-driven branch (a vec4 construct stands in for the feat_data lookup).
const featureVariant: PolygonVariantSpec = {
  preamble: null,
  fillExpr: vec4(f32(0.5), f32(0.2), f32(0.8), f32(1)) as never,
  strokeExpr: null,
  fillPreamble: null,
  strokePreamble: null,
  needsFeatureBuffer: true,
}

describe('#1252 data-driven extrude fragment', () => {
  it('the NULL variant passes v_color through unchanged (constant path byte-identical)', () => {
    const body = fnBody(emitPolygonWgsl(null, false), 'fs_fill_extrude')
    // The constant path binds v_ext_color from the v_color varying and returns it
    // (× rim) — the pre-#1252 `out.color = input.v_color` behaviour, unchanged.
    expect(body).toContain('let v_ext_color = input.v_color')
    expect(body).toContain('out.color = v_ext_color')
    // It must NOT re-light (no per-fragment base-colour lighting on the constant path).
    expect(body).not.toContain('ext_base')
  })

  it('a data-driven variant re-lights the sampled base colour in the fragment', () => {
    const body = fnBody(emitPolygonWgsl(featureVariant, false), 'fs_fill_extrude')
    // The base colour is bound from fillExpr, then re-lit against the interpolated
    // geometric shade (shade_geom.x = d_geom, .y = vgrad_factor) + the light uniforms
    // — the exact lighting the constant path bakes per-vertex, now per-fragment.
    expect(body).toContain('let ext_base =')
    expect(body).toContain('input.shade_geom')
    expect(body).toContain('u.light_dir_ecef.w') // light intensity
    expect(body).toContain('unpack4x8unorm(u.light_color_packed)') // light colour
    // luminance-weighted mix (the MapLibre directional highlight boost).
    expect(body).toContain('0.2126')
    // The constant pass-through must NOT survive when a fillExpr is present.
    expect(body).not.toContain('out.color = v_ext_color')
  })

  it('the fragment reads shade_geom ONLY on the data-driven path (constant DCEs it)', () => {
    // The constant fragment reads only v_color, so the optimizer drops its
    // `v_ext_shade = input.shade_geom` bind — no wasted work. The data-driven
    // fragment re-lights against shade_geom, so the read survives there.
    const nullFs = fnBody(emitPolygonWgsl(null, false), 'fs_fill_extrude')
    const featFs = fnBody(emitPolygonWgsl(featureVariant, false), 'fs_fill_extrude')
    expect(nullFs).not.toContain('shade_geom')
    expect(featFs).toContain('input.shade_geom')
  })
})
