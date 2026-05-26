// ═══ Shader DSL — shared FrameUniform struct (Phase 4+ migration) ═══
//
// Re-authors the WGSL_FRAME_UNIFORM struct previously inlined in
// runtime/src/engine/gpu/frame-uniform.ts. Renderers concatenate the
// emitted string into their own WGSL — the byte layout (128 bytes;
// mvp@0 / proj_params@64 / viewport@80 / _pad@96) stays version-
// locked with the CPU writer in frame-uniform.ts's `setFrame()`.
//
// CPU writer (Float32Array.set + index assignments) is the source of
// truth for the layout — see FrameUniform.setFrame mapping at u[0..15]
// for mvp, u[16..19] for proj_params, u[20..23] for viewport, u[24..27]
// for _pad.

import { module, mat4x4fT, vec4fT, type StructDecl, type ModuleDecl } from '../core/ir'
import { emitModule } from '../core/backends/wgsl'

const FrameUniform: StructDecl = {
  name: 'FrameUniform',
  fields: [
    { name: 'mvp', type: mat4x4fT },
    // x=type, y=centerLon, z=centerLat, w=log_depth_fc
    { name: 'proj_params', type: vec4fT },
    // x=w_px, y=h_px, z=meters_per_pixel, w=dpr
    { name: 'viewport', type: vec4fT },
    // reserved for future shared globals
    { name: '_pad', type: vec4fT },
  ],
}

const frameUniformModule: ModuleDecl = module({ structs: [FrameUniform] })

export const emitFrameUniformWgsl = (): string => emitModule(frameUniformModule)
