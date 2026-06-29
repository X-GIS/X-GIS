// Drift guard: the line shader's HAND-CODED uniform sizes must equal what
// reflect(buildLineModule()) reports — so a future LineLayer / TileUniforms
// field change can't silently desync the CPU packer from the GPU struct (the
// std140-drift class the polygon path retired; see polygon-uniform-offset-
// parity.test.ts + line-uniform-slots.ts).
//
// Two line sizes are UNAVOIDABLY eager (so they can't just be read lazily from
// reflect): `LINE_UNIFORM_SIZE` (line-pattern.ts) backs a MODULE-SCOPE scratch
// Float32Array, and `LineRenderer.LAYER_SLOT` is a `static` ring stride — both
// evaluate before configureProjections() and would throw if they called reflect
// directly (the map-load-crash class, see no-eager-uniform-reflect.test.ts). So
// they stay literals, and THIS guard locks them to the reflected truth instead.

import { describe, it, expect } from 'vitest'
import { reflect } from '@xgis/shader-dsl'
import { buildLineModule } from '../shaders/dsl/line'
import { uniformFieldSlots } from './reflection-to-webgpu'
import { lineLayerUniformBytes, lineLayerUniformStride } from './line-uniform-slots'
import { polygonUniformBytes } from './polygon-uniform-slots'
import { LINE_UNIFORM_SIZE } from './line-pattern'
import { LineRenderer } from './line-renderer'

describe('line uniform sizes — reflect parity (drift guard)', () => {
  it('LINE_UNIFORM_SIZE literal equals the reflected LineLayer byte size', () => {
    // line-pattern.ts's eager `LINE_UNIFORM_SIZE` (module-scope scratch) must match
    // reflect(buildLineModule()).LineLayer. If LineLayer grows, this fails and the
    // literal + scratch must be updated together.
    expect(LINE_UNIFORM_SIZE).toBe(lineLayerUniformBytes())
  })

  it('LineRenderer.LAYER_SLOT ring stride equals the reflected LineLayer stride', () => {
    // The `static` LAYER_SLOT (256) is align(LineLayer, 256). Correct only while
    // LineLayer ≤ 256; if it grows past 256 the stride must become 512 and the
    // static literal would silently truncate every layer slot — this catches it.
    const layerSlot = (LineRenderer as unknown as { LAYER_SLOT: number }).LAYER_SLOT
    expect(layerSlot).toBe(lineLayerUniformStride())
  })

  it('line TileUniforms (group 0) byte-mirrors the polygon Uniforms struct', () => {
    // The line VS shares group(0) with VTR's polygon bind group, so line.ts's
    // TileUniforms MUST match polygon Uniforms field offsets / size exactly (see
    // the TileUniforms doc in line.ts). Lock the invariant to both reflect sources.
    const tileBytes = uniformFieldSlots(reflect(buildLineModule(false)), 'TileUniforms').slots * 4
    expect(tileBytes).toBe(polygonUniformBytes())
  })
})
