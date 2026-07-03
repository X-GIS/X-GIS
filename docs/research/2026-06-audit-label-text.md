# Audit ④ — Label / text rendering subsystem

_Deep-research synthesis, 2026-06-08. File:line audit of the X-GIS text pipeline merged with SDF-text and map-label-placement research (the latter cross-referenced from the MapLibre source surveyed in Audit ①). Part of the 10-audit series. Claims cited inline._

---

## TL;DR

The text subsystem is **mature and heavily battle-tested** — it carries an atlas **generation counter** that guards every glyph cache against eviction-induced slot aliasing, a **preload-before-shape** ordering that prevents within-frame slot reuse, and SDF encoding that matches Canvas2D and PBF byte-for-byte. But the audit surfaced one **genuine, still-live correctness bug** plus a cluster of bilingual/CJK fragilities:

- **HEADLINE BUG — layout-cache hash collision returns the wrong label's glyph offsets** (`text-stage.ts:1359-1381`). The 32-bit FNV-1a `layoutCacheKey` can collide; on a false hit the cache returns label-A's `glyphOffsets` for label-B, and the **generation guard does _not_ catch it** (it validates eviction-staleness, not text identity). This is the reproduced "일부만" bilingual scatter.
- **Bilingual vertical collapse** from a bearingY sign-convention mismatch (PBF Latin negative/ascender-relative vs Canvas2D CJK positive/baseline-relative).
- **Silent label drop on atlas overflow** (no diagnostic).
- **Async PBF zero-SDF flicker** (the same async-landing class as Audit ①).

X-GIS notably has **no cross-tile symbol index** (Mapbox/MapLibre's `CrossTileSymbolIndex`), which is the standard mechanism for keeping a label stable — not flickering/duplicating — across tile boundaries and zoom; worth flagging as a structural gap even though no specific bug was traced to it here.

---

## A. Architecture (as audited)

`TextResolver` (expr→string) → `GlyphAtlasHost` (LRU slots + rasterizer dispatch) → `GlyphAtlasGPU` (R8 atlas uploads) → `TextRenderer` (vertex packing, dynamic-offset uniforms, SDF threshold + halo). Per frame: `beginFrame` (FrameArena reset) → `addLabel` → `prepare` (preload codepoints → overflow-drop → shape/wrap (Knuth-Plass) → collision (greedy bbox) → paired-symbol drop) → `render`. Multiple caches (wrap, GlyphInfo[], 4096-entry layout) each guarded by the atlas **generation counter**.

The SDF technique itself is the standard one: glyphs are encoded as a signed distance field in a texture atlas and rendered with a smoothstep threshold in the fragment shader, which makes scaling/rotation cheap and yields crisp text + cheap halos via a threshold offset [Valve/Green 2007; Mapbox "Drawing Text with SDF"]. Its known limits — rounded sharp corners and thin-stroke fragility at very small sizes (MSDF is the mitigation) — are inherent, not X-GIS bugs.

## B. Findings (file:line, severity)

1. **Layout-cache hash collision → wrong glyph offsets — HIGH (live correctness bug).** `text-stage.ts:1359-1381`: `layoutCacheKey()` is a 32-bit FNV-1a over (textKey, size, maxWidth, lineHeight, justify, anchor, offset, translate, padding, halo). A collision between two different labels returns label-A's `glyphOffsets` for label-B. The **generation guard at :1381 only checks eviction-staleness, not text identity**, so a false hit passes. Reproduced as the "일부만" scatter (`bilingual-prepare-scatter.test.ts`, iter-327). **Fix:** add a secondary text-codepoint validation on hit (or 64-bit key) — cheap, bulletproof. _(This is the same class as the shader audit's "validated ≠ correct": the guard checks the wrong invariant.)_
2. **Bilingual vertical collapse — HIGH.** `pbf-rasterizer.ts:152-170`: PBF Latin glyphs carry **negative** bearingY (ascender-relative ~−9..−13) while Canvas2D Hangul/CJK carry **positive** (baseline-relative ~+20); mixed in one label the Latin line collapses into the CJK line (reported "Fuxing\n复兴镇 복흥진"). A fix at :165-169 recovers true ascent for PBF Latin, but **only covers the PBF-Latin-vs-Canvas2D case** — a different rasterizer pairing could reintroduce it. **Fix:** normalize all rasterizers to one bearingY convention at the source.
3. **Silent label drop on atlas overflow — MEDIUM.** `text-stage.ts:1176-1220`: when unique codepoints exceed atlas slots mid-frame, labels are dropped (after `preloadString`) with `fullyResolved=false` to keep retrying — correct for stability, but **no diagnostic**; the user sees labels flicker/vanish with no signal of "atlas too small." **Fix:** priority-drop by sort-key/layer + a `getDroppedLabels()` diagnostic (parallel to the existing `getDroppedPairKeys()`).
4. **Async PBF zero-SDF flicker — LOW-MED.** `pbf-rasterizer.ts:175-186`: when a PBF glyph lands, `onLanded` invalidates the slot, but a cached `GlyphInfo[]` (`stringInfoCache`) still references it with **zero SDF bytes** (metrics-only fallback) → glyph invisible 1-2 frames on high-latency servers. This is the **same async-landing under-invalidation class as Audit ①** — `stringInfoCache` entries lack a generation stamp. **Fix:** generation-stamp `stringInfoCache` (the pattern the layout cache already uses) or clear the font's entries on invalidate.
5. **Lower-severity:** newline-codepoint ghost glyph (already **fixed** at `text-renderer.ts:217`, `if (g.codepoint === 10) continue`); multi-page atlas slice-vs-eviction race (LOW, no shrink path today); FrameArena view-lifetime contract (LOW, requires breaking the setDraws→render synchronous contract).

