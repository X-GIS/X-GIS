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
import { glslFor, glslStagesFor, shipSource, wgslFor, type ShaderSourceDevice } from './wgsl-for'
import { BAKED_SHADER_KEYS } from '../../shaders/baked/registry'

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

/** A thunk's output as the seam SHIPS it (#1889): `wgslFor` and friends now run the emitted
 *  text through `shipSource` so a cache hit and a cache miss hand a device the same bytes.
 *
 *  These gates are about PROVENANCE — did the text come from the thunk or from the store —
 *  and that is what they still test: a store hit returns the installed bytes verbatim, so
 *  `'BAKED …'` expectations below are unchanged, and no transform can make `'EMITTED …'`
 *  and `'BAKED …'` collide. What is no longer claimed is that the seam is a pass-through,
 *  which it deliberately is not. */
const shipped = (src: string): string => shipSource(src)

describe('emit seam: NO id is the pre-bake behaviour, exactly (#1679)', () => {
  it('wgslFor without an id runs the thunk even when the store holds that very id', () => {
    installBakedSources(artifactOf({ [WGSL_ID]: 'BAKED WGSL' }))
    expect(wgslFor(GPU, () => 'EMITTED WGSL')).toBe(shipped('EMITTED WGSL'))
    untouched()
  })

  it('glslFor without an id runs the thunk even when the store holds that very id', () => {
    installBakedSources(artifactOf({ [GLSL_ID]: 'BAKED GLSL' }))
    expect(glslFor(GL, () => 'EMITTED GLSL')).toBe(shipped('EMITTED GLSL'))
    untouched()
  })

  it('glslStagesFor without ids runs the thunk even when the store holds both stages', () => {
    installBakedSources(artifactOf({ [STROKE.vertex]: 'BAKED VS', [STROKE.fragment]: 'BAKED FS' }))
    expect(glslStagesFor(GL, () => ({ vertex: 'EMITTED VS', fragment: 'EMITTED FS' }))).toEqual({
      vsCode: shipped('EMITTED VS'),
      fsCode: shipped('EMITTED FS'),
    })
    untouched()
  })
})

describe('emit seam: an id whose bytes are not installed falls through (#1679)', () => {
  it('wgslFor emits and records the id — a miss costs a frame, never a pixel', () => {
    expect(wgslFor(GPU, () => 'EMITTED WGSL', WGSL_ID)).toBe(shipped('EMITTED WGSL'))
    expect(bakedStoreStats()).toMatchObject({ hits: 0, absent: 1, misses: 0 })
    expect(bakedSeamEmitted(), 'the fall-through is named, not merely counted').toEqual([WGSL_ID])
    expect(bakedSeamServed()).toEqual([])
  })

  it('glslFor emits and records the id', () => {
    expect(glslFor(GL, () => 'EMITTED GLSL', GLSL_ID)).toBe(shipped('EMITTED GLSL'))
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
    ).toEqual({ vsCode: shipped('EMITTED VS'), fsCode: shipped('EMITTED FS') })
  })

  it('the same holds when it is the FRAGMENT half that is installed', () => {
    installBakedSources(artifactOf({ [STROKE.fragment]: 'BAKED FS' }))
    expect(
      glslStagesFor(GL, () => ({ vertex: 'EMITTED VS', fragment: 'EMITTED FS' }), STROKE),
    ).toEqual({ vsCode: shipped('EMITTED VS'), fsCode: shipped('EMITTED FS') })
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

describe('emit seam: shipSource actually compacts (#1889)', () => {
  // The arm the provenance gates above CANNOT supply. They compare a thunk's output against
  // `shipped(thunk)`, so gutting `shipSource` to the identity function leaves every one of
  // them green — the expectation degrades in lockstep with the thing it tests, which is
  // exactly the vacuous shape §12 records. This asserts the transform on REAL shader text.
  const sample = (): string => {
    const key = BAKED_SHADER_KEYS.find((k) => k.language === 'glsl')
    expect(key, 'the registry yielded no GLSL key — this gate lost its input').toBeDefined()
    return key!.emit()
  }

  it('strips the whitespace a raw emit carries', () => {
    const raw = sample()
    // Fail-before on the INPUT too: a raw emit that were already compact would make the
    // size assertion below pass for the wrong reason.
    expect(raw, 'a raw emit is indented, multi-line text').toMatch(/\n {2}\S/)
    const shipped = shipSource(raw)
    expect(
      shipped.length,
      `${shipped.length} >= ${raw.length} — shipSource did not compact`,
    ).toBeLessThan(raw.length * 0.9)
    expect(shipped, 'no indentation survives').not.toMatch(/\n {2}\S/)
  })

  it('keeps #version on its own first line — the one thing GLSL cannot have joined', () => {
    // GLSL ES 3.00 §3.4: `#version` must precede any non-preprocessor token, and a directive
    // owns its line. A minifier that joined everything would produce text no driver accepts,
    // and the compile gates would catch it — a decade of frames later than this does.
    const shipped = shipSource(sample())
    expect(shipped.startsWith('#version 300 es\n')).toBe(true)
  })

  it('is idempotent — re-shipping shipped text changes nothing', () => {
    // The property the bake leans on: `bakedSourceOf` runs this once, and a re-bake runs it
    // over the same emit again. A transform that drifted on a second pass would make two
    // consecutive bakes disagree and `baked-sync` flap.
    const once = shipSource(sample())
    expect(shipSource(once)).toBe(once)
  })
})
