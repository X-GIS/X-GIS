import type {
  VectorTileRenderer,
  RenderFrameState,
  BundleEncodeDescriptor,
} from '../vector-tile-renderer'
import type { RenderArgs } from '../vector-tile-renderer-types'
import type { BundleKeyState } from '../../_cache/bundle-cache-key'
import { structuralHashKey } from '../../_cache/structural-key'
import { isOverdrawActive } from '../../debug-flags'
import { getSampleCount, isPickEnabled } from '@xgis/engine'
import type { RhiPipelineHandle } from '@xgis/engine'

/** #2508 phase 7 — draw the current-zoom tiles (stencil write) across the
 *  world copies. A pure CONSUMER of the frame: every argument is a value
 *  `render()` has already fixed, and nothing computed here is read by a
 *  later phase (free-variable analysis: 0 writes to `render()` locals, 0
 *  declarations read after it). The body is the former `render()` block,
 *  moved — it decides bundle vs direct dispatch per world copy and hands
 *  each set of keys to `renderTileKeys`. */
export function drawPrimary(
  vtr: VectorTileRenderer,
  args: RenderArgs,
  ctx: RenderFrameState,
): void {
  // Render current zoom tiles (stencil write) — with world copy offsets.
  // Translucent line passes have NO depth/stencil attachment, so skip the
  // stencil reference call there.
  //
  // Skip primary renderTileKeys when no tile went through the in-
  // archive path: every neededKey is over-zoom so its gpuCache.get
  // returns null inside renderTileKeys (none of them are populated;
  // fast path uploads only PARENTS, never the over-zoom keys
  // themselves). The function's loop would iterate every key just
  // to `continue`, burning N method calls + N drawKey computations
  // per layer for zero output.
  if (ctx.anyInArchive) {
    if (args.phase !== 'strokes') ctx.pass.setStencilReference(1)
    // Ground-layer fill (`extrude.kind === 'none'`) uses the
    // depth-disabled pipeline so coplanar layers resolve via
    // painter's order. Layers with `extrude:` keep the regular
    // depth-write pipeline; the per-feature extruded path takes
    // its own branch inside renderTileKeys.
    //
    // Pick the depth-disabled ground pipeline whose layout matches
    // the show's bind-group layout. Two cases:
    //   • Show is base-layout (no variant feature buffer): use the
    //     renderer-level default `fillPipelineGround` (base-only).
    //   • Show is variant + featureBindGroupLayout: use the
    //     `fillPipelineGroundOverride` the caller built for THIS
    //     variant (matches layout). When that's absent (very old
    //     caller / test stub), fall back to `fillPipeline` and
    //     accept depth-write — better z-fighting than a layout
    //     mismatch that drops the whole encoder.
    const groundIsBase = args.bindGroupLayout === vtr._bindGroups.baseLayout()
    // ?debug=overdraw: VTR's internal `fillPipelineGround` targets the
    // swapchain format, but the caller's `fillPipelineGroundOverride`
    // is the r16float debug variant. Always prefer the override here
    // so the entire opaque pass agrees on the r16float attachment.
    const groundForLayout: RhiPipelineHandle | null = isOverdrawActive(vtr.rhi.caps)
      ? (args.fillPipelineGroundOverride ?? args.fillPipeline)
      : groundIsBase
        ? vtr._bindGroups.groundPipeline()
        : (args.fillPipelineGroundOverride ?? null)
    // Fill-pattern routing. When the show has a resolved pattern UV bbox
    // AND the variant pipeline path isn't active AND overdraw isn't
    // active (r16float surface), swap the ground pipeline for the
    // pattern variant. The pattern pipeline uses the same base
    // bindGroupLayout, so it's only valid on the `groundIsBase` path;
    // variant + feature-data pattern shows fall through to the generic
    // fillPipeline (renders solid colour, not crash).
    const patternActive =
      !isOverdrawActive(vtr.rhi.caps) &&
      groundIsBase &&
      args.show.fillPatternUV != null &&
      vtr._bindGroups.patternGroundPipeline() !== null
    const groundChoice = patternActive ? vtr._bindGroups.patternGroundPipeline() : groundForLayout
    const mainFill =
      vtr.currentExtrudeMode === 'none' && groundChoice !== null ? groundChoice : args.fillPipeline
    // Fill-extrusion-pattern: when the extruded pattern pipeline is wired
    // and the show has a resolved pattern UV bbox, route per-feature
    // extruded draws to the pattern variant. Same gate as the ground path.
    const extrudedPatternActive =
      !isOverdrawActive(vtr.rhi.caps) &&
      groundIsBase &&
      args.show.fillPatternUV != null &&
      vtr._bindGroups.patternExtrudedPipeline() !== null
    // #1252 — the SHOW's variant extruded pipeline wins when present (a
    // data-driven fill on the feature layout); otherwise the pattern-extrude
    // variant, then the shared base extruded pipeline. A data-driven fill and
    // a fill-pattern are mutually exclusive (both own fill_color slots), so
    // the override never collides with extrudedPatternActive.
    const extrudedPipeline =
      args.fillPipelineExtrudedOverride ??
      (extrudedPatternActive
        ? vtr._bindGroups.patternExtrudedPipeline()
        : vtr._bindGroups.extrudedPipeline())
    // Bundle wrap for the primary opaque pass call. Gated to the main
    // opaque attachment context (excludes OIT, debug overdraw,
    // translucent stroke bucket, the standalone strokes phase). Cache key
    // includes every input that affects the recorded draws OR the bundle
    // descriptor; the next miss re-encodes from scratch.
    //
    // Hit path: re-runs renderTileKeys for state side effects (uniform
    // staging, strokeQueue population) but `_skipFillDrawForBundle` +
    // `_skipStrokeDrawForBundle` mute the actual draw emit;
    // `executeBundles([bundle])` replays the cached commands.
    // Miss path: getOrEncode runs renderTileKeys with the bundle encoder —
    // state side effects + draws recorded into the bundle, then
    // `executeBundles` replays into the real pass.
    // Bundle ONLY when every needed tile is in layer cache. Partial-set
    // bundles caused the user-reported flicker (OFM Bright import + wheel
    // zoom):
    //
    //   1. Fast zoom selects new neededKeys; tiles A,B not loaded yet.
    //   2. Bundle encodes — recordTileFill skips A,B (cache miss
    //      inside per-tile loop), records draws for already-loaded
    //      C,D only.
    //   3. Bundle cached under key with ueXor reflecting only C,D's
    //      uploadEpochs ("tiles not yet in layerCache contribute 0" was
    //      the design gap).
    //   4. Frame N+1: same neededKeys, same ueXor (A,B still loading,
    //      C,D unchanged) → cache HIT → replays the partial bundle
    //      with A,B missing → polygon fills disappear for A,B until
    //      they finally upload + bump ueXor.
    //   5. Strokes don't hit this because `phase === 'strokes'` skips
    //      the bundle path entirely, and the fallback ancestor path is
    //      also bundled with the same gap.
    //
    // Gating shouldBundle on the all-loaded invariant eliminates the
    // partial-encode case. During fast zoom we fall through to a direct
    // renderTileKeys call (no bundle, no cache); steady-state (all tiles
    // loaded) keeps the 97.6% hit rate.
    //
    // #1190 — DEFAULT ON again (WebGPU only; WebGL2 has no render
    // bundles). The prior default-off was containment for an
    // then-undiagnosed replay bug: interactive navigation showed a
    // MOSTLY EMPTY canvas (iPhone OFM Bright z=7.53 pitch 3.6) even
    // under the all-loaded gate, because the recorded bundles bake
    // UniformRing dynamic offsets and the ring CURSOR BASE (every
    // allocation earlier in the frame, across the VTR's other shows +
    // fallback walks) was not part of the cache key — an upstream
    // alloc-count change replayed stale offsets under a hit. The key
    // now pins `ringCursor` + the stroke draws' layer-slot offsets
    // (BundleKeyState), making a stale-offset replay a MISS by
    // construction; the hit-path dev invariant below proves the
    // re-walk still lands draw-for-draw on the baked offsets.
    // `_bundle-replay-parity-gate.spec.ts` is the interactive §5 gate
    // the old single-static-screenshot validation lacked.
    //   __XGIS_BUNDLE_OFF = true   → A/B + emergency escape hatch
    let allTilesLoaded = true
    for (let i = 0; i < ctx.neededKeys.length; i++) {
      if (!ctx.layerCache.get(ctx.neededKeys[i]!)) {
        allTilesLoaded = false
        break
      }
    }
    const _bundleOff = (globalThis as { __XGIS_BUNDLE_OFF?: boolean }).__XGIS_BUNDLE_OFF === true
    const shouldBundle =
      !_bundleOff &&
      vtr.rhi.caps.renderBundles &&
      !isOverdrawActive(vtr.rhi.caps) &&
      !args.translucentBucket &&
      args.phase !== 'strokes' &&
      args.phase !== 'oit-fill' &&
      allTilesLoaded
    if (shouldBundle) {
      // Structural cache key: a single structuralHashKey() over a typed
      // state literal. Adding a new dependency below = one new property;
      // the hash adapts and the cache invalidates correctly without
      // string-template churn. See _cache/structural-key.ts.
      const pickOn = isPickEnabled()
      const samples = getSampleCount()
      const epochs: number[] = new Array(ctx.neededKeys.length)
      for (let i = 0; i < ctx.neededKeys.length; i++) {
        epochs[i] = ctx.layerCache.get(ctx.neededKeys[i]!)!.uploadEpoch
      }
      // `satisfies BundleKeyState` enforces that every property of the
      // contract is filled. Adding a new dimension to BundleKeyState
      // breaks BOTH call sites here (primary + fallback) until the literal
      // is updated.
      const keyState = {
        sliceLayer: ctx.sliceLayer,
        phase: args.phase,
        // Order significant — neededKeys is iteration order, the
        // same order the bundle records draws in.
        // #778 P1: pass by-ref; the hash reads it synchronously and never retains keyState → the defensive .slice() was pure waste.
        neededKeys: ctx.neededKeys,
        epochs,
        // #778 P1: reused scratch instead of a per-frame `.map()` alloc (identical rounded contents → identical hash).
        worldOffsets: vtr._worldOffScratchKey(ctx.worldOffDeg),
        bindGroupEpoch: vtr._bindGroups.epoch(),
        pickOn,
        samples,
        mainPipelineLabel: mainFill.label ?? null,
        linePipelineLabel: args.linePipeline.label ?? null,
        // #1190 — the walk's dynamic-offset base and the stroke draws'
        // baked layer-slot offsets. Without the cursor, an EARLIER
        // show's allocation-count change let this show's key hit while
        // its baked offsets pointed at foreign slots — the "mostly
        // empty canvas during interactive navigation" that kept the
        // bundle path disabled. See BundleKeyState field docs.
        // #2042 INC-5b — a RING-FREE walk (every draw split-bound; see
        // _walkRingFree) bakes no per-tile ring reader, so the live
        // cursor is not a replay dependency there: keying it anyway made
        // one tile's residency flip re-record every downstream show
        // (PR #2090's sweep: bundleMisses ≈ N per window). The -2
        // sentinel decouples ring-free shows from the frame's ring
        // traffic; every _walkRingFree input is itself pinned by this
        // key, so record and hit agree on the verdict.
        ringCursor: vtr._walkRingFree(
          mainFill,
          args.bindGroupLayout,
          args.phase,
          args.translucentBucket,
          null,
          args.show.shaderVariant,
          ctx.sliceLayer,
        )
          ? -2
          : vtr._ringCursorForBundleKey(),
        lineLayerOffset: ctx.lineLayerOffset,
        lineLayerOffsetGap: ctx.lineLayerOffsetGap,
        // #2093 — these SELECT what the bundle records (`drawFills` /
        // `drawStrokes`); nothing else in the key separates the two arms.
        // Full derivation: the BundleKeyState field docs.
        drapeGlobeFills: vtr._drapeGlobeFills,
        drapeStrokes: vtr._drapeStrokes,
      } as const satisfies BundleKeyState
      const cacheKey = `vt:${ctx.sliceLayer}:${args.phase}:${structuralHashKey(keyState)}`
      const desc: BundleEncodeDescriptor = {
        colorFormats: pickOn ? [vtr.format, 'rg32uint'] : [vtr.format],
        depthStencilFormat: 'depth24plus-stencil8',
        sampleCount: samples,
        depthReadOnly: false,
        stencilReadOnly: false,
        label: cacheKey,
      }
      let wasMiss = false
      const bundle = vtr.bundleCache.getOrEncode(cacheKey, desc, (encoder) => {
        wasMiss = true
        vtr._skipFillDrawForBundle = false
        vtr._skipStrokeDrawForBundle = false
        vtr.renderTileKeys(
          ctx.neededKeys,
          encoder,
          mainFill,
          args.linePipeline,
          args.projCenterLon,
          args.projCenterLat,
          ctx.worldOffDeg,
          ctx.lineLayerOffset,
          ctx.lineLayerOffsetGap,
          args.phase,
          ctx.layerCache,
          extrudedPipeline,
          args.bindGroupLayout,
          args.translucentBucket,
          undefined,
          args.show.shaderVariant,
          ctx.sliceLayer,
        )
      })
      if (wasMiss) {
        // #1190 — pin the encode walk's ring-slot alloc count to the bundle.
        vtr._bundleWalkAllocs.set(
          bundle,
          vtr._ringCursorForBundleKey() - Math.max(0, keyState.ringCursor),
        )
      } else {
        // Cache hit: replay path. Re-run renderTileKeys for state
        // side effects with both skip flags TRUE — recordTileFill
        // + drawSegments no-op; uniform staging + strokeQueue
        // population still happens.
        vtr._skipFillDrawForBundle = true
        vtr._skipStrokeDrawForBundle = true
        vtr.renderTileKeys(
          ctx.neededKeys,
          ctx.pass,
          mainFill,
          args.linePipeline,
          args.projCenterLon,
          args.projCenterLat,
          ctx.worldOffDeg,
          ctx.lineLayerOffset,
          ctx.lineLayerOffsetGap,
          args.phase,
          ctx.layerCache,
          extrudedPipeline,
          args.bindGroupLayout,
          args.translucentBucket,
          undefined,
          args.show.shaderVariant,
          ctx.sliceLayer,
        )
        vtr._skipFillDrawForBundle = false
        vtr._skipStrokeDrawForBundle = false
        // #1190 invariant — the hit re-walk must land its uniforms on
        // EXACTLY the offsets the bundle baked: same base (ringCursor is
        // in the key, so it matches by key equality) AND same alloc
        // count. A mismatch means an input to renderTileKeys changed
        // under an unchanged BundleKeyState — the class of bug that
        // produced the mostly-empty interactive canvas. Fail loud in
        // dev; the key fix (not this check) is what prevents it.
        // EXEMPT under a ring-reader-free walk (#2042 INC-5): a
        // splitWalkSkip call bakes no per-tile ring readers (every fill
        // and stroke binds the three-range split group; even the seed
        // tile's ring stage is write-only), so alloc-count alignment is
        // a vacuous proxy there — record packs fresh tiles (1 + k
        // allocs), the next hit's re-walk skips them (1), and both
        // replay correctly. Key equality ⇒ identical qualification
        // inputs ⇒ the exemption is stable across record and hit.
        if (ctx._inv && !vtr._lastWalkRingFree) {
          const expected = vtr._bundleWalkAllocs.get(bundle)
          const got = vtr._ringCursorForBundleKey() - Math.max(0, keyState.ringCursor)
          if (expected !== undefined && got !== expected) {
            throw new Error(
              `[XGIS INVARIANT] bundle hit re-walk allocated ${got} ring slots where ` +
                `the encoded bundle recorded ${expected} (key ${cacheKey}). An input to ` +
                `renderTileKeys changed under an unchanged BundleKeyState — the baked ` +
                `dynamic offsets no longer align. Add the missing input to ` +
                `_cache/bundle-cache-key.ts.`,
            )
          }
        }
      }
      ctx.pass.executeBundles([bundle])
    } else {
      vtr.renderTileKeys(
        ctx.neededKeys,
        ctx.pass,
        mainFill,
        args.linePipeline,
        args.projCenterLon,
        args.projCenterLat,
        ctx.worldOffDeg,
        ctx.lineLayerOffset,
        ctx.lineLayerOffsetGap,
        args.phase,
        ctx.layerCache,
        extrudedPipeline,
        args.bindGroupLayout,
        args.translucentBucket,
        undefined,
        args.show.shaderVariant,
        ctx.sliceLayer,
      )
    }
  }
}

