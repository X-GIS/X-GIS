// ═══ Fullscreen-VS twin parity gate (#929 B) ═══
//
// compute-webgl2.ts authors its fullscreen-triangle vertex shader LOCALLY so
// the adapter carries no @xgis/engine value import. The duplication is made
// verified-by-construction here: the local twin's GLSL vertex emit must stay
// BYTE-IDENTICAL to the engine's proven overdraw-compose vs_full emit (the
// entry _compute-dispatch-parity validated on a real WebGL2 GPU). A drift on
// EITHER side fails this gate — fix the twin, don't loosen the assertion.
//
// (Test files are exempt from the dependency-direction ratchet, so the
// @xgis/engine import below is legal here and only here.)

import { describe, expect, it } from 'vitest'
import { emitGlslModule } from '@xgis/shader-dsl'
import { overdrawComposeModule } from '@xgis/engine'
import { fullscreenVsModule } from './compute-webgl2'

describe('compute-webgl2 fullscreen-VS twin (#929 B)', () => {
  it('local vs_full emit is byte-identical to the engine overdraw-compose emit', () => {
    const local = emitGlslModule(fullscreenVsModule, 'vertex')
    const engine = emitGlslModule(overdrawComposeModule, 'vertex')
    expect(local).toBe(engine)
  })
})
