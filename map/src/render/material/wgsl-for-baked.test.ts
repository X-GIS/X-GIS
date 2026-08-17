// ═══ The emit seam's optional baked id — serve, fall through, and never mix (#1679) ═══
//
// Increment 3 gave `wgslFor` / `glslFor` / `glslStagesFor` an optional trailing id. Since
// increment 5 the seven parameterless boot-group families DO pass one (their call sites are
// pinned in `simple-family-rewiring.test.ts`), but most of the open set still passes
// `undefined` — so both halves below remain live, and the two ways this can be wrong are
// both silent:
//
//   * the store is consulted when it must not be — a call site that passes NO id has to
//     behave bit-identically to before the seam existed, because that is the promise the
//     open set opts out on;
//   * the thunk still runs on a HIT — which is not a wrong pixel but the entire point of
//     the bake evaporating, and a counter-based assertion cannot see it (a stale closure
//     satisfies `calls === 0` just as well as a thunk that never ran). Every hit arm below
//     therefore passes a THROWING thunk: the only way to pass is to not call it.
//
// The pair arm is the one with real semantics. `glslStagesFor` is BOTH-OR-NEITHER: the
// thunk lowers the module ONCE for both stages, so a half-hit would run it anyway and buy
// nothing while producing a descriptor whose halves came from two different producers.
//
// Ids come from `ids.ts` rather than being typed as literals, for the reason `store.ts`'s
// spec gives: a grammar change must move this spec's inputs with it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { _resetBakedBodyGuardMemo, liveBodyConsts } from '../../shaders/baked/body-guard'
import {
  POLY_STROKE,
  hillshadeGlslId,
  hillshadeWgslId,
  polygonGlslIds,
} from '../../shaders/baked/ids'
import {
  bakedSeamEmitted,
  bakedSeamServed,
  bakedStoreStats,
  installBakedSources,
  _resetBakedStore,
} from '../../shaders/baked/store'
import type { BakedArtifact, BakedMeta } from '../../shaders/baked/registry'
import { glslFor, glslStagesFor, wgslFor, type ShaderSourceDevice } from './wgsl-for'

const GL: ShaderSourceDevice = { caps: { shaderLanguage: 'glsl-es300' } }
const GPU: ShaderSourceDevice = { caps: { shaderLanguage: 'wgsl' } }

const WGSL_ID = hillshadeWgslId(3, true)
const GLSL_ID = hillshadeGlslId(3, true, 'fragment')
const STROKE = polygonGlslIds(false, POLY_STROKE)

/** A meta the body guard opens on — the four live const values, read now. */
const openMeta = (): BakedMeta => ({ ...liveBodyConsts(), projectionFingerprint: 'spec' })

/** A committed artifact in miniature, content-addressed the way the generator writes it. */
function artifactOf(sources: Readonly<Record<string, string>>): BakedArtifact {
  const contents: Record<string, string> = {}
  const index: Record<string, string> = {}
  for (const [id, source] of Object.entries(sources)) {
    const hash = `c${Object.keys(contents).length}`
    contents[hash] = source
    index[id] = hash
  }
  return { meta: openMeta(), contents, index }
}

/** A thunk that cannot be called. Stronger than a call counter: a counter can be read off
 *  a stale closure, a throw cannot be absorbed. */
const never = (): never => {
  throw new Error('the thunk ran on a baked HIT — the emit the bake exists to avoid')
}
const neverStages = (): { vertex: string; fragment: string } => never()

/** Nothing was asked of the store, and nothing was recorded. */
const untouched = (): void => {
  expect(bakedStoreStats()).toMatchObject({ hits: 0, misses: 0, absent: 0, closed: 0 })
  expect(bakedSeamServed()).toEqual([])
  expect(bakedSeamEmitted()).toEqual([])
}

beforeEach(() => {
  _resetBakedStore()
  _resetBakedBodyGuardMemo()
})

afterEach(() => {
  _resetBakedStore()
  _resetBakedBodyGuardMemo()
})

describe('emit seam: NO id is the pre-bake behaviour, exactly (#1679)', () => {
  it('wgslFor without an id runs the thunk even when the store holds that very id', () => {
    installBakedSources(artifactOf({ [WGSL_ID]: 'BAKED WGSL' }))
    expect(wgslFor(GPU, () => 'EMITTED WGSL')).toBe('EMITTED WGSL')
    untouched()
  })

  it('glslFor without an id runs the thunk even when the store holds that very id', () => {
    installBakedSources(artifactOf({ [GLSL_ID]: 'BAKED GLSL' }))
    expect(glslFor(GL, () => 'EMITTED GLSL')).toBe('EMITTED GLSL')
    untouched()
  })

  it('glslStagesFor without ids runs the thunk even when the store holds both stages', () => {
    installBakedSources(artifactOf({ [STROKE.vertex]: 'BAKED VS', [STROKE.fragment]: 'BAKED FS' }))
    expect(glslStagesFor(GL, () => ({ vertex: 'EMITTED VS', fragment: 'EMITTED FS' }))).toEqual({
      vsCode: 'EMITTED VS',
      fsCode: 'EMITTED FS',
    })
    untouched()
  })
})

