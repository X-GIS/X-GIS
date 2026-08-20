// ═══ The body guard — the mechanism that keeps a bake off the wrong planet (#1678) ═══
//
// The committed artifact embeds the four body-routed GPU consts as EMITTED LITERALS.
// A bake served under a different body still compiles and still renders — silent and
// wrong, the failure mode `shader-emit-worker.ts` already names — so `bakedAvailable
// ForBody` is the ONE thing standing between the artifact and that frame.
//
// §12 — an assertion carries information only if it DISTINGUISHES the states of the
// thing it tests, so this file asserts BOTH states of the same mechanism and pins the
// premise that makes the guard necessary at all:
//
//   MOON  → the guard closes, AND a live emit really does carry 1737400 (so there
//           genuinely is something to protect against), AND those bytes really do
//           differ from the baked ones (so serving the bake would have been WRONG).
//   EARTH → the guard opens, AND the live emit is byte-identical to the baked source
//           (so the guard is not just permanently closed, and the bake is usable).
//
// CUT PROBE (verified while landing this): make `bakedAvailableForBody` `return true`
// and the MOON case goes red on its first assertion, naming the guard. Neither the
// literal check nor the byte-difference check moves — they are the premise, not the
// mechanism — which is exactly why the guard assertion has to be there in its own right.
//
// The body is PROCESS-GLOBAL and so is the guard's memo, so Earth is restored in
// afterEach (the `body-option.test.ts` / `body-blind-caches.test.ts` discipline) and no
// Earth literal is spelled here — every expectation reads the Body authority.

import { describe, it, expect, afterEach } from 'vitest'
import { EARTH, MOON, configureBody, makeBody, type Body } from '@xgis/shared'
import { PROJECTIONS } from '@xgis/geo'
import { configureProjections } from '../dsl/projections'
import { configureBodyConsts } from '../../body-consts'
import { emitFor } from '../emit/shader-emit-request'
import { bakedAvailableForBody, liveBodyConsts, _resetBakedBodyGuardMemo } from './body-guard'
import { hillshadeGlslId } from './ids'
import { BAKED_GLSL_HILLSHADE } from './baked-glsl-hillshade.generated'

configureProjections(PROJECTIONS)

/** Apply a body exactly as the XGISMap ctor does (`applyBodyOption` is this pair). */
function switchBody(body: Body): void {
  configureBody(body)
  configureBodyConsts(body)
}

afterEach(() => {
  switchBody(EARTH)
  _resetBakedBodyGuardMemo()
})

/** The baked source for a registry id, through the artifact's own index. */
function bakedSource(id: string): string {
  const hash = BAKED_GLSL_HILLSHADE.index[id]
  expect(hash, `${id}: absent from the baked index`).toBeTypeOf('string')
  const src = BAKED_GLSL_HILLSHADE.contents[hash as string]
  expect(src, `${id}: index points at unstored content`).toBeTypeOf('string')
  return src as string
}

// methodFlag 4 = multidirectional, the heaviest method and the one the demo authors.
const REQ = { family: 'hillshade', pick: false, methodFlag: 4 } as const

/** Does `src` carry a numeric literal whose f32 value equals `want`? Spelling-blind on
 *  purpose — `shipSource` re-spells every float to the shortest decimal that rounds to the
 *  same f32, so `1737400.0`, `1737400.` and `17374e2` are all the same shader constant and a
 *  string match on any one of them is testing the minifier, not the body routing. */
function hasLiteralValue(src: string, want: number): boolean {
  const target = Math.fround(want)
  for (const m of src.matchAll(/\d*\.?\d+(?:[eE][+-]?\d+)?/g))
    if (Math.fround(Number(m[0])) === target) return true
  return false
}

