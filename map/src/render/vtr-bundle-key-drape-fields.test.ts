// ═══ The drape flags select what a bundle RECORDS, so they belong in its key (#2093) ═══
//
// THE BUG: `_drapeGlobeFills` / `_drapeStrokes` decide `drawFills` / `drawStrokes`
// inside renderTileKeys (vector-tile-renderer.ts ~4614/4628) — i.e. they select
// WHICH draws a GPURenderBundle records — and neither appeared in BundleKeyState.
// That contradicts the type's own stated contract (`_cache/bundle-cache-key.ts`:
// "Every cell that affects the recorded GPU commands a RenderBundle holds MUST
// appear here").
//
// Nothing else in the key need separate the two arms:
//   • `allocUniformSlot()` runs once per tile at tile-loop scope, ABOVE the
//     `if (drawFills …)` guard, so the walk allocates identically either way and
//     the hit-path alloc-count invariant (~3944) cannot fire; and
//   • `ringCursor` splits them ONLY on a frame where the drape really (re-)bakes
//     — `bakeTileToTexture` takes one ring slot per bake — which is precisely
//     what the bake cache stops happening. Once the bakes are cached (and
//     beginFrame's `resetSlot()` has rewound the ring) the cursor at key-build
//     time is identical on both arms.
//
// Reachability: before the #2093 LOD ceiling the flags were camera-invariant per
// show, so a flip always came with a `neededKeys` change. The ceiling makes them
// zoom-dependent AND `__XGIS_FORCE_VECTOR_DRAPE` (a CI-registered gate flips it
// mid-page) toggles them at a FIXED camera on CACHED tiles — every other key cell
// identical → a bundle recorded by the DIRECT arm hits under a held drape and
// replays its fill draws on top of the draped ones.
//
// WHY A SOURCE GATE: same rationale the co-located `vtr-fallback-drape-draw`
// gate records — the flags are private fields read deep inside render()'s bundle
// dispatch, behind the full source / bind-group / tile-decision / drape / bundle-
// cache pipeline that no VTR unit harness reconstructs. `satisfies BundleKeyState`
// makes tsc force the field to be PRESENT; only this gate forces it to carry the
// LIVE field rather than a hardcoded literal. The key-shape half (each flag moves
// the hash, and a state missing them is not a BundleKeyState) is pinned
// behaviourally in `_cache/bundle-cache-key.test.ts`.
//
// FAIL-BEFORE: on the pre-fix source neither literal mentions the flags, so the
// per-region assertions below fail for BOTH the primary and the fallback site.

import { describe, it, expect } from 'vitest'
import { renderPathSource } from './render-path-source'

const SOURCE = renderPathSource()

const CLOSE = '} as const satisfies BundleKeyState'

/** Every `const <name> = { … } as const satisfies BundleKeyState` literal in the
 *  VTR: each `satisfies` close paired with the NEAREST preceding `const … = {`.
 *  The close is the anchor, so a NEW bundle producer (the type's own header
 *  anticipates compute / OIT / stroke-phase bundles) is covered the day it is
 *  added rather than needing this gate extended. */
function keyLiteralRegions(src: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = []
  for (let from = 0; ;) {
    const close = src.indexOf(CLOSE, from)
    if (close < 0) return out
    const head = src.slice(0, close)
    const open = [...head.matchAll(/const (\w+) = \{\n/g)].pop()
    if (open) out.push({ name: open[1]!, body: head.slice(open.index + open[0].length) })
    from = close + CLOSE.length
  }
}
const regions = keyLiteralRegions(SOURCE)

describe('#2093 — both drape flags are cells of every bundle cache key', () => {
  it('the key-literal anchors resolve (both known build sites)', () => {
    // Companion assertion (CLAUDE.md §12): a renamed literal or a reworded
    // `satisfies` line must make this gate RED, never vacuously green.
    const names = regions.map((r) => r.name)
    expect(
      regions.length,
      `no \`as const satisfies BundleKeyState\` literal found in vector-tile-renderer.ts — ` +
        `the anchor moved; re-point this gate instead of deleting it.`,
    ).toBeGreaterThanOrEqual(2)
    expect(names, 'the primary bundle key literal (`keyState`) must be present').toContain(
      'keyState',
    )
    expect(names, 'the fallback bundle key literal (`fbKeyState`) must be present').toContain(
      'fbKeyState',
    )
  })

  it('every key literal carries the LIVE `_drapeGlobeFills` field', () => {
    for (const r of regions) {
      expect(
        r.body.includes('drapeGlobeFills: this._drapeGlobeFills'),
        `\`${r.name}\` must key on \`drapeGlobeFills: this._drapeGlobeFills\` — it selects ` +
          `\`drawFills\` in renderTileKeys, so a direct-arm bundle would otherwise HIT while ` +
          `the drape is held and replay its fill draws on top of the draped tiles. A hardcoded ` +
          `\`false\` satisfies the type and reintroduces exactly that hole.`,
      ).toBe(true)
    }
  })

  it('every key literal carries the LIVE `_drapeStrokes` field', () => {
    for (const r of regions) {
      expect(
        r.body.includes('drapeStrokes: this._drapeStrokes'),
        `\`${r.name}\` must key on \`drapeStrokes: this._drapeStrokes\` — it selects ` +
          `\`drawStrokes\` in renderTileKeys (the #599 line-drape half), so the same ` +
          `stale-replay hole exists for baked strokes.`,
      ).toBe(true)
    }
  })

  it('the selection reads the key now covers are still the ones renderTileKeys makes', () => {
    // Ties the two halves together: if a refactor moved the suppression off
    // these fields, keying on them would be covering nothing. (The exact
    // `drawFills` / `drawStrokes` derivations are pinned in
    // `vtr-fallback-drape-draw.test.ts`; this only asserts the linkage exists.)
    expect(
      SOURCE.includes('!this._drapeGlobeFills'),
      'renderTileKeys must still suppress the direct fill draw on `_drapeGlobeFills`',
    ).toBe(true)
    expect(
      SOURCE.includes('!this._drapeStrokes'),
      'renderTileKeys must still suppress the direct stroke draw on `_drapeStrokes`',
    ).toBe(true)
  })
})