describe('emit seam: an id whose bytes are not installed falls through (#1679)', () => {
  it('wgslFor emits and records the id — a miss costs a frame, never a pixel', () => {
    expect(wgslFor(GPU, () => 'EMITTED WGSL', WGSL_ID)).toBe('EMITTED WGSL')
    expect(bakedStoreStats()).toMatchObject({ hits: 0, absent: 1, misses: 0 })
    expect(bakedSeamEmitted(), 'the fall-through is named, not merely counted').toEqual([WGSL_ID])
    expect(bakedSeamServed()).toEqual([])
  })

  it('glslFor emits and records the id', () => {
    expect(glslFor(GL, () => 'EMITTED GLSL', GLSL_ID)).toBe('EMITTED GLSL')
    expect(bakedStoreStats()).toMatchObject({ hits: 0, absent: 1, misses: 0 })
    expect(bakedSeamEmitted()).toEqual([GLSL_ID])
  })
})

describe('emit seam: an installed id is served and the thunk does NOT run (#1679)', () => {
  it('wgslFor serves the baked bytes', () => {
    installBakedSources(artifactOf({ [WGSL_ID]: 'BAKED WGSL' }))
    expect(wgslFor(GPU, never, WGSL_ID)).toBe('BAKED WGSL')
    expect(bakedStoreStats()).toMatchObject({ hits: 1, misses: 0, absent: 0, closed: 0 })
    expect(bakedSeamServed()).toEqual([WGSL_ID])
    expect(bakedSeamEmitted()).toEqual([])
  })

  it('glslFor serves the baked bytes', () => {
    installBakedSources(artifactOf({ [GLSL_ID]: 'BAKED GLSL' }))
    expect(glslFor(GL, never, GLSL_ID)).toBe('BAKED GLSL')
    expect(bakedStoreStats()).toMatchObject({ hits: 1, misses: 0 })
    expect(bakedSeamServed()).toEqual([GLSL_ID])
  })

  it('glslStagesFor serves BOTH stages when both are installed', () => {
    installBakedSources(artifactOf({ [STROKE.vertex]: 'BAKED VS', [STROKE.fragment]: 'BAKED FS' }))
    expect(glslStagesFor(GL, neverStages, STROKE)).toEqual({
      vsCode: 'BAKED VS',
      fsCode: 'BAKED FS',
    })
    expect(bakedStoreStats()).toMatchObject({ hits: 2, misses: 0 })
    expect(bakedSeamServed()).toEqual([STROKE.fragment, STROKE.vertex].sort())
  })
})

describe('emit seam: glslStagesFor is BOTH-OR-NEITHER (#1679)', () => {
  it('one stage installed — the thunk runs and BOTH halves come from it', () => {
    // The half that WOULD have served must not survive into the descriptor: the thunk ran
    // regardless (one lowering emits both stages), so taking its pair costs nothing and
    // keeps the two halves from having different producers.
    installBakedSources(artifactOf({ [STROKE.vertex]: 'BAKED VS' }))
    expect(
      glslStagesFor(GL, () => ({ vertex: 'EMITTED VS', fragment: 'EMITTED FS' }), STROKE),
    ).toEqual({ vsCode: 'EMITTED VS', fsCode: 'EMITTED FS' })
  })

  it('the same holds when it is the FRAGMENT half that is installed', () => {
    installBakedSources(artifactOf({ [STROKE.fragment]: 'BAKED FS' }))
    expect(
      glslStagesFor(GL, () => ({ vertex: 'EMITTED VS', fragment: 'EMITTED FS' }), STROKE),
    ).toEqual({ vsCode: 'EMITTED VS', fsCode: 'EMITTED FS' })
  })

  it('both ids are looked up on a half-hit, so the accounting names the severed half', () => {
    // polygon IS installed and the fragment id is not in it — the #996 case, and the only
    // outcome the store calls a bug. Short-circuiting the second lookup would hide it.
    installBakedSources(artifactOf({ [STROKE.vertex]: 'BAKED VS' }))
    glslStagesFor(GL, () => ({ vertex: 'EMITTED VS', fragment: 'EMITTED FS' }), STROKE)
    expect(bakedStoreStats()).toMatchObject({ hits: 1, misses: 1, absent: 0, closed: 0 })
    expect(bakedSeamEmitted(), 'the stage that fell through').toEqual([STROKE.fragment])
  })
})

describe('emit seam: the language gate still comes first (#1679)', () => {
  it('a WGSL device asking glslStagesFor gets {} and never touches the store', () => {
    installBakedSources(artifactOf({ [STROKE.vertex]: 'BAKED VS', [STROKE.fragment]: 'BAKED FS' }))
    expect(glslStagesFor(GPU, neverStages, STROKE)).toEqual({})
    untouched()
  })

  it('a WGSL device asking glslFor gets undefined and never touches the store', () => {
    installBakedSources(artifactOf({ [GLSL_ID]: 'BAKED GLSL' }))
    expect(glslFor(GPU, never, GLSL_ID)).toBeUndefined()
    untouched()
  })

  it("a GLSL device asking wgslFor gets '' and never touches the store", () => {
    installBakedSources(artifactOf({ [WGSL_ID]: 'BAKED WGSL' }))
    expect(wgslFor(GL, never, WGSL_ID)).toBe('')
    untouched()
  })
})
