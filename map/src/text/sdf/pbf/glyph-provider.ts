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

  /** Optional terminal-state probe: has this provider finished deciding about the range
   *  containing `codepoint`, either way? Providers that load synchronously, or that can
   *  never load more than they already hold, omit it and are read as "still pending" —
   *  the conservative answer, since it keeps the cheap placeholder in play.
   *
   *  This is what lets the rasterizer distinguish a glyph that has not ARRIVED yet from
   *  one that is never coming, and pick a fallback accordingly. */
  isResolved?(fontstack: string, codepoint: number): boolean
}
