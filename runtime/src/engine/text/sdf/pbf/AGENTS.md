<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# pbf

## Purpose
MapLibre PBF glyph sourcing — fetch, decode, cache, and bridge server-side glyph SDFs into the engine's atlas. MapLibre serves glyphs in 256-codepoint range PBFs (`0-255`, `256-511`, …) under a `{fontstack}/{range}.pbf` URL template. This dir hand-rolls the protobuf decode (no `pbf` dependency), caches decoded glyphs by codepoint, dedupes in-flight requests, supports inline (air-gapped) glyph injection, and reconciles the PBF bitmap convention with the engine's fixed atlas slot format.

## Key Files
| File | Description |
|------|-------------|
| `glyph-pbf-cache.ts` | Range-keyed lazy fetcher + by-codepoint cache for MapLibre glyph PBFs; dedupes in-flight requests, marks failed ranges silently (offline fallback takes over). |
| `glyph-provider.ts` | `GlyphProvider` extension point — ordered list walked on every rasterise: sync `get()` probe (first non-undefined wins) + async `ensure()` background load. |
| `inline-glyph-provider.ts` | In-memory provider seeded with pre-loaded PBF range bytes — closed-network / air-gapped deployments; zero network, first-frame authored typeface. |
| `glyphs-proto.ts` | Decoder for the MapLibre `glyphs.proto` schema (fontstack → glyphs with id/bitmap/width/height/left/top/advance). |
| `pbf-to-slot.ts` | Bridges a PBF glyph (`(width+6)×(height+6)`, 3px buffer, 24px ref, edge byte 192) into a `GlyphRasterResult` for the engine's fixed slotSize × slotSize atlas (rasterFontSize 32, radius 8). |
| `varint.ts` | Minimal hand-rolled protobuf varint/length-delimited decoder for `glyphs.proto` (avoids the `pbf` package dependency). |

## For AI Agents

### Working In This Directory
- The PBF→slot bridge is precision-sensitive: PBF bearingY (`top`) is NEGATIVE for latin glyphs but the engine/CJK convention is positive — this mismatch is the root of the bilingual vertical-collapse bug. Any change to `pbf-to-slot.ts` glyph metrics must be checked against `pbf-glyph-bearingy.test.ts`.
- Glyph fetching is lazy + deduped + silently-failing by design (offline fallback). Don't make a failed range throw; mark it failed and let the fallback chain handle it.
- The protobuf decode is hand-rolled to keep the zero-dependency policy — do NOT add the `pbf` npm package. Extend `varint.ts`/`glyphs-proto.ts` instead.
- The inline provider exists for air-gapped deployments — keep it network-free.

### Testing Requirements
- `glyph-pbf-cache.test.ts`, `glyphs-proto.test.ts`, `inline-glyph-provider.test.ts`, `pbf-to-slot.test.ts`. Add bearingY + buffer-convention coverage for slot-bridge changes; add a decode round-trip case for proto/varint changes.

### Common Patterns
- 256-codepoint range fetch + by-codepoint cache. Provider chain (sync get / async ensure / onLanded invalidate). Hand-rolled protobuf, zero deps.

## Dependencies

### Internal
- `../glyph-rasterizer` (`GlyphRasterResult`), `../atlas-state` (slot conventions).

### External
- None (hand-rolled protobuf; deliberately no `pbf` package).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
