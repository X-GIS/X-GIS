// ═══ Shader DSL — overdraw debug fragment shader (Phase 4+ migration) ═══
//
// Single fragment entry that every debug-overdraw pipeline appends to
// its vertex stage. Each fragment writes 1.0 to the red channel; the
// compose pass (runtime/src/engine/shaders/dsl/overdraw-compose.ts) divides by an
// exposure constant before applying the colormap.
//
// Previously inlined in runtime/src/engine/debug-flags.ts as the
// `OVERDRAW_FS_SOURCE` wgsl-tag template. The DSL module here emits
// the SAME WGSL — `debug-flags.ts:OVERDRAW_FS_SOURCE` is now a const
// initialised by calling `emitOverdrawFsWgsl()`, so consumers
// (background-renderer + every other debug pipeline) need no change.

import { fn, module, vec4, Return, type ModuleDecl } from '@xgis/shader-dsl'
import { emitModule } from '@xgis/shader-dsl'

const fsOverdraw = fn(
  'fs_overdraw',
  {},
  (_p) => {
    Return(vec4(1, 0, 0, 0))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const overdrawFsModule: ModuleDecl = module({ funcs: [fsOverdraw] })

export const emitOverdrawFsWgsl = (): string => emitModule(overdrawFsModule)
