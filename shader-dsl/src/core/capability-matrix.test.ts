// ═══ capabilityMatrix — the capability × backend table, DERIVED (#1717) ═══
//
// #1717 Ask 2 asked for this as a documentation page. It is a function instead, because
// #1700 already records three authorities describing this API and a hand-written table
// would be the fourth — one nothing checks against a `capProfile`. These arms are what
// make "derived" mean something: the matrix must agree with the profiles row for row, and
// it must not silently shrink when the vocabulary grows.

import { describe, it, expect } from 'vitest'
import { capabilityMatrix } from './backend'
import { ALL_CAPABILITIES } from './ir'
import { wgslBackend } from './backends/wgsl'
import { glslEs300Backend } from './backends/glsl'

const BACKENDS = [wgslBackend, glslEs300Backend]
const matrix = capabilityMatrix(BACKENDS)
const rowFor = (c: string) => matrix.find((r) => r.capability === c)!

describe('capabilityMatrix — one row per capability, one column per backend', () => {
  it('covers the WHOLE vocabulary, in ALL_CAPABILITIES order', () => {
    expect(matrix.map((r) => r.capability)).toEqual([...ALL_CAPABILITIES])
  })

  it('agrees with each backend capProfile row for row — it is derived, not transcribed', () => {
    // The non-vacuity that matters: recompute the expected kind straight from the profile
    // and require the matrix to match. A matrix that returned 'unsupported' everywhere, or
    // that dropped a backend, fails here rather than reading as a plausible table.
    for (const be of BACKENDS)
      for (const cap of ALL_CAPABILITIES) {
        const row = be.capProfile[cap]
        const expected =
          row === undefined
            ? 'unsupported'
            : row.directive
              ? 'directive'
              : row.hostFeature
                ? 'host-feature'
                : 'native'
        expect(rowFor(cap).support[be.id], `${be.id} / ${cap}`).toBe(expected)
      }
  })

  it('the two profiles genuinely DISAGREE somewhere', () => {
    // Otherwise the arm above would pass over a matrix that ignored its backend argument.
    const disagreements = ALL_CAPABILITIES.filter(
      (c) => rowFor(c).support['wgsl'] !== rowFor(c).support['glsl-es300'],
    )
    expect(disagreements.length).toBeGreaterThan(0)
  })

  it('marks the three DERIVED caps as not declarable', () => {
    // `DeclarableCapability` (#1681 A2) makes naming one in `enables` a compile error; the
    // matrix has to report the same taxonomy or a doc rendered from it would invite the
    // mistake the type system already forbids.
    for (const c of ['storageBuffer', 'compute', 'msaaTextureLoad'] as const)
      expect(rowFor(c).declarable).toBe(false)
    for (const c of ['f16', 'floatRenderTarget', 'multiview'] as const)
      expect(rowFor(c).declarable).toBe(true)
  })

  it('the documented unreachable trio is visible as SUPPORTED but unusable', () => {
    // f16 / subgroups / multiview are declarable and emit a directive, yet nothing can be
    // authored with them (capability-reachability.test.ts's allowlist, #1681 A3). The
    // matrix reports support honestly; a renderer must pair it with that allowlist rather
    // than let a reader conclude the DSL can do multiview.
    expect(rowFor('f16').support['wgsl']).toBe('directive')
    expect(rowFor('multiview').support['glsl-es300']).toBe('directive')
    expect(rowFor('multiview').support['wgsl']).toBe('unsupported')
  })

  it('an empty backend list yields rows with no columns, not an empty matrix', () => {
    const bare = capabilityMatrix([])
    expect(bare.length).toBe(ALL_CAPABILITIES.length)
    expect(Object.keys(bare[0]!.support)).toEqual([])
  })
})