describe('baked shaders — the body guard (#1678)', () => {
  it('MOON: the guard CLOSES — the bake may not be served', () => {
    switchBody(MOON)
    expect(
      bakedAvailableForBody(BAKED_GLSL_HILLSHADE.meta),
      'bakedAvailableForBody must close on MOON: the committed artifact embeds Earth‘s ' +
        'EARTH_R / EARTH_E2 / WGS84_A / WGS84_E2 as emitted literals, so serving it here ' +
        'would render a Moon-sized world through Earth-sized shader constants',
    ).toBe(false)
  })

  it('MOON: the premise — a live emit really does carry the Moon radius', () => {
    switchBody(MOON)
    const live = emitFor(REQ, false)
    // By VALUE, not by spelling (#1889). The emit now goes through `shipSource`, whose f32
    // re-spelling writes 1737400 as `17374e2` — same f32, five fewer chars. `toContain(String
    // (MOON.sphereR))` was asserting the decimal FORM, which is not the claim: the claim is
    // that the Moon's radius reaches the shader and Earth's does not, and a value test says
    // that whatever the minifier decides the shortest spelling is.
    expect(
      hasLiteralValue(live.vertex, MOON.sphereR),
      `the Moon sphere radius reaches the emitted GLSL (looked for an f32-equal literal, ` +
        `since the shipped spelling is minified)`,
    ).toBe(true)
    expect(hasLiteralValue(live.fragment, MOON.sphereR)).toBe(true)
    expect(hasLiteralValue(live.vertex, EARTH.sphereR), 'and Earth‘s does not').toBe(false)
  })

  it('MOON: the consequence — those bytes DIFFER from the baked ones', () => {
    switchBody(MOON)
    // The whole reason the guard exists: without it, these baked bytes would be handed
    // to a pipeline whose world is 1737400 m across.
    expect(emitFor(REQ, false).vertex).not.toBe(bakedSource(hillshadeGlslId(4, false, 'vertex')))
    expect(emitFor(REQ, false).fragment).not.toBe(
      bakedSource(hillshadeGlslId(4, false, 'fragment')),
    )
  })

  it('EARTH: the guard OPENS again, and the bake is byte-identical to a live emit', () => {
    // The other state — a guard stuck closed would pass every MOON case above while
    // silently disabling the bake forever.
    switchBody(MOON)
    expect(bakedAvailableForBody(BAKED_GLSL_HILLSHADE.meta)).toBe(false)
    switchBody(EARTH)
    expect(
      bakedAvailableForBody(BAKED_GLSL_HILLSHADE.meta),
      'the guard must re-open on the body the artifact was baked under',
    ).toBe(true)
    const live = emitFor(REQ, false)
    expect(live.vertex).toBe(bakedSource(hillshadeGlslId(4, false, 'vertex')))
    expect(live.fragment).toBe(bakedSource(hillshadeGlslId(4, false, 'fragment')))
  })

  it('compares VALUES, not the body‘s NAME — a mis-named Body is still a different planet', () => {
    // `makeBody('earth-wgs84', 1737400, 0)` is legal. A guard that trusted
    // `activeBody().name` would wave this through and serve Earth‘s bytes for it.
    switchBody(makeBody(EARTH.name, MOON.a, MOON.f))
    expect(liveBodyConsts().EARTH_R).toBe(MOON.sphereR)
    expect(
      bakedAvailableForBody(BAKED_GLSL_HILLSHADE.meta),
      'the guard must key on the emitted const VALUES, never on the body name',
    ).toBe(false)
  })

  it('the memo follows the body epoch rather than pinning the first answer (#1568)', () => {
    switchBody(EARTH)
    expect(bakedAvailableForBody(BAKED_GLSL_HILLSHADE.meta)).toBe(true)
    switchBody(MOON) // configureBodyConsts bumps the epoch
    expect(bakedAvailableForBody(BAKED_GLSL_HILLSHADE.meta)).toBe(false)
    switchBody(EARTH)
    expect(bakedAvailableForBody(BAKED_GLSL_HILLSHADE.meta)).toBe(true)
  })
})
