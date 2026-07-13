// ═══ Globe fallback must draw under a drape-active primary (#1076) — source gate ═══
//
// THE BUG (#1076): on the globe sphere route with the vector DRAPE active (WebGPU
// + non-extruded + constant fill + no pattern — the default land/water case), the
// PRIMARY tiles' fills/strokes are suppressed from the direct ECEF-chord draw
// (`_drapeGlobeFills` / `_drapeStrokes` → `drawFills`/`drawStrokes` in
// renderTileKeys) because VectorDrapeRenderer bakes them onto the raster sphere
// grid instead. But the drape's `renderGlobeFills` only ever receives `neededKeys`
// — it is NEVER handed `fallbackKeys`. Those FALLBACK ancestors (coarse parents
// standing in for a missing child while it streams) are computed + uploaded, yet
// the SAME instance flags that suppress the primary direct draw ALSO killed the
// fallback dispatch (both share `renderTileKeys`). Result: a hemisphere whose
// tiles are still streaming renders pure background instead of a transient coarse
// chord — the user-reported blank hemisphere.
//
// THE FIX: scope the drape suppression to the PRIMARY dispatch only. The fallback
// dispatch block save/clears both flags → the fallback `renderTileKeys` draws the
// direct ECEF-chord ancestors (clipped to their missing child) → restore in a
// `finally` so the PRIMARY suppression stays intact.
//
// WHY A SOURCE GATE (not a render() unit test): the flag lives on a private field
// read deep inside render()'s fallback dispatch. The existing VTR harnesses
// (vtr-continuous-zoom / vtr-pump-prefetch / vtr-bundle-compaction-invalidate)
// drive the private `renderTileKeys` / `beginFrame` directly via Object.create +
// field injection — none reconstructs the full render() pipeline (source, bind
// groups, tile decision, drape, bundle cache …) that the fallback dispatch sits
// behind, and doing so would be a large fake harness for one boolean. So this
// pins the invariant as a text fact about the dispatch region, exactly like the
// co-located tile-camera-anchor-authority source-authority gate. GPU-free; rides
// the `test (map)` CI leg. FAIL-BEFORE: the unfixed source has NO drape clear in
// the fallback region (count 0), so every assertion below fails on it.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'vector-tile-renderer.ts'),
  'utf8',
)

// The fallback DISPATCH region: from the fallback gate (`fillPipelineFallback &&
// fallbackKeys.length > 0`) to the prefetch block that follows it. Both dispatch
// arms — the bundle-record arm (`getOrEncode` encodes the bundle) and the direct
// arm — live inside this slice.
const FB_GATE = 'if (fillPipelineFallback && fallbackKeys.length > 0) {'
const FB_END = '// Prefetch adjacent + next zoom'
const fbStart = SOURCE.indexOf(FB_GATE)
const fbEnd = SOURCE.indexOf(FB_END, fbStart)
const fbRegion = fbStart >= 0 && fbEnd > fbStart ? SOURCE.slice(fbStart, fbEnd) : ''

