// ═══ God-file LOC ceiling ratchet — map/engine/geo/data/rhi* ═══
//
// The arch-invariants NEW_FILE_CAP gate (runtime/src/engine/architecture-invariants.
// test.ts) walks only runtime/compiler/blueprint/shared, so the repo's biggest,
// fastest-growing files have NO growth ceiling — the gate's own comment concedes it:
// "package-level LOC ratchets for map/engine are a tracked post-Gate-6 follow-up".
// This is that follow-up (#1003), extended to geo/data/rhi* too.
//
// Co-located under map/src (not the retiring runtime/ tree, per #1005) so it rides
// the confirmed `test (map)` CI leg; it READS files across the listed packages (it
// does not import them). CEILING semantics (shrink-only high-water marks, like the
// arch-invariants gate): a baselined file may only stay ≤ its ceiling; no NON-
// baselined source file may cross NEW_FILE_CAP. LOWER a ceiling when a file shrinks.
//
// Applies the #996 lesson (a gate whose allowlist points at moved/deleted files is
// vacuously green): every CEILINGS key MUST still exist, or the test fails loudly.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PKGS = [
  'map/src',
  'engine/src',
  'geo/src',
  'data/src',
  'rhi/src',
  'rhi-webgpu/src',
  'rhi-webgl2/src',
  // #1005 — carried from the retiring runtime arch-invariants Gate 3, whose
  // SRC_DIRS walk covered these three trees; without this they go ceiling-dark
  // the day runtime/ is deleted. Ceilings re-measured at carry time (several
  // files had shrunk below their old runtime ceilings — the tighter value won).
  'compiler/src',
  'blueprint/src',
  'shared/src',
]
const NEW_FILE_CAP = 800

function walkTs(absDir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(absDir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue
    const p = join(absDir, name)
    if (statSync(p).isDirectory()) out.push(...walkTs(p))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
      out.push(p)
  }
  return out
}
const rel = (abs: string): string => relative(ROOT, abs).split('\\').join('/')
function lineCount(abs: string): number {
  const s = readFileSync(abs, 'utf8')
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}
function exists(abs: string): boolean {
  try {
    statSync(abs)
    return true
  } catch {
    return false
  }
}