/** #2508 phase 8 — draw the fallback ancestors (stencil test) across the
 *  world copies for the visible tiles with no resident tile of their own.
 *  A consumer with ONE frame-state write, stated here because the epilogue
 *  depends on it: the three parallel fallback arrays are re-sorted into
 *  `ctx` (smallest z first, deepest last, so the most detailed parent wins
 *  the LEQUAL fragment competition) and the stable set is built from that
 *  order. The drape flags are saved, cleared around the dispatch and
 *  restored — the fallback draws direct even when the primary drapes
 *  (#1076). */
export function drawFallback(
  vtr: VectorTileRenderer,
  args: RenderArgs,
  ctx: RenderFrameState,
): void {
  // Render fallback ancestors (stencil test) — with world offsets for wrapping
  if (args.fillPipelineFallback && ctx.fallbackKeys.length > 0) {
    // Sort ascending by z (smallest-z first → deepest-z last). Where
    // multiple z-level parents overlap in screen space (z=11 parent
    // covers area that z=14 parent also covers), the deepest z draws
    // last and wins LEQUAL fragment competition. Without this the
    // simpler-geometry parent could occlude the more-detailed one
    // depending on fallbackKeys insertion order.
    //
    // Do NOT dedup by (key, offset): each push renders the SAME parent
    // with a DIFFERENT per-tile visible clip mask (one push per visible
    // tile it fills for), so dedup'ing would erase coverage of N-1
    // visible tiles.
    if (ctx.fallbackKeys.length > 1) {
      const indexed: { k: number; o: number; vk: number; z: number }[] = []
      for (let i = 0; i < ctx.fallbackKeys.length; i++) {
        const k = ctx.fallbackKeys[i]
        // Extract z from tileKey: tileKey = 4^z + morton(x,y).
        let z = 0
        while (Math.pow(4, z + 1) <= k) z++
        indexed.push({ k, o: ctx.fallbackOffsets[i], vk: ctx.fallbackVisibleKeys[i], z })
      }
      indexed.sort((a, b) => a.z - b.z)
      ctx.fallbackKeys = indexed.map((c) => c.k)
      ctx.fallbackOffsets = indexed.map((c) => c.o)
      ctx.fallbackVisibleKeys = indexed.map((c) => c.vk)
    }
    if (args.phase !== 'strokes') ctx.pass.setStencilReference(0)
    // Visual debug hook: when `globalThis.__XGIS_FALLBACK_RED = true` is
    // set, override the fallback fill colour to bright red. Lets the
    // user visually confirm whether parent/child fallback is actually
    // rendering during a "white flash" — if red is visible, the bug
    // is downstream of fallback rendering (e.g., later layer covering
    // it, alpha = 0, render order); if no red appears, the fallback
    // path itself is dropping the tile.
    const _debugRed = (globalThis as { __XGIS_FALLBACK_RED?: boolean }).__XGIS_FALLBACK_RED
    let _origR = 0,
      _origG = 0,
      _origB = 0
    if (_debugRed) {
      // Save/override RGB only — alpha stays whatever the tile loop last
      // wrote (the setter's fixed arity re-writes it with its current value).
      const f32 = new Float32Array(vtr.frameBlock.buffer)
      const a0 = vtr.frameBlock.fieldOffset('fill_color') / 4
      _origR = f32[a0]!
      _origG = f32[a0 + 1]!
      _origB = f32[a0 + 2]!
      vtr.frameBlock.set.fill_color(1.0, 0.0, 0.0, f32[a0 + 3]!)
    }
    // Same layout-matched ground pickup as the primary path —
    // base layout uses the renderer-level fallback ground; feature
    // layout uses the variant's fallback ground override.
    const fallbackGroundIsBase = args.bindGroupLayout === vtr._bindGroups.baseLayout()
    const fallbackGroundForLayout: RhiPipelineHandle | null = isOverdrawActive(vtr.rhi.caps)
      ? (args.fillPipelineGroundFallbackOverride ?? args.fillPipelineFallback ?? null)
      : fallbackGroundIsBase
        ? vtr._bindGroups.groundPipelineFallback()
        : (args.fillPipelineGroundFallbackOverride ?? null)
    // Fill-pattern fallback routing (mirror of the primary path above).
    const fallbackPatternActive =
      !isOverdrawActive(vtr.rhi.caps) &&
      fallbackGroundIsBase &&
      args.show.fillPatternUV != null &&
      vtr._bindGroups.patternGroundPipelineFallback() !== null
    const fallbackGroundChoice = fallbackPatternActive
      ? vtr._bindGroups.patternGroundPipelineFallback()
      : fallbackGroundForLayout
    const fallbackFill =
      vtr.currentExtrudeMode === 'none' && fallbackGroundChoice !== null
        ? fallbackGroundChoice
        : args.fillPipelineFallback
    // Fill-extrusion-pattern fallback path mirror.
    const fallbackExtrudedPatternActive =
      !isOverdrawActive(vtr.rhi.caps) &&
      fallbackGroundIsBase &&
      args.show.fillPatternUV != null &&
      vtr._bindGroups.patternExtrudedPipelineFallback() !== null
    const fallbackExtrudedPipeline =
      args.fillPipelineExtrudedFallbackOverride ??
      (fallbackExtrudedPatternActive
        ? vtr._bindGroups.patternExtrudedPipelineFallback()
        : vtr._bindGroups.extrudedPipelineFallback())
    // Fallback path bundle wrap. Mirror of the primary-call wrap, applied
    // to the fallbackKeys renderTileKeys invocation. Same gate + same
    // cache key shape, plus the fallback-specific `fallbackVisibleKeys`
    // hash so the per-tile clip_bounds (set from `visibleKeysForClip`) is
    // part of the invalidation surface. Tiles + visibleKeys + offsets
    // together fully describe the recorded draws.
    // Mirror the primary path's all-loaded gate. Fallback keys are by
    // construction picked from layerCache, but an entry could be evicted
    // between selection and bundle encode (LRU under tight cap). Cheap
    // guard avoids the same partial-set replay class of bug.
    let fbAllLoaded = true
    for (let i = 0; i < ctx.fallbackKeys.length; i++) {
      if (!ctx.layerCache.get(ctx.fallbackKeys[i]!)) {
        fbAllLoaded = false
        break
      }
    }
    // #1190 — fallback path defaults ON with the primary (same key fix,
    // same escape hatch; see the primary-site rationale).
    const _fbBundleOff = (globalThis as { __XGIS_BUNDLE_OFF?: boolean }).__XGIS_BUNDLE_OFF === true
    const fbShouldBundle =
      !_fbBundleOff &&
      vtr.rhi.caps.renderBundles &&
      !isOverdrawActive(vtr.rhi.caps) &&
      !args.translucentBucket &&
      args.phase !== 'strokes' &&
      args.phase !== 'oit-fill' &&
      !_debugRed &&
      fbAllLoaded
    // #1076 — the fallback ancestors MUST draw even when the drape owns the primary
    // tiles. `_drapeGlobeFills`/`_drapeStrokes` suppress the PRIMARY direct draw
    // (renderGlobeFills bakes the primary tiles onto the sphere), but the drape only
    // ever receives `neededKeys`, never `fallbackKeys` — so a suppressed fallback
    // dispatch leaves a streaming hemisphere pure background. Clear the suppression
    // for the fallback dispatch ONLY (the bundle-record arm — where the bundle is
    // encoded — and the direct arm both flow through here), restore in `finally` so
    // the PRIMARY suppression above stays intact. Coarse ECEF chords beat a blank
    // hemisphere; chord fallback is the accepted globe behaviour whenever the drape
    // is inactive. Proper drape-fallback (parent-bake UV windowing) is a #599 follow-up.
    const _fbSavedDrapeGlobeFills = vtr._drapeGlobeFills
    const _fbSavedDrapeStrokes = vtr._drapeStrokes
    vtr._drapeGlobeFills = false
    vtr._drapeStrokes = false
    try {
      if (fbShouldBundle) {
        // Structural cache key (mirrors primary path; see
        // _cache/structural-key.ts).
        const fbPickOn = isPickEnabled()
        const fbSamples = getSampleCount()
        const fbEpochs: number[] = new Array(ctx.fallbackKeys.length)
        for (let i = 0; i < ctx.fallbackKeys.length; i++) {
          fbEpochs[i] = ctx.layerCache.get(ctx.fallbackKeys[i]!)?.uploadEpoch ?? 0
        }
        const fbKeyState = {
          sliceLayer: ctx.sliceLayer,
          phase: args.phase,
          // Fallback bundle has no `neededKeys` (the primary side),
          // only fallback tile keys; populate both for uniform shape
          // — the structural hash treats null + the array distinctly.
          // #778 P1: pass by-ref; the hash reads it synchronously and never retains keyState → the defensive .slice() was pure waste.
          neededKeys: ctx.fallbackKeys,
          fallbackKeys: ctx.fallbackKeys.slice(),
          fallbackVisibleKeys: ctx.fallbackVisibleKeys ? ctx.fallbackVisibleKeys.slice() : null,
          epochs: fbEpochs,
          // #778 P1: reused scratch instead of a per-frame `.map()` alloc (identical rounded contents → identical hash).
          worldOffsets: vtr._worldOffScratchKey(ctx.fallbackOffsets),
          bindGroupEpoch: vtr._bindGroups.epoch(),
          pickOn: fbPickOn,
          samples: fbSamples,
          mainPipelineLabel: fallbackFill.label ?? null,
          linePipelineLabel: args.linePipelineFallback?.label ?? null,
          // #1190 — mirror of the primary site: the fallback walk's
          // dynamic-offset base (it runs AFTER the primary walk, so
          // its base also moves with the primary's alloc count) and
          // the stroke draws' baked layer-slot offsets.
          // #2042 INC-5b — always the LIVE cursor here: fallback-clip
          // walks pass visibleKeysForClip, which disqualifies ring-free
          // by definition (their clip_bounds live in ring slots).
          ringCursor: vtr._ringCursorForBundleKey(),
          lineLayerOffset: ctx.lineLayerOffset,
          lineLayerOffsetGap: ctx.lineLayerOffsetGap,
          // #2093 — mirror of the primary site. The #1076 fallback dispatch
          // PINS both false above; the key follows the field, not a literal.
          drapeGlobeFills: vtr._drapeGlobeFills,
          drapeStrokes: vtr._drapeStrokes,
        } as const satisfies BundleKeyState
        const fbCacheKey = `vt-fb:${ctx.sliceLayer}:${args.phase}:${structuralHashKey(fbKeyState)}`
        const fbDesc: BundleEncodeDescriptor = {
          colorFormats: fbPickOn ? [vtr.format, 'rg32uint'] : [vtr.format],
          depthStencilFormat: 'depth24plus-stencil8',
          sampleCount: fbSamples,
          depthReadOnly: false,
          stencilReadOnly: false,
          label: fbCacheKey,
        }
        let fbWasMiss = false
        const fbBundle = vtr.bundleCache.getOrEncode(fbCacheKey, fbDesc, (encoder) => {
          fbWasMiss = true
          vtr._skipFillDrawForBundle = false
          vtr._skipStrokeDrawForBundle = false
          vtr.renderTileKeys(
            ctx.fallbackKeys,
            encoder,
            fallbackFill,
            args.linePipelineFallback!,
            args.projCenterLon,
            args.projCenterLat,
            ctx.fallbackOffsets,
            ctx.lineLayerOffset,
            ctx.lineLayerOffsetGap,
            args.phase,
            ctx.layerCache,
            fallbackExtrudedPipeline,
            args.bindGroupLayout,
            args.translucentBucket,
            ctx.fallbackVisibleKeys,
            args.show.shaderVariant,
            ctx.sliceLayer,
          )
        })
        if (fbWasMiss) {
          // #1190 — pin the encode walk's alloc count (mirror of primary).
          vtr._bundleWalkAllocs.set(
            fbBundle,
            vtr._ringCursorForBundleKey() - Math.max(0, fbKeyState.ringCursor),
          )
        } else {
          // jscpd:ignore-start — the bundle-hit re-walk below and the no-bundle arm that
          // follows issue the SAME 17-argument fallback dispatch; only the surrounding
          // bundle bookkeeping differs. The pair pre-exists on main, and hoisting the two
          // calls into one helper is blocked by a gate rather than by taste:
          // `vtr-fallback-drape-draw.test.ts` anchors the #1076 witness on the POSITION of
          // each `renderTileKeys(` relative to the drape clear and restore, so a helper
          // declared at the top of this phase would put the first occurrence above the
          // clear and silently retarget it. Consolidating means reworking that gate's
          // anchoring first — #2577.
          vtr._skipFillDrawForBundle = true
          vtr._skipStrokeDrawForBundle = true
          vtr.renderTileKeys(
            ctx.fallbackKeys,
            ctx.pass,
            fallbackFill,
            args.linePipelineFallback!,
            args.projCenterLon,
            args.projCenterLat,
            ctx.fallbackOffsets,
            ctx.lineLayerOffset,
            ctx.lineLayerOffsetGap,
            args.phase,
            ctx.layerCache,
            fallbackExtrudedPipeline,
            args.bindGroupLayout,
            args.translucentBucket,
            ctx.fallbackVisibleKeys,
            args.show.shaderVariant,
            ctx.sliceLayer,
          )
          vtr._skipFillDrawForBundle = false
          vtr._skipStrokeDrawForBundle = false
          // #1190 invariant — mirror of the primary site; see there.
          if (ctx._inv) {
            const expected = vtr._bundleWalkAllocs.get(fbBundle)
            const got = vtr._ringCursorForBundleKey() - Math.max(0, fbKeyState.ringCursor)
            if (expected !== undefined && got !== expected) {
              throw new Error(
                `[XGIS INVARIANT] fallback bundle hit re-walk allocated ${got} ring ` +
                  `slots where the encoded bundle recorded ${expected} (key ${fbCacheKey}). ` +
                  `An input to renderTileKeys changed under an unchanged BundleKeyState — ` +
                  `add the missing input to _cache/bundle-cache-key.ts.`,
              )
            }
          }
        }
        ctx.pass.executeBundles([fbBundle])
      } else {
        vtr.renderTileKeys(
          ctx.fallbackKeys,
          ctx.pass,
          fallbackFill,
          args.linePipelineFallback!,
          args.projCenterLon,
          args.projCenterLat,
          ctx.fallbackOffsets,
          ctx.lineLayerOffset,
          ctx.lineLayerOffsetGap,
          args.phase,
          ctx.layerCache,
          fallbackExtrudedPipeline,
          args.bindGroupLayout,
          args.translucentBucket,
          ctx.fallbackVisibleKeys,
          args.show.shaderVariant,
          ctx.sliceLayer,
        )
      }
      // jscpd:ignore-end
    } finally {
      vtr._drapeGlobeFills = _fbSavedDrapeGlobeFills
      vtr._drapeStrokes = _fbSavedDrapeStrokes
    }
    if (_debugRed) {
      const f32 = new Float32Array(vtr.frameBlock.buffer)
      const a3 = vtr.frameBlock.fieldOffset('fill_color') / 4 + 3
      vtr.frameBlock.set.fill_color(_origR, _origG, _origB, f32[a3]!)
    }
  }
}