describe('globe fallback draws under a drape-active primary (#1076)', () => {
  it('the fallback-dispatch region anchors resolve', () => {
    expect(fbStart, `fallback-dispatch gate not found: ${JSON.stringify(FB_GATE)}`).toBeGreaterThan(
      -1,
    )
    expect(
      fbEnd,
      `prefetch end-anchor not found after the fallback gate: ${JSON.stringify(FB_END)}`,
    ).toBeGreaterThan(fbStart)
  })

  it('the fallback dispatch clears BOTH drape flags before dispatching', () => {
    // The drape (renderGlobeFills) never receives fallbackKeys, so the fallback
    // renderTileKeys MUST run with the suppression flags cleared — otherwise
    // drawFills/drawStrokes drop it and a streaming hemisphere renders blank.
    expect(
      fbRegion.includes('this._drapeGlobeFills = false'),
      'the fallback dispatch must set `this._drapeGlobeFills = false` (#1076) — the drape ' +
        'only bakes neededKeys, so fallback ancestors must draw as direct ECEF chords.',
    ).toBe(true)
    expect(
      fbRegion.includes('this._drapeStrokes = false'),
      'the fallback dispatch must set `this._drapeStrokes = false` (#1076) — fallback ' +
        'strokes are never draped, so they must draw as direct chords too.',
    ).toBe(true)
    const clearIdx = fbRegion.indexOf('this._drapeGlobeFills = false')
    const firstDispatchIdx = fbRegion.indexOf('renderTileKeys(')
    expect(firstDispatchIdx, 'no renderTileKeys( call in the fallback region').toBeGreaterThan(-1)
    expect(
      clearIdx,
      'the drape suppression must be cleared BEFORE the fallback renderTileKeys dispatch ' +
        '(including the bundle-record arm, so the recorded bundle bakes the draws in).',
    ).toBeLessThan(firstDispatchIdx)
  })

  it('the cleared flags are restored in a finally AFTER the whole dispatch', () => {
    expect(
      /\}\s*finally\s*\{/.test(fbRegion),
      'the fallback dispatch must be wrapped in try/finally',
    ).toBe(true)
    const restoreFillsIdx = fbRegion.indexOf('this._drapeGlobeFills = _fbSavedDrapeGlobeFills')
    const restoreStrokesIdx = fbRegion.indexOf('this._drapeStrokes = _fbSavedDrapeStrokes')
    expect(
      restoreFillsIdx,
      'finally must restore `_drapeGlobeFills` from its saved value',
    ).toBeGreaterThan(-1)
    expect(
      restoreStrokesIdx,
      'finally must restore `_drapeStrokes` from its saved value',
    ).toBeGreaterThan(-1)
    // The restore lives in the finally, i.e. AFTER the last dispatch (bundle replay
    // + executeBundles / the direct arm) — never mid-dispatch.
    const lastDispatchIdx = fbRegion.lastIndexOf('renderTileKeys(')
    expect(
      restoreFillsIdx,
      'the `_drapeGlobeFills` restore must come AFTER the last fallback dispatch (finally).',
    ).toBeGreaterThan(lastDispatchIdx)
  })

  it('the PRIMARY drape suppression is UNTOUCHED — only the fallback clears the fill flag', () => {
    // Regression guard: on the drape route the PRIMARY direct fill/stroke draw MUST
    // stay suppressed (the drape bakes those tiles). If a future edit cleared the
    // flag for the primary dispatch too, primary tiles would double-draw (chord +
    // drape). Exactly ONE `this._drapeGlobeFills = false` may exist, and it must be
    // the fallback clear. (The field initializer is `private _drapeGlobeFills =
    // false` — no `this.` — so it does not count here.)
    const clears = (SOURCE.match(/this\._drapeGlobeFills = false/g) ?? []).length
    expect(
      clears,
      `expected exactly 1 \`this._drapeGlobeFills = false\` (the #1076 fallback clear); got ` +
        `${clears}. MORE than 1 means the primary dispatch also clears the flag — that ` +
        `double-draws the draped primary tiles (chord + bake). Scope the clear to the fallback.`,
    ).toBe(1)
    expect(
      fbRegion.includes('this._drapeGlobeFills = false'),
      'the sole `this._drapeGlobeFills = false` must live in the fallback dispatch region.',
    ).toBe(true)
    // The suppression MECHANISM the primary path relies on must survive verbatim.
    expect(
      SOURCE.includes("const drawFills = phase !== 'strokes' && !this._drapeGlobeFills"),
      'the primary fill-suppression read (`drawFills … && !this._drapeGlobeFills`) must remain — ' +
        'it is how the drape owns the primary tiles.',
    ).toBe(true)
    expect(
      /const drawStrokes = .*&& !this\._drapeStrokes/.test(SOURCE),
      'the primary stroke-suppression read (`drawStrokes … && !this._drapeStrokes`) must remain.',
    ).toBe(true)
  })
})
