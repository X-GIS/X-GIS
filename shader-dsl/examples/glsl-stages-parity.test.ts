// ═══ emitGlslStages ≡ two emitGlslModule calls (byte-identity gate) ═══
//
// `emitGlslStages` exists to pay the IR half of a GLSL emit ONCE per module instead of
// once per stage: `lowerForGlsl` runs validate → autoVars → lowerModule → fp64Lower →
// the optimizer FIXPOINT, and on a heavy fragment (map's multidirectional hillshade,
// ~770 ms per emit) that dominates. It is only a legal substitution if the shared
// lowered module spells IDENTICALLY to two independently-lowered ones, which needs two
// properties that are easy to break silently:
//
//   1. the lowering is DETERMINISTIC (same authored module in → same lowered out), and
//   2. the spelling half does NOT mutate the lowered module it reads — otherwise the
//      SECOND stage in emitGlslStages sees a module the first one edited, and only the
//      fragment (emitted second) would drift.
//
// Asserting BOTH stages over the whole renderable example corpus catches either one:
// a mutating emitter shows up as a fragment mismatch, a non-deterministic lowering as
// a vertex mismatch. This is the gate the WGSL/GLSL goldens cannot give — they pin what
// `emitGlslModule` produces, not that the shared-lowering path agrees with it.

import { describe, it, expect } from 'vitest'
import { examples } from './index.ts'
import { emitGlslModule, emitGlslStages } from '../src/index.ts'

describe('emitGlslStages — shared lowering is byte-identical to per-stage lowering', () => {
  const renderable = examples.filter((e) => e.renderable)

  it('covers a real corpus (a registry that stops being renderable must not silently skip)', () => {
    expect(renderable.length).toBeGreaterThanOrEqual(2)
  })

  for (const ex of renderable) {
    it(`${ex.id}: both stages match emitGlslModule byte-for-byte`, () => {
      const both = emitGlslStages(ex.module)
      expect(both.vertex).toBe(emitGlslModule(ex.module, 'vertex'))
      expect(both.fragment).toBe(emitGlslModule(ex.module, 'fragment'))
    })
  }

  it('is idempotent — a second call over the same authored module emits the same bytes', () => {
    // Guards the other direction of the mutation hazard: `lowerForGlsl` must not edit
    // the AUTHORED module either, or the second pipeline built from a memoised module
    // (exactly what a draper does for its pick variant) would diverge from the first.
    const ex = renderable[0]!
    const a = emitGlslStages(ex.module)
    const b = emitGlslStages(ex.module)
    expect(b.vertex).toBe(a.vertex)
    expect(b.fragment).toBe(a.fragment)
  })
})
