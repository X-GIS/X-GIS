// ═══ @xgis/shader-dsl example — discard cutout (#1840 GLSL-legalize coverage) ═══
//
// A fragment helper discards outside a centred circle and returns the fill colour;
// the fragment stage calls it ONCE, as the sole argument of the fragment IO-struct's
// `.construct({...})` — the exact shape ANGLE's D3D11 backend miscompiles when the
// discarding call is left inline in a GLSL struct constructor (glsl-legalize.ts,
// #1840). This example's GLSL golden pins the `_dh0` local the legalize pass
// hoists it into; the WGSL golden stays the untouched inline call (WGSL has no
// such backend bug, so it is byte-untouched by design).

import {
  fn,
  module,
  ioStruct,
  vec3,
  vec4,
  location,
  vec2fT,
  vec4fT,
  If,
  Discard,
  Let,
  length,
  mix,
} from '../src/index.js'
import { VsOut, vs, fullscreenUniforms, screenCoords } from './_fullscreen.js'
import type { ShaderExample } from './_shared.js'

const U = fullscreenUniforms()

const FsOut = ioStruct('FsOut', { color: location(0, vec4fT) })

// Discards outside the unit circle; inside, a radial gradient from a bright
// centre to a dim rim.
const discardOutsideCircle = fn('discard_outside_circle', { p: vec2fT }, ({ p }) => {
  const r = Let(length(p))
  If(r.gt(1), () => {
    Discard()
  })
  return vec4(mix(vec3(1, 1, 1), vec3(0.06, 0.1, 0.35), r), 1)
})

const fs = fn(
  'fs',
  { vo: VsOut },
  ({ vo }) => {
    const p = screenCoords(vo.uv, U.field.resolution)
    return FsOut.construct({ color: discardOutsideCircle({ p }) })
  },
  { stage: 'fragment' },
)

const discardCutoutModule = module({
  structs: [U.struct, VsOut.decl, FsOut.decl],
  bindings: [U.binding],
  funcs: [vs, fs],
})

export const discardCutout: ShaderExample = {
  id: 'discard-cutout',
  title: 'Discard cutout',
  blurb:
    "A fragment helper discards outside a centred circle and returns the fill colour, called once as the fragment IO-struct's constructor argument — the exact shape ANGLE's D3D11 backend miscompiles when left inline (#1840). Renders a clean circular cutout with a radial centre-to-rim gradient.",
  category: 'generic',
  file: 'discard-cutout.ts',
  module: discardCutoutModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
  },
}
