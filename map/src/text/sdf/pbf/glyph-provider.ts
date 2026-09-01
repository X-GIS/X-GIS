// Glyph resource provider — the extension point for "where does the
// next PBF glyph come from?".
//
// PbfRasterizer holds an ordered list of GlyphProvider instances and
// walks them on every rasterise:
//   1. Sync probe — each provider's `get()` is called in order. The
//      first non-undefined result wins. Inline / preseeded providers
//      hit synchronously; cache-warm HTTP / IDB providers do too.
//   2. Async ensure — if no provider has the glyph ready, each one
//      with an `ensure()` method is given a chance to schedule a
//      background load. When any of them lands, the atlas re-rasterises
//      via the same chain and a sync probe now hits.
//
// Designed for chain-of-responsibility composition: a polished setup
// is `[Inline, IndexedDB, Http]` so the cheapest source wins first.
// Custom backends (S3, IPFS, on-device cache) plug in by implementing
// this interface — no PbfRasterizer changes needed.

import type { PbfGlyph } from './glyphs-proto'

export interface GlyphProvider {
  /** Cheap sync probe. Return the glyph iff it's ready in this
   *  provider's local store; undefined for both "haven't loaded yet"
   *  and "this provider can never have it". The rasterizer doesn't
   *  distinguish the two cases — it just walks the chain. */
  get(fontstack: string, codepoint: number): PbfGlyph | undefined

  /** Optional async load trigger. Providers with no remote source
   *  (pure inline data) omit this. Must be idempotent: repeat calls
   *  for the same (fontstack, codepoint) coalesce into one fetch.
   *  Fires `onReady` once the load REACHES A TERMINAL STATE — the glyph is retrievable
   *  via `get()`, or it never will be (404, CORS, network). Both outcomes notify (#1574):
   *  a caller that is told nothing cannot tell "still coming" from "never coming", and it
   *  drew the awaiting-PBF placeholder forever. A repeat `ensure` for a range that has
   *  ALREADY failed stays silent, so a re-raster prompted by that notification terminates. */
  ensure?(fontstack: string, codepoint: number, onReady: () => void): void

  /** Optional BOUNDED in-flight probe: does this provider have a load outstanding that the
   *  render loop should stay awake for? The map's `shouldRenderThisFrame` ORs this, so
   *  `idle` means "converged INCLUDING text" rather than "converged except for text" — the
   *  gap that let a settle-on-idle harness sample first-visit frames before their glyphs
   *  landed (#2116).
   *
   *  BOUNDED is part of the contract, not an implementation detail: `safeFetch` carries no
   *  timeout, so a provider that answered `true` for as long as a request was outstanding
   *  would let one hung host wedge the loop awake forever — the never-idle shape #2091 was.
   *  An implementation MUST stop counting a load once it has been outstanding past its own
   *  deadline, whether or not it ever settles. Providers with no remote source omit this
   *  and are read as "nothing outstanding".
   */
  hasPendingLoads?(): boolean

  /** Optional terminal-state probe: has this provider finished deciding about the range
   *  containing `codepoint`, either way? Providers that load synchronously, or that can
   *  never load more than they already hold, omit it and are read as "still pending" —
   *  the conservative answer, since it keeps the cheap placeholder in play.
   *
   *  This is what lets the rasterizer distinguish a glyph that has not ARRIVED yet from
   *  one that is never coming, and pick a fallback accordingly. */
  isResolved?(fontstack: string, codepoint: number): boolean
}