// High-water LOC ceilings for the god-files in these packages. SHRINK-ONLY: lower a
// number when its file shrinks; a file NOT listed here must stay under NEW_FILE_CAP.
// Measured 2026-07-11. (line.ts / polygon.ts are also ceiling-gated by the runtime
// arch-invariants test until runtime/ retires — #1005; the tighter ceiling governs.)
const CEILINGS: Record<string, number> = {
  // 4334→4336 (#991 P2): the UniformRing relocation to @xgis/engine injects the
  // perf-mark coupling via onGrowStart/onGrowEnd callbacks the engine no longer
  // owns; VTR (the ring that grows under load — the perf-audit hot path) supplies
  // them at the ring ctor (+2 lines). Lower again as #991 decomposes VTR.
  // 4336→4397 (#599 I2): the globe vector great-circle drape SEAM — the bake→
  // drape logic itself is EXTRACTED to render/vector-drape-renderer.ts (a new
  // ~180-LOC file); VTR keeps only the sphere-route gate + one invocation + a
  // dedicated bake uniform block (so the mid-render bake can't clobber the
  // shared frameBlock the stroke draw reads). Lower as #991 decomposes VTR.
  // 4397→4403 (#599 I3): the drape baked-fill cache lifecycle wire — two call
  // sites into VTR's existing beginFrame (deferred cache eviction, post-submit
  // safe window) + destroy (free baked textures). The policy itself lives in
  // render/vector-drape-cache.ts + vector-drape-renderer.ts, not here.
  // 4403→4487 (#599 line-drape): globe vector LINE / polygon-OUTLINE drape — the
  // stroke bake reuses the fill bake pass but adds the SDF line segments to the
  // tile texture. The bake-layer-slot packing + cache key + segment draw are
  // EXTRACTED to render/vector-drape-stroke.ts; VTR keeps only the wiring (the
  // captured stroke style + the drape-seam gate/strokeKey + the drawStrokes
  // suppression + the in-bake bakeTileStrokes call). Lower as #991 decomposes VTR.
  // 4487→4494 (#1154): pattern_active flag written per fill draw (both the
  // pattern/else branch at the fill_translate site + the three sentinel paths)
  // so the VS knows to gate off fill-translate when a pattern owns those slots.
  // 4494→4506 (#1153 P2 R1): destroy() now releases the two GPU pools it owns but
  // previously leaked — stagingPool.dispose() (the ≤16 MB tiered staging pool, the
  // iOS staircase) + bundleCache.invalidateAll() — with their rationale (+12).
  // 4494→4511 (#1155 F3): cold-start burst forwarder — the `_coldStartBurst`
  // field + `setColdStartBurst` + the burst flag on the per-render
  // uploadBudgetFor/setMaxJobs call. (Ceiling corrected from a padded 4513 to the
  // measured post-prettier 4511 — #1155 F3 adjudication, shrink-only high-water.)
  // Merge union (#1170 <- origin/main): both bumps stacked non-overlappingly on VTR (destroy() +12 AND cold-start burst +17), so the merged high-water is the measured 4523, not either standalone value.
  // 4523→4563 (#1057): the VT tile-points inline path split into the single-
  // authority emitTilePointsRhi(pass: RhiRenderPass, …) — render() delegates via
  // wrapWebGpuPass while the twin (render-loop.ts) calls it directly — plus the
  // one-line stableKeys record in renderFillsRhi for the twin's accumulation.
  // 4563→4591 (#1057 inc2 adversarial review): renderFillsRhi now (a) merges
  // protectedAncestors into stableKeys for point-parity with the WebGPU merged
  // set, (b) resets stableKeys=[] on both bail paths so a bailed show can't leak
  // prior keys into the twin's decoupled emitTilePointsRhi, each with rationale
  // docs; plus the parity pointer note on emitTilePointsRhi.
  // 4523→4609 (#1059): the fill-pattern GLSL twin on the WebGL2 fills path — a
  // ground fill-pattern Material with GLSL twins (ensureFillPatternMaterialRhi) +
  // its sprite-atlas tile bind group (fillPatternTileBgRhi, mirrors lineTileBgRhi) +
  // the renderFillsRhi pattern branch (pack-driven fill_color/fill_translate/pattern_active
  // + Material/tile-bg selection). +86; the pattern PACK decision is shared with the
  // WebGPU path via resolveFillPatternPack (extracted to polygon-fill-material.ts, so the
  // slot bytes can't drift), keeping the twin a thin caller. Lower as #991 decomposes VTR.
  // Merge union (#1057 + #1059): tile-points AND the pattern branch stacked in
  // renderFillsRhi non-overlappingly — merged high-water is the measured 4677.
  // 4677→4702 (#1198, merge union): frame-matched extrusion-light packing — the
  // `currentProjType` stash (proj_params write sites) + the flat-raw vs
  // sphere-rotated light_dir_ecef branch, fixing the continent-scale roof
  // lighting gradient (raw light in the vertex-ENU frame on flat projections);
  // stacked non-overlappingly on the #1057/#1059 twin work — measured 4702.
  // 4702→4706 (#1222): zoom-bucketed stroke rebake wiring — the strokeWidthScale
  // param on bakeTileToTexture (threaded to bakeTileStrokes) + camera.zoom on the
  // renderGlobeFills call; the bucket/scale MATH lives in vector-drape-cache.ts.
  // 4706→4739 (raster-resolution follow-ups): the feature-buffer-fill ×
  // extrude downgrade guard (base-only extruded pipelines vs feature bind
  // group = per-draw validation flood) + extruded shows draw no ground
  // outline (MapLibre fill-extrusion semantics; ground strokes composited
  // across raised roofs).
  // 4739→4740 (#1252): the two fillPipelineExtrudedOverride params + their use
  // at the primary/fallback extrude-pipeline selection (data-driven fill extrude).
  // 4740→4791 (#1371 atomic re-seed): `reseedTiles` (re-request the keys this renderer has
  // uploaded) + `applyReplacedTiles` (swap a replaced tile's GPU buffers in beginFrame, drop it
  // when the replacement is empty). Both need the store + upload coordinator + source together,
  // which only this class holds; extracting them would export three internals to buy back 51.
  // merge union — 4740→4761 (#1397): the viewport-anchored extrusion light gains its bearing
  // rotation in the per-tile light_dir_ecef packing. The two edits are disjoint, so the
  // ceilings SUM rather than max: 4740 + 51 + 21 = 4812.
  // merge union — 4791→4797 (#1402): `applyReplacedTiles` now asks for a REPLACING upload and
  // re-arms the key when the swap did not land, so an upload that bails cannot strand the tile
  // after the replaced-set was drained. +6, all inside the existing method. Disjoint from #1397
  // as well, so the three sum: 4740 + 51 + 21 + 6 = 4818 = the merged file's line count.
  // Shrink-only from here.
  // merge union — main shrank this to 4815; +1 for the `import { wgslFor, glslFor }` line
  // (draper source gating). The four polygon pipelines below it emitted BOTH shader
  // languages unconditionally while each device reads only one — ~130 ms of discarded WGSL
  // per site on WebGL2, and the mirror waste of the GLSL pair on WebGPU. No statement was
  // added: the existing shader/vsCode/fsCode expressions were wrapped in place, and the
  // decision itself lives in material/wgsl-for.ts.
  'map/src/render/vector-tile-renderer.ts': 4816,
  // 4232→4237 (#1000 heatmap relocate): the heatmap density-target OWNERSHIP
  // extracted to render/heatmap-targets.ts; map keeps only the irreducible
  // composition-root wiring — the `heatmapTargets` field + its import (mirrors
  // the `_paletteHandles` / `renderTargets` owner fields). Lower as #991 shrinks map.ts.
  // 4236→4216 (cast audit): the heatmap show build extracted to heatmap-show.ts;
  // the rebuild loop keeps only the loop-top routing + one call.
  // 4216→4232 (#1112): the live one-line `import "url"` path drops the imported
  // style's top-level `sprite` URL — the raw JSON is fetched INSIDE
  // resolveImportsAsync so the host never sees it to call setSpriteUrl. +16 =
  // the `importedTopLevel` collector + its pass-through into the resolve call +
  // the guarded `this.spriteUrl` wire, all at the existing import-resolution
  // site (composition-root; nothing extract-worthy, §2). Lower as #991 shrinks map.ts.
  // 4232→4245 (INC-1 under-occluder): the `underOccluder` owner field + its import +
  // the construct/setColor at the synthetic-earth-surface install + the teardown +
  // the two mid-session setColor mirrors. Composition-root renderer wiring (mirrors
  // the rasterRenderer / heatmapTargets owner fields); nothing extract-worthy (§2).
  // 4245→4276 (#777 I-E): the `_backgroundPattern` field + its reset + the
  // `pattern:` styleProperty parse arm, plus the synthetic-show carrier gate
  // (pattern-only backgrounds inject a default-black carrier) and the pattern
  // pass-through at the three synthetic-show injection sites. All at existing
  // sites; the carrier decision itself lives in synthetic-earth-surface-show.ts.
  // 4276→4283 (#1154): the world-band reinstall now rebuilds the dispatch list
  // when the synthetic background was re-installed (not only when polar caps
  // changed), so the globe background-pattern's fresh show reaches vectorTileShows.
  // 4284→4336 (#1155 F1 mount-hang): the shader-variant prewarm now KICKS before
  // the data-load settle (so driver pipeline compile overlaps the tile-source
  // network RTTs instead of serializing after them) and GATEs ready on a
  // delta belt-and-braces re-collect at the old await site — the
  // `_collectShaderVariants` helper + the early-kick + the await-site delta,
  // all at the run() flow with block comments documenting the reorder. Pure
  // latency overlap, no behaviour change (§2 — composition-root reorder,
  // nothing extract-worthy). Lower as #991 decomposes map.ts.
  // 4336→4398 (#1155 F3): cold-start burst lifecycle hooks — the state machine
  // itself was EXTRACTED to map-cold-start-burst.ts (ColdStartBurstController,
  // mirrors device-lost-recovery.ts); map keeps only the irreducible wiring: the
  // `_burst` field + deps closure, `_registerVtSource`, and the enter/tick/note/
  // exit calls at run/runBinary/renderLoop/_releaseGpuResources.
  // 4398→4411 (#1155 F3 adjudication): stop() now releases the burst refcount
  // (it was leaking the shared MVT pool for the page lifetime + disabling the
  // 10 s cap); the rendered-frame note skips 0×0 early-return frames so a map
  // booted hidden keeps burst for its real first cascade; and the polar-cap +
  // source-manager registrations route through `_registerVtSource` (single
  // write authority) so a source attached mid-burst inherits the flags.
  // 4411→4446 (#1167 F3 real-GPU adjudication): desktop-only burst gate
  // (`viewportEligible` deps closure — mobile keeps steady 4/1 as a CONSERVATIVE
  // default; the mobile regression it originally guarded was not statistically
  // established under a permutation test, but the desktop convergence win was)
  // + the visibilitychange backstop (`_burstVisibilityHandler` field +
  // `_enterColdStartBurst` helper that arms it, destroy() removes it) so a hidden
  // tab reclaims the shared pool's raised drain cap at once. The non-rAF
  // wall-clock timer that makes the 10 s cap real lives in the extracted
  // controller (map-cold-start-burst.ts), not here.
  // 4446→4447 (#1176 pick pre-gate, merged): the anyLayerListens dep wired at
  // the composition root so fireOnce skips the GPU pick readback when nobody
  // listens (§2 wiring, nothing extract-worthy).
  // 4447→4371 (a11y + webgpu-unavailable extraction): the P0-7 accessibility
  // trio (_setupAccessibility / _injectFocusStyle / _onKeyDown) moved to
  // map-accessibility.ts and the WebGPU-unavailable DOM builder moved to
  // map-webgpu-unavailable.ts (both free-function modules); map keeps only thin
  // wrappers. Pure mechanical extraction, identical runtime behaviour.
  // 4336→4356 (#1158 GAP-1 INC-A): the `coverage` source public API + marker narrow —
  // `getCoverage(sourceId)` (the CoverageHandle value-readout accessor, doc §6) + the
  // `{ _coverage }` rebuildLayers narrowing (keeps the rebuild feature-path-safe). +20,
  // both at existing composition-root sites; nothing extract-worthy (§2).
  // Merge (#1174): main's F3/#1167/#1176/extraction chain (→4371) UNION the #1158
  // GAP-1 INC-A coverage API above; ceiling re-measured to the merged file's actual
  // size (wc -l = 4391).
  // 4391→4469 (#1153 P1 lifecycle hardening): the run-epoch token (`_runEpoch` +
  // `_ctxOwned` + the `_epochStale` single-authority predicate) and its eight
  // post-await guards across run()/runBinary() (dispose-local pre-publication,
  // plain-return post-publication), parse-first (the tokenize/parse moved to the
  // top under a try/catch that fires the typed boot error before any teardown or
  // gpuInit kickoff), the epoch-guarded device-lost recovery closures (A6), and
  // the A7 `isStale` thread into the load loop. NET of the D4 extraction: the
  // shared renderer set moved to scene-renderers.ts (buildSceneRenderers), but the
  // seven-field assignment at BOTH run() and runBinary() call sites plus the
  // per-guard constraint comments outweigh the ~30 lines removed. The extraction
  // itself is the right cut (single authority, also fixes runBinary's missing
  // shapeRegistry/lineRenderer, #7); the remainder is irreducible in-flow wiring.
  // 4336→4495 (#1153 M1/M4/M5 mobile hardening): the touch-action claim
  // (_setupTouchAction + its destroy restore, M1), the getBackend() reader + the
  // 'backendresolved' fire at both boot tails (M4), and the visibility park/resume
  // seam (_scheduleFrame + _cancelScheduledFrame + _onDocHidden/_onDocVisible + the
  // deferred device-lost resume + fields, M5). New event/DOM policy lives in new
  // modules (visibility-pause.ts); map.ts keeps only the composition-root wiring +
  // the render-loop scheduling authority (mirrors the a11y/auto-resize precedents).
  // 4495→4518 (#1153 M5c/M5 review fixes): the deferred-resume in-flight latch
  // (_deviceLostResumePending field + the _onDocVisible gate + its clear in
  // _armDeviceLostRecovery — dedupes the pageshow+visibilitychange double-burn) and the
  // once-allocated _rafTick field (0-alloc rAF chain). Irreducible policy/field adds.
  // Lower as #991 decomposes map.ts.
  // 4469→4480 (#1177): the CameraController's injected invalidate becomes a
  // camera-scoped re-arm (_markDirty(CAMERA), destroyed-guarded) instead of the
  // blanket invalidate() — blanket-tagging LABEL forced a label re-prepare on
  // every programmatic camera frame, defeating the zoom-tolerant skip. +11 =
  // the closure + the why-comment at the single injection site (§2).
  // 4469→4488 (#1194 A1b): runScene — the second scene entrypoint. run()'s
  // post-parse body extracted VERBATIM into _runProgram (shared by run/runScene;
  // the device-lost recovery hook re-runs from the resolved AST so builder
  // scenes recover too). +19 = the runScene method + the two method boundaries
  // + docs; the 700-line body itself only moved. The real shrink lever remains
  // the #991 decomposition, not this seam.
  // Merge (#1195): main's #1177 camera-scoped invalidate UNION the #1194 A1b
  // runScene seam above; ceiling re-measured to the merged file's actual size
  // (wc -l = 4499).
  // 4499→4503 (#1196, merge union): name the actual GPU-boot failure at the
  // WebGPUUnavailable catch — the generic UX text hid the real cause (a webgl2
  // live-swap re-boot dying) for a full debugging session. Measured 4503.
  // 4503→4526 (#777 Phase II, merge union): the raster-dem → HillshadeRenderer
  // wiring — the hillshadeRenderer + _hillshadeShow fields, the two ctor init
  // sites, the rebuildLayers reset + `_dem`-marker arm branch, and the
  // rebuildForQuality hook. Irreducible: class-member declarations + the
  // source-dispatch arm that must sit in rebuildLayers where the source markers
  // are read. The DEM decode itself was extracted to hillshade-renderer.ts
  // (armHillshadeSource). Measured 4526.
  // Merge union (#1172 <- main): the M1/M4/M5/M5c mobile-hardening seams stacked
  // non-overlappingly on main's #1177/#1194/#1196/#777-II lineage — merged
  // high-water is the measured 4708.
  // 4708→4711 (raster-resolution): rebuildLayers hands the raster source's
  // authored tileSize to the renderer (cover-zoom bias wiring).
  // 4708→4715 (#1235 gap 2): the FeatureUpdateQueue host gains the seeded-FC
  // getter (CRS-guarded) + the reseedSource hook — wiring only; the patch/
  // re-seed logic lives in feature-update-queue.ts + source-manager.ts.
  // Merge union (raster-resolution <- main): both bumps stacked
  // non-overlappingly (tileSize wiring +3, #1235 seams +7) — merged
  // high-water is the measured 4718.
  // 4718→4766 (#1272): completes the #1158 coverage render wiring the rebuild
  // left as a bare `continue` (arms the CoverageRenderer from the `_coverage`
  // marker) + the setCoverageData host-push API for live NOAA refresh, and the
  // ADR-0010 read-in-place ingest (readCoverage → HDF5, no `.xgcov`).
  // 4718→4732 (#1192 batch 5): the sourceCRS registry-population comment
  // documents the real bug the animate-line/realtime-update ports' render
  // probe caught — every geojson source's lower.ts-defaulted 'EPSG:4326'
  // was read as an explicit declaration, so getSeededFC() (the #1242 gap-2
  // check) rejected updateFeature() for every .xgis-declared/URL geojson
  // source. One-line functional fix; the rest is comment.
  // 4732→4749 (#1229 item 1): the public `getMissingTileCount()` accessor + its
  // `_missingTileCount` host field (both render paths write the per-frame in-
  // flight tile sum) so the playground can surface a tile-loading affordance
  // without polling the allocating `stats` getter. Irreducible: a class field +
  // a one-line read accessor + their docs (§2); the count is computed in
  // render-loop.ts, not here.
  // 4715→4729 (symbol fade): the `labelFadeDurationMs` field (+doc, MapLibre
  // fadeDuration parity, options-bag consumption) + the fade keep-alive read
  // in shouldRenderThisFrame (mirrors the adjacent _sceneHasAnimation line).
  // The fade machinery itself lives in text/label-fade.ts — wiring only here.
  // 4718→4756 (#1255 paint transitions): the paintTransitionDurationMs
  // option field (+doc, option-bag consumption), the registry field, the
  // transitions context handed to XGISLayer at construction, the
  // shouldRenderThisFrame keep-alive read, renderFrame()'s settle sweep,
  // and the two scene-rebuild clear() calls. The transition MECHANISM
  // lives extracted + unit-proved in paint-transitions.ts — wiring only
  // grew here.
  // 4718→4788 (#1256 easeTo/flyTo): the cameraAnimationDurationMs option +
  // reduced-motion override fields (+docs, option-bag parse), the three new
  // CameraController deps handed at construction, the isAnimating()
  // keep-alive in shouldRenderThisFrame, renderFrame()'s pre-compose
  // tickAnimation, the _animClockMs / _prefersReducedMotion helpers, the
  // stopAnimation() method + the lifecycle-stop cancel, and the easeTo
  // signature widening. The animation MECHANISM (vWN path + driver) lives
  // extracted + unit-proved in camera-animation.ts; only wiring grew here.
  // Merge union (camera animation <- main): the fade/tile-count/CRS/paint-
  // transition stacks (→4801) and the #1256 camera-animation wiring (+70) are
  // non-overlapping, so the merged file measures the 4871 wc -l, not
  // max(4801, 4788).
  // 4871→4911 (#1260 reduced-motion): the effectiveFadeDurationMs +
  // _onReducedMotionChange helpers, the _detachReducedMotion field + its
  // _setupAccessibility attach / destroy() detach, the paint-transition
  // durationMs getter now folding in _prefersReducedMotion, and the
  // _prefersReducedMotion refactor onto the pure resolveReducedMotion. The
  // precedence resolver + media-query watcher live extracted + unit-proved in
  // map-accessibility.ts — only the wiring grew here.
  // 4911→4994 (#1268 URL hash sync): the `hash` option parse + _hashSync /
  // _hashMoveHandler / _hashWriteTimer fields, the ctor boot-seed (fragment
  // wins over the camera options) via _setupHashSync, the debounced move-end
  // _scheduleHashWrite / _writeHash (replaceState) pair, and the destroy()
  // detach. The format/parse/namespace-merge MECHANISM lives extracted +
  // unit-proved in map-hash.ts (86 LOC, under the cap) — wiring only here.
  // Merge union (#1272 <- main): main's camera/fade/hash stack (→4994) and the
  // #1272 coverage wiring (+48 over the 4718 base) are non-overlapping, so the
  // merged file measures 5042, not max(4994, 4766).
  // 5042→5063 (#1263 cursor feedback): the `cursor` option, the `_cursor`
  // field + ctor construction, four `setInteracting` wire-ups in the controller
  // event arms, the dispatcher `onHoverActiveChange` dep, and the destroy()
  // teardown — wiring only; the grab/grabbing/pointer policy MECHANISM lives
  // extracted + unit-proved in cursor.ts (well under the cap).
  // 5063→5094 (raster tile fade-in): the `rasterFadeDuration` option + field,
  // the effective-duration (reduced-motion) + apply helpers, the two renderer-
  // setup applies, the reduced-motion re-apply, and the shouldRenderThisFrame
  // keep-alive. Wiring only; the per-tile ramp + cross-fade live in the raster
  // renderer. +31, measured post-hook.
  // 5094→5099 (particle-flow idle keep-alive): the shouldRenderThisFrame gate ORing
  // in `_graphics.hasAnimatedGraphics()` so a currents overlay's drift does not freeze
  // on a static camera. Wiring only; the animation authority lives in graphics-manager.
  // +5, measured post-hook.
  // 5099→5111 (#1302 declarative arrows): the isArrow fork in rebuildLayers + the
  // arrow-show import + the clearCompiledArrows call. Wiring only; per-feature eval
  // lives in arrow-show.ts and the draw in graphics-manager. +12, measured post-hook.
  // 5111→5169 (#1272 E-③ forecast time): the setCoverageTime / playCoverageTime /
  // pauseCoverageTime public API — thin `this`-coupled glue (re-read a Group_NNN over
  // Range + re-arm the CoverageRenderer). The reusable state (epoch guard + playback
  // timer + the pure index/ISO→group resolver) lives in coverage-time.ts. +58, post-hook.
  // 5169→5192 (#1333 coverage `| arrow`): arm the engine S-111 arrow field — the coverage
  // block's `if (show.isArrow)` call + the `_coverageArrowsArmed` flag + its reset + the
  // data-swap re-derive branch in setCoverageData/setCoverageTime. Thin `this`-coupled glue;
  // the generator + portrayal rule live in coverage-arrow-show.ts / s111-portrayal.ts.
  // +23, post-hook.
  // 5192→5205 (#1333 arrows-only + time): the `arrowsOnly` guard that skips the fill for a
  // `| arrow` coverage with no `ramp` (strict S-111 = arrows, no raster), + setCoverageData's
  // `{ url }` option so a host-push keeps `_url` and setCoverageTime can step forecast hours.
  // +13, post-hook.
  // 5205→5212 (#1333 play fix): setCoverageData `{ group }` re-decodes the ALREADY-DOWNLOADED
  // pushed bytes at a different forecast hour — the mosaic steps time with zero network, so
  // play can't crash on a range re-fetch. +7, post-hook.
  // 5212→5240 (#1333 coverage `| particles`): arm the animated particle-flow field alongside
  // `| arrow` — the `_coverageParticleHandle` + `_coverageParticlesArmed` fields, the
  // `_coverageFieldArmed` getter (single predicate for both fields' rebuild-vs-fast-path
  // choice, replacing the arrows-only check at both call sites), the coverage block's
  // `if (show.isParticles)` arm + its `.remove()` reset, and generalizing `arrowsOnly` to
  // `fieldOnly`. Thin `this`-coupled glue; the generator lives in coverage-particle-show.ts
  // (a new, non-baselined file, well under its own 800-line cap). +28, post-hook.
  // 5240→5330 (#1333 forecast-time interpolation): `_coverageFieldShow` (captures which show
  // armed the field, for a targeted re-paint outside a full rebuild) + its reset;
  // `_armCoverageFields` (re-derive fill/arrow/particle from a TRANSIENT handle — the coverage
  // arm's own logic, factored out so interpolation doesn't pay for a full rebuildLayers);
  // the public `setCoverageFrame` (lets a host's own playback loop, e.g. a zero-network mosaic
  // cache, push a blended frame); `playCoverageTime`'s `interpolateSteps` option + its
  // `stepFraction` closure (decode the "to" hour once per transition, blend via
  // `interpolateVectorCoverage`, `setCoverageFrame` each sub-step). The interpolation MATH
  // itself lives in @xgis/data (interpolate-vector.ts); this is the `this`-coupled wiring
  // only. +90, post-hook.
  // 5330→5336 (hillshade tile fade-in): the DEM relief now cross-fades on the SAME
  // ramp as raster, and map.ts is the single owner of both hooks the ramp needs — the
  // keep-alive gate (`hillshadeRenderer.hasFadingTiles()`, beside the raster line it
  // mirrors) and the reduced-motion push (`setHillshadeFadeDurationMs` from the SAME
  // effectiveRasterFadeDurationMs, so there is no second duration knob to drift). Two
  // one-line wirings + their notes; irreducible — neither hook can live anywhere else.
  // +6, post-hook.
  //
  // +5 (#1333): the flow-field keep-alive in `shouldRenderThisFrame`. IBFV is a RECURSIVE
  // filter, so it advances only on RENDERED frames — an idle loop stops the animation rather
  // than pausing it. Deliberately NOT extracted: `shouldRenderThisFrame` IS the composition
  // root's idle decision and already carries four sibling one-line gates (text fade, raster
  // fade, particle flow, pending source work); moving the fifth elsewhere would scatter one
  // decision across two files. Post-hook.
  //
  // +10 (#1333): OWNERSHIP wiring for the FlowRenderer — the field declaration, its assignment
  // at the two renderer-set mount points (run / runBinary), the import, and the dispose in
  // _releaseGpuResources. Nothing extractable: the class itself is a separate file
  // (render/flow-renderer.ts) and its construction already lives in the shared
  // scene-renderers.ts builder; what remains here is exactly the lines that must name the
  // member on XGISMap, which is where every other renderer's ownership also lives. Post-hook.
  //
  // +10 (#1367): the forecast-hour step fix — an epoch guard on `setCoverageData` (2 lines) plus
  // the rationale for BOTH swap paths re-deriving only the coverage arm instead of running a
  // full `rebuildLayers()`. Irreducible: these are edits to the two public swap methods, which
  // live here. The measured per-step cost that motivated them is recorded on
  // render/coverage-timestep-cost.test.ts, not in this file. Post-hook.
  //
  // MERGE UNION (#1333/#1367 <- main): the hillshade fade-in (+6, main) and this branch's work
  // (+5 keep-alive, +10 FlowRenderer ownership, +10 step fix) are non-overlapping edits to
  // different methods, so the merged file measures their SUM — not max() of the two ceilings.
  // Same accounting the render-loop.ts entry below already records for the #1272 merge.
  //
  // +91 (#1158 S-102 live refresh): the three public refresh methods (`refreshCoverage` —
  // probe, decide, epoch-guarded re-read, re-arm; the `autoRefreshCoverage` /
  // `stopAutoRefreshCoverage` pair) + the scheduler field + its destroy() stop. The POLICY
  // (validator comparison, the decision table, the poll loop's lifecycle) lives in
  // coverage-refresh.ts and is unit-tested there; map.ts keeps only the `this`-coupled
  // wiring, mirroring the coverage-time.ts precedent. Partly paid for by extracting
  // `_rearmCoverage` — the post-swap re-arm block setCoverageData and setCoverageTime each
  // carried a copy of, now one authority the three swap paths share. Post-hook.
  //
  // MERGE UNION #2 (#1158 <- main @ 4accf02): main's #1367 freeze fix and this branch's
  // `_rearmCoverage` extraction landed on the SAME block — the fix replaced
  // `rebuildLayers()` with `_armCoverageFields()` inside the block the extraction moved. The
  // resolution keeps BOTH: the extracted single authority now carries the coverage-arm-only
  // re-arm, so neither the freeze fix nor the de-duplication was dropped. Lower as #991
  // decomposes map.ts.
  //
  // +1 (#1371): the `getVtSource` SourceManager dep, so a host data push swaps a source's
  // backend on the LIVE catalog instead of tearing the pair down. One line, same union
  // accounting as above — non-overlapping with the three bundles.
  //
  // MERGE UNION #3 (#1366 <- main @ 023a9b7): main's #1333 follow-up extracted the drape-arm
  // decision into `coverageDrapeArm` and retired `| particles` for `| flow`, so this branch's
  // own `coverageDrawsFill` predicate was DELETED rather than merged — the label case moved
  // into main's extraction, which is the single authority for it. That is a NET SHRINK on top
  // of the sum, which is why the measured number is below 5452 + 1.
  // re-arm, so neither the freeze fix nor the de-duplication was dropped. Measured 5452 =
  // 5330 + 31 (main) + 91 (branch). Lower as #991 decomposes map.ts.
  // +1 (#1371): the `getVtSource` SourceManager dep, so a host data push swaps a source's
  // backend on the LIVE catalog instead of tearing the pair down. One line, same union
  // accounting as above — non-overlapping with the three bundles, so the merged file is 5362.
  // MERGE UNION #3 (#1158 <- main @ 904a528): both sides' deltas are non-overlapping edits
  // to different methods, so the merged file measures their SUM. Value below is the MEASURED
  // post-hook line count, not an arithmetic guess.
  // MERGE UNION: non-overlapping deltas; the value is the MEASURED post-hook count.
  // 5409→5412 (#1272 E-④ follow-up): the coverage deps record binds the renderer through a
  // THUNK instead of capturing it. `coverageRenderer` is declared `!` and assigned only at
  // GPU boot, so the captured form was `undefined` forever — it broke every ramp-only
  // coverage push and every mosaic region eviction, and shipped green. +3 is the one-line
  // change plus the three-line reason; there is nothing to extract from a single binding,
  // and dropping the comment would leave the next reader free to "simplify" it back.
  // 5412→5438 (#1419): the advected-arrow arm — `_armAdvectedArrows` (the `| flow` +
  // `arrows` portrayal fork, the peak-speed read off the UPLOADED field, and why a
  // not-yet-uploaded region arms nothing), its two call sites, and the one line handing the
  // graphics store the FlowRenderer that owns the arrow state. It is a coverage ARM, which is
  // what this file's coverage section already is; extracting a five-line fork to a module of
  // its own would move the decision away from the other three arms it must stay consistent
  // with. Measured post-hook.
  // 5438→5447 (#1419, second pass): the drape arm now keeps RESIDENCY and PAINTING apart —
  // skipping the arm was also skipping the coverage upload, so the advected arrow field had no
  // velocity textures and the portrayal rendered NOTHING (found by the render gate, not by any
  // unit test). +9 is the `needsResidency` fork, the `hidden` argument, and the four lines
  // saying why, which are the part a future reader needs most.
  // 5447→5387 (#1426): the deferred coverage attach needed a THIRD arm site, so the
  // arm itself came OUT — armCoverageDrape/armCoverageShow/armAdvectedArrows/armLandedCoverage
  // now live in coverage-arm.ts, taking the map structurally. #1419's residency/`hidden` fork
  // and its advected-arrow fork moved WITH it, unchanged. LOWERED per the shrink-only rule.
  //
  // MERGE UNION (#1419 follow-up <- main @ #1426): my side's +1 was the arrow clear moving out
  // of the `| arrow` branch — that line now lives in coverage-arm.ts, so it adds nothing here
  // and main's LOWER ceiling stands. Value below is the MEASURED post-merge count.
  'map/src/map.ts': 5387,
  // Baselined at #1255 (measured 830): the DOM-inspired layer API crossed
  // NEW_FILE_CAP with the paint-transition style-setter integration — the
  // StyleHost.transitions context, the shared applyNumber/applyColor
  // helpers, and the four setter rewires (fill/stroke/opacity/strokeWidth
  // route their paintShapes writes through the #1255 registry; the ramp
  // machine itself lives in paint-transitions.ts). Cohesive layer-API
  // ownership (registry + style proxy + feature events) — shrink-only
  // from now; split (LayerIdRegistry / events vs style) if it grows again.
  'map/src/layer.ts': 830,
  // Baselined at #1235 (measured 846): SourceManager crossed NEW_FILE_CAP with
  // the gap-1/gap-2 seams — the setSourceData virtual re-seed branch (the
  // legacy worker-compile path renders fills/points but no line segments) +
  // the attach-time ShowSourceMaps/seeded-FC records the re-seed and the
  // feature-update queue read. Cohesive source-lifecycle ownership; split
  // (attach arms vs push/ingest) when #991 gets here — shrink-only from now.
  // (raster-resolution merge: the tileSize passthrough line lands inside the
  // existing 846 measurement — no growth.)
  // 846→849 (#1272): thread the coverage source's ramp/range display options
  // onto the `_coverage` marker so rebuild arms the CoverageRenderer with them.
  // 849→841 (#1158 S-102 live refresh): the coverage attach's range-then-whole-file
  // ladder moved to `coverage-fetch.ts` so `Map.refreshCoverage` reads through the same
  // authority. Ceiling LOWERED to lock the extraction in, per this gate's own rule.
  // 849→925 (#1371 atomic re-seed): `_reseedInPlace` — the data-swap sibling of the attach.
  // It repeats that method's bookkeeping (reproject → seeded FC → polar caps → heatmap points)
  // against the SAME catalog, then swaps the backend. Sharing the body with the attach would
  // mean parameterising camera-fit, pipeline setup and registration away — more coupling than
  // the 76 lines cost.
  // MERGE UNION: a −8 extraction and a +76 addition to different methods, so the merged file
  // measures 849 − 8 + 76. The extraction stays locked in — the union is the sum of the two
  // deltas, never max() of the two ceilings.
  // measures 849 − 8 + 76. The extraction stays locked in — the union is the SUM of the two
  // deltas, never max() of the two ceilings.
  // 925→926 (#1272 E-④ multi-region): ONE line — the `DEFAULT_REGION` import. A coverage
  // source now holds a keyed Map of regions, so the declared single cell must name the key it
  // lands on. There is nothing to extract: the ingest branch itself did not grow, and the same
  // change moved 100+ lines of region/time-axis logic OUT of map.ts into coverage-source.ts
  // (map/src/map.ts came DOWN 5362→5339 in the same commit).
  // MERGE UNION (#1158 <- #1272 E-④): a −8 extraction (the coverage attach's fetch ladder moved
  // to coverage-fetch.ts, shared with refreshCoverage) and main's +77 are edits to different
  // methods, so the merged file measures their SUM. The extraction stays locked in.
  // MERGE UNION (#1353 × #1371/#1272): both sides edited this file over the same 849 base and
  // the edits do not overlap, so they SUM — never take one side, never max() the two ceilings.
  // #1353's teardown fix added `_dropTilingIndexWithCatalog` + its two attach call sites (+22)
  // and paid for it by EXTRACTING setSourceData's input contract (Feature/bare-Geometry lift,
  // features-array guard, ingest-budget guard) to source-data-normalize.ts (−36 net) — that
  // block never touched `this`, and setSourceData is now just the re-seed-vs-raw-write
  // decision. Ceiling below is the MERGED file's actual wc -l, measured after prettier.
  // MERGE UNION: both sides' deltas are non-overlapping, so the value is the MEASURED count.
  // MERGE UNION: non-overlapping deltas; the value is the MEASURED post-hook count.
  // #1426 left this file at its ceiling exactly: the `type: coverage` branch stopped awaiting
  // its multi-MB read (retiring the fetch/read imports) and spent the saved lines on the
  // host-fed `url`-less guard + its reason. Net 0 — nothing to lower.
  'map/src/source-manager.ts': 903,
  // 1920→1930 (#1042 R3): the globe limb cull for MULTI-LINE labels must land in
  // the collision phase — the ONLY site holding the label's quad half-height (the
  // collision box IS the height authority; the label-pass dispatch site has only
  // the unresolved TextValue). +10 = the `limbInset` prepare() param + the
  // box-height gate at collisionInput. An 8-line predicate isn't extract-worthy (§2).
  // 1930→1941 (#1081): the point-loop folds the per-anchor perspectiveScale into
  // sizePx — the SINGLE quad authority, so the collision box AND the draw quad
  // scale together (and the #1042 R3 limb gate then compares the SCALED half-
  // height). +11 = the sizePx fold (quantised 1/64 for layout-cache stability) +
  // addLabel's perspScale param/push. Inline in the hot loop; not extract-worthy (§2).
  // 1941→1975 (#777 I-A): the icon-text-fit read hook — the per-pairKey shaped-bbox
  // stash (`_pairFitBox` field + doc, the top-of-prepare clear, the two hit/miss
  // stash sites) + the `getPairFitBoxes` getter, so IconStage can fit a shield quad
  // to its paired text. +34, all read-only (no text-layout change); a minimal
  // cross-subsystem hook — the ONLY Phase-I cluster that touches text-stage (§2).
  // 1975→2066 (#777 I-G): inline images in label text — addLabel/addCurvedLineLabel
  // carve the PUA marker out of the resolved text (parseInlineImages), the point loop
  // resolves sprites + widens totalAdvance + branches the pen fill to the image-aware
  // helper (both in text-stage-helpers.ts, where the arithmetic lives + is unit-tested),
  // and the survivor loop emits placements for IconStage. +91; image-bearing labels
  // bypass the layout cache; the plain-label path is byte-identical (§2).
  // 2066→2068 (#1177 replay correction): render() gains the optional S16
  // skip-replay transform param, forwarded to TextRenderer.draw. +2.
  // 2068→2085 (near-first collision): CollisionItem.nearY wiring — one field
  // (`nearY: s.layouts[0]?.draw.anchorY`) so same-layer overlaps resolve
  // near-first on pitched views (site report: Shanghai dropped for Seoul at
  // pitch 81°), +16 comment lines (precedence note (3), the nearY rationale,
  // and the corrected byte-identical claims). Logic lives in text-collision.ts.
  // 2085→2136 (near-on-top draw order): the default/`auto` legacy emit now
  // Y-sorts DRAW order WITHIN each layer so overlapping allow-overlap labels
  // paint near-on-top (the collision sibling decided which SURVIVES; this
  // decides which paints last). +51 = the gated in-place drawOrder sort (≥1
  // allow-overlap, else source order at zero cost) + its rationale block + the
  // `layerName` thread onto pending/shaped (the layer-precedence key, ranked by
  // first appearance) at addLabel/addCurvedLineLabel + the 3 shaped pushes.
  // 2068→2155 (symbol fade): the prepare()-side fade wiring — the ledger /
  // holdover-store fields + ctor init, the dispatch-order fadeInstanceKey
  // precompute, the placed-branch place()+store, the fade-out holdover
  // emission + sweep, the empty-prepare wholesale arm, the eviction clear,
  // and the holdoverOk param (+docs). The MECHANISM (ledger, holdover clone
  // store) lives extracted + unit-proved in text/label-fade.ts; only the
  // prepare-loop integration grew here. +87.
  // Merge union (symbol fade <- main): near-first collision (+68) and symbol
  // fade (+87) stack non-overlappingly on the shared 2068 base — they SUM to
  // the measured 2223, not max(2136, 2155).
  // 2223→2230 (#1260 reduced-motion): the setFadeDurationMs passthrough (+doc)
  // that forwards a live reduced-motion / option change to the ledger's new
  // setDurationMs. Mechanism in text/label-fade.ts; a thin forwarder here. +7.
  // 2230→2239 (#1254 zoom-blink fix): the fade key now strips the zoom-varying
  // invLayer prefix via fadeStableIdentity (+doc) so a stable label doesn't blink
  // on a zoom-level tile swap. The strip helper lives in text/label-fade.ts. +9
  // (the fade-key change +4, plus the prettier pre-commit hook wrapping the now-
  // 4-name label-fade import onto 6 lines +5 — measured post-hook via
  // `git show HEAD: | wc -l`, correcting the pre-hook 2234 #1298 landed with).
  // 2239→2284 (fade-out-during-zoom): a label dropped mid-zoom now REPROJECTS its
  // holdover (holdover-reproject.ts) so it fades in place instead of popping.
  // Here: the _fadeHoldoverBake map + import, the motionHoldover prepare param,
  // the per-prepare makeBakeFrame + placement stamp, and the holdoverDrawToEmit
  // emit + parallel bake sweeps (empty-prepare + eviction). Math + decision live
  // extracted/unit-proved in holdover-reproject.ts. +45, measured post-hook.
  'map/src/text/text-stage.ts': 2284,
  // 1786→1719 (#727 C): the line/point dedupe + pair-key helper block was
  // EXTRACTED to passes/line-label-dedupe.ts when the world-copy fan-out would
  // otherwise have grown this file — the extract-don't-grow answer.
  // 1719→1726 (#1081): thread the projector's per-copy perspScale (projectLonLat
  // Copies tuple slot 3) into the point-label addLabel + dispatchIcon, plus
  // dispatchIcon's own perspScale param → addIcon. +7, all at existing call sites.
  // 1726→1747 (#1081 fix): the reland wired Path 1 (GeoJSON) only — thread the
  // same perspScale through BOTH VT point-label arms (globe: tuple slot 3;
  // mercator: the perspectiveScale() scratch getter). +21, dominated by prettier
  // wraps (the 6-name projector destructure + the globe arm's 8-arg dispatchIcon
  // both go one-per-line). Same existing call sites; nothing extract-worthy (§2).
  // 1749→1851 (#777 I-B + I-F, merged): I-B icon-keep-upright adds the exported
  // resolveIconRotateRad helper (+JSDoc — dispatchIcon is an anon closure, so the
  // upright half-plane fold math is extracted for unit coverage), the dispatchIcon
  // fold call, and the inline `def` iconKeepUpright field (+39); I-F icon
  // value-forms adds 3 per-feature exprAst sources (icon-size / icon-opacity
  // data-driven, icon-translate expr → [dx,dy]), the extended null-guard, and 3
  // applyFeatureExprs evaluate blocks mirroring the text-size/color/icon-image
  // arms (+63). Both additive; nothing extract-worthy (§2).
  // 1851→1863 (#777 I-A): dispatchIcon's inline `def` gains iconTextFit/
  // iconTextFitPadding, the addIcon call gains the `fit` opt, and the
  // setPairFitBoxes handoff mirrors the existing setDroppedPairKeys line. +12,
  // all at existing call sites; nothing extract-worthy (§2).
  // 1863→1869 (#777 I-G): the setSpriteMetadata injection before stage.prepare +
  // the setInlineImagePlacements handoff after it — both mirror the adjacent
  // setPairFitBoxes line. +6 at the existing stage-prepare site; nothing else (§2).
  // 1869→1906 (#777 I-E): ensureBackgroundPatternAtlas — the background-pattern
  // sprite-atlas gate (a label-less style still loads its sprite; onLanded
  // invalidate() re-arms the idle loop). A free exported function so the gate +
  // hook are behaviour-gated GPU-free (mirrors backgroundClearValue). +37.
  // 1906→1956 (#1177 Option B): zoom-tolerant prepare skip — the skip state
  // gains preparedZoom/prevFrameZoomKey/preparedCenterX/Y/centerLatDeg (each
  // with its contract doc), the active-zoom tolerance branch (|Δzoom| ≤ 0.15,
  // centre ≤ 48 px) beside the exact settled compare, the per-frame
  // prevFrameZoomKey update, and the design-rationale comment. +50, all inside
  // the existing S16 skip block; nothing extract-worthy at this size (§2).
  // 1956→2002 (#1177 replay correction — the Option B staleness fix): the skip
  // state gains replayRefs/replayRefsValid/replayOut, the miss branch samples
  // reference points, hit frames solve prepared→current and pass it to the 4
  // stage/iStage render calls. The MATH lives extracted in
  // passes/label-replay-transform.ts (unit-proved); only wiring grew here. +46.
  // 2002→2005 (near-first collision): labelCollisionId composes with the
  // TIEBREAK_GROUP_SEP const now owned by text-collision.ts (import + 2 doc
  // lines); the ordering logic itself lives there. +3.
  // 2002→2063 (symbol fade): the per-frame ledger advance + completion
  // LABEL-dirty at execute() top, the tsOpts.fadeDurationMs line, the
  // holdoverOk exact-camera derivation beside the S16 signature (uses the
  // same locals), the stage/iStage prepare threading + setFadeLedger
  // handoff, and dispatchIcon's fadeId param at the collisionId-bearing
  // call sites. Mechanism in text/label-fade.ts; wiring only here. +61.
  // Merge union (symbol fade <- main): near-first collision (+3) and symbol
  // fade (+61) stack non-overlappingly on the shared 2002 base — they SUM to
  // the measured 2066, not max(2005, 2063).
  // 2066→2069 (#1260 reduced-motion): the lazy-construction fade read now folds
  // in prefers-reduced-motion via host.effectiveFadeDurationMs() (+3 doc lines
  // explaining the boot-disabled vs live-flip split). One existing call site. +3.
  // 2069→2098 (fade-out-during-zoom): builds the motionHoldover ctx (holdover-
  // reproject.ts) — the mercator+pitch-0 similarity-safe gate + a solve closure
  // over the #1177 replay refs/projector — and threads it into stage.prepare +
  // iStage.prepare so a fade-out label/badge reprojects instead of popping mid-
  // zoom. Reuses the existing replay machinery; wiring only here. +29.
  // 2098→2130 (#1314 line-label edge-inset cull): the LINE_LABEL_EDGE_INSET_CSS_PX
  // const + doc, the per-layer lineLabelEdgeInsetPx + anchorInView closure (+doc),
  // the withinViewportInset import expansion, the four vector-tile along-line
  // emit-site guards (curved short/spacing conditions, the placeLabelsAlongLine
  // cull arg, the line-center midpoint gate), AND the inline (raw-GeoJSON) path's
  // cull closure at the placeInlineLineLabels call — so a near-edge line label is
  // dropped instead of rendering glued half-off-screen, on BOTH the tile and inline
  // paths. The predicate + cull-aware walk live in place-labels-along-line.ts
  // (unit-proved); only wiring grew here. +32, post-hook.
  // 2130→2150 (#1366 INC-5 sounding labels): a THIRD dispatch arm — an S-100 gridded
  // coverage. It matched neither existing path (a grid has no `features` and no vtSources
  // entry), so `| label-[…]` on a coverage layer compiled and drew nothing. The selection
  // walk AND the emit loop were both extracted (coverage-sounding-anchors.ts,
  // dispatch-coverage-soundings.ts, both unit-proved); what remains here is the branch
  // itself + the per-frame closures the pass owns and cannot hand off (the camera
  // unprojector, the viewport, applyFeatureExprs, projectLonLatCopies, addLabel). +20.
  // 2150→2116 (overlay-native-resolution INC-1): the pass now names WHICH target geometry it
  // reads (`ctx.screen` — it is the overlay), which cost a line the ceiling had no room for.
  // Paid by extraction, not by a bump: `ensureBackgroundPatternAtlas` moved to
  // background-pattern-atlas.ts (one call site, its own GPU-free gate).
  // →2081 across two main merges. Both sides lowered this independently and BOTH wins are
  // banked: the resolution is the MEASURED post-prettier size of the merged file, never either
  // side's number. Picking one would silently hand back the other's reduction as headroom to
  // re-spend, which is the quiet way a shrink-only ratchet stops shrinking.
  'map/src/render/passes/label-pass.ts': 2081,
  // #1081 — per-anchor perspective distance attenuation (MapLibre parity). New
  // baseline: the wCenter + perspScale scratch-out-value lives INLINE in the two
  // existing projector closures (it rides the cw already computed per anchor —
  // not extract-worthy, §2), plus the perspectiveScale() getter, the 3-slot
  // projectLonLatCopies tuple, and the 6-member return objects prettier now wraps
  // multi-line — together nudging this helper just over NEW_FILE_CAP (773→818).
  'map/src/render-loop-helpers.ts': 818,
  // 1458→1505 (#1155 F4 mount-hang): the per-variant WGSL emit is deduped —
  // buildShader now memoizes emitPolygonWgsl by (variant.key, pickEnabled), and
  // the already-emitted wgsl is plumbed through create{Variant}Pipelines[Async]
  // + buildVariantDescriptors into registerFillMaterials, killing the SECOND
  // full shader-dsl emit + O2 fixpoint per variant (~13× on OFM Bright, the
  // main-thread mount-hang). +47 is the memo + the `{ pipelines, wgsl }` return
  // threading + rationale comments; the emit is byte-identical (§2 — no
  // extract-worthy unit, the dedup lives at the existing build sites). Lower as
  // #991 decomposes the render SCC.
  // 1505→1613 (#1252): the data-driven extrude pipeline family — the
  // fillExtruded/fallback descriptors in BOTH variant builders (sync +
  // async), the CachedPipeline return mappings, and the per-style extrude
  // Material twin build + registration (buildExtrudeMaterial over the variant
  // WGSL, feature layout). Cohesive with the existing per-style flat/ground
  // twin machinery it mirrors; lower as #991 decomposes the render SCC.
  // (measured 1621 post-prettier reflow of the extruded descriptors.)
  'map/src/render/pipeline-factory.ts': 1621,
  'map/src/camera/camera.ts': 1419,
  'map/src/shaders/dsl/line.ts': 1441,
  // 1373→1422 (#1246): the flat-projection stroke-width fix. The VS clamp's flat
  // branch is rewritten from the (miscalibrated, no-op) targetNdc clamp to a
  // self-calibrating length(mercProbe)/length(projProbe) = 1/J screen-size ratio
  // that widens ONLY the across offset (acrossOffset captured pre-along-pad), plus
  // a decoupled world_local_out Var so the FS stays byte-identical (true Mercator).
  // The globe (≥6.5) arm keeps the exact former ECEF clamp. +49 is the split
  // branch bodies + the four NDC probe reductions + rationale comments.
  // 1315→1339 (#1154): the pattern_active struct field (+ its rationale comment)
  // and the fill-translate `if (pattern_active == 0)` gate in the three VS entries
  // (vs_main / vs_main_ecef / vs_main_ecef_extruded) — fixes blank fill-patterns.
  // 1339→1344 (#1062): emitPolygonGlsl gains an optional `entry` override (+ its doc)
  // so the graticule twin can emit the vs_main / fs_stroke GLSL for its WebGL2 line
  // overlay — reusing the SAME polygon module instead of forking a shader.
  // 1339→1347 (#1059): emitPolygonGlsl gains an `entry` override (+ its doc) so the
  // WebGL2 twin can narrow the module to fs_fill_pattern for its ground fill-pattern
  // Material, plus the updated GLSL-twin-set charter comment. Emit byte-identical.
  // Merge union (#1062 + #1059): one shared `entry` override, charter covers both
  // consumers — merged high-water is the measured 1348.
  // 1348→1368 (#1198, merge union): the ECEF→vertex-ENU normal rotation in the
  // extrude VS (roof lighting was anchor-relative → continent-scale gradient) +
  // the exact |N_enu.z| wall/roof discriminator; oracle in
  // core/extrude-light-frame.test.ts. Stacked on the entry override — measured 1368.
  // 1368→1448 (#1252): the data-driven extrude fragment path — shade_geom
  // varying + the VS d_geom/vgrad_factor split (v_color byte-identical), the
  // fs_fill_extrude composer placeholder, and default/variantExtrudeReturnStmts
  // (fragment re-lighting of the feat_data colour). The shading math is a
  // faithful replay of the VS lighting; not extract-worthy (§2).
  // 1448 → 1476 (#1397): the extruded VS gained two vertex attributes
  // (wall_base, local_merc), the flat-arm plane-z gained its base term +
  // Mercator vertical scale, and the wall vertical gradient gained the
  // MapLibre `+ base` term. Shrink-only from here. (#1343 retired the runtime/
  // second authority, so this file is now the only one to update.)
  'map/src/shaders/dsl/polygon.ts': 1476,
  // 1290→1314 (#1155 F3): cold-start burst tick budget — the `_coldStartBurst`
  // field + `_BURST_TICK_BUDGET` + `setColdStartBurst` + the burst-selected
  // budget in resetCompileBudget's backend tick loop.
  // 1314→1360 (#1371 atomic re-seed): `refreshTiles` (re-request a CACHED key, the one thing
  // `requestTiles` refuses) + `consumeReplacedKeys` + the two key sets they own. Cache identity
  // and the request path both live here, so the pair cannot move out.
  // 1360→1402 (#1402 re-seed completeness): the refresh QUEUE the #1371 pair was missing —
  // `_refreshQueue` + `drainRefreshQueue` + the queue-first, de-duped key walk in requestTiles
  // + `markReplaced`. `requestTiles` breaks at the concurrency cap, so a one-shot refresh
  // re-tiled only the tiles that happened to fit and the rest kept the previous backend's data
  // forever. The queue has to live beside the cap it works around and beside the cache identity
  // it arms (`_pendingRefresh`), so it cannot move out.
  // MERGE UNION (#1353 × #1371 × #1402): non-overlapping edits over a common base, so they SUM
  // — never take one side, never max() the ceilings. #1353's teardown fix added the
  // `_onDestroy` list + `onDestroy` + the destroy() drain (+15) and paid for it by EXTRACTING
  // the quantized-ECEF quad construction out of createFullCoverTileData to
  // tile-full-cover-quad.ts (−47 incl. three now-orphaned ecef-packing imports) — pure geometry,
  // no `this`, and the layout with the #449 bug history is now directly assertable. Ceiling
  // below is the MERGED file's actual wc -l, measured after prettier.
  'data/src/tile-catalog.ts': 1370,
  // 1173→1180 (#1046 F1): thread the required `rhi: RhiDevice` onto the FrameContext at
  // both build sites — the main-chain init literal and the twin label stage — so a seam
  // can reach `ctx.rhi.caps.*` (doc §3-F1). +7 = two assignments + their rationale comments;
  // seam-only (no consumer reads caps yet). Lower as the twin frame retires (F6).
  // +8 (#1046 F2): the frame-shell RHI-sourcing branch + `__xgisRawFrameShell`
  // kill-switch (doc §3-F2). F6 slashes this file to ~880 (twin deletion).
  // 1188→1205 (#1046 F3): the `?rhichain=1` routing switch — the `_chainRunsOnWebgl2`
  // held-off field (+ its doc) and the twin early-return's routing comment/guard (doc
  // §3-F3). +17, all documentation of the held-off switch; the guard is byte-identical
  // (the twin still renders). F6 slashes this file to ~880 (twin deletion).
  // 1205→1213 (#1153 P2 R6): the WebGL2 takeGlErrors drain now routes through the
  // shared capped writer `pushValidationError` (rhi-webgpu) so the _validationErrors
  // queue can't grow unbounded — the 4-name import expansion + the drain-loop doc.
  // 1213→1212 (#1153 M5/M3, merged): the 5 bare rAF reschedules now route through
  // `host._scheduleFrame()` (the single park-aware scheduling authority) and the
  // per-frame dpr line adopts resizeCanvas's returned (clamp-aware) value — net -1 on
  // this PR's base.
  // 1213→1228 (#1057): the direct-layer points draw on the WebGL2 twin — one
  // pointRenderer.renderRhi call site (+ its updateDynamicSizes + hasLayers gate +
  // rationale) in renderFrameViaRhi, after the translucent bucket, mirroring the
  // WebGPU points-pass placement.
  // 1228→1252 (#1057 inc2): VT tile-points on the twin — pointRenderer.beginFrame()
  // (retired-buffer drain) + the per-opaque-show emitTilePointsRhi call in the opaque
  // loop (inside each show's fills+strokes, mirroring the WebGPU per-VTR flush), both
  // with rationale docs.
  // 1213→1227 (#1062): the graticule overlay draw on the WebGL2 twin — one
  // renderGraticuleOverlayRhi call site in renderFrameViaRhi (after the opaque
  // fills/strokes, before translucent), mirroring the WebGPU opaque-pass placement.
  // Merge union (#1057 + #1062): both twin call-site blocks stacked non-overlappingly
  // in renderFrameViaRhi — merged high-water is the measured 1266.
  // 1140→1169 (#1057): render() split into a thin GPURenderPassEncoder-wrapping
  // delegator + a single-authority renderRhi(pass: RhiRenderPass, …) so the WebGPU
  // pass-chain and the forced-WebGL2 twin share ONE point-draw body (uploadLayer +
  // writePointFrameUniform + PointDraper draw) — the twin's screen RhiRenderPass
  // flows straight in, no wrapWebGpuPass.
  // 1169→1174 (#1057 inc2): flushTilePoints renamed to flushTilePointsRhi(pass:
  // RhiRenderPass, …) — the draw seam already flowed through PointDraper, so only the
  // pass handle changes (wrap moves up to VTR.emitTilePointsRhi); +5 doc lines.
  // 1213→1237 (#1060): the heatmap twin call site — HeatmapRenderer.renderRhi runs
  // the 3-pass accum→blur→compose density pipeline on WebGL2 after the label pass
  // (the caps.floatBlendTargets gate + its doc). F6 slashes this file (twin deletion).
  // Merge union (#1060 <- main): stacked growth — measured 1290.
  // 1290→1315 (#777 Phase II, merge union): the hillshadeRenderer.beginFrame()
  // eviction hook + the HillshadePass ported into the forced-WebGL2 twin
  // (renderFrameViaRhi, after translucent, before points) + the
  // applyHillshadePaint import — so relief renders under ?forcegl2=1 (the
  // _hillshade-gl2-gate). Stacked on the #1057/#1062/#1060 twin call sites —
  // measured 1315.
  // Merge union (#1172 <- main): the M5/M3 scheduling-authority reroute (net -1)
  // stacked on main's twin lineage — merged high-water is the measured 1314.
  // 1314→1326 (raster-resolution): hillshade DEM fetches join BOTH keep-alive
  // checks (WebGPU + WebGL2 twin) — a hillshade-only scene otherwise idles
  // before its tiles arrive and the arrival never repaints (black relief).
  // 1326→1338 (#1229 item 1): both render paths publish the per-frame in-flight
  // tile sum to `_missingTileCount` for the public getMissingTileCount() accessor
  // — VT missed + raster/hillshade pendingLoadCount(). The WebGL2 twin derives its
  // keep-warm return from that single authority (count > 0). Irreducible: the two
  // write sites (one per path) + docs.
  // 1338→1341 (#1261): the WebGPU sprite-atlas push now reads the now-optional
  // getView via `?.` (the host atlas's WebGPU half became optional so its WebGL2
  // twin type-checks) + a 3-line rationale. One existing call site.
  // 1326→1344 (#1272): the coverage colour-ramp draw joins the forced-WebGL2
  // twin (renderFrameViaRhi), mirroring the opaque-pass dispatch — flat arm.
  // Merge union (#1272 <- main): the #1229/#1261 stack (→1341) and the #1272
  // coverage-twin draw (+18 over the 1326 base) are non-overlapping — the merged
  // file measures 1359, not max(1341, 1344).
  // 1359→1370 (hillshade tile fade-in): the forced-WebGL2 twin's keep-warm return
  // was a tile-COUNT only, so a tile that had finished FETCHING but was still
  // mid-fade froze the ramp at partial opacity (the count hits 0 on the last fetch)
  // — a permanently semi-transparent basemap/relief on that path until the next
  // interaction. Now ORs the two renderers' hasFadingTiles(), the same signals the
  // WebGPU loop's idle-skip already reads, + the note explaining why a count alone
  // cannot express "still converging" (and the correction of the older comment that
  // claimed the return was derived from the count alone). +11, post-hook.
  //
  // +12 (#1333): the IBFV advection step joins the twin, between the background
  // clear and the raster/fills — the producer slot for the coverage drape this
  // twin ALREADY draws. Two statements + the rationale for why the step is here
  // and not deferred (the GPU work itself is FlowRenderer), plus 3 lines
  // threading the RHI-TYPED frame encoder onto the FrameContext (`rhiEncoder`,
  // the F3/P5 direction) so that renderer names no WebGPU type and stays inside
  // the #991 backend-import + raw-WebGPU ratchets.
  //
  // MERGE UNION (#1333 <- main): the hillshade keep-warm fix (+11) and the flow
  // step (+12) touch different regions of the twin, so the merged file measures
  // their SUM, not max(1370, 1371).
  //
  // +5 (#1333 (b)): the twin's coverage draw now hands the drape the advected view
  // (2 statements + why `currentView` is THIS frame's image here, since the step
  // runs earlier in this same method) plus the FLOW_DRAPE_MIX import. Irreducible:
  // it is the twin's own call site, and the shader/material work it feeds lives in
  // coverage-ramp.ts and coverage-material.ts.
  //
  // +7 (#1419, measured after the prettier hook wrapped the call): the WebGL2 twin's
  // arrow-advection step, beside the trail step it already ran.
  // Irreducible for the same reason the +12 above was: this is the twin's own call site, and
  // omitting it is exactly the "?forcegl2=1 shows a different map" failure the twin exists to
  // prevent — here, a field of arrows frozen at their origins.
  //
  // +1 (#1419, second pass): the twin's trail step is now gated on a VISIBLE drape — under the
  // arrows portrayal every flow region is resident-but-hidden, so advecting a full-screen image
  // nobody draws was a per-frame cost with no picture attached.
  'map/src/render-loop.ts': 1395,
  // Baselined at 806 (hillshade tile fade-in): HillshadeRenderer crossed
  // NEW_FILE_CAP restoring the three tile-streaming fixes raster-renderer had
  // landed since hillshade was copied from it — the per-tile fade ramp + its
  // cross-fade underlay (emitTileAt / findCachedParent / eachCachedChild,
  // _fadeDurationMs / _hasFadingTiles / _lastTargetKeys), the #1153 P2 R4
  // load-path try/catch + .catch that un-wedge a loadingTiles slot, and the
  // pole-cap (tileOpacity, capSign) argument fix. It is the SAME cohesive
  // renderer shape as raster-renderer.ts (baselined 990), not a new god-file —
  // the two are deliberately separate so the hillshade prepare-pass upgrade can
  // diverge. Shrink-only from now; both collapse together when #991 decomposes
  // the render SCC.
  // 806→828 (failed-tile backoff): a DEM load that resolves null used to be
  // re-requested EVERY FRAME forever — and that is the common path, since a DEM
  // source has a real max zoom (terrarium stops at z15) while rasterCoverZoom asks
  // for zoom+1, so zooming past it makes every visible tile a permanent 404 that
  // pins all 6 concurrency slots. +22 for the failedTiles map, the two request-site
  // guards, the two failure/clear branches and the re-arm reset; the POLICY itself
  // (backoff curve + attempt cap) went to hillshade-tile-retry.ts rather than in
  // here, so it is unit-testable without a GPU and this file stays near its mark.
  // 828→836 (cold-start load budget): the leaf loop broke only at the FULL concurrency
  // budget, so on the first frame it took all 6 slots and the parent-fallback prefetch
  // right below it got none — nothing was drawable until a full-resolution DEM tile
  // landed, and terrarium PNGs measure ~131-143 KB against ~19-28 KB for a satellite
  // JPEG over the same ground. +8 = the 3-line rationale, the one `leafBudget` binding,
  // and the 4 lines prettier adds re-wrapping the now-101-char retry import. The POLICY
  // is again in hillshade-tile-retry.ts (leafLoadBudget), same split as the backoff.
  // 836→834 (merge union, #1413 <- main): the byte-budget cache landed here too, and its
  // `_cacheTile` helper REPLACED two inline four-line `tileCache.set` blocks (the leaf and
  // parent load paths), so the union is two lines SHORTER than this branch alone. Measured,
  // not guessed — shrink-only means taking the shrink.
  'map/src/render/hillshade-renderer.ts': 834,
  // Merge union (#1060 <- main): stacked growth — measured 1174.
  'map/src/render/point-renderer.ts': 1174,
  // 1106→1120 (#1043 state-hygiene): three unmask-before-clear / state-reset fixes for the
  // WebGL2 flicker class — beginScreenPass colorMask unmask (the colour sibling of #746/#780),
  // dispatchComputeToR32UI viewport snapshot+restore, and the setPipeline no-depth arm's
  // POLYGON_OFFSET_FILL reset. Each is a documented comment + one GL call (net +14).
  // 1120→1142 (#1046 F1): the RhiCaps record + its constructor population — 7 capability
  // truths frozen at build, with `floatBlendTargets` feature-DETECTED via getSupportedExtensions
  // (EXT_color_buffer_float && EXT_float_blend; a pure query, enables nothing → byte-identical).
  // +22 = the field + its doc comment + the frozen init. (F3 raises this again for beginRenderPass.)
  // 1142→1157 (#1046 F2): the required (INERT) acquireScreenView / acquireFrameEncoder
  // frame-shell methods + the FBO-0 SCREEN_VIEW_SENTINEL (twin never calls them; F3 wires them).
  // 1157→1285 (#1046 F3): the universal `beginRenderPass` — the #1049 descriptor-parity
  // umbrella (doc §2.4/§3-F3). The new FRAME encoder (WebGl2FrameEncoder) originates the
  // chain's passes; the device gains `beginRenderPass` dispatching a colour-sentinel
  // descriptor to the new FBO-0 screen arm (`beginScreenRenderPass`, GL-call-identical to
  // beginScreenPass) or the proven offscreen arm, `finishFrame` (the present analog), and
  // a shared `glCopyBufferSubData`. +128; byte-identical on the default WebGL2 boot (the
  // twin early-returns before the frame shell, so the frame encoder is never acquired).
  // Fail-loud on any non-bindable descriptor shape (no silent fallback). Lower in F6.
  // 1285→1292 (#1153 A): WebGl2Device.destroy() — the required RhiDevice whole-device
  // teardown (the WebGL2 twin of GPUDevice.destroy(), releasing the GL context via
  // WEBGL_lose_context). An interface method cannot be extracted out of its class, so this
  // is irreducible growth (+7); the map's teardown routes through it instead of the raw
  // fail-loud ctx.device proxy, killing the deterministic webgl2 teardown crash.
  // 1292→1341 (#1153 P2 R3): WebGl2Device now OWNS the canvas context-loss listeners —
  // the guarded 'webglcontextlost'/'restored' ctor attach (preventDefault + fan-out to
  // onContextLost/onContextRestored subscribers), the two subscription methods, the
  // bound-handler fields, and the destroy() removeEventListener-BEFORE-loseContext
  // teardown (the intentional-teardown guard). A device owning its own listeners can't
  // extract them; irreducible (+49).
  // 1354→1364 (#1049): createPipeline fail-loud guard rejecting an unsupported nonzero
  // depthStencil.bias.clamp (gl.polygonOffset has no clamp param) — inline descriptor
  // validation at the createPipeline entry, not extractable (+10).
  // 1364→1373 (#1057): VFMT gains a `uint32` entry (the SDF point quad_id lane) and the
  // bindAttributes glType selector grows one ternary arm to UNSIGNED_INT — both are
  // inline table/selector entries, not extractable (+9).
  // 1364→1376 (#1062): the 'line-list' topology seam — a Gl2Pipeline.topology field
  // (stored from desc.topology) + a drawMode() helper picking gl.LINES vs gl.TRIANGLES,
  // consumed by both draw / drawIndexed, so the graticule twin can draw segment pairs.
  // Merge union (#1057 + #1062): uint32 entry AND topology seam stacked — merged
  // high-water is the measured 1385.
  // 965→1000 (#1062): the graticule overlay's WebGL2 seam — renderGraticuleOverlayRhi
  // (the RHI twin of renderGraticuleOverlay, threading the canonical ECEF frame view
  // + projection into GraticuleRenderer.renderFrameRhi) + the RhiRenderPass import.
  // 1364→1384 (#1060): the heatmap r16float twin — ENABLE (not just detect) the
  // EXT_color_buffer_float / EXT_float_blend extensions so the density FBO is
  // color-renderable + blendable, plus the scalar `uint32` vertex format (the
  // accum quad's quad_id) with its UNSIGNED_INT glType arm.
  // Merge union (#1060 <- main): stacked growth — measured 1000.
  'map/src/render/renderer.ts': 1000,
  // Merge union (#1060 <- main): stacked growth — measured 1397.
  // 1397→1404 (#1196, merge union): destroy() stashes the pre-loss
  // WEBGL_lose_context handle on the canvas (stashGl2RestoreToken) —
  // getExtension() is null on a lost context, so a same-canvas remount could
  // never restore without it. Measured 1404.
  // 1404→1436 (#1049, merge union): descriptor-parity batch — the MRT per-target
  // blend/writeMask divergence guard (fail-loud; ES 3.00 lacks
  // OES_draw_buffers_indexed), frontFace modeled + applied at setPipeline,
  // UNPACK_ALIGNMENT restored to the GL default after ad-hoc uploads, and
  // createPipeline unbinding the program after reflection. Stacked on the
  // #1057/#1062/#1060/#1196 growth — measured 1436.
  // 1436→1464 (#1419): the dev-only texture-usage guard. WebGPU validates every queue write
  // against the target's usage flags and WebGL2 validates nothing, so a texture missing
  // `copy-dst` passes every headless render gate here and dies at boot on WebGPU — it cost the
  // S-111 advected arrow field exactly that. The software backend now enforces the stricter
  // contract in dev, which is the only place the class is catchable without a WebGPU adapter.
  // +28 is the guard, the `usage`/`label` fields it reads, and the reason — the reason being
  // the part that stops someone deleting a check their own backend does not need.
  'rhi-webgl2/src/rhi-webgl2.ts': 1469,
  // 941→975 (#1371 atomic re-seed): `releaseSupersededTile` + `dropTile`, and the split of
  // `_releaseTileSlots` into a resource-release body the two share with eviction. Arena/pool
  // ownership is this class's whole reason to exist.
  // 975→946 (#1357): the pooled-buffer recycler moved out to gpu-buffer-pool.ts
  // (bucketing + entry cap + the new byte cap), which also orphaned the raw
  // `device` field — its only reader was the pool's createBuffer.
  'map/src/render/gpu-tile-store.ts': 946,
  // 930→948 (#1078): the zoom-transition readiness gate now probes the SAME
  // selector the frame draws with — routeToSphereSelector picks globeVisibleTiles
  // on the globe/sphere route (vs the flat visibleTilesSSE) so cz hold/advance is
  // decided over the drawn set, not a Mercator-frustum proxy. +18 is the two-arm
  // selector branch (irreducible: both selector calls wrap one-arg-per-line under
  // prettier) + its rationale. Lower as #991 decomposes the selection SCC.
  // 948→977 (#1153 #12): SINGLE-slot frame-tile memo → per-margin LRU. N shows
  // with divergent stroke-derived cull margins ping-ponged the one slot within a
  // frame, re-running the 7-16 ms quadtree walk several times per frame; the LRU
  // (keyed by marginPx, SAME frameId/currentZ/maxLevel invalidation) walks once
  // per distinct margin. +29 = LRU map + per-entry array ownership (a shared
  // scratch would clobber across margins) + the walk-count gate hook. The file's
  // own doc mandates keeping selection cohesive (no split); lower as #991 decomposes.
  // 977→985: FRAME_TILE_CACHE_SLOTS 8→16. 8 sat BELOW the frame's real distinct-
  // margin count, so the LRU evicted a margin the SAME frame still needed and
  // re-walked it — the ping-pong the LRU exists to kill, one N up. Measured (RTX
  // 2080, OFM Bright z14 Tokyo, wheel zoom): D = 10 distinct walks/frame median,
  // 14 max, at 7.2 ms @pitch0 / 16.3 ms @pitch60 each. +8 is the constant's
  // rationale (the measurement that picks 16 over 8) — the constant is line-neutral.
  // Gated by tile-selection-lru.test.ts (12 distinct margins → exactly 12 walks).
  // +2 (#1374): the SSE selector's emit cap used to truncate the visible set
  // SILENTLY, so a partially-uncovered viewport was indistinguishable from a
  // complete one and missing tiles reached users with no diagnostic. Reporting it
  // costs exactly two lines here — the import and the `onTruncated` argument; the
  // warn POLICY was extracted to render/selection-truncation.ts rather than added
  // to this file. Single ratchet for this path since runtime/ dissolved.
  // 987→997 (#1393): the adaptive quality ladder's far-field notch reaches the selector
  // from here — the import plus the `farTargetBoost` argument on BOTH selection calls
  // (the drawing one and the readiness gate, which must agree or the zoom advance stalls
  // waiting for tiles a coarser selection never asks for). The POLICY stays in engine's
  // adaptive-quality.ts and the mechanism in data's tiles-sse.ts; this file only carries
  // the wire, which is exactly where the composition root belongs. The notch also joins
  // `FrameTileCache` + its validity check: a STATIC camera never bumps `frameId`, so
  // without that the memo would keep serving the pre-degrade selection for exactly as
  // long as the user held still — measured, 0.6% instead of 26%.
  'map/src/render/tile-selection-cache.ts': 1011,
  // 870→876 (#1083): +6 for the tile-rect NE-corner Mercator calc threaded
  // into generateWallMeshExtrudedECEF so it drops clip-synthetic seam walls.
  // 876→889: visible-first cap-deferral — `_distSq` field + `resetFrameCap`
  // sorts the held backlog NEAREST-first so a zoom-in's visible slices upload
  // ahead of the accumulated far/ancestor backlog (the ~30 s stall fix).
  // Baselined 807 (#1153 P2 R4): raster-renderer crossed 800 for the WebGL2 tile-load
  // robustness fix — loadTileTexture's try/catch (close the decoded bitmap + destroy
  // any half-created texture, resolve null to the WebGPU contract) + the two async load
  // chains' `.catch` that un-wedges the loadingTiles slot (a createTexture throw on a
  // lost context otherwise pins all 6 slots → raster stops + the loop never idles).
  // A cohesive renderer, not a new god-file; shrink as #991 decomposes the render SCC.
  // 809→838 (raster-resolution): rasterCoverZoom — the tileSize-aware cover-zoom
  // authority (camera zoom is the 512-px convention; 256-px XYZ tiles need z+1
  // or every raster renders one LOD blurry) + the _tileSize field/setter.
  // 838→848 (raster-resolution CI round): per-frame draw dedup keyed by render
  // coord + ox — parent fallback mapped every uncached child onto the same
  // parent quad (4× duplicate draws; alpha compounds at raster-opacity < 1),
  // pinned by runtime raster-world-copy no-duplicate gate.
  // 848→855 (#1229 item 1): pendingLoadCount() — the in-flight tile count behind
  // hasPendingLoads(), summed into the map's public getMissingTileCount() so the
  // loading affordance covers network raster sources. A one-line read + docs.
  // 855→915 (raster tile fade-in): the draw loop split into an emitTileAt helper
  // + findCachedParent so a fading child (firstShownFrame ramp → per-tile
  // opacity) draws over its cached parent (cross-fade, no background flash) —
  // plus the _fadeDurationMs field, setRasterFadeDurationMs, and hasFadingTiles.
  // depthCompare 'always' makes the parent-under-child painter order z-fight-free.
  // +60, measured post-hook.
  // 915→922 (merge union — satellite z18+ jitter fix): writeRasterFrameUniform
  // splits the camera anchor DSFUN hi/lo (cam_ecef_center + new cam_ecef_center_l)
  // so the raster/hillshade vs_tile subtracts it in df64 (hi then lo) — the tile
  // sheet stopped shaking at over-zoom. Stacked non-overlappingly on the fade-in
  // work (+7), so the merged high-water is the measured 922.
  // 922→977 (#1317 raster zoom-OUT cross-fade): the reverse of #1307 — a tile
  // RE-ENTERING the target set re-arms its ramp (the `_lastTargetKeys` field + the
  // entry-based firstShownFrame restamp) so zooming back out to a parent fades in
  // instead of snapping, and a fading tile now also draws its cached direct CHILDREN
  // beneath it (findCachedChildren) so the departing higher-detail tiles are retained
  // until the parent is opaque (cross-fade sharp→native, no pop). +55, post-hook.
  // 977→990 (non-Mercator raster-jitter fix): rasterFrameCamAnchor — the single-
  // authority DSFUN camera anchor shared by RasterRenderer (render +
  // renderRhiChecker) AND HillshadeRenderer (both drive the shared vs_tile) — packs
  // per-projType lanes (Mercator 2D centre / flat non-Merc clon+camProj0 / globe
  // ECEF) so the flat non-Mercator arm subtracts the camera in df64 and stops
  // shaking at z18+. +13 post-hook; a free function (single authority, not three
  // duplicated inline branches).
  'map/src/render/raster-renderer.ts': 990,
  // 889→906 (#1155 F3): cold-start burst enqueue cap — the `_coldStartBurst`
  // field + `setColdStartBurst` + the burst-selected 8/4 cap in enqueue().
  // 906→910 (#1155 F3 adjudication): the burst 8/4 pair now comes from the
  // shared `burstUploadBudget` authority (import + call + note) so the enqueue
  // cap and uploadBudgetFor's maxJobs can't drift out of lockstep.
  // 910→921 (#1402): the `replace` opt-out of `_dispatch`'s "already uploaded" short-circuit,
  // threaded through `uploadSync`. +11 is the two signatures, the amended guard, and the note
  // recording WHY the guard was a silent no-op for the one caller that meant to overwrite.
  'map/src/render/upload-coordinator.ts': 921,
  // 811→826 (#1152 INC-3): proj_globe gains the ellipsoid N term (sqrt +
  // (1−E2) z-compression), globe_eye_horizon_cos rescales its surface point into
  // the (a,b) sphere frame, and PROJECTION_CONSTS gains the EARTH_E2 decl (prettier
  // wraps its long-value literal multi-line) + the sqrt/inverseSqrt/normalize
  // imports. All irreducible — the ellipsoid forward IS the increment (§2, no
  // extract-worthy unit). Lower when the GPU re-targets emitModule (SCOPE, above).
  // 826→835: the globe rim_alpha band now scales with (1−globe_eye.w) so a fixed 0.02
  // cosine band can't swallow the whole view at high zoom (raster zoom-in darkening fix)
  // + a root-cause note; the prettier pre-commit hook then wrapped the now-longer
  // smoothstep call across lines. +9 measured post-hook (`git show HEAD: | wc -l`, §12),
  // correcting the pre-hook 829 the fix first landed with. Irreducible in an existing branch.
  // 835→841 (non-Mercator raster-jitter fix): project_geom is exported as an
  // externFn (+ its rationale note) so raster arm 2 can call the world-copy-aware
  // vertex projection directly and subtract a df64 camera term itself (flat_rel
  // does that subtract in f32, which cancels and shakes). +6, irreducible.
  'map/src/shaders/dsl/projections.ts': 841,
  // #1005 — carried from the runtime arch-invariants Gate 3 (re-measured
  // 2026-07-13; lower.ts had shrunk 1452→1409, the tighter value carried).
  // 1790→1546 (INC-0 extract): the conforming red-green subdivision cluster
  // (vertexKey + subdivideTriangleMM / subdivideChainMM + their gate constants
  // and helpers) moved verbatim to tiler/subdivide-conforming.ts — pure code
  // motion, mesh output byte-identical; vector-tiler re-imports the three
  // consumed symbols. The extract answers INC-0's growth over the old ceiling
  // (extract, don't raise), per this gate's own message.
  // 1546→1587 (#1221 round 2): pushLinePartWithWrap + shiftLinePartLon add the
  // inline-tiler equivalent of geojson-vt's wrap() — a >±180-authored line also
  // emits its ±360-shifted world-copy continuation so the beyond-seam tail lands
  // in the wrapped tiles the renderer draws at world-copy ±1 (ADR-0006). New
  // logic (not a formatting bump); no natural extract site (belongs beside
  // makeLinePart in decomposeFeatures). Measured after prettier: wc -l = 1587.
  'compiler/src/tiler/vector-tiler.ts': 1587,
  // 1409→1415 (#1066): +6 to wire validateFnCalls (unknown-callee →
  // X-GIS0012) into lower()'s diagnostics — the validation pass itself
  // lives in the new ir/validate-fncalls.ts; only the import + call +
  // rationale land here. Still under the runtime arch-invariants
  // second-authority ceiling (1452).
  // 1415→1432 (#1067): the unknown-utility registry gate — 2 import lines +
  // the X-GIS0013 error push (with nearest-name help) after the utility-form
  // dispatch, + the diagnostics arg threaded into expandKeyframeTimeStops.
  // Irreducible: the gate must sit in the driver loop where the dispatch
  // verdict is known. (Still ≤ the runtime arch-invariants ceiling of 1452,
  // unchanged there — shrink-only.)
  // 1432→1433 (#1302): arrow-layer plumbing (isArrow + arrowBearing local decl,
  // acc read-back, node literal). 1433→1438 (merge union with #1305 symbol-fade
  // lowering).
  // 1438→1452 (#1272 E-②): presets carry coverage paint (`ramp:`/`range:`) — the
  // PresetDef type + presetMap value change + the resolveCoveragePaint call in
  // lowerLayer. The merge LOGIC itself is extracted to ir/lower-coverage-paint.ts
  // (extract-don't-grow); only the threading lands here. Now EQUALS the
  // arch-invariants second-authority ceiling (1452, unchanged there — in sync).
  // Measured after prettier: wc -l = 1452.
  // 1452→1457 (#1333 `| particles`): `isParticles` local + its 3 acc-thread/return sites —
  // mirrors isArrow's shape exactly (no arrowBearing-like companion needed), no new logic.
  // Measured after prettier: wc -l = 1457.
  // 1457→1463 (#1418): threading `flowPortrayal` through the lowering — one `let`, one
  // read-back from the accumulator, one return field, plus the three lines saying why the
  // default is deliberately left UNDEFINED here rather than baked in. A declarative surface
  // has to touch this file to exist; there is nothing to extract from six lines of threading,
  // and dropping the comment would invite a later reader to "helpfully" default it and create
  // the second authority it exists to prevent.
  'compiler/src/ir/lower.ts': 1463,
  // #777 I-B icon-keep-upright + I-F icon value-forms (merged) grow three
  // symbol-lowering god-files (per-row justification in
  // architecture-invariants.test.ts, the second authority):
  //  layers-symbol 1296→1328: I-B keep-upright emit + I-F icon-size /
  //    icon-translate data-driven emit (exprToXgis, replaces two warns).
  //  lower-label 1101→1145: I-B labelIconKeepUpright knob + I-F
  //    labelIconSizeExpr / labelIconTranslateExpr parse arms + knob decls +
  //    types + return + buildLabelShapes wiring.
  //  render-node 913→928: I-B LabelDef.iconKeepUpright + I-F
  //    LabelDef.iconTranslateExpr fields + docs.
  // #777 I-A icon-text-fit grows the same trio (per-row justification also in
  // architecture-invariants.test.ts, the second authority):
  //  layers-symbol 1328→1363: the warn→emit swap in convertIconProperties
  //    (label-icon-text-fit-<v> enum + per-side padding utilities, with negative
  //    clamp + unknown-enum + non-constant warns).
  //  lower-label 1145→1187: labelIconTextFit/labelIconTextFitPadding knob decls +
  //    the padding-prefix + enum parse arms + knob return + types + LabelDef spread.
  //  render-node 928→943: LabelDef.iconTextFit / iconTextFitPadding fields + docs.
  // 1363→1357: the text-pitch-alignment gap report (authored "map" AND the
  // spec default chain that resolves to it) moved out to
  // layers-helpers.pitchAlignmentGapWarning, net-shrinking the caller.
  'compiler/src/convert/layers-symbol.ts': 1357,
  'compiler/src/ir/lower-label.ts': 1187,
  'compiler/src/tokens/colors.ts': 937,
  // 943→956 (#1302): RenderNodeArrowPaint sub-bundle (isArrow + arrowBearing).
  // 956→957 (merge union with #1305 RenderNodeCoveragePaint).
  // 957→966 (#1333): RenderNodeParticlePaint sub-bundle (isParticles) + its merge into
  // RenderNode's extends list.
  // 966→969 (#1418): the `flowPortrayal` field on RenderNode plus its doc comment. A field on
  // the IR node type is the whole point of the file; extracting one property would split the
  // node's shape across two places for no gain.
  'compiler/src/ir/render-node.ts': 969,
  'compiler/src/convert/paint-helpers.ts': 826,
  'blueprint/src/editor.ts': 1448,
}

