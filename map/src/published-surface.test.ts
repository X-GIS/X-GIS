// #2613 — the guard on what `index.ts` publishes for `XGISMap`.
//
// Before this, `index.ts` exported the CLASS, so all 215 of its public members
// reached consumers. The intent was already written down —
// `render/passes/pass-hosts.ts:1-18` says the members "stay package-internal on
// XGISMap" — but a comment is not a boundary, and the export undid it at the one
// edge that matters.
//
// This file is that boundary's gate. It is keyed on the TYPE, not on a file path:
// a path-keyed ratchet goes vacuously green the day the file moves (#996), and
// this one cannot, because it asks the compiler about `keyof XGISMap` itself.
//
// `typeIsNarrowed` is the assertion that earns its keep. If someone restores
// `export { XGISMap } from './map'`, `keyof XGISMap` becomes the full class again
// and this file FAILS TO COMPILE — `bun run build` reds, before any test runs.
import { describe, expect, it } from 'vitest'
import { XGISMap, type PublishedMapMember } from './index'

/** True only when A and B are the same type, in both directions. Wrapped in
 *  tuples so a union does not distribute and quietly report a subset as equal. */
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** The published names, written out so a diff shows exactly what a PR changes.
 *  Kept in sync with `PublishedMapMember` BY THE COMPILER (`listMatchesUnion`),
 *  not by hand — two authorities that can drift is the thing this repo keeps
 *  paying for. */
const PUBLISHED = [
  'run',
  'runScene',
  'stop',
  'destroy',
  'invalidate',
  'getCamera',
  'setCenter',
  'setZoom',
  'setBearing',
  'getBearing',
  'setPitch',
  'jumpTo',
  'flyTo',
  'fitBounds',
  'markCameraPositioned',
  'isCameraPositioned',
  'project',
  'unproject',
  'getCanvas',
  'getCanvasDpr',
  'getContainer',
  'getBackend',
  'getMissingTileCount',
  'on',
  'off',
  'once',
  'setSourceData',
  'setSourcePoints',
  'updateFeature',
  'setPaintProperty',
  'setProjection',
  'setGlyphsUrl',
  'setSpriteUrl',
  'setLight',
  'setAtmosphere',
  'setTerrain',
  'getTerrain',
  'addOverlay',
  'addImage',
  'graphics',
  'getCoverage',
  'setCoverageTime',
  'playCoverageTime',
  'pauseCoverageTime',
  'setLabelDebugHook',
] as const

// A red on either line is a TYPE error, not a test failure — it stops `bun run
// build` before vitest runs. `true is not assignable to false` on the first means
// the list and the union disagree; on the second, that `XGISMap` no longer
// publishes exactly the union (someone widened the alias, or restored the class).
const listMatchesUnion: Eq<(typeof PUBLISHED)[number], PublishedMapMember> = true
const typeIsNarrowed: Eq<keyof XGISMap, PublishedMapMember> = true

describe('#2613 published XGISMap surface', () => {
  it('publishes exactly the declared union — widening it fails to COMPILE, here', () => {
    // Both consts are `true` only if the compiler agreed. A mismatch in either
    // direction is a type error on the declaration above, so this assertion is
    // the readable half of a gate that has already fired at build time.
    expect(listMatchesUnion).toBe(true)
    expect(typeIsNarrowed).toBe(true)
  })

  it('publishes 45 members, not the class’s 215', () => {
    // The number is the point of the gate: it moves only when someone edits the
    // union AND this line, which is what "deliberate" means here.
    expect(PUBLISHED.length).toBe(45)
    expect(new Set(PUBLISHED).size).toBe(PUBLISHED.length)
  })

  it('still exports a constructor, not just a type', () => {
    // The narrowing is `type` + `const`; if the const half is ever dropped,
    // `new XGISMap(canvas)` breaks for every consumer and nothing else here
    // would notice.
    expect(typeof XGISMap).toBe('function')
    expect(XGISMap.prototype).toBeDefined()
  })
})
