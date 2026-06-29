<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-29 -->

# pbf

## Purpose
MapLibre PBF glyph sourcing — fetch, decode, cache, and bridge server-side glyph SDFs into the engine's atlas. MapLibre serves glyphs in 256-codepoint range PBFs (`0-255`, `256-511`, …) under a `{fontstack}/{range}.pbf` URL template. This dir hand-rolls the protobuf decode (no `pbf` dependency), caches decoded glyphs by codepoint, dedupes in-flight requests, supports inline (air-gapped) glyph injection, and reconciles the PBF bitmap convention with the engine's fixed atlas slot format. A `__fixtures__/` subdir holds a real Open Sans Semibold range-0 PBF for decode round-trip tests.

## Key Files
| File | Description |
|------|-------------|
| `glyph-pbf-cache.ts` | Range-keyed lazy fetcher + by-codepoint cache for MapLibre glyph PBFs; dedupes in-flight requests, marks failed ranges silently. SSRF-guarded via `assertSafeRemoteUrl` + body capped at 8 MB via `readBodyCapped` (ship-P0). |
| `glyph-provider.ts` | `GlyphProvider` interface — sync `get()` probe (first non-undefined wins) + optional async `ensure()` background load. Chain-of-responsibility extension point; custom backends implement this interface with no changes to the rasterizer. |
| `inline-glyph-provider.ts` | In-memory provider seeded with pre-loaded PBF range bytes — closed-network / air-gapped deployments. Accepts raw `Uint8Array` bytes (decoded lazily on first access) or pre-decoded `Map<number, PbfGlyph>`. No `ensure()` — nothing to fetch. |
| `glyphs-proto.ts` | Decoder for the MapLibre `glyphs.proto` schema: `decodeGlyphsPbf` → `PbfFontstack[]` with `PbfGlyph` (id/bitmap/width/height/left/top/advance). Bitmap bytes are defensively copied out of the reader subarray to allow the input buffer to be GC'd. |
| `pbf-to-slot.ts` | Bridges a `PbfGlyph` into a `GlyphRasterResult` for the atlas. Identity byte copy (no bilinear resample) at PBF's native 24 px reference; returns `rasterFontSize: PBF_REF_SIZE (24)` so the renderer scales by `sizePx/24` at draw time. Copies the full `(width+6) × (height+6)` bitmap including the 3-px outer-falloff buffer — omitting it causes hard SDF cutoff at the glyph boundary. |
| `varint.ts` | `PbfReader` — hand-rolled protobuf varint/length-delimited decoder (wire types 0 and 2 plus generic skip). Supports zigzag-decoded `readSignedVarint()` for `sint32` fields (`left`, `top`). |

## For AI Agents

### Working In This Directory
- The PBF→slot bridge is precision-sensitive: `pbf-to-slot.ts` performs an identity byte copy at PBF's native 24 px — do NOT couple it to `rasterFontSize` (the global DPR-scaled Canvas2D size) or reintroduce bilinear resampling; that was deliberately removed to fix Latin glyph softening. The returned `rasterFontSize: PBF_REF_SIZE` (24) lets the renderer scale correctly at draw time.
- PBF `bearingY` (`top`) is NEGATIVE for Latin glyphs but the engine/CJK convention is positive — this mismatch is the root of the bilingual vertical-collapse bug. Any change to slot metrics must be checked against `pbf-glyph-bearingy.test.ts` (lives in `../pbf-rasterizer` test suite).
- The full `(width + 2*PBF_BUFFER)` × `(height + 2*PBF_BUFFER)` bitmap must be copied including the 3-px buffer; stripping the buffer reintroduces hard SDF cutoff at glyph edges (iter-121 regression).
- Glyph fetching is lazy + deduped + silently-failing by design. Failed ranges are session-permanent (no retry). Do NOT throw on fetch failure; mark the range `failed` and let the provider chain handle the gap.
- `glyph-pbf-cache.ts` calls `assertSafeRemoteUrl` before issuing any fetch — a private/loopback URL silently degrades to `failed`. Do not bypass this guard.
- The protobuf decode is hand-rolled to maintain the zero-dependency policy. Do NOT add the `pbf` npm package — extend `varint.ts` / `glyphs-proto.ts` instead.

### Testing Requirements
- `glyph-pbf-cache.test.ts`, `glyphs-proto.test.ts`, `inline-glyph-provider.test.ts`, `pbf-to-slot.test.ts`. For slot-bridge changes add bearingY and buffer-convention coverage; for proto/varint changes add a decode round-trip using the `__fixtures__/open-sans-semibold-0-255.pbf` fixture.

### Common Patterns
- 256-codepoint range fetch + by-codepoint cache. Provider chain (sync `get` / async `ensure` / `onReady` invalidate). Identity byte copy into slot with centered placement. Hand-rolled protobuf, zero deps.

## Dependencies

### Internal
- `../glyph-rasterizer` (`GlyphRasterResult` type)
- `engine/safety` (`assertSafeRemoteUrl`, `readBodyCapped`, `safeFetch` — SSRF guard + body cap, imported as `../../../safety`)

### External
- None (hand-rolled protobuf; deliberately no `pbf` package).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
