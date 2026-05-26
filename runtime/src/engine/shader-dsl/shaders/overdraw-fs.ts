// ═══ Shader DSL — overdraw debug fragment shader (Phase 4+ migration) ═══
//
// Single fragment entry that every debug-overdraw pipeline appends to
// its vertex stage. Each fragment writes 1.0 to the red channel; the
// compose pass (shader-dsl/shaders/overdraw-compose.ts) divides by an
// exposure constant before applying the colormap.
//
// Previously inlined in runtime/src/engine/debug-flags.ts as the
// `OVERDRAW_FS_SOURCE` wgsl-tag template. The DSL module here emits
// the SAME WGSL — `debug-flags.ts:OVERDRAW_FS_SOURCE` is now a const
// initialised by calling `emitOverdrawFsWgsl()`, so consumers
// (background-renderer + every other debug pipeline) need no change.

import { entryFn, module, f32, vec4, vec4fT, type ModuleDecl } from '../core/ir'
import { emitModule } from '../core/backends/wgsl'

const fsOverdraw = entryFn(
  'fs_overdraw', 'fragment', [], vec4fT,
  (b) => { b.ret(vec4(f32(1), f32(0), f32(0), f32(0))) },
  '@location(0)',
)

const overdrawFsModule: ModuleDecl = module({ funcs: [fsOverdraw] })

export const emitOverdrawFsWgsl = (): string => emitModule(overdrawFsModule)
