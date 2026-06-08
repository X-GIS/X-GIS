# Audit ① — Async / concurrency / staleness correctness

*Deep-research synthesis, 2026-06-08. Direct file:line audit of X-GIS async boundaries merged with async-invalidation research and a MapLibre GL JS source comparison. Part of the 10-audit series. The recently-fixed S16 staleness bug was the first instance of the pattern this audit generalizes. Claims cited inline.*

---

## TL;DR
S16 was **not a one-off** — it exposed a **systemic pattern**: in X-GIS, *async resource-landing callbacks have no path to the frame loop*. When a glyph PBF, sprite atlas, or raster image finishes loading in the background, the code that consumes it is invalidated, but **nothing re-arms `map._needsRender`** — so an already-settled frame keeps showing stale/missing content until the camera happens to move. The single highest-confidence finding: **glyph PBF `onLanded` (`text-stage.ts:812`) calls `GlyphAtlasHost.invalidate()` but never reaches `_needsRender`** → after an S16 skip, labels freeze until a camera twitch. MapLibre solves exactly this with a one-line discipline X-GIS is missing: **resource-landed → set a dirty flag → fire a `data` event → schedule one frame**, plus a per-tile **dependency index** so only the affected tiles re-layout.

---

## A. The pattern (root cause)
The render loop **does** re-arm `_needsRender` for vector-tile uploads (`render-loop.ts:644-650` checks `totalMissed`/pending uploads — a correct positive control), but there is **no symmetric re-arm for glyph / sprite-atlas / raster GPU flushes** [audit, key insight]. The async completion callbacks live deep in resolution chains (`PbfRasterizer.onLanded`, `SpriteAtlasHost.readyPromise.finally`) with no reference to the map's frame scheduler. This is the textbook "completion lands but never re-triggers invalidation, so a settled frame keeps showing stale output" failure [browser/Flutter: the fix is `markNeedsPaint`-on-resource-load].

## B. Findings (file:line, severity, trigger)