## C. Structural gap — no cross-tile symbol index

Mapbox/MapLibre keep labels stable across tile boundaries and zoom with a **`CrossTileSymbolIndex`** plus **pauseable/incremental placement** whose `_updatePlacement` returns `needsRerender = !placement.isDone() || placement.hasTransitions()` to re-arm the loop until placement and **fades** settle [MapLibre, verbatim source surveyed in Audit ①]. X-GIS has a strong **per-frame** greedy collision pass but **no cross-tile symbol identity** — so as tiles load/unload or zoom changes, there is no structural guarantee against the same label flickering or duplicating across a tile seam. No specific bug was traced to this in the audit, but it is the standard mechanism X-GIS lacks, and the natural home for fade-in/out transitions (see B-fade below).

**Label fade:** the `opacityOverride` field on `TextStage` exists but the audit found **no fade-lifecycle tests** and no clear tie to the dirty/invalidation system — fade timing, smoothness, and post-fade clearing are unverified (matches Audit ③'s gap #11). MapLibre's model — animate opacity over a duration and keep firing repaints via `hasTransitions()` until done — is the reference.

## D. What's robust (positive controls)

The **atlas generation counter** (bumps on every slot reuse; every GlyphInfo[]/layout cache checks it — `glyph-atlas-host.ts`, `text-stage.ts:1381`) blocks most stale-slot corruption; **preload-before-shape** (admits all codepoints before any shape loop holds a slot ref) prevents within-frame label-A/label-B eviction cycles; greedy collision with stable sort-key + variable-anchor is deterministic; **SDF encoding matches Canvas2D + PBF byte-for-byte**; premultiplied-alpha blend prevents washed halos; per-glyph `rasterFontSize` lets bilingual labels mix PBF-24px Latin with DPR-scaled Hangul correctly.

## E. Top fixes (ranked)

1. **Layout-cache text-identity validation** (B1) — the one live correctness bug; cheap secondary key/check.
2. **Normalize bearingY across all rasterizers** (B2) — removes the bilingual-collapse class at the source rather than per-pairing.
3. **Generation-stamp `stringInfoCache`** (B4) — closes the async PBF flicker with the pattern the layout cache already uses; pairs with Audit ①'s glyph-PBF→dirty fix.
4. **(Structural, larger)** consider a cross-tile symbol identity + a tested fade lifecycle if cross-seam label stability / fades become priorities (C).

---

## Sources

**Codebase audit (file:line):** `text-stage.ts:1176-1220,1359-1381` (overflow drop, layout-cache key + generation guard), `sdf/pbf-rasterizer.ts:152-170,175-186` (bearingY, onLanded), `sdf/glyph-atlas-host.ts` (generation counter, three caches), `text-renderer.ts:147-161,217,220-225` (FrameArena, newline skip, page slice), `text-collision.ts` (greedy pass); tests `bilingual-label-placement-repro.test.ts`, `bilingual-prepare-scatter.test.ts` (iter-327), `glyph-atlas-host.test.ts` (iter-190/273).
**SDF research:** Green 2007 "Improved Alpha-Tested Magnification for Vector Textures and Special Effects" (Valve, the original SDF technique) [high]; Mapbox "Drawing Text with Signed Distance Fields" [high]; MSDF (Chlumský) as the corner-rounding mitigation [med].
**Label placement/fade:** MapLibre GL JS source (CrossTileSymbolIndex, `performSymbolLayout` behind `Promise.all`, `_updatePlacement`→`needsRerender`, fade via `hasTransitions`) — verbatim in Audit ①'s `2026-06-audit-async-concurrency.md` [high].

_Confidence: the codebase audit (direct read, with concrete repro tests named) is load-bearing; the layout-cache collision and bilingual-collapse bugs are the highest-value findings. SDF-technique citations are the canonical primary sources; the dedicated SDF/label-placement web angles for this audit were still completing at synthesis time, so the placement/fade grounding is carried from the verified MapLibre source surveyed in Audit ① rather than a fresh fetch — the load-bearing claims are unaffected._
