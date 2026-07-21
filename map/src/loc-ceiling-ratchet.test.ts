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
  'map/src/render/vector-tile-renderer.ts': 4739,
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
  // marker) + the setCoverageData host-push API for live NOAA refresh.
  'map/src/map.ts': 4766,
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
  'map/src/source-manager.ts': 849,
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
  'map/src/text/text-stage.ts': 2085,
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
  'map/src/render/passes/label-pass.ts': 2005,
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
  'map/src/render/pipeline-factory.ts': 1505,
  'map/src/camera/camera.ts': 1419,
  'map/src/shaders/dsl/line.ts': 1373,
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
  'map/src/shaders/dsl/polygon.ts': 1368,
  // 1290→1314 (#1155 F3): cold-start burst tick budget — the `_coldStartBurst`
  // field + `_BURST_TICK_BUDGET` + `setColdStartBurst` + the burst-selected
  // budget in resetCompileBudget's backend tick loop.
  'data/src/tile-catalog.ts': 1314,
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
  // 1326→1344 (#1272): the coverage colour-ramp draw joins the forced-WebGL2
  // twin (renderFrameViaRhi), mirroring the opaque-pass dispatch — flat arm.
  'map/src/render-loop.ts': 1344,
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
  'rhi-webgl2/src/rhi-webgl2.ts': 1436,
  'map/src/render/gpu-tile-store.ts': 941,
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
  'map/src/render/tile-selection-cache.ts': 985,
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
  'map/src/render/raster-renderer.ts': 848,
  // 889→906 (#1155 F3): cold-start burst enqueue cap — the `_coldStartBurst`
  // field + `setColdStartBurst` + the burst-selected 8/4 cap in enqueue().
  // 906→910 (#1155 F3 adjudication): the burst 8/4 pair now comes from the
  // shared `burstUploadBudget` authority (import + call + note) so the enqueue
  // cap and uploadBudgetFor's maxJobs can't drift out of lockstep.
  'map/src/render/upload-coordinator.ts': 910,
  // 811→826 (#1152 INC-3): proj_globe gains the ellipsoid N term (sqrt +
  // (1−E2) z-compression), globe_eye_horizon_cos rescales its surface point into
  // the (a,b) sphere frame, and PROJECTION_CONSTS gains the EARTH_E2 decl (prettier
  // wraps its long-value literal multi-line) + the sqrt/inverseSqrt/normalize
  // imports. All irreducible — the ellipsoid forward IS the increment (§2, no
  // extract-worthy unit). Lower when the GPU re-targets emitModule (SCOPE, above).
  'map/src/shaders/dsl/projections.ts': 826,
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
  'compiler/src/ir/lower.ts': 1432,
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
  'compiler/src/convert/layers-symbol.ts': 1363,
  'compiler/src/ir/lower-label.ts': 1187,
  'compiler/src/tokens/colors.ts': 937,
  'compiler/src/ir/render-node.ts': 943,
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