1. **Glyph PBF landing → no redraw — CRITICAL.** `text-stage.ts:812`: `PbfRasterizer.onLanded(font,cp)` → `GlyphAtlasHost.invalidate()` marks the glyph stale, but **no path to `map._needsRender`**. Trigger: PBF arrives *after* a label pass took the S16 skip → text frozen in stale slots until the camera moves. [audit #1]
2. **Sprite atlas load → no re-eval on `loaded` transition — HIGH.** `sprite-atlas-host.ts:190-191`: `readyPromise` resolves on atlas load; `IconStage.isAtlasTerminal()` correctly *blocks* the S16 skip while loading, but on the `loading→loaded` transition nothing *forces* a re-prepare if the dispatch signature is unchanged → icons invisible for ≥1 frame after the sprite lands. [audit #2]
3. **Animation-end + PBF land same frame — HIGH.** `label-pass.ts:278-284`: while `_labelsHaveTimeAnimation` is set the skip is correctly disabled; but if the animation ends *and* a PBF lands in the same frame, the next frame's signature is unchanged → skip fires with glyphs still dirty. [audit #5]
4. **Icon paired-collision vs async atlas — HIGH.** If an icon atlas lands *after* its paired text was collision-dropped but *before* `IconStage.prepare` reads `droppedPairKeys`, the icon re-evaluates against a stale dropped-set → orphaned icon renders. [audit #6]
5. **Raster/glyph GPU flush count ignored → no re-arm — MEDIUM.** `text-stage.ts:1939` calls `gpu.flush()` but ignores the returned upload count; raster-renderer similarly. No `_needsRender` re-arm when new glyphs/rasters were uploaded → invisible until signature change. (Usually masked because users pan during load.) [audit #4,#9]

## C. The reference design (MapLibre GL JS source)
MapLibre is the architecturally-equivalent open renderer, and its async-landing machinery is exactly what X-GIS lacks:
- **Resource-landed → dirty → frame.** `_afterImageUpdated(id)` sets `this._changed = true` and fires `Event('data',{dataType:'style'})`; the `Map` wires `on('data', e => this._update(e.dataType === 'style'))`, so image arrival schedules a frame [MapLibre style.ts/map.ts, high]. Three dirty flags `_styleDirty`/`_sourcesDirty`/`_placementDirty` drive a demand loop [map.ts, high]. (three.js, by contrast, is demand-rendered and the app *must* call `invalidate()` on texture load — the documented footgun X-GIS currently has [three.js manual #12105].)
- **Dependency-index reload, not global.** Each tile records `setDependencies('glyphs'|'icons'|'patterns', deps)`; when a resource lands, `reloadTilesForDependencies([...], changed)` reloads **only** tiles whose dependency index matches [source_cache.ts/tile.ts, high]. This is the granular analog of "tag only the affected domain dirty."
- **Gate layout behind resource readiness.** `WorkerTile.parse()` awaits `Promise.all([glyphs, icons, patterns, dashes])` **before** `performSymbolLayout` — symbols are never laid out before their resources exist [worker_tile.ts, high].
- **Continue until settled.** `_updatePlacement()` returns `needsRerender = !placement.isDone() || placement.hasTransitions()` → `_placementDirty` re-arms the loop until placement/fades settle [style.ts, high].
- **The canonical failure mode** (validating the whole thesis): Mapbox PR#7355 — a reload whose worker never signalled completion left tiles stuck `state:'reloading'` so `map.loaded()` never returned true [high]. Missing completion signal → stuck/stale state.

For the *race* half (out-of-order results, cancellation): the standard fixes are **epoch/request-ID tokens** (discard results that aren't the current generation — React's `ignore` bit, promise identity), **AbortController** to cancel in-flight work on state change (MapLibre's `_removeTile`→`tile.aborted=true`→worker `abort.abort()`), and **rAF coalescing** so many invalidations collapse into one frame [web: react.dev, sebastienlorber, Paul Irish; MapLibre vector_tile_worker_source.ts].

## D. What X-GIS already does right (positive controls)
Generation/epoch guards on glyph eviction (`glyph-atlas-host.ts:186-192` bumps `_generation`; layout-cache hit checks it, `text-stage.ts:1381`) — a correct epoch-token pattern; atlas-overflow label drop with `_lastPrepareFullyResolved` gating the skip; the S16 four-condition skip gate (any async-pending blocks the skip — correct *defence*, just missing the *offence* of re-arming on completion); icon paired-collision synced within-frame via `droppedPairKeys`; and the VT-tile upload re-arm in the render loop. The machinery exists — it just isn't wired at the glyph/sprite/raster boundaries.

## E. Top-3 fixes
1. **Glyph PBF `onLanded` → dirty** (B1): route it to `map._needsRender = true` (or tag the LABEL domain via the S14 dirty bitset). This is MapLibre's `_afterImageUpdated → data → _update` in one hop. CRITICAL, small.
2. **Sprite-atlas `loading→loaded` → dirty** (B2): fire a callback on the state transition that tags LABEL dirty so the next frame re-prepares even with an unchanged signature.
3. **Flush-count → re-arm** (B5): check `gpu.flush()`'s returned upload count; if `>0`, set `_needsRender` — symmetric with the existing VT-tile re-arm.

The unifying rule (MapLibre-grounded): **every async completion that invalidates a cached render result must set a dirty flag and schedule a frame** — either post `_needsRender`/tag the domain, or be detected in the skip gate by a since-last-frame state-change check. The S16 skip is sound; it just needs the completion side to ring the bell.

---

## Sources
**Codebase audit (file:line):** `text-stage.ts:812,1208,1375-1381,1939`, `sprite/sprite-atlas-host.ts:190-191`, `text/sdf/glyph-atlas-host.ts:186-192,251-261`, `render/passes/label-pass.ts:278-284,328-330`, `sprite/icon-stage.ts:149-150`, `render/render-loop.ts:644-650` (VT re-arm positive control), `raster-renderer.ts`.
**Async-invalidation research:** browser.engineering invalidation (under/over-invalidation) [high]; React useEffect (out-of-order results, `ignore` bit) https://react.dev/reference/react/useEffect [high]; sebastienlorber race-conditions (epoch token, abort+ignore) [high]; Paul Irish rAF scheduling (coalescing, same-frame timestamp) [high]; MDN AbortController [high]; Flutter markNeedsPaint (dirty-on-load) [high]; Nystrom dirty-flag [high].
**MapLibre/three.js comparison:** MapLibre GL JS v4.7.1 source — style.ts `_afterImageUpdated`/`_updatePlacement`, map.ts dirty flags + `on('data')`, source_cache.ts `reloadTilesForDependencies`/`_removeTile`, tile.ts `setDependencies`/`TileState`, worker_tile.ts `Promise.all`→`performSymbolLayout`, vector_tile_worker_source.ts `abortTile`/`reloadTile` [all high, verbatim]; Mapbox PR#7355 (stuck reloading) [high]; three.js rendering-on-demand manual + #12105 [high]; R3F `invalidate()` [med].

*Confidence: the codebase audit (direct read) and MapLibre verbatim source are load-bearing. The MapLibre `_render` final re-trigger conditional and Blender/R3F analogs are flagged med (truncation / search-summary).*
