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
   *  Fires `onReady` once the glyph becomes retrievable via `get()`.
   *  Stays silent on permanent failure (404, CORS, network) so the
   *  rasterizer's fallback path can handle the gap. */
  ensure?(fontstack: string, codepoint: number, onReady: () => void): void
}
