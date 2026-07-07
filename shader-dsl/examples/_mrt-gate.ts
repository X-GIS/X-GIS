// ═══ @xgis/shader-dsl — MRT gate module (#847) ═══
//
// NOT a gallery example (underscore prefix, not in index.ts): a minimal
// multi-render-target module that exists to PROVE the multi-@location
// fragment-output path end-to-end. The fragment returns an ioStruct with two
// @location fields — WGSL carries the attributes on the struct, and the GLSL
// backend scatters them into `layout(location = N) out` draw buffers.
//
// The outputs are deterministic gradients so the render gate can verify each
// attachment numerically: color0 encodes uv.x in red, color1 encodes uv.y in
// green — a swapped, dropped, or blended attachment cannot pass both checks.
// Consumed by examples/mrt.test.ts (emit shape) and
// playground/e2e/_shader-dsl-mrt-render.spec.ts (real-WebGL2 two-attachment
// draw + readback).

import { fn, module, ioStruct, vec4, location, vec4fT } from '../src/index.ts'
import { VsOut, vs } from './_fullscreen.ts'

const FsOut = ioStruct('FsOut', {
  color0: location(0, vec4fT),
  color1: location(1, vec4fT),
})

const fs = fn(
  'fs',
  { vo: VsOut },
  ({ vo }) => {
    const uv = vo.uv
    return FsOut.construct({
      color0: vec4(uv.x, 0.25, 0, 1),
      color1: vec4(0, uv.y, 0.75, 1),
    })
  },
  { stage: 'fragment' },
)

export const mrtGateModule = module({
  structs: [VsOut.decl, FsOut.decl],
  funcs: [vs, fs],
})