describe('LOC ceiling ratchet: map/engine/geo/data/rhi* god-files shrink-only (#1003)', () => {
  it('no baselined god-file exceeds its locked ceiling', () => {
    const grown = Object.entries(CEILINGS)
      .filter(([p]) => exists(join(ROOT, p)))
      .map(([p, ceil]) => ({ p, n: lineCount(join(ROOT, p)), ceil }))
      .filter((x) => x.n > x.ceil)
      .map(
        (x) => `${x.p}: ${x.n} > ceiling ${x.ceil} — extract, don't grow (then lower the ceiling)`,
      )
    expect(grown, grown.join('\n')).toEqual([])
  })

  it('no CEILINGS entry is stale (every key still exists — the #996 vacuity guard)', () => {
    const stale = Object.keys(CEILINGS)
      .filter((p) => !exists(join(ROOT, p)))
      .map((p) => `${p} — file moved/deleted; delete or repoint this stale ceiling`)
    expect(stale, stale.join('\n')).toEqual([])
  })

  it(`no non-baselined source file exceeds ${NEW_FILE_CAP} LOC`, () => {
    const tooBig: string[] = []
    for (const pk of PKGS) {
      for (const f of walkTs(join(ROOT, pk))) {
        const r = rel(f)
        if (r in CEILINGS) continue
        const n = lineCount(f)
        if (n > NEW_FILE_CAP)
          tooBig.push(`${r}: ${n} > ${NEW_FILE_CAP} — split it before it becomes a god-file`)
      }
    }
    expect(tooBig, tooBig.join('\n')).toEqual([])
  })
})
