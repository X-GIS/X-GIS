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
  // +4 (#1046 F3b Inc-2d): the render() boundary — the chain hands the neutral
  // RhiRenderPass and the internal native tile plumbing unwraps it ONCE. The
  // seam retires with the VTR cluster's own #991 flip.
  // #1479: −5. The `getDrawStats` forwarder restated its return type by hand — a second
  // authority for one shape. Deriving it (`ReturnType<FrameDrawStats['getDrawStats']>`)
  // paid for the `drawnByZoom` field and left the file smaller than before.
  // 4813→4823 (#1583, main merge): the fill-null bail in renderFillsRhi now also calls
  // reportRhiFillGap(show, this.rhi.backend) for its warning side effect, while still
  // returning `missing` (#1046 Inc-F2b's tile-acquisition count, which this bail must
  // not silently drop) — a #1594 merge, not new #1594 work: main's fix returned a bare
  // 0 here; this branch's renderFillsRhi had already moved past that shape.
  // 4823→4828 (#1581, main merge): leg B's static-camera tile-point pack-key auto-
  // merged in cleanly (buildTilePointPackKey/hashStableKeys + the canSkipTilePointRepack
  // fast path in emitTilePointsRhi) — a real new feature, not slack. The doc comment
  // above emitTilePointsRhi was the only textual conflict (both sides reworded the same
  // twin-era prose); kept this branch's wording, which is longer because it names the
  // twin's actual #1046 Track A1 replacement (the WebGL2 immediate arm) instead of
  // main's still-twin-shaped phrasing.
  // 4828→4863 (#1605 Phase 1 PR B, measured post-prettier per §12): thread
  // show.shaderVariant into the SDF line draw dispatch (2 drawSegmentsRhi call
  // sites in renderLinesRhi + a new lineVariant param on renderTileKeys, kept
  // TRAILING rather than mid-list so reflection-based unit tests calling this
  // private method positionally don't shift, threaded to its 6 call sites and
  // 2 drawSegments calls), and narrow the two warnStageBlockUnsupported('line',
  // ...) call sites to the genuinely-rejected case now that a feature-free
  // @stroke expression is actually consumed.
  // 4863→4913 (#1592, measured post-prettier per §12): the RHI data-driven fill.
  // The two substantial pieces — the per-variant Material cache and the per-tile
  // feat_data buffer/bind-group — were NOT added here; they are their own owner
  // (render/rhi-fill-variant.ts, 211 lines) precisely because this file is at its
  // ceiling, and the pure pack it shares with FeatureDataBinder is a third file
  // (render/feature-data-pack.ts). What lands here is only the wiring a renderer
  // cannot delegate: the lazy owner field + accessor, the narrowed fill bail
  // (`!fill && !dataDriven`) with the variant Material lookup, the null-fill
  // branches for `fill_color` / `fillA`, the per-tile group selection in the draw
  // loop, and the two teardown hooks (eviction + destroy).
  // 4913 -> 4911 (#1679 inc 6): the four polygon call sites moved their emit+key pairing
  // into material/polygon-baked.ts, which is the 'extract, don't grow' this ratchet asks
  // for — the id wiring landed OUTSIDE the god-file and took two lines of imports with it.
  // 4911→4932 (#1632): the tile-point pack cache became one slot PER SHOW, and the
  // slot ids need a namespace this renderer alone can mint. The cache itself is a new
  // owner (render/tile-point-cache.ts) — the 'extract, don't grow' this ratchet asks
  // for — so what lands here is only the wiring a renderer cannot delegate: the
  // per-instance show-id prefix, the showId derivation at the emit site, the
  // PointRenderer back-reference destroy() needs, and the eviction call itself
  // (without which a setSourceData swap leaks three GPU buffers per point show).
  // MERGE UNION (#1596 <- main): main's +21 (#1632, above) and this branch's +12 (the
  // classifyTile failureCount predicate wiring and the terminal-flag gate on the
  // `pending` consumer's recordMissedTile(); retry ladder stays in PMTilesBackend,
  // bound in tile-decision.ts) are non-overlapping and compose. Value is the MEASURED
  // post-merge, post-prettier count (4911 + 21 + 12 = 4944, arithmetic agrees).
  // 4911→4920 (#1355, adopted onto main @ e54a892): the byte-telemetry read-out — the
  // `arenaBytes()` thin accessor (the sum itself lives in render-stats-bytes.ts, NOT here)
  // plus its two imports and one line of comment on the getDrawStats forwarder. On the PR's
  // own base this held at 4816 because naming `DrawStatsSnapshot` in frame-draw-stats.ts paid
  // for it by deleting the inline literal restated here; main had ALREADY banked that saving
  // with `ReturnType<FrameDrawStats['getDrawStats']>`, so the same extraction cannot be
  // spent twice and the +9 is genuinely new. MEASURED post-pick.
  // This row is the one #1355 keeps re-learning: it auto-merges CLEANLY and therefore
  // silently takes the OTHER side's ceiling WITHOUT the paired raise — the vitest leg, not
  // the merge, is what catches it. Fixed once on the PR's own base (4863→4870) and re-fixed
  // here against main's 4911, because the number is a MEASUREMENT of this tree and never a
  // number carried across a rebase.
  // MERGE UNION (#1756 <- main): main's 4944 (#1632 + #1596, above) and the adoption's +9
  // (byte-telemetry read-out, its rationale re-quoted above) compose. MEASURED post-merge,
  // post-prettier (4944 + 9 = 4953, arithmetic agrees).
  // 4953→4957 (#1253): the 'oit-fill' phase now draws the SHELL through the same
  // extruded pipeline as the opaque path, so the routing collapses from four
  // decisions (oit-pipe / oit-skip / extrude-want / extrude-use) to two — the
  // net +4 is the `extrudeShell` pass-through on `recordTileFill` plus the
  // comment that records why the shell phase answers to the extrude skip rule.
  // The shell's DRAW state lives in polygon-fill-material.ts (§2). MEASURED.
  // 4957→4976 (#2013): the Tier-2 zoom-direction prefetch is no longer gated on
  // cameraIdle — the guard made it unreachable during the gesture it exists for —
  // with the comment recording why, the farTargetBoost pass-through (prefetch
  // probes the same far-field notch the drawing selection runs at), and the
  // child-fallback fetch-frontier push (covered is not loaded — without it the
  // deeper #2013 stretch let a view settle permanently on stretched children).
  // 4976→4961 (#2028): the tile-point emit body moved to render/tile-point-emit.ts,
  // which owns the ancestry-shadow rule (the per-point form of #616's label shadow).
  // The file was AT its ceiling, so the fix could not have been written in place.
  // 4961→4990 (#2024, merge union): the globe virtual-overzoom drape. The
  // selection ladder itself lives in render/drape-overzoom-dispatch.ts (extracted
  // at birth); the +29 kept here is the irreducible composition wiring — the
  // dispatch call with its collaborator closure (uploadResident needs
  // this.uploadTile), the bakeTileToTexture window parameter + windowed ortho
  // (the bake matrix is this file's state), and one import. Deltas are disjoint
  // (−15 #2028 extraction, +29 #2024 over the 4976 base). MEASURED post-merge.
  // 4990→5078 (#1190, merge union atop #2024): bundle replay made correct-by-
  // construction — ringCursor + stroke layer-slot offsets in both BundleKeyState
  // literals, the hit-path alloc-count invariant at both sites, default-ON gate.
  // Deltas disjoint (+29 #2024, +88 #1190 over the shared #2028 base). MEASURED.
  // 5078→5101 (#1190 allocation ledger): the strokeQueue's per-call object
  // array became instance parallel scratch (+ the offsets-pair scratch) — the
  // O(stroked-tiles × layers)/frame nursery churn from the issue's ledger, plus
  // the field docs that record why the reuse is re-entrancy-safe.
  // 5101→5128 (#2042 INC-1): _writeRtcAnchors — the absolute tile/cam ECEF
  // anchor staging (one helper, three per-tile call sites) + the §5 witness
  // skew hook, behind the __XGIS_RTC_RECOMBINE flag. Shrinks back at INC-4/5
  // when the legacy cam_ecef_off writes and the per-tile re-walk retire.
  // 5128→5172 (#2042 INC-2): TileUniformArena wiring — the field + release-
  // hook line + the per-tile ensureSlot call + the sliceLayer trailing param
  // threaded through six renderTileKeys call sites + flush/reset/destroy
  // pairing. The arena itself lives in tile-uniform-arena.ts (180 LOC, its
  // own file); this is only the seam. Shrinks at INC-5 with the re-walk.
  // 5172→5182 (#2042 INC-6): the two Mercator-anchor writes in
  // _writeRtcAnchors (tile_origin_merc_hl carries the same skew witness).
  // 5182→5186 (#2042 INC-4b prep): the tile-arena grow-retired drain beside
  // the ring drain (leak fix — the arena pinned every outgrown buffer).
  // 5186→5253 (#2042 INC-4b): the split-bind wiring — ctor construction +
  // rebind wire, setFillRhi layout hand-off, the per-draw split resolve in
  // renderTileKeys (qualify + offsets), recordTileFill's trailing param, and
  // the flush/drain/destroy pairings. The write path itself lives in
  // uniform-split-bind.ts (276 LOC, its own file); this is only the seam.
  // Shrinks at INC-5 with the re-walk deletion.
  // 5253→5254 (#2042 INC-4b fix): the sliceLayer argument threaded into
  // syncShow — the show-slot identity gained the slice half (the gate-caught
  // filter-bucket aliasing; see uniform-split-bind.ts's header).
  // 5254→5303 (#2042 INC-4c): the stroke split — the resolve hoisted to
  // tile-loop scope (fills + strokes share it), the _strokeQueueTileOff
  // parallel array + its two pushes, and the stroke-emit split resolve +
  // per-tile bind selection threaded through both drawSegments calls.
  // Shrinks at INC-5 with the re-walk deletion.
  // 5303→5379 (#2042 INC-5): the walk-skip — per-call splitWalkSkip
  // qualification, the per-tile skip block (arena-resident tiles bypass the
  // whole pack + ring alloc/stage after the first tile seeds the show/frame
  // lanes), the pack block wrapped in if(!skipPack), the __xgisVtrWalkSkips
  // executed-mechanism witness, and the _lastWalkRingFree exemption of the
  // bundle-hit ring-alloc invariant (vacuous under a ring-reader-free walk).
  // 5379→5397 (#2042 INC-4d): splitFillsCapable (default pipes OR an
  // eligible per-style split twin) + the stroke clause widened to
  // split-eligible line variants (splitStrokeEligible).
  // 5397→5454 (#2042 INC-5b): the qualification extracted into the single
  // ring-free authority _walkRingFree (shared by renderTileKeys' walk-skip
  // and BOTH bundle-key sites) + the primary key's ringCursor -2 sentinel
  // for ring-free walks (PR #2090's measured re-record coupling) + the
  // opaque-layout-param note (#991).
  // 5303→5311 (#2093 F1): the drape LOD ceiling at the `_drapeGlobeFills`
  // derivation — the `drapesAtSelectionZ(currentZ)` conjunct + its
  // __XGIS_FORCE_VECTOR_DRAPE A/B escape (6, incl. the 3-line rationale) and 2
  // in the block comment above it. The arithmetic itself is NOT here: the
  // chord-sagitta-vs-bake-texel derivation lives with the constant in
  // geo/src/projections-table.ts (GLOBE_DIRECT_MIN_SELECTION_Z), so this file
  // gains only the call-site seam.
  // 5311→5320 (#2093 E1): the two drape flags added as cells of BOTH bundle
  // cache keys (primary + fallback) — 4 property lines + 5 of pointer comment.
  // They SELECT what a bundle records (`drawFills` / `drawStrokes`) and the
  // ceiling made them zoom-dependent, so a key that omits them lets a direct-arm
  // bundle replay its fill draws over the drape. Irreducible: the contract is
  // one property per key literal (`satisfies BundleKeyState`), and the full
  // derivation lives with the fields in _cache/bundle-cache-key.ts, not here.
  // 5454→5471 (#2093 F1+E1) and 5454→5466 (#2117 line-gradient) are two
  // independent +17 / +12 on the SAME 5454 base. #2117 adds the `lineGradient`
  // resolve (pattern-exclusion comment + one const) at BOTH stroke-write sites,
  // the argument at the three writeLayerSlot calls, and the `bs.gradient` bake
  // capture — no new branch, the ramp itself lives in line-pattern.ts /
  // line-gradient.ts. Merged: 5483, MEASURED post-merge on the merged file
  // (`wc -l`) — never side-picked, never summed by hand, exactly as main's own
  // note above warns. Headroom is re-justified per phase, never banked.
  // 5483→5466 (#2240): the three fill-translate packers now read one producer
  // (render/fill-translate-ndc.ts), which took 17 net lines out of this file.
  // Measured with `wc -l` on the post-prettier tree, per the note above.
  // 5466→5467 (#2249): +1, and it is ONE argument — the anchor-rotated NDC pair
  // forwarded to `renderGlobeFills` so the globe drape stops dropping
  // `fill-translate`. A new call argument cannot be under one line here (the
  // call is already multi-line, so prettier gives each argument its own), and
  // the explanation that would have cost three more lives at the parameter's
  // declaration in vector-drape-renderer.ts, which is where a reader of the
  // signature looks. Nothing was extracted for it: extracting from this file to
  // pay for a one-line bug-fix wire would be a refactor smuggled inside a fix.
  // 5466->5471 (#2286): destroy() releases the three LAZY fill Materials
  // (_fillMatRhi/_fillPickMatRhi/_fillPatternMatRhi) it never named -- reached mid-session
  // by teardownSource with the device still alive.
  // MEASURED 5472 with `wc -l` on the post-prettier merged tree. #2249 (+1) and
  // #2286 (+5) both raised this key from 5466 on separate branches, so the merged
  // file carries BOTH deltas and NEITHER side's number is right. Carrying either
  // across would leave the ceiling one change too low — red on main having been
  // green on both branches (§12).
  // 5472->5481 (#2325): destroy() releases the FOURTH lazy fill Material,
  // `_fillBakeMatRhi` -- #2286 named three and missed the globe vector-drape bake
  // twin. The array reflows to one entry per line at printWidth 100.
  // 5466→5469 (#2093 follow-up, measured post-prettier per §12): the drape LOD ceiling
  // reads `max(currentZ, targetZ)` so a zoom-in readiness HOLD past the ceiling draws
  // its held coarse tiles direct — one destructured field + a tightened comment.
  // 5469→5471 (#2346, measured post-prettier): the windowed-bake dispatch is a
  // texel-DENSITY decision, so its call site hands it `dpr` and the drawn
  // `neededKeys` — two argument lines; the policy itself lives in
  // render/drape-overzoom-dispatch.ts.
  // 5471→5478 (#2346 AA band, measured post-prettier): the mid-render bake is
  // driven from VectorDrapeRenderer, which has no viewport state, so the frame
  // dpr is stashed here (`_bakeDpr`, +6 with its rationale) and handed to
  // bakeTileStrokes (+1). The derivation lives in render/vector-drape-cache.ts.
  // 5478→5501 (#2346 diagnostics, measured post-prettier): the windowed-bake
  // switch is atomic, so its usual failure is to do NOTHING — twice this PR that
  // was inferred from pixels instead of read. The per-slice diagnostic scratch
  // (`_drapeOverzoomDiagBySlice` + `_sliceOverzoomDiag`) is what turned the
  // third round into one measurement; the policy stays in
  // render/drape-overzoom-dispatch.ts.
  // 5501→5524 (design INC-3, measured post-prettier): the STROKE half of the drape
  // decision is now its own derivation beside the fill half (`_bakeStrokesGated`,
  // +14 with its rationale) instead of one line nested inside it, so a frame can
  // drape its fills and still draw its roads direct. The predicate lives in
  // geo/src/projections-table.ts (GLOBE_DIRECT_MIN_STROKE_Z).
  // MEASURED 5539 with `wc -l` on the post-prettier merged tree. main reached 5481
  // (#2249 +1, #2286 +5, #2325 +9) while this branch reached 5524 from the same 5466
  // base, so the merged file carries BOTH sets of deltas and neither side's number is
  // right (§12 — the same trap #2286/#2249 already paid for above).
  // 5539→5541 (measured post-prettier): the merge also collided on the BACKEND-IDENTITY
  // ratchet, INC-3's stroke gate having added a second `backend` test to a file main had
  // also grown. The fix hoists what both halves ask — WebGPU, non-extruded, not disabled
  // — into one `bakeAvailable`, which is net −0 lines of code (six conjuncts out, four
  // in, two references back). The +2 is its two-line comment; the alternative was an
  // unexplained hoist.
  // 5481->5515 (#2309): the two prefetch throttles get a per-frame memo. Both are
  // documented "every 10 / 6 FRAMES" but sat on a modulo inside render(), which runs
  // once per ShowCommand -- 106x/frame on OFM Bright, so the modulo could not express
  // a frame cadence in ANY form. The +34 is 3 fields plus the record of the two forms
  // that both failed (`frameCount % 6` ~17.7 hits/frame, `currentFrameId % 6` 106 hits
  // on every 6th) and of why the memo is keyed by `currentZ` -- the cheap-to-forget half
  // that would otherwise be rediscovered the expensive way a third time.
  // MEASURED 5575 post-prettier on this merged tree. THIRD collision on this key in
  // two days: main went 5481 -> 5515 (#2309's per-frame prefetch memo) while this
  // branch went to 5541 from 5539, so the file again carries both deltas and neither
  // side's number is right (§12).
  // 5575→5576 (#2094, measured post-prettier): the fill drape's WHEN moved OUT of
  // this file's dependency — `drapesAtSelectionZ` came from @xgis/geo alongside
  // `bakesVectorDrape`, `drapesAtChordBudget` comes from ./globe-drape-budget — so
  // the +1 is a second IMPORT STATEMENT, not a line of logic. The gate body itself
  // is unchanged in length (one predicate call, one extra argument) and both comment
  // blocks were trimmed back to their prior height to keep it at exactly one.
  // 5575->5583 (#2309): the two draw-dedup call sites swap a template literal /
  // `number | string` union for a numeric (tileKey, subKey) pair. The +8 is the
  // widened markDrawn argument lists at both sites plus the comments naming what
  // the encoding preserves; the pack itself and its arithmetic argument were
  // EXTRACTED to draw-dedup-key.ts rather than parked here.
  // 5576->5580 (#2474, measured post-prettier): `bakeTileToTexture`'s fence stopped
  // asking whether `createCommandEncoder` EXISTS and started asking the capability.
  // The one-line optional-call guard becomes a two-line guard, and the three comment
  // lines are the refuted premise written down where the next reader meets it — the
  // old one-line `// WebGL2 fail-closed (no offscreen encoder)` was false (WebGL2
  // hands out a copy-scoped encoder), and a reader who believed it would delete the
  // routing guard into a runtime throw. The routing site itself is net zero.
  // MERGE UNION -> MEASURED: FIFTH collision on this key, and the second on this one
  // branch. Three disjoint deltas now stack over the 5575 common base: #2094 (+1) and
  // #2474 (+4) from main, #2309 (+8) here. Every side's number is stale by exactly the
  // other sides' deltas, and git reports no conflict for the ARITHMETIC — only for the
  // line (§12). The ceiling below is `wc -l` on the merged tree, not a sum; the sum is
  // kept here only as a cross-check that nothing was dropped in the resolution.
  // 5588->5596 (#2439, re-measured POST-MERGE — twice): the seeded `categorical()` value
  // lists are OWNED BY `feature-data-binder.ts`, not by this file — what lands here is
  // the 2-line forwarder to it plus one argument at the webgl2 packer call. The first
  // draft did hold the state here (field + docblock + setter, +19) and was extracted
  // precisely because this gate said so.
  // SIXTH collision, same key, and the worst shape §12 names: #2309 (+8, main) and
  // #2439 (+8, here) both wrote 5588 over the 5580 base — the SAME number from two
  // different deltas, so the source merged with no conflict and this file conflicted
  // only on the COMMENT. 5580 + 8 + 8 = 5596 = `wc -l` on the merged tree.
  // 5466→5478 (#2292, hunt 2026-09-02): `rebuildForQuality()` releases the globe
  // VectorDrapeRenderer whose RasterDraper pipelines bake the OLD sample count — one
  // 3-line body plus the 7-line rationale (why a kept drape is a WebGPU validation
  // error, not just a leak). Measured with `wc -l` on the post-prettier tree.
  // 5478→5483 (#2301, hunt 2026-09-02): the store's release hook now takes `keyRebound`
  // so the SUPERSEDE path keeps the ComputeLayerHandle the replacement upload re-used —
  // one guard plus the 5-line rationale (why the other two caches still drop).
  // Measured with `wc -l` on the post-prettier tree.
  // MERGE RE-MEASURE (2026-09-02, main <- issue-hunt branch): both sides raised this
  // key from a common base, so the merged file carries BOTH deltas and neither side's
  // number is right — carrying either across would leave the ceiling one change too low
  // (green on both branches, red on main). Measured 5489 with `wc -l` on the post-prettier
  // merged tree.
  // MERGE RE-MEASURE (2026-09-05, main <- issue-hunt branch, second merge): both sides
  // raised this key from a common base, so the merged file carries BOTH deltas and
  // neither side's number is right (§12). Measured 5597 with `wc -l` on the
  // post-prettier merged tree.
  // MERGE RE-MEASURE (2026-09-05, main <- issue-hunt branch, FOURTH merge): main's #2309
  // (+8, the numeric draw-dedup sub-key) and this branch's #2292/#2301 stack over the
  // common base, so neither side's number is right (§12). Measured 5605 with `wc -l` on
  // the post-prettier merged tree.
  // MERGE RE-MEASURE (2026-09-05, eighth main merge): both sides raised this key from
  // the common base, so neither number is right (§12) — 5613 is `wc -l` on the merged tree.
  'map/src/render/vector-tile-renderer.ts': 5613,
  // Baselined 801: #1602 (the drape's overlap winner is relevance, not re-arm recency)
  // brought the file to exactly NEW_FILE_CAP (800), and the independent #1603 material-
  // release fix landed on main one line above it in the same file, pushing it to 801 on
  // merge. Genuine collision between two unrelated PRs sharing a file, not scope creep —
  // nothing here is extract-worthy.
  // 801→812 (#1544, main merge): the forced-WebGL2-twin-frame deletion reworked this
  // renderer's frame entry points, landing 11 net lines in the same file this branch
  // already baselined — another unrelated-PR collision, not new #1602 scope.
  // Merge union (#1602 <- main #1605 Phase 1-3): the two sides touch DIFFERENT keys —
  // main raised vector-tile-renderer.ts (line composer dispatch), this branch adds the
  // coverage-renderer.ts baseline — so both entries stand; neither number is a pick
  // between sides. Both re-measured against the merged tree.
  // 812->815 (#2286): dispose() drops the drapers; releaseRegion never touched them, so the
  // one path map teardown reaches left them all alive.
  // 812→815 (#2319, hunt 2026-09-02): the drape draw now selects its pipeline from
  // `pickTargetsEnabled(this.rhi.caps)` — the one authority the opaque pass attaches its
  // rg32uint pick MRT from — so a coverage layer under `?picking=1` stops handing a
  // 1-target pipeline to a 2-attachment sub-pass. One argument plus the 3-line rationale
  // (why a mismatched target count invalidates the WHOLE sub-pass, basemap included);
  // the pick twin itself lives in coverage-material.ts, not here. Measured with `wc -l`
  // on the post-prettier tree.
  // MERGE RE-MEASURE (2026-09-02, main <- issue-hunt branch): both sides raised this
  // key from a common base, so the merged file carries BOTH deltas and neither side's
  // number is right — carrying either across would leave the ceiling one change too low
  // (green on both branches, red on main). Measured 819 with `wc -l` on the post-prettier
  // merged tree.
  'map/src/render/coverage-renderer.ts': 819,
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
  //
  // #1437 likewise landed ON that extraction rather than beside it: its own drape-arm extraction
  // was dropped on the merge and the `filter:` argument went into coverage-arm.ts, so map.ts is
  // untouched by it too. Both merges leave the number as #1426's, re-measured each time.
  //
  // MERGE UNION (#1419 third pass <- main @ #1437): main's side adds nothing here (see above);
  // my side's +6 is the coverage renderer's LRU eviction now being ANNOUNCED, with the map as
  // the listener — a dropped region takes its compiled arrows with it. Two wire-ups (the GPU
  // boot and the backend switch), each carrying the sentence saying why the LRU needed one at
  // all: nothing else observed it, so an evicted region's arrows kept drawing against velocity
  // textures that had just been destroyed.
  //
  // 5393→5392 (#1449): the three arm sites now call ONE decision point (`armCoverageArrows`),
  // so the `if (show.isArrow) …` + `armAdvectedArrows(…)` pair here collapsed to a single call
  // and the static-arrow import went with it. LOWERED per the shrink-only rule.
  //
  // MERGE UNION (#1448 <- main @ #1449): non-overlapping, so a SHRINK and a GROW compose —
  // never take one side, never max(). #1448's +3 is one disjunct in `hasPendingSourceWork` (a
  // swap OWED is pending work, not pending fetch) plus the two lines saying why; without it the
  // loop stopped with a re-seed replacement un-applied and the layer drew the previous seed for
  // good. Value below is the MEASURED post-merge, post-prettier count — not 5392+3 assumed.
  //
  // MERGE UNION (#1453 <- main @ #1455): non-overlapping, so main's +3 and this branch's
  // +27 COMPOSE — never take one side, never max(). Value below is the MEASURED post-merge,
  // post-prettier count, not 5395+27 assumed.
  // 5392→5419 (#1453 catalogue-driven coverage residency): a `coverage` source's `url:` may
  // name a STAC catalogue of cells, and then the ENGINE owns residency from the viewport — the
  // job `type: raster` has always done for itself. What lands HERE is only the map-shaped part
  // of that: the per-source catalogue state (declared before `_coverageDeps`, because a field
  // initialiser captures `undefined` the other way round — the `_coverageRefresh` lesson), the
  // two deps members feeding it, the move-end listener + its `destroy()` detach, and the
  // `onRegionDropped` rewire. Every DECISION — the cell/catalogue byte probe, the STAC parse,
  // the viewport resolve, the arm loop and the stop-on-eviction rule — lives in
  // coverage-catalogue.ts (pure) and coverage-source.ts (drives it), the same policy/driver
  // split coverage-refresh.ts already uses, so this is wiring and not logic. An earlier draft
  // put a `_beginCoverageLoad` method here too (+45); it was extracted into
  // `resolveCoverageCatalogues` + `viewBbox` rather than ratcheted for. Post-hook measurement.
  // 5422→5427 (source maxzoom, the 404 class): a dataset has a deepest REAL level and asking
  // past it is a guaranteed 404, not a slow tile — terrarium stops at z15 while
  // rasterCoverZoom adds +1 on a 256-px source, so every visible tile failed from about
  // camera z14.5 (verified: terrarium/16/13651/25075 404, its z15 parent 200). +5: the arm call plus its two-line reason and prettier's wrap.
  // 5427→5426 (#1046 F3b): doc-only — the `_missedTiles` comment named BOTH render
  // paths writing it; only the render-loop path exists post-deletion.
  // 5427→5412 (#1577, parallel on main): the style-import resolver (SSRF guard + body
  // cap + the log-every-failure contract) moved whole to style-import-resolver.ts, and
  // the absolute-base-URL helper joined map-teardown.ts — headroom for the orphaned-boot
  // guard, paid for rather than borrowed.
  // 5412→5411 (#1576, parallel on main): the visible-resume branch lost its duplicated
  // latch commentary — the latch's own declaration already carries it.
  // Merge union (#1046 F3b <- main): both sides shrank independently — measured post-hook.
  // 5409→5410 (merge union, #1046 F3b <- main #1605): stacked non-overlapping edits SUM —
  // this branch's twin-deletion shrink and main's stage-block-drop warning (+1 net, which
  // fit under main's own looser 5411) land in different regions of the same file, so the
  // ceiling is the MERGED file's measured size, never either side's number.
  // 5410→5418 (#1605 Phase 2 PR B): the point runtime-wiring import + the narrowed
  // warnStageBlockUnsupported gate (toComposerPointVariant local + fillIsStage/
  // strokeIsStage condition) + the trailing shaderVariant arg on pointRenderer.addLayer —
  // mirrors line's own Phase 1 wiring at this same call site.
  // 5418→5431 (#1627): three `assertNotErrorPage` calls — the `.xgb` side-load, the
  // `.xgb` scene and the `.xgis` style arm of `load()`. A missing file is answered
  // 200-with-HTML by most hosts, so every `resp.ok` check here passes and the page
  // reaches JSON.parse / the lexer, which report a position inside HTML nobody wrote.
  // The guard itself lives in shared/src/safety.ts (one authority, eight call sites);
  // what lands HERE is irreducible — a guard must sit at the call site that owns the
  // body, and each needs the label naming its URL. +13 = 3 calls + 5 lines of why +
  // the import's prettier wrap. MEASURED on the merged file, not derived from the
  // pre-#1605 base: the two raises land in different regions and therefore SUM.
  // 5431→5436 (#1664): the per-feature colour bake stops failing SILENTLY. A
  // data-driven fill has no layer constant to fall back to, so the catch that
  // isolated one bad expression was also swallowing "this feature has no colour".
  // +5 = the warning import, the `axis` parameter that names which of fill/stroke
  // failed, the report call, and one line of why. The message, its latch and its
  // injectable sink live in render/per-feature-color-warning.ts — only the call
  // site is irreducible here, because only here are the layer and the axis known.
  // 5436→5439 (#1664 review fold-in): the accept side of that same catch. `parseHexColor`
  // is TOTAL — opaque BLACK for anything it does not recognise — so a non-hex string
  // ("red", a data-carried token, a typo) painted a WRONG colour and reported it as a
  // right one, the one failure mode the warning above cannot see. +3 = the token/CSS
  // resolver ahead of the NULLABLE parse (one line, replacing two) plus the four lines
  // naming why, mirroring what render/passes/label-pass.ts has always done. MEASURED.
  // 5439→5442 (#1599): `_eventBus` drops `private` so `FrameLoopHost` can Pick it —
  // the render loop's GPU-fault drain fires the typed `'error'` event through it. +3
  // is the doc lines naming why it is package-internal, not a new member. MEASURED.
  // 5439→5432 (#1364, adopted onto main @ e54a892): the post-allSettled outcome policy
  // moved out to source-load-outcome.ts — it depends on nothing about the map instance
  // beyond raising an error event, and inline it needed a live GPU context to reach, so it
  // had no test. On the PR's own base that read 5409→5402 (−7); ADOPTION re-measures rather
  // than re-uses that number, because main's base moved under it. MEASURED post-pick.
  // MERGE UNION (#1756 <- main): main's +3 (#1599 _eventBus visibility, above) and the
  // adoption's -7 (#1364 outcome-policy extraction, above) compose. MEASURED post-merge,
  // post-prettier.
  // 5437→5446 (#1257): style-authored `raster-fade-duration` resolved once in the
  // rebuildLayers raster-source arm, next to setUrlTemplate/setTileSize/setSourceMaxzoom;
  // `?.` guards a hand-built ShowCommand test double whose paintShapes omits raster.
  // 5446→5450 (#1253): the classifier call site gains `extrudeShell` — the one
  // frame-level fact the pure bucket scheduler cannot see (the device consumes
  // WGSL AND ?debug=overdraw is off) — plus the `readsWgsl` / `isOverdrawActive`
  // imports and one line of comment. Composition-root wiring at the existing call
  // site; the decision it feeds lives in bucket-scheduler.ts (§2). MEASURED.
  // 5450→5458 (#1375): the FeatureUpdateQueue host gains `patchFeaturesInPlace` — the
  // in-place point patch the flush now prefers over a re-seed. The BODY of it lives in
  // SourceManager; what map.ts contributes is the one gate only map.ts can answer (a
  // HEATMAP show on the patched source is built inside `rebuildLayers`, which the
  // in-place path deliberately never calls) plus its reason. Nothing cohesive to
  // extract: it is a single predicate over `showCommands`, which this file owns.
  // Re-measured after merging both branches (5450 + the #1375 +8).
  // 5458→5460 (#1800): the SourceManagerDeps wiring gains `hasVariantSources` — the
  // one-line predicate only map.ts can answer (it owns `vtSources`, SourceManager
  // only sees it through injected callbacks) plus the import. The BODY (the
  // id/id__N predicate + both fast-path gates) lives in map-teardown.ts /
  // source-manager.ts.
  // 5460→5497 (#1265): double-click zoom + Shift+drag box zoom (standard gesture
  // parity). map.ts's share is composition-root wiring only — the gesture state
  // machine itself lives in controller.ts: two runtime-settable enable/disable
  // fields (doubleClickZoomEnabled/boxZoomEnabled, MapLibre handler parity) +
  // their constructor-option reads, the `getState()` closure threading them to
  // the controller live, the new `onBoxZoom` callback (the eased-fitBounds
  // terminal call — #1256's easeTo infra is what makes "eased" possible now),
  // and `fitBounds`'s opt-in `duration`/`easing` passthrough. MEASURED.
  // Baselined at #1265 (measured 997 after the prettier pass): the pointer-gesture state machine crossed
  // NEW_FILE_CAP adding the two gestures MapLibre parity was missing — double-
  // click zoom (native `dblclick`, +1/-1 about the cursor via the existing
  // smooth-zoom rAF loop; the old pointerdown-timing double-tap is now touch/
  // pen-only so it can't double-fire alongside this) and Shift+drag box zoom
  // (rubber-band state + the module-level overlay-div/stylesheet helpers,
  // mirroring map-accessibility.ts's injectFocusStyle pattern; on release,
  // unprojects all 4 screen corners via the existing `unprojectToLonLat` — which
  // already scopes to flat projections, so globe/untilted-disc naturally defer
  // with no extra branching — into a geo AABB dispatched via the new
  // `onBoxZoom` callback). Cohesive gesture-controller ownership; shrink-only
  // from now.
  // 997→1166 (#1264): `cooperativeGestures` (MapLibre parity) — stop an
  // embedded map from hijacking page scroll. `CooperativeGesturesOptions` +
  // two new live-read `ControllerState` fields (cooperativeGestures,
  // prefersReducedMotion — same getState()-closure pattern #1265 established
  // for doubleClickZoomEnabled/boxZoomEnabled), the module-level hint-overlay
  // helpers (mirroring the #1265 box-zoom overlay: shared injected
  // stylesheet + a lazily-created display:none-at-rest div, platform/
  // reduced-motion-aware text, auto-fade timer), the per-attach `showCoopHint`
  // closure, the onWheel early-return that cedes a plain wheel to the page
  // (no preventDefault) while Ctrl/⌘+wheel still zooms, the onPointerDown
  // branch that blocks a single-finger TOUCH drag from panning (mouse
  // drag-pan unaffected), and cleanup teardown for the hint div + its timer.
  // Same cohesive gesture-controller ownership as #1265; shrink-only from now.
  // 1166→1184 (interaction-dpr anchor fix, measured post-prettier per §12): every
  // gesture site now reads the scale the swapchain is ACTUALLY sized at
  // (canvasEffectiveDpr) instead of re-deriving min(devicePixelRatio, maxDpr),
  // and forwards it to camera.zoomAt / panToScreenAnchor / pan. The growth is
  // prettier wrapping five now-6-argument camera calls; nothing to extract.
  // 1184→1195 (#2294): the pan-inertia launch gains a recency gate —
  // INERTIA_MAX_IDLE_MS plus the pointerup check that discards a velocity
  // sample older than it, so a drag that ends with a stationary HOLD no longer
  // flings from the frozen last-pointermove velocity. Growth is the comment
  // explaining why the sample is zeroed; nothing to extract.
  // 1195→1216 (#2295 + #2296, re-measured post-prettier per §12 — the two fixes
  // grew the file without carrying the number, which is exactly the "re-measure,
  // never carry the ceiling across" trap): #2295 gates the pointerup 2→1 handoff
  // on the same cooperativeGestures/touch predicate pointerdown already applies,
  // so the single-finger contract is a property of the pointer-count STATE
  // rather than the press origin; #2296 clears `pressEligible` when a second
  // pointer joins, so a multi-touch gesture cannot pass the click gate. Both are
  // in-place guards inside handlers this file owns — 31 lines of branch
  // conditions and their rationale, with nothing cohesive to extract.
  // 1216->1224 (#2295 review follow-up): the handoff above asked the predicate
  // about `e`, the pointerup of the finger that LEFT, so a touch finger still
  // panned when a pen lifted beside it and a mouse drag was newly blocked when a
  // touch pointer did. `activePointers` now stores each pointer's `pointerType`
  // so the predicate can be asked about the one that REMAINS. The +8 is the map's
  // widened entry type, the two set() sites, and the two comments naming which
  // pointer is being asked about — the mistake was invisible precisely because
  // nothing at either site said which one it was.
  'map/src/controller.ts': 1224,
  // 5497→5546 (#1258, atop the #1265 bump): `_atmosphere` (the top-level style flag) + `setAtmosphere` — the SAME
  // shape `_light`/`setLight` already have in this file (a top-level style concern's field +
  // its public setter, not yet a style-spec JSON property). Nothing cohesive to extract: the
  // setter mutates a private class field directly, exactly like every sibling setter here
  // (setBackgroundFill, setLight, setProjection); pulling just this one out to a free function
  // would need the field made reachable from outside the class, which is a worse shape than
  // the file's own established pattern. The BODY the render pass actually draws with (the
  // camera-ray extraction, the uniform pack, the shader) lives in atmosphere-uniform.ts /
  // atmosphere-pass.ts / shaders/dsl/atmosphere.ts.
  // 5546→5578 (#1264, atop the #1258 bump): `cooperativeGestures` (MapLibre parity) — stop an
  // embedded map from hijacking page scroll. map.ts's share is again
  // composition-root wiring only (the gesture logic + hint overlay live in
  // controller.ts): the `cooperativeGestures` field (default OFF, unlike
  // doubleClickZoom/boxZoom's default-ON) + its constructor-option read, the
  // `getState()` closure threading it + `prefersReducedMotion` to the
  // controller live, and `_setupTouchAction`'s default-branch swap to
  // `'pan-y'` (vs #1153's `'none'`) so a released single-finger touch drag
  // actually reaches the OS as a native scroll. MEASURED at the union merge
  // with #1827's independent 5497→5546 bump (both additive from 5497).
  // 5578→5584 (#1304, atop the #1264 bump): two one-line calls to `sourceManager.stopAllRefresh()`, in
  // `_teardownForReinit()` and `destroy()` alongside the existing coverage
  // stop-block — the SourceManager half of the same teardown spine, so a
  // `refresh:`-declared polling loop can't outlive a scene swap or ghost-write
  // into a same-named source in the next scene (the #1569 class of bug).
  // 5584→5586 (#1836, atop the #1304 bump): the boot-fit width import + a one-line
  // call-site comment at the tile-worker-compile bounds-fit — routes through the new
  // `fitWidthCssPx` helper (map-geo-helpers.ts) instead of the stale `canvas.width / dpr`.
  // 5586→5603 (#1837, atop the #1836 bump): the inline-GeoJSON route gate stops requiring an opt-in flag —
  // ONE condition line (`|| !isLegacyGeoJSONOptOut()`) plus the comment recording why
  // 788e2282 orphaned every flag-off legacy inline scene and which two show shapes
  // (filtered / procedural) deliberately stay behind. Nothing extract-worthy: the gate
  // is four terms inside the show loop, and the flag it now consults is already a
  // shared export from source-manager.ts.
  // 5603→5623 (#1940, atop the #1837 bump): the legacy GeoJSON route now names the slot it
  // writes — one `computeSliceKey(...)` const (4 lines) threaded into `addTileLevel` (+5, the
  // call wraps at four args) and `setRawParts`, plus the comment recording that the key is
  // the VTR's lookup string, that `vtKey` is the wrong one, and which shows this un-blanks.
  // Nothing extract-worthy: this is the ONE line only map.ts can write — it owns both the
  // ShowCommand the key is derived from and the catalog the key is handed to. MEASURED.
  // 5623→5630 (#1177/#2013): the `_labelDispatchLoopRuns` counter + its rationale and
  // the `loopRuns` field in getLabelDispatchStats — the observable the zoom-skip gate
  // asserts the dispatch-loop skip on (measure the skip, not the frame time).
  // 5630→5462 (#2052, T5 sky/fog Phase 0): the top-level style ROOT family moved to
  // style-top-level.ts — the `background { fill / opacity / pattern }` block parse (and the
  // two lexer helpers only it used), plus the validate halves of setLight / setAtmosphere.
  // map.ts keeps the composition-root wiring only IT can write: the `_destroyed` guard,
  // the private `_dirty.tag(STYLE)`, and `invalidate()`. `setBackgroundFill` deliberately
  // did NOT move — its body reaches map.ts PRIVATE members (`_syntheticBackend`,
  // `_installSyntheticEarthSurfaceSource`) and setBackgroundFill-lifecycle.test.ts pins its
  // text to THIS file. Pure extraction, no behaviour line. LOWERED by the extracted count
  // per the doc's Phase 0 mandate — headroom is re-justified per phase, never banked. MEASURED.
  // 5462→5471 (#2116): the glyph keep-alive in `shouldRenderThisFrame`. It sits HERE and
  // not behind a forwarder because this method is the single authority that gates both
  // rendering and `idle`, and the sibling symbol-fade keep-alive it stands next to answers
  // the same question — a second place to decide "is the text finished?" is how #2091 /
  // #2101 / #2116 became three faces of one defect. 1 predicate line + its 8-line reason.
  // MEASURED.
  // 5471→5482 (#2122): the sprite keep-alive, beside the glyph one #2120 added. Same
  // authority for the same reason — `shouldRenderThisFrame` gates both rendering and
  // `idle`, and a second place to decide "is this frame's async content finished?" is how
  // that question has drifted three times already. Reads a deadlined probe rather than the
  // existing `isAtlasTerminal()`, which is the prepare-skip question and stays false
  // forever against a host that hangs. 1 predicate line + its 10-line reason. MEASURED.
  // 5482→5468 (#2144): `getDumpedLabels`'s inline return type — the third
  // hand-written copy of `DumpedLabel` — becomes the imported interface.
  // 5482→5486 (#2118): the ONE line only map.ts can write — `show.circlePitchAlignmentMap`
  // into the geojson-point `addLayer` tail — plus its three-line note on why the knob is
  // trailing. Composition-root wiring, nothing extract-worthy (§2).
  // 5482→5485 (#2162, main): both `getMissingTileCount` docstrings claimed it "settles to 0
  // exactly when the scene converges". It does not — the sum carries three of
  // `keepLoopWarm`'s six terms, and the vector arm counts cells with NO fallback, so a
  // cell showing a magnified ancestor mid-download reads 0 where the raster arm's
  // fetch-count reads 1. Comment-only correction on a PUBLIC accessor; +3 lines.
  // →5478 (#2149 increment 3, main): the sprite keep-alive block (11 lines) moved onto its
  // registration in pending-work.ts — the shared registry term already covers it.
  // →5464 (merge union): FIVE bumps were authored against the same base — #2144's −14,
  // #2118's +4, #2162's +3, #2149's net-zero and #2149-inc3's −11 — so no branch's number
  // survives and arithmetic on any subset of them is wrong. Set from `wc -l` on the merged
  // file; every bump note above is kept because each documents a different change
  // (CLAUDE.md §12).
  // →5432 (#2149 increment 6): hasPendingSourceWork() + its doc + its call line deleted
  // (the registry's full-union read covers the set); the burst dep re-wired to
  // hasPending(SCOPE_VT_PIPELINE) with a 4-line comment. MEASURED (`wc -l`) on the
  // increment-6 tree over the #2154 base. Lower as #991 decomposes map.ts.
  // 5432->5428 (#2162 option B): the accessor's rationale moves to pending-work.ts, which
  // owns SCOPE_TILE_COUNT; map.ts keeps the contract and a pointer. A LOWERING.
  // 5428→5419 (#2121): the imported-style top-level wires (`sprite` from #1112
  // and the `glyphs` this issue adds) moved out to render-adjacent
  // `map/src/imported-top-level.ts` — the pair is one concern, and keeping them
  // apart is how the second one came to be dropped. Measured with `wc -l` on
  // the post-prettier tree.
  // 5419->5432 (#2286): _releaseGpuResources now RELEASES the two owners it only ever
  // dropped -- `renderer` (the MapRendererContent -> FrameRenderer -> PipelineFactory chain
  // that owns every fill Material) and the under-occluder, whose only destroy lived in
  // setBackgroundFill. Teardown code paying an ownership debt, not feature growth.
  // 5432->5437 (#2306): `_backgroundColorFromStyle` provenance flag (field + doc) and its
  // two clears in setBackgroundFill's null/non-null branches, so a style-set fill and a
  // host-set fill (setBackgroundFill) can be told apart when a background-less re-run()
  // resets the style-owned one. Pre-prettier measurement; parent session re-measures.
  // 5437->5440 (#2439, measured post-prettier): three lines — a one-line
  // `setSeededFeatures(filtered.features)` at the attach site plus its two-line why.
  // An earlier draft derived the value lists HERE and cost 11 (call, rationale,
  // import); moving the derivation into the binder, lazily, cut this to the wire AND
  // fixed a staleness bug, so the smaller number is the better design rather than a
  // trimmed comment. Ratcheting DOWN from the 5448 that draft measured.
  // 5419→5427 (hunt 2026-09-02): `_releaseGpuResources` now drops the synthetic
  // earth-surface background's two owner refs (`_syntheticBackend`,
  // `underOccluder`) it was leaking across a re-run — 3 statements plus the
  // 5-line rationale. Measured with `wc -l` on the post-prettier tree.
  // 5427→5432 (#2292, hunt 2026-09-02): the per-VTR loop in `setQuality` now also calls
  // `vtRenderer.rebuildForQuality()` — one line only map.ts can write (it owns
  // `vtSources`) plus the 4-line reason. Measured with `wc -l` on the post-prettier tree.
  // 5432→5437 (#2298, hunt 2026-09-02): `_releaseGpuResources` now re-arms the
  // `_spriteAtlasViewPushed` one-shot latch — one statement only map.ts can write (it
  // owns both the latch and the shared teardown body) plus the 4-line reason. Measured
  // with `wc -l` on the post-prettier tree.
  // 5437→5439 (#2324, hunt 2026-09-02): the addLayer-time circle base-size resolve
  // now reads `this._elapsedMs` (the frame clock) instead of `performance.now()`, so
  // a time-interpolated size is born at its t=0 stop instead of navigation-elapsed —
  // one line plus the 2-line reason. Measured with `wc -l` on the post-prettier tree.
  // MERGE RE-MEASURE (2026-09-02, main <- issue-hunt branch): both sides raised this
  // key from a common base, so the merged file carries BOTH deltas and neither side's
  // number is right — carrying either across would leave the ceiling one change too low
  // (green on both branches, red on main). Measured 5452 with `wc -l` on the post-prettier
  // merged tree, then 5452->5450 when the merge's duplicated under-occluder teardown
  // (#2290 here, #2286 on main — git auto-merged both into one function) folded back
  // to one site.
  // 5450->5468 (#2411): setQuality now rebuilds the under-occluder, the seventh
  // sample-count-baked owner and the only one with no rebuildForQuality() for the
  // fan-out to reach — 8 statements plus the 10-line reason (why a constructor-baked
  // count cannot be re-wired in place, and what the real device says when it is not
  // rebuilt). Only map.ts can write it: it owns `underOccluder`, `ctx` and
  // `_backgroundColor` alike, and extracting 8 lines used once would add a file to
  // pay for a bug fix — a refactor smuggled inside a fix, which the #2249 note above
  // declines for the same reason. Measured with `wc -l` on the post-prettier tree.
  // MERGE RE-MEASURE (2026-09-05, main <- issue-hunt branch, second merge): both sides
  // raised this key from a common base, so the merged file carries BOTH deltas and
  // neither side's number is right (§12). Measured 5473 with `wc -l` on the
  // post-prettier merged tree.
  // 5473->5477 (#2305): setQuality's msaa/picking rebuild fan-out now guards on
  // `this.renderer` being assigned — pre-run() it dereferenced an unassigned
  // renderer field right after `updateQuality(patch)` had already mutated the
  // process-global QUALITY, throwing a TypeError with no way to retell whether the
  // half-applied patch stuck. 1 changed condition + a 4-line comment on why the
  // guard holds (run()/runBinary() are the only assignment sites; the boot itself
  // reads QUALITY live, so the pre-boot value is still honoured). Measured with
  // `wc -l` on the post-prettier tree.
  // 5477->5490 (#2289 review follow-up): `getCanvasDpr()` — a host that drives
  // `Camera.zoomAt` from its own gesture listeners (the site's three wheel
  // handlers) had no way to ask what scale the canvas is sized at, so all three
  // took the `dpr = effectiveDpr()` default and anchored the wrong world point
  // whenever the swapchain sat below the policy dpr. One 2-line accessor
  // delegating to `canvasEffectiveDpr` + the 9-line docblock naming the
  // authority and what re-deriving it costs, which is the half that keeps the
  // next host from writing `min(devicePixelRatio, maxDpr)` again. Measured with
  // `wc -l` on the post-prettier tree.
  // MERGE RE-MEASURE (2026-09-05, eighth main merge): both sides raised this key from
  // the common base, so neither number is right (§12) — 5493 is `wc -l` on the merged tree.
  'map/src/map.ts': 5493,
  // Baselined at 801 (#2129/#2149 increment 2): crossed NEW_FILE_CAP (was 798) by the
  // three pending-work lines — the optional `beginPendingWork` dep, the ticket checkout
  // after the synchronous `state.inFlight.add`, and its `done()` in the settle `finally`.
  // The keep-warm reason lives on the registration (pending-work.ts); this file carries
  // only the wire. Shrink-only from here. MEASURED post-prettier, re-measured at the
  // #2138 merge (main did not touch this file): 801.
  // 801->814 (#2375 F-5): the forecast-step and playback-transition reads called
  // readCoverageRange with no `fetch`, so they fell through to the global one and
  // `_coverageAbort.cancelAll()` — the #1570 fix run by destroy() AND
  // _teardownForReinit() — could not stop a read in flight. Threading the guarded
  // fetch costs a sourceId parameter, a required arg on readRegionsAtGroup, and the
  // multi-line call shapes. Abort-spine plumbing, not feature growth.
  'map/src/coverage-source.ts': 814, // Baselined at #1255 (measured 830): the DOM-inspired layer API crossed
  // NEW_FILE_CAP with the paint-transition style-setter integration — the
  // StyleHost.transitions context, the shared applyNumber/applyColor
  // helpers, and the four setter rewires (fill/stroke/opacity/strokeWidth
  // route their paintShapes writes through the #1255 registry; the ramp
  // machine itself lives in paint-transitions.ts). Cohesive layer-API
  // ownership (registry + style proxy + feature events) — shrink-only
  // from now; split (LayerIdRegistry / events vs style) if it grows again.
  // 830→817 (#1666): the local `parseHexColor` wrapper is gone — a THIRD copy of the CSS
  // hex regex, existing only to turn the total parser's opaque black back into the null the
  // setters gate on. feature-helpers' `hexToRgba` now IS that contract, so the setters call
  // it directly. Deleting a duplicate authority, not moving lines elsewhere.
  // 817→819 (#1599): `XGISMapErrorPhase` gains a fourth member, `'gpufault'` — an async
  // GPU validation/OOM fault now reaches the typed map `'error'` channel instead of only
  // the console. +2 = the two prose lines documenting the phase; the union edits in place.
  // 817→807 (#1364, adopted onto main @ e54a892): the map-level error-event payload
  // moved out to map-error-event.ts — a self-contained cluster nothing else in this file
  // touches. Re-exported here, so existing import paths are unchanged. On the PR's own base
  // that read 830→820 (−10); ADOPTION re-measures on top of #1666's shrink instead of
  // carrying the stale number. MEASURED post-pick.
  // MERGE UNION (#1756 <- main): the #1599 'gpufault' member now lives in
  // map-error-event.ts (the #1364 extraction is the single authority for the error
  // types; layer.ts re-exports). MEASURED post-merge, post-prettier.
  'map/src/layer.ts': 815,
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
  //
  // 903→898 (#1364, adopted onto main @ e54a892): the heatmap point split moved out to
  // heatmap-point-split.ts — it was duplicated verbatim at both sites that tile a GeoJSON
  // source (initial attach + the #1371 in-place re-seed). The PR also carried a
  // `DEFAULT_REGION` import for its own base's `_coverage` seeding; #1426 replaced that
  // branch with an empty region map on main, so the import would be orphaned and was DROPPED
  // in adoption — the source-failure payload (`XGISMapErrorInfo`/`fireError`) is the part
  // that lands. MEASURED post-pick.
  // 898→939 (#1375): `patchFeaturesInPlace` — the route a host feature update takes
  // when it does NOT need a re-tile. RAISED rather than extracted because the method is
  // the sibling of `_reseedInPlace` directly above it: both answer "a push arrived for
  // an already-attached source", both are the only writers of `hostSeededFC` +
  // `heatmapPointData` for that source, and splitting them would put the two halves of
  // one decision in two files — the second-authority shape §12 warns about. +41 is ~14
  // lines of body and the rest the recorded reasoning (why the catalog's all-or-nothing
  // false means fall back, why the seeded FC must still be adopted with nothing
  // re-tiled, and why `detectCapPoles` is deliberately NOT re-run). MEASURED.
  // 939→959 (#1800): both in-place fast paths (`_reseedInPlace`'s call site in
  // setSourceData, `patchFeaturesInPlace`) gain a `hasVariantSources(sourceId)`
  // guard — neither can reach a filtered-show variant catalog's (`id__N`)
  // independently-seeded subset, so a positive answer demotes them to the
  // existing full teardown/rebuild path instead (conservative shape (b); the
  // filter-membership problem a per-variant patch would need to solve is a
  // design increment, not a right-sized fix here). +20 = the deps field/doc,
  // the ctor wire, and the two call-site guards + their reasoning. The id/id__N
  // predicate itself is NOT duplicated here — it lives once in map-teardown.ts
  // (`hasVariantCatalogs`, sharing `teardownSources`' own predicate) and is
  // threaded in as a callback, same shape as `getVtSource`. MEASURED.
  // 959→1042 (#1304): declarative `refresh:` polling for a live source. Two small
  // helpers extracted so the initial attach and a refresh tick share ONE body
  // instead of two drifting copies (`_fetchGeoJSONDoc` — the geojson-URL
  // fetch+parse; `_runCustomLoader` — invoke a registered `SourceLoader` +
  // normalise its `{fc|points}` result), plus `_armRefresh` (starts the
  // per-source poll after a successful attach, re-fetches on each tick and
  // swaps via the EXISTING `setSourceData` re-seed path — no second data-swap
  // mechanism), `stopAllRefresh()` (this manager's half of the #1569-style
  // teardown spine, called from map.ts), the `_sourceRefresh` field, and the
  // two attach-site call additions (geojson-URL branch + custom-loader branch).
  // Failures keep last-good data and report through the typed `'source'` error
  // event instead of throwing — a live poll must survive one bad response.
  // 1042→1057 (#1304 adjudication): the scheduler's generation guard only stops a
  // tick from RE-ARMING — it does not abort a continuation already in flight — so
  // a stale scene-A refresh tick could still resolve AFTER stopAllRefresh() +
  // scene B's re-attach of a same-named source and overwrite scene B's data (the
  // #1569 ghost-write class, one layer deeper than the attach-path A7 guards).
  // Fix: re-check `isStale?.() || !this._sourceRefresh.isRunning(sourceName)`
  // AFTER the tick's await, BEFORE `setSourceData` — same shape as every other
  // A7 guard in this file. +15 = the guard line + its reasoning comment.
  // 1057→1060 (#1836): a one-line call-site comment at each of the three boot-fit
  // sites (PMTiles / GeoJSON-URL / VirtualPMTiles attach), now routed through the
  // new `fitWidthCssPx` helper (map-geo-helpers.ts) instead of the stale `canvas.
  // width / dpr` — the pre-first-frame boot-fit read the un-sized HTML canvas
  // default (300) instead of the laid-out CSS width.
  // 1060→1068 (#1837, atop the #1836 bump): the `?legacy=1` / `__XGIS_USE_LEGACY_GEOJSON` opt-out became a
  // named export (`isLegacyGeoJSONOptOut`) because map.ts's inline route now reads the
  // SAME flag — one authority, not a hand-copied predicate that could drift into meaning
  // two different things on one page. Net +8: the exported function + its doc, minus the
  // inline `useLegacy` expression and the comment lines it replaced.
  // 1068->1073 (#2439, measured post-prettier): `_reseedInPlace` KEEPS the renderer
  // by design, so the dense `categorical()` index derived from the previous data
  // would rank the new data against the OLD value set — a wrong-colour bug, not a
  // missed optimisation. One `setSeededFeatures(reprojected.features)` next to the
  // existing `reseedTiles()`, plus the four lines saying why a reader must not drop
  // it. Re-seeding drops the binder's memo, so the ranks cannot outlive their data.
  // 1068→1094 (#2300, and re-measured over the #2299 per-source `_showSourceMaps`
  // bump this file had already taken): `resetForReinit()` — the manager half of the
  // teardown spine, which now releases `hostSeededFC` / `vtBackends` /
  // `_showSourceMaps` instead of only stopping the refresh loops, so a swapped-out
  // scene's seeded collections cannot outlive it. +26 = the 4-line body and the
  // recorded reasoning (why nothing keyed there is still live after either teardown
  // path, and what the stale FC did to `updateFeature`). MEASURED post-prettier.
  // MERGE RE-MEASURE (2026-09-05, eighth main merge): both sides raised this key from
  // the common base, so neither number is right (§12) — 1099 is `wc -l` on the merged tree.
  'map/src/source-manager.ts': 1099,
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
  // 2284→2232 (#777 IV3-2b), →2231 (2c: the bbox arithmetic, written twice, became
  // one deriveLabelBbox authority that also routes the ground basis): the module-scope constants (STAGE_DEFAULTS,
  // TEXT_MAX_ANGLE_DEFAULT_DEG) and the pure rotateLabelTranslate helper moved to
  // text-stage-helpers.ts — none touch `this`. A behaviour-free move that opens the
  // headroom the ground-basis bbox work needs; the file sat exactly at its ceiling.
  // 2231→2187 (#1574): the rasterizer-wiring block — which of the three cases applies,
  // the chain order, and WHICH of the two fallbacks a glyph gets — moved whole to
  // glyph-rasterizer-wiring.ts. Nothing outside it read its locals, and the two-fallback
  // rule needed a place to be written down: routing a permanently-failed range to the
  // metrics-only placeholder is what made every Latin label inkless. The ceiling is
  // lowered to the measured post-hook figure rather than left slack — the extraction
  // paid for the fix's growth, so the win is banked, not spent twice.
  // 2187→2167 (#2012 INC-4): the curved-label GLYPH WALK — cumulative arc length,
  // the fit/clamp, the keep-upright reversal, the per-glyph sample + max-angle gate
  // and the offsets/rotations fill — moved whole to text/curved-glyph-walk.ts. It is
  // exactly the code the increment had to change, and inline it could not be gated:
  // the LABEL-PLANE ↔ SCREEN index correspondence INC-4 introduces is now a pure
  // function of its two polylines with a unit gate that can be severed on its own.
  // The file had 2 lines of headroom and the increment needed ~40, so the extraction
  // pays for it AND banks the rest: the ceiling drops to the measured post-prettier
  // size rather than being left slack, because headroom is re-justified per phase,
  // never banked. MEASURED.
  // 2176→2175 (#2012 INC-5, on top of #2116's 2167→2176). #2116 added
  // `hasPendingGlyphLoads()` (+9); INC-5 nets −1 here by paying for the pitched size
  // correction out of TWO extractions, because the file had ZERO headroom to pay it from.
  // (1) `labelSizePx` — authored size × DPR × the 1/64-quantised perspective factor —
  // moved to text-stage-helpers.ts, taking the #1081 rationale and the layout-cache
  // contract with it. It is exactly the arithmetic INC-5 makes SHARED: the point loop has
  // folded a perspective factor in since #1081 and the curved loop now does too, and two
  // copies are two chances to quantise one and not the other (the cache is keyed on the
  // result, so the un-quantised arm would thrash on every frame of a tilt).
  // (2) `CurvedGroundArgs` — the `addCurvedLineLabel` ground payload, which INC-5 showed
  // was hand-written on BOTH sides of the stage boundary plus once more as the dispatch's
  // reused holder: adding one field meant editing three copies of one shape, so it becomes
  // one named type in text-stage-types.ts. What GREW here is only the two loops' one-line
  // size derivation and their reasoning. The ceiling drops to the measured post-merge size
  // rather than being left slack: headroom is re-justified per phase, never banked. MEASURED.
  // 2175→2164 (#2144, D7 P2 — CJK vertical writing). The file had ZERO headroom
  // and the column needed ~24 lines (the `vertical` gate, the rotations arena
  // alloc, the `fillVerticalColumn` call, the vertical bbox metrics, the two
  // draw sites, the cache-entry field and the layoutCacheKey term), so the
  // increment is paid for by THREE extractions rather than a bump:
  // (1) the plain-text per-line pen loop is DELETED, not moved: with no sprites
  //     `fillPointGlyphOffsetsWithImages` degrades to exactly it, so the second
  //     copy of the justify + advance arithmetic is gone and one copy can no
  //     longer drift from the other (the `labelSizePx` rationale, one level down);
  // (2) `anchorVAlign` (MapLibre getAnchorAlignment's vertical half) and
  //     `resolveJustify` (`text-justify: auto` against the anchor) move to
  //     text-stage-helpers.ts, each landing beside its only consumer there
  //     (`mlVerticalLayout` and `fillPointGlyphOffsetsWithImages`);
  // (3) the 20-line #608 autopsy above the `pairedTextCentreShift` call moves
  //     into that function's docblock in paired-symbol-box.ts — the file whose
  //     own header says the split exists "so each has room to carry its own
  //     rationale".
  // (4) `getDumpedLabels`'s inline return shape — a hand-written mirror of
  //     `DumpedLabel`, written out a THIRD time in map.ts — collapses to the
  //     exported interface. P2 adds two fields to that shape (`rot`, `vertical`),
  //     and three copies of one type are three chances to add a field to two.
  // The ceiling drops to the measured post-prettier size rather than being left
  // slack: headroom is re-justified per phase, never banked. MEASURED.
  // 2149→2145 (#2170): text-translate came out of the cached layout and its
  // key, replacing the fold-then-add with one grouped expression at each of the
  // two draw sites. Measured with `wc -l` on the post-prettier tree.
  // 2145->2171 (#2440 text-optional): the `isTextOptional` module predicate and
  // its docblock, plus its two consumer sites (the live-text set and the drop
  // cascade). One function for a one-line read is deliberate — §12's
  // single-producer rule: the two consumers must agree by construction, because
  // suppressing the cascade alone leaves the surviving icon drawing while
  // blocking nothing, and changing the set alone leaves it dropped with a box
  // nobody sees. The docblock is the ONE home of that argument; render-node.ts,
  // capabilities/symbol.ts and the spec-coverage note all point here rather than
  // restate it (an earlier draft restated it four times and cost 33 lines).
  // MEASURED post-prettier (`wc -l`), set EXACTLY to the count.
  // 2171→2172 (#2446): one argument — the label's inline-image anchors — threaded
  // into wrapWithKnuthPlass so the whitespace trim stops at an image.
  // 2149→2178 (#2313 — an unshapeable curved line label must still be counted).
  // The three early-outs of the line-shaping loop (no glyphs, degenerate
  // polyline, glyph walk rejected by run length / text-max-angle) `continue`d
  // out of the loop, so the label never entered `shaped[]` and the drop loop —
  // which stamps droppedPairKeys only from `shaped[]` — left its paired highway
  // shield on screen as an empty badge with no road number. Each early-out now
  // pushes a layout-less entry, which the EXISTING collision + drop wiring
  // already reports as unplaced (+15 for the shared field builder and its
  // rationale, +9 at the three sites, +5 for the two z-order comparators'
  // optional anchor read). The file had ZERO headroom and there is nothing to
  // extract that would carry this: the entry's fields ARE prepare()'s local
  // ShapedLabel shape, so the one duplication the fix would have introduced is
  // instead collapsed into `lineShapedFields`, which the fitted push now shares.
  // MEASURED post-prettier.
  // 2178→2195 (#2323 — same-route spacing window follows the run's own
  // authored symbol-spacing instead of one frame-wide 250*dpr constant):
  // `addCurvedLineLabel` grew one trailing param + doc comment, `PendingLineLabel`
  // / `ShapedLabel` each grew one field + doc comment, and the two
  // `collisionInput` builders (legacy + z-order-ordered) each grew one line
  // forwarding it through to `CollisionItem`. No single site could absorb this —
  // it is the same field threaded through every existing carrier on the
  // point-to-collision path, mirroring how `lineId`/`anchorDistancePx` are
  // already threaded. MEASURED post-prettier.
  // MERGE RE-MEASURE (2026-09-05, main <- issue-hunt branch, second merge): both sides
  // raised this key from a common base, so the merged file carries BOTH deltas and
  // neither side's number is right (§12). Measured 2217 with `wc -l` on the
  // post-prettier merged tree.
  // MERGE RE-MEASURE (2026-09-05, third main merge): main's #2503 (leading-whitespace
  // trim) and #2507 (limb-cull) landed on this file while this branch carried #2313 and
  // #2323, so the merged file holds every delta and neither side's number is right.
  // Measured 2218 with `wc -l` on the post-prettier merged tree.
  'map/src/text/text-stage.ts': 2218,
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
  // 2034→2013 (#1046 F3b, the LAST chain pass): the text-overlay sub-pass originates
  // through requireRhiFrame (+9 — the seam call, the conditional-resolve rationale, and
  // the reworded twin-arm comment). Paid by extraction, not a bump: resolveIconRotateRad
  // (+JSDoc) moved VERBATIM to icon-keep-upright-rotate.ts (pure, one call site, its own
  // unit gate keeps importing the same symbol).
  // #777 IV3: −8. The point-label dispatch loop moved to dispatch-point-labels.ts,
  // which is also where the ground-basis producer lives — the extraction paid for
  // the wiring rather than the file growing to hold it.
  // 2005→1996 (#1046 F3b): the `ctx.rhiPass` twin arm (draw directly on the forced-
  // WebGL2 frame's live screen pass) deleted; the `else` branch (originate through
  // the RHI frame encoder) unconditional now that it is the only frame shape.
  // 1996→2010 (#1177/#2013): the S16 dispatch-loop skip — a loop-condition guard
  // plus its safety rationale, and the loop-run counter incremented INSIDE the
  // body so the zoom-skip gate's loopRuns === misses assertion measures the skip
  // itself (removing the guard while keeping the counter turns the gate red).
  // 2010→1977 (#2012 INC-4): the CURVED LINE dispatch — the per-stop emit body, the
  // world-lattice cadence, and the run identity (dedupe key / lineId / collisionId)
  // it feeds — moved to passes/dispatch-curved-line-labels.ts, mirroring how
  // dispatch-point-labels.ts paid for #777 IV3 (see the note above). The file had
  // ZERO headroom and INC-4 adds the label-plane projection, the merc sample arrays
  // and the ground gate here; the extraction pays for all of it. It also stops the
  // run identity being derived on `text-rotation-alignment: viewport` layers, where
  // no consumer exists. The ceiling drops to the measured post-prettier size rather
  // than being left slack: headroom is re-justified per phase, never banked. MEASURED.
  // 1977→1998 (#2166): the per-feature `symbol-sort-key` arm in applyFeatureExprs
  // — the ast hoist + its 5-line why (the collision pass reads the dispatched def in
  // the SAME frame, so nothing is owed in text-stage.ts), the early-out term, and
  // the evaluate arm with the non-numeric fallback note. The groundAlignsAtRuntime
  // repoint above it is net zero. MEASURED post-prettier (`wc -l`).
  // 1998->2008 (#2224): the tangent gate reads the SHARED `tangentRotates`
  // predicate instead of spelling `!== 'viewport'` a second time (the split the
  // fourth enum value opened), which wraps the '@xgis/compiler' import to one
  // name per line (+6) and the call to three lines, against the six-line why.
  // RE-MEASURE after any merge with a branch that also moves this key — #2536
  // lowers it to 1990 from the same base, and the file takes BOTH deltas.
  // 1998→2001 (#2324, hunt 2026-09-02): the per-show `elapsedMs` now reads
  // `host._elapsedMs` (the frame clock the fade ledger above it already reads)
  // instead of `performance.now()` — one line plus the 2-line reason. MEASURED
  // post-prettier (`wc -l`).
  // MERGE RE-MEASURE (ninth main merge): both sides raised this key; 2011 is `wc -l`
  // on the post-prettier merged tree (§12 — never carry either side's number across).
  'map/src/render/passes/label-pass.ts': 2011,
  // #1081 — per-anchor perspective distance attenuation (MapLibre parity). New
  // baseline: the wCenter + perspScale scratch-out-value lives INLINE in the two
  // existing projector closures (it rides the cw already computed per anchor —
  // not extract-worthy, §2), plus the perspectiveScale() getter, the 3-slot
  // projectLonLatCopies tuple, and the 6-member return objects prettier now wraps
  // multi-line — together nudging this helper just over NEW_FILE_CAP (773→818).
  // 818→817 (#1575, main only): the end-of-frame keep-warm gate moved to
  // render-loop-keep-warm.ts, where it is unit-testable — previously it was reachable
  // only through a full GPU frame, which is why the disjunct MISSING from it could not
  // be gated at all.
  // 817 stayed 818 on this branch (#1046 F3b merge): #1575's extraction landed on main
  // before this branch's merge-base and never touched render-loop-helpers.ts itself here
  // (the file's own content is untouched by #1575 on this line range) — the 817 above is
  // main's number for a file this branch independently grew by +1 earlier in the PR,
  // unrelated to #1575. Auto-merge silently took main's ceiling edit without the paired
  // file edit that justified it on main's side; restored to the branch's own measured
  // reality.
  // 818→841 (#1599): `reportErrorScope` hands a RESOLVED validation message to an
  // INJECTED `(msg: string) => void` sink, so all three fault origins reach the one
  // capped queue the per-frame GPU-fault drain reads. +23 = the signature prettier now
  // wraps over 4 lines, the 3-line body block, and the contract prose naming why the
  // rejected arm stays log-only and why nothing double-counts. The sink is a callback
  // and NOT the RenderContext (#1599 fix-up, review finding 1): writing the queue here
  // would need a concrete backend-adapter import, which the #991 backend-adapter
  // ratchet rejects for this file — it has no baseline row — and would falsify this
  // module's "no GPU coupling" header. No import was added; the prose paid for the +23.
  // 841→869 (#2315): `frameCenterLatDeg` — the frame's RTC centre latitude, moved here
  // out of the render loop (which shrinks by the same block, ceiling lowered below) and
  // fixed to read the centre through `representsCenterAs` instead of the Mercator-
  // saturated `mercatorYToLat(centerY)`. +28 = the 4-line signature prettier wraps, the
  // 7-line body, and the doc prose that records WHY the sphere family's centre latitude
  // is authoritative here: the tile/raster/drape anchors and the orbit matrix's RTC
  // origin must be the same point, and the saturated value put them 441 km apart at
  // lat 89. That prose is the reason a future edit cannot 'simplify' the branch away.
  // MEASURED post-prettier (`wc -l`), set EXACTLY to the count.
  // 869->841 (2026-09-05, third main merge): this branch's #2315 helper
  // `frameCenterLatDeg` was superseded by main's `frameCenterLatOf` (view-matrix.ts,
  // #2507), which took over its only call site in render-loop.ts, so the helper and
  // its test were removed as the orphans the merge created. Shrink-only: measured 841
  // with `wc -l` on the post-prettier merged tree.
  'map/src/render-loop-helpers.ts': 841,
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
  // 1621→1568 (#1046 F3b Inc-2c): the heatmap blur/compose factories retired
  // with the chain's RHI re-origination — win banked.
  // 1568→1496 (#1568): the ShaderVariantInfo→WGSL choke point + its memo moved to
  // polygon-shader-cache.ts to pay for the body-epoch key — win banked.
  // 1496→1553 (#2042 INC-4b): the split-bind fill family — the
  // SPLIT_FILL_LAYOUT_ENTRIES static (drift-test-pinned), the flag-gated
  // layout + twin build in build(), the two fields, and fillRhiState's
  // split hand-off. The factory is the layout/pipeline owner, so the
  // descriptor increment lands here by design.
  // 1553→1650 (#2042 INC-4d): the lazy per-style split twin registry —
  // perStyleSplitTwin (emitted-interface eligibility + build-on-first-use),
  // the two cache maps, the registerFillMaterials info capture, and
  // fillRhiState's perStyleTwin hand-off.
  // 1650→1659 (#2042 INC-7): the split-bind default flips from opt-IN (`=== true`) to
  // opt-OUT (`!== false`). One condition character, plus a 9-line reason recording why the
  // escape hatch stays for one release, why INC-8's legacy deletion is gated on ON having
  // SHIPPED green rather than merged, and why WebGPU-only here is structural — build()
  // early-returns for webgl2 before the split layout is created, so the flip is inert on
  // that backend and the "both backends" precondition is discharged by showing WebGL2
  // UNCHANGED. MEASURED after prettier.
  // 1659->1709 (#2286): the factory had NO destroy at any level and no `.destroy()` call
  // anywhere in the file, so `rebuild()` (map.setQuality) dropped the whole fill-Material
  // set undestroyed with the device alive. Adds ownedMaterials/dropMaterials/destroy -- one
  // authority shared by rebuild and teardown.
  // 1709->1736 (#2309): the two per-style maps get a write-through label index, so the
  // fill draw path's dual-instance fallback is one lookup instead of a walk of all 160
  // entries (measured 698 wasted iterations a frame). The +27 is 2 index fields, the 2
  // setters that are now the ONLY write authority for the maps, and the clear. The
  // contract and the rationale were EXTRACTED to material/per-style-label-index.ts
  // rather than parked here -- that extraction is also what kept polygon-fill-material.ts
  // under the 800 new-file cap.
  'map/src/render/pipeline-factory.ts': 1734,
  // 1419→1442 (#1506): `setProjection` — the camera now RESOLVES its own
  // projection kind (azimuthal-when-tilted promotion → projType /
  // azimuthalProjType / globeMode) instead of being a per-frame write target for
  // three fields the render loop derived. This is a net repo SHRINK, not growth:
  // render-loop.ts loses the same block (955→934 below, −21) and gains one call.
  // Nothing to extract — the rule reads `this.pitch` and writes this class's own
  // fields, so it IS camera state; a separate file would re-create the split the
  // change exists to close. Most of the +23 is the moved rationale.
  // 1442→1441 (#2332): effectiveMpp's docblock rewritten to the builder it mirrors.
  // MERGE UNION (#2507 <- main): main's -1 (#2332, above) and the branch's -1 (#2500:
  // the disc zoomAt branch's viewport-fit clamp + latPreserve reset block became one
  // dual write, _setDiscCenterLat) compose. MEASURED post-merge: 1440. A LOWERING.
  // 1442→1452 (interaction-dpr anchor fix, measured post-prettier per §12): pan /
  // zoomAt / panToScreenAnchor / maxCameraY take the caller's device scale
  // instead of each re-deriving min(devicePixelRatio, maxDpr) — three inline
  // derivations out, one parameter + its rationale in.
  // 1452→1459 (#2322, measured post-prettier per §12): pan()'s two raw-mpp
  // scale lines (sphere-family + flat) now call the existing effectiveMpp
  // single authority instead of re-deriving the uncapped formula, so the
  // inertia glide / off-ground fallback moves by the same on-screen scale
  // the frame is rendered at below the view-height cap. No new file to
  // extract to — both call sites already had the authority in scope; the
  // growth is the two swapped lines plus their rationale comments.
  // 1459→1474 (#2332, measured post-prettier per §12): effectiveMpp's globe arm
  // mirrored buildECEFFrameView's cos-lat cap, but globeMode routes
  // getViewForProjection into buildGlobeFrame/globeAltitude instead — uncapped
  // for the perspective globe (#450), flat-capped for the promoted disc — so
  // every metre-scaled size consumer read a scale up to 6.6x off below z*. The
  // branch now splits per REACHABLE BUILDER (+5 lines of body); the other +10 is
  // the per-arm builder map that replaces the one-line claim the split refutes.
  // Nothing to extract: it is a two-line decision about this class's own fields,
  // and moving it out would re-create the mirror-drift the fix closes.
  // MERGE RE-MEASURE (2026-09-05, third main merge): main's #2332 (6e34251, kept as the
  // implementation) and this branch's #2289 (dpr-anchored pan/zoom) + #2322 (pan scale
  // cap) all raised this key from a common base; the merged file carries every delta and
  // neither side's number is right. Measured 1457 with `wc -l` on the post-prettier
  // merged tree.
  'map/src/camera/camera.ts': 1457,
  // 1441→1524 (#1605 Phase 1, measured post-prettier per §12): compute_line_color gains
  // an explicit vec4 return type + a 'line-color-return' placeholder (named alpha/
  // base_color Lets + a line_color_out Var so a foreign composer Stmt list can varref
  // them), plus the new LineVariantSpec type, its two composer helpers, and
  // buildLineModule/emitLineWgsl threading a variant param through — the line half of
  // the polygon-only @stroke fragment seam.
  // 1524→1542 (#1635): the group(0) block's `_pad_tail0: vec4fT` becomes polygon's four
  // named f32 lanes (same bytes) so the `zoom` a `@stroke` stage block reads is a lane that
  // EXISTS, plus the `as: 'tile'`→`as: 'u'` instance rename the composer's plain-text
  // `u.<lane>` requires and the VS's fill_translate_x/y reads that replace the old `.zw`
  // index. Structural (+4) — a lane cannot be extracted elsewhere; the rest is the two
  // rationale comments for a rename whose reason is invisible from the token.
  // 1542→1543 (#1828): the saturate migration keeps one non-[0,1] clamp (t along the
  // segment), so the import list carries BOTH names — one structural line, zero logic.
  // 1543→1527 (#1496): the seam-crossing segment cull lands +15 in vs_line,
  // paid for by extracting finalize_corner + pattern_unit_to_m to
  // line-corner.ts (TILE lanes as parameters; a one-line adapter keeps the
  // call sites). Net shrink banked per the shrink-only rule. MEASURED
  // post-prettier.
  // 1527→1535 (#2042 INC-1): the four `_pad_*_ecef_center_*` size-mirror pads
  // for polygon's appended absolute RTC anchors (shared VTR group(0) buffer —
  // polygon-line-uniform-parity). MEASURED post-prettier.
  // 1535→1539 (#2042 INC-6): the two `_pad_*_hl` Mercator-anchor mirror pads.
  // 1539→1641 (#2089): the 12 ECEF endpoint-lane struct fields, the lane/ENU
  // corner construction that replaced the in-shader `ecefFromMerc` re-derivation,
  // and the reviewed error-budget rationale the construction rests on (the
  // spherical-vs-ellipsoidal cos(lat) residual, the exact-affine tangent-plane
  // argument, and the δφ·|off| vs δφ·R statement of what the migration buys).
  // The arm closes over base/isStart/sego, so it lives with the VS builder
  // rather than extracting; the growth is comment-heavy by design — a wrong
  // justification here is what a later reader would build on.
  // 1641→1651: the measured before/after (1.17e3 m → 2.1e-1 m, from
  // _line-ecef-lane-parity) and the scope note that the lanes are f64-exact as
  // PACKED while the shader recombines in f32 — the distinction a later reader
  // would otherwise have to rediscover from a failing tolerance.
  // 1651→1673 (#2042 INC-6, the LINE half): the flat arm now RECOMBINES the Mercator
  // camera-relative pair from the absolute anchors instead of reading the CPU-packed
  // cam_h/cam_l lanes. That is a real added code path, not padding: three un-padded lane
  // declarations + their reasons, a `tileCamRel()` adapter over the shared merc-cam-rel.ts
  // authority, and a `lineEndpoint` adapter over the extracted helper. `line_endpoint`
  // itself MOVED OUT to line-endpoint.ts (the #1003 line-corner.ts idiom — lanes as
  // parameters), which is why the growth is 22 and not 30; the extraction was required by
  // the increment anyway, since that function's cam read is one of the three sites the
  // recombination replaces and the pair it needs is flag-selected, not a raw lane.
  // The file's path back DOWN is identified and measured: `compute_line_color`
  // (map/src/shaders/dsl/line.ts, ~497 lines — a third of the file) is the next extraction,
  // deliberately not folded in here so this increment's diff stays about the recombination.
  // MEASURED after prettier.
  // 1651→1673 (#2117 line-gradient, on top of #2089's 1539→1651). #2089 paid 112 lines
  // for the ECEF endpoint lanes and the error-budget rationale under them; #2117 adds
  // 22: the two ramp uniform arrays + `gradient_count` on LineLayer (which takes the
  // slot the 16-byte alignment pad occupied, so the struct grows only by the arrays),
  // and the ramp substitution in compute_line_color. The ramp EVALUATION — the stop
  // loop and the 4-per-vec4 position unpack — is extracted to line-gradient.ts, the
  // same relief valve #1496 used, so only the struct fields and one `If` block land
  // here. Headroom is re-justified per phase, never banked. MEASURED post-merge.
  // BOTH histories above start from 1651 and BOTH add 22 — #2042 INC-6 and #2117 each
  // reached 1673 independently, which is exactly the merge where taking either side's
  // number looks right and is wrong. Merged and MEASURED post-merge (`wc -l`): 1695.
  'map/src/shaders/dsl/line.ts': 1695,
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
  // 1476→1498 (shared-lowering twin): +22 for `emitPolygonGlslStages` — a 5-line
  // rationale, the 9-line emitter, and the 8 lines prettier adds re-wrapping the now
  // 106-char shader-dsl import. It exists because the per-stage `emitPolygonGlsl` above
  // prunes the module before EACH emit, so the four polygon pipelines (three in VTR, one
  // graticule) each lowered + ran the optimizer fixpoint twice; the module build is 2 ms
  // against ~80 ms for one emit, so that lowering is the entire cost.
  // 1498→1540 (#2042 INC-1): the four absolute RTC anchor struct fields (with
  // the recombine-flag contract doc) + the flag-selected rtc_off_h/l Let pair
  // in the projection ladder's 3D arm. Shrinks at INC-4 when the legacy
  // cam_ecef_off fields and the select retire. MEASURED post-prettier.
  // 1540→1577 (#2042 INC-6): the two Mercator anchor fields + the flag-
  // selected cam_rel_h/l Let pair at the ladder top (the flat-arm
  // recombination). Same INC-4/5 shrink-back path. MEASURED post-prettier.
  // 1577→1567 (#2042 INC-6 prep): the Mercator cam-rel recipe moved to the shared
  // merc-cam-rel.ts so line.ts can consume the SAME authority instead of spelling out a second
  // copy (it would have been the third, counting polygon-split.ts's `derived` map). Shrink-only
  // ratchet, so the freed 10 lines are given back rather than banked. The extraction is proven
  // byte-identical by polygon-variant-diff.test.ts's 8 un-minified snapshots, and that gate was
  // itself validated against a known positive (renaming the Let reds all 8). MEASURED.
  // 1567→1593 (#1496): the seam-needle discard's PLUMBING only — two varyings, the ladder's
  // seamX output var, and 3×(Var + arg + two output fields). The decision and its rationale
  // live in polygon-seam-needle.ts (new, < 800). MEASURED post-prettier.
  'map/src/shaders/dsl/polygon.ts': 1593,
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
  // 1370→1384 (#1448): `hasReplacedKeys()` — the PEEK the render loop's idle-skip needs to see
  // that a re-seed swap is still owed. RAISED, not paid for by an extraction: a two-line
  // accessor has nowhere cohesive to go, and the twelve lines are the reason it must not drain
  // (a predicate that consumed its own evidence would swallow the swap it schedules) plus the
  // measurement that found the bug — the part a future reader needs most. Measured post-hook.
  // 1384→1383 (merge union <- main): a one-line shrink banked honestly rather than left
  // as silent headroom — the ratchet passes on shrinkage, so this would never have failed.
  // 1383→1392 (#1616): `contentGeneration()` — the signal `indexGeneration` structurally
  // cannot carry, since index entries only GROW and a re-tile of an already-held key moves
  // neither them nor the selected key set. RAISED, same shape as the #1448 entry above: a
  // counter field + a one-line accessor have nowhere cohesive to extract to, and the bumps
  // sits at the ONE chokepoint every slice write passes (`setSlice`) plus the refresh-drop
  // branch, which changes content with no write for `setSlice` to see. +4 more for the
  // review correction: the doc had claimed it fires "whenever content changes", which is
  // false — eviction deletes bypass this class entirely. Measured post-hook.
  // 1399→1412 (#1596): `getTileFailureCount()` — the count BEHIND `getTileState`'s
  // `'failed'`, which the render loop needs to bound how long a failing VT tile keeps it
  // awake. RAISED, same shape as the #1448/#1616 entries above: a 6-line accessor that
  // folds the backends exactly as `getTileState` (its immediate neighbour) already does
  // has nowhere cohesive to extract to, and splitting the pair would put two readings of
  // one backend's failure cache in two files. Measured 1412 post-commit, no hook.
  // 1412→1444 (#1375): `patchPointFeatures()` — rewrite the POINT records already sitting
  // in cached tiles instead of re-tiling the source. RAISED, same shape as the #1616 /
  // #1596 entries above: the planning + packing is EXTRACTED (point-feature-patch.ts, a
  // new 194-LOC leaf) and the flat cache walk belongs to TileDataCache (`slices()`), so
  // what stays here is 6 lines — the delegation plus the `_contentGeneration` bump, which
  // MUST stay here because this file is that counter's single write authority and a patch
  // that forgot to bump would be invisible to the point repack. The other +26 is the
  // import block, the `pointFeatureIds` passthrough at the two descriptor sites, and the
  // recorded reasoning. MEASURED.
  // 1444→1456 (#1940): `setRawParts` / `addTileLevel` gain a `sliceKey` (default '', so every
  // existing caller is byte-identical) and pass it to the runtime backend + the two writes in
  // addTileLevel's body. +12 is the two parameters, the three passthroughs and the doc that
  // says WHY the slot has to be named — the catalog is the storage authority the VTR's
  // `computeSliceKey` lookup has to agree with. MEASURED.
  // 1456->1478 (#2182): `loadingTiles` becomes a Map (key -> dispatch ms) so
  // `hasPendingLoads()` can be DEADLINED. It was the one keep-warm signal still
  // unbounded: `safeFetch` has no timeout, backends release only from `.then`/`.catch`,
  // and `cancelStale` is keyed on the ACTIVE set, so a still-visible tile whose fetch
  // HANGS was stranded for the session and `idle` never fired again (#2091's shape, at
  // the catalog level, so every backend). +22 is the constant with its bound rationale,
  // the field doc, the deadline loop and the accessor doc. A first draft cost +39 and was
  // trimmed. MEASURED post-prettier.
  // #2273 raised 1478 -> 1492: the prefetch shield now ages per frame (a frame-id
  // record in resetCompileBudget + a guard in cancelStale). Six lines of logic;
  // the rest is the measured rationale. Nothing here is a separable unit.
  // #2391 raised 1492 -> 1503: the detached-producer guard (audit F-8). ONE line of
  // logic in acceptResult plus a two-statement reorder in attachBackend; the rest is
  // the two rationales, and they are the load-bearing part — the obvious spelling of
  // this guard silently drops the polar caps and the synthetic earth surface, because
  // both emit from inside attach(). A first draft cost +17 and was trimmed to +11 by
  // moving the full argument onto the issue. Not separable: the check belongs at the
  // single sink chokepoint. MEASURED post-prettier.
  'data/src/tile-catalog.ts': 1503,
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
  // 1387→1418 (#1046 F3b Inc-2a): the F3b bridge — keep the RHI screen-view
  // handle beside its unwrap, populate the three parallel rhi*View ctx fields
  // in both ctx branches + the MSAA block, and the WeakMap-memoized
  // _rhiViewFor wrap helper (allocation-free steady state). All of it is
  // transitional plumbing that the F3b FrameContext field collapse deletes
  // together with the native trio. +31, post-hook. 1418→1425 (F3b review):
  // the msaa=1 bridge reuses the device's rebind screen wrapper instead of
  // memo-wrapping a per-frame-minted view — keeps the loop allocation-free
  // on that path too. +7, post-hook.
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
  //
  // 1433 (merge, F3b branch × #1419/#1424): both sides GREW independently — the F3b
  // bridge (+38 over 1387) and the twin's arrow step (+8 over 1387) touch disjoint
  // regions; the ceiling is the MEASURED post-merge size, not either side's number.
  // +2 (#1419, third pass): the twin declares the arrow field every frame — OUTSIDE the `if`,
  // because a frame with no field is exactly the one that must say so (an evicted region's
  // textures are destroyed, and a binding still holding them dies in the next submit).
  // 1435 (merge): measured again after the #1445 +2 landed on main's side.
  // 1435→1425 (#1046 Inc-3b): the field collapse deleted the native trio's
  // population + the rawFrameShell escape arms — the loop SHRANK through a
  // feature increment, which is the ratchet working as designed.
  // 1425→1392 (#1046 F4 Inc-D): the native→RHI view memo (_rhiViewMemo/
  // _rhiViewFor/_rhiViewForBound) + the screen-view unwrap retired with the
  // RenderTargets RhiTexture retype.
  // 1392→957 (#1046 Inc-F3a): the forced-WebGL2 twin frame (renderFrameViaRhi,
  // its dispatch fork, and the DPR fork) deleted outright.
  // 957→958 (#1046 F3b, doc sweep): two comments still described the deleted
  // forced-WebGL2 twin in the present tense (a review-round finding); one
  // reword net +1 line, the other net 0.
  // 1425→1405 (#1575, parallel on main): the keepLoopWarm extraction — the
  // disjunction itself left this file with the helper.
  // Merge union (#1046 F3b <- main): the twin deletion and the keepLoopWarm
  // extraction touch disjoint regions of the SAME pre-merge file; the ceiling
  // is the MEASURED post-merge size, not either side's number (this file's
  // own precedent, see the F3b/#1419 merge note above).
  // 943→945 (#1594): `isOverdrawActive(this.host.ctx.rhi.caps)` in place of the
  // bare `DEBUG_OVERDRAW` read pushed the ternary past printWidth 100 (measured
  // 112 chars pre-wrap); prettier wraps it onto 3 lines, +2.
  // Merge union (#1046 F3b <- main #1587): main's row reads 1400 because main still
  // carries the twin this branch deleted; the prefetch fix's own -/+ lands inside that
  // body here and dies with it, leaving only the chain-side pumpFramePrefetch call.
  // Ceiling re-measured on the MERGED file below: 945→937, a real shrink — the four
  // twin-only imports went with the body, and #1587's pumpFramePrefetch extraction
  // took the inline prefetch block out of the chain path too.
  // 937→957 (#1599): the per-frame GPU-fault drain is WIRED here — one import, the
  // GpuFaultDrain field, and the call after the GL-error drain. The drain itself lives in
  // render-loop-gpu-fault.ts (a new ~94-LOC file) precisely so this god-file does not
  // absorb it; the wiring plus the prose naming why an async validation fault cannot
  // reach the 3-strike halt is +11 of it. The rest is the #1599 fix-up (review finding 1)
  // + the #1046 seam: the validation sink is built HERE as the single bound
  // `_queueValidation` field — this file is the one that already holds the baselined
  // backend-adapter import (render-loop-helpers.ts must not take one), and
  // gl-error-sink-seam.test.ts pins `pushValidationError(this.host.ctx, ` to exactly
  // one call site, which that field is.
  // 937→935 (#1355, adopted onto main @ e54a892): the byte-telemetry gather is a call to
  // render-stats-bytes.ts, paid for by dropping the `totalTilesVis`/`totalTilesCached` locals
  // — `tilesVisible`/`tilesCached` now accumulate straight into `_stats` like
  // `drawCalls`/`vertices`/`triangles`/`lines` five lines above already did. `beginFrame()`
  // zeroes both, so the round trip through locals bought nothing but the two assignments that
  // put them back. On the PR's own base that read −2 off 1397; main's twin deletion means the
  // number is re-MEASURED here, never carried.
  // MERGE UNION (#1756 <- main): main's +20 (#1599 GPU-fault drain wiring, above) and
  // the adoption's -2 (#1355 locals dropped) compose. MEASURED post-merge, post-prettier.
  // 955→934 (#1506): the open-coded projection resolution (the promotion, its
  // three camera field writes and their rationale) moved to Camera.setProjection,
  // where the fields live; this file keeps one call reading the resolved kind.
  // Two now-orphaned @xgis/geo imports (isGlobeProj, promotesToGlobeWhenTilted)
  // went with it. Measured, not arithmetic.
  // 934->935 (#2162): the end-of-frame `_missingTileCount` comment asserted the sum
  // "settles to 0 exactly when that gate stops re-arming" -- it is three of the gate's
  // six terms (retries, pending VT uploads and `_czPendingAdvance` absent). One line,
  // comment-only. MEASURED post-prettier.
  // →933 (#2149 increment 6): keepLoopWarm's vtRenderers input died — the VT signals ride
  // the registry scope, so the call site passes one input fewer. MEASURED post-prettier.
  // 933->932 (#2162 option B): the hand-maintained three-term `_missingTileCount` re-sum
  // becomes one registry read (`count(SCOPE_TILE_COUNT)`). A LOWERING.
  // 932→924 (#2315): the inline RTC-centre-latitude clamp (and its S5/S10 roadmap
  // comment, now landed) became one call to render-loop-helpers' frameCenterLatDeg;
  // the orphaned `poleLimit` import went with it. A LOWERING. MEASURED post-prettier.
  // 924->932 (2026-09-05, third main merge): render-loop.ts is main's file verbatim after
  // #2507 superseded this branch's #2315 there, and main's own ceiling for it is 932 —
  // the merge had kept this branch's 924 because both sides raised the key inside one
  // conflict hunk. Measured 932 with `wc -l` on the merged tree (identical to main).
  'map/src/render-loop.ts': 932,
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
  // (backoff curve + attempt cap) went to tile-retry.ts rather than in
  // here, so it is unit-testable without a GPU and this file stays near its mark.
  // 828→836 (cold-start load budget): the leaf loop broke only at the FULL concurrency
  // budget, so on the first frame it took all 6 slots and the parent-fallback prefetch
  // right below it got none — nothing was drawable until a full-resolution DEM tile
  // landed, and terrarium PNGs measure ~131-143 KB against ~19-28 KB for a satellite
  // JPEG over the same ground. +8 = the 3-line rationale, the one `leafBudget` binding,
  // and the 4 lines prettier adds re-wrapping the now-101-char retry import. The POLICY
  // is again in tile-retry.ts (leafLoadBudget), same split as the backoff.
  // 836→834 (merge union, #1413 <- main): the byte-budget cache landed here too, and its
  // `_cacheTile` helper REPLACED two inline four-line `tileCache.set` blocks (the leaf and
  // parent load paths), so the union is two lines SHORTER than this branch alone. Measured,
  // not guessed — shrink-only means taking the shrink.
  // 834→839 (off-thread emit): +5 — the `shaderEmitPending` import and the four-line
  // reason it now rides `hasFadingTiles`. A draper whose shader is still being emitted
  // draws NOTHING, so a loop idling on tile-count alone would leave the relief blank with
  // its tiles already cached — the same freeze class as a stranded fade ramp, which is why
  // it joins that signal rather than getting its own. The seam itself is in shaders/emit/.
  // 839→847 (source maxzoom, the 404 class): a dataset has a deepest REAL level and asking
  // past it is a guaranteed 404, not a slow tile — terrarium stops at z15 while
  // rasterCoverZoom adds +1 on a 256-px source, so every visible tile failed from about
  // camera z14.5 (verified: terrarium/16/13651/25075 404, its z15 parent 200). +8: the HillshadeParams field, the arm-site plumbing, and their rationale.
  // 847→846 (#1575): the failed-tile Map + its four call sites became one owned
  // FailedTileLedger in tile-retry.ts — the policy had drifted into three separate
  // copies across the repo and only the vector one was bounded.
  // 846→844 (#1623): the WebGPU raw-device `loadImageTexture` fork in loadTileTexture
  // deleted (both backends now load through the RHI) — the `if` wrapper and the
  // `device: GPUDevice` field/assignment it was the only reader of are gone.
  // 844→850 (#1623 gate round): +6 comment lines on the DEM texture's explicit
  // 'render' usage — WebGPU's copyExternalImageToTexture demands RENDER_ATTACHMENT
  // and the un-mipped DEM never gets raster's mip-chain auto-widen; the chain gate
  // went red without it, and the why must live at the descriptor it constrains.
  // 850->853 (#2286): raster twin of the same draper gap.
  // 853→747 (#2268 / D5 INC-0, main merge): DEM residency — the tile cache +
  // byte accounting, both ledgers, the URL template/scheme and the whole fetch path —
  // moved to dem-tile-store.ts. The file sat at EXACTLY its ceiling, so nothing could
  // be added to it at all; that is why the extraction is a precondition for the terrain
  // track rather than tidying. #2286's three destroy() lines are KEPT (the draper is
  // this renderer's, not the store's), so this is not a same-file double delta: the
  // number below is RE-MEASURED post-prettier (`wc -l`) on the merged tree, never
  // carried across or computed from either side's.
  // 747→754 (#2302, main merge): the flat-branch selector derivation LEFT this file
  // for flat-tile-selector.ts (cull space == draw space — the inert 'non-mercator'
  // shim culled equirect/natural_earth tiles in Mercator space while vs_tile drew
  // them through the display projection: a blank poleward band). The +7 is
  // call-site width only: the 4-line shim became an 8-argument call prettier
  // breaks over 10 lines, plus one import and one comment. Same key raised on both
  // sides (853→747 above on main, 850→857 on this branch), so the merged file
  // carries both deltas and neither side's number is right (§12) — RE-MEASURED
  // post-prettier (`wc -l`) on the merged tree.
  // 754→753 (#2507 merge): the `@xgis/geo` import line emptied on both sides. RE-MEASURED.
  // 753→758 (#2314, main <- issue-hunt branch, fourth merge): the draw took the bare
  // `isPickEnabled()` and selected a 2-target (rg32uint) pipeline for a pass that opens
  // ONE colour attachment — a per-frame WebGPU validation error whenever picking and a
  // DEM layer are both on. The call site is now a literal `false`; the +5 is the comment
  // recording why, at the argument it constrains, so the flag cannot drift back. This
  // branch's own #2302 fix (`selectFlatProjTiles` in raster-renderer.ts) was SUPERSEDED
  // by main's flat-tile-selector.ts on this merge and removed as its orphan, so #2314 is
  // the only delta this branch still carries here. RE-MEASURED post-prettier (`wc -l`)
  // on the merged tree.
  'map/src/render/hillshade-renderer.ts': 758,
  // Merge union (#1060 <- main): stacked growth — measured 1174.
  // 1174→1167 (#1581, main merge): leg B extracted the tile-point pack-key/uniform-
  // refresh/draw tail into tile-point-pack-key.ts + tile-point-draw.ts (this file keeps
  // only canSkipTilePointRepack + the two callers) — a genuine shrink, not this branch's
  // doing (its own delta on this file was a same-length comment reword, 0 net lines).
  // 1167→1197 (#1605 Phase 2 PR B): the variant-keyed _pointDrapers Map replacing the
  // single _pointDraper field, ensurePointDraper's WebGL2-forced-base-variant + cache-key
  // logic, the two call-site updates, and addLayer's trailing shaderVariant param —
  // mirrors LineRenderer's own Map<string, LineDraper> cache (#1605 Phase 1 Step 3).
  // Merge union (#1616 <- main): the two sides edited disjoint regions, so they SUM —
  // 1197 + 1 = 1198, measured on the merged file, not picked from either side.
  // 1167→1168 (#1616): `pointWorldCopies` now returns the shared `SINGLE_COPY` off
  // Mercator instead of a fresh `[0]`. +1 is the import; the allocation it removes is
  // per point-show per frame on the #1581 cache-HIT path, whose whole purpose is to
  // allocate nothing — this commit is what made that path call it every frame.
  // 1198→1209 (#1605 Phase 3 PR C): ensurePointDraper drops its WebGL2 null-force (the
  // composer now runs on both backends) and `_tilePointDrawDeps` takes the show's variant
  // instead of hardcoding null — the VT/tile-point path is what an inline-GeoJSON point
  // source actually renders through, so without it a point stage block reached no pixels
  // at all (browser-probed). Most of the delta is the two rationale comments.
  // 1209→1208 (#1666): the two `fillHex`/`strokeHex` temporaries existed only to feed a
  // `hex ? parse(hex) : null` ternary the null-returning `hexToRgba` makes redundant.
  // 1208→1213 (#1635): `writePointFrameUniform` packs the new `zoom` lane (point's Uniforms
  // had none, so a composed `u.zoom` addressed a field that did not exist). One packed field
  // + its rationale; the lane's full doc lives on the struct in shaders/dsl/point.ts, and the
  // write is single-authority here by construction (`write()` has no optional fields).
  // MERGE UNION (#1632 <- main): main's +5 (#1635 zoom lane, above) and this branch's −2
  // (the tile-point pack scalar cache + retire queue moved out to tile-point-cache.ts,
  // keyed per show) are non-overlapping and compose. Value is the MEASURED post-merge,
  // post-prettier count.
  // 1211→1247 (#2118): `circle-pitch-alignment: map`. The pitch MODE CODE replaces the
  // pitch-scale flag in circle_params.w (the two knobs stop being independent once the
  // disc leaves the screen plane, so a bit field would let both fire and count the
  // perspective twice), the `mvp_pitch0` lane is packed from a module-level
  // `Pitch0Unprojector` — the SAME producer label-pass hands `groundBasisAt`, so the two
  // ground-aligned features cannot drift onto different ideas of the unpitched camera —
  // and `addLayer` grows one TRAILING optional. Most of the +36 is the rationale for the
  // `camera.pitch > 0` suppression, which is what makes the unpitched frame provably
  // byte-identical rather than arithmetically equal. MEASURED post-prettier (`wc -l`), set
  // EXACTLY to the count — headroom is re-justified per phase, never banked.
  'map/src/render/point-renderer.ts': 1247,
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
  // 1000→986 (#1046 F3b Inc-2c): heatmap forwarders retired — win banked.
  // +12 (#1046 F3b Inc-2d): renderToPass/renderGraticuleOverlay narrowed to
  // RhiRenderPass with a one-line native unwrap each (legacy plumbing), plus
  // the drawOitCompose forwarder. Retires with the legacy-layer cluster.
  // 998→999 (#1046 F3b): doc-only — the 3 comments referencing the twin/`renderFrameViaRhi`
  // as present-tense reasoning are now false (the twin is deleted); reworded to describe
  // the surviving RHI-native arm directly. One comment gained a line in the rewording.
  // 999→1003 (#1539, parallel on main, merge union): the `input` runtime's
  // MapRendererContent integration — an `inputs: InputStore | null` field + its doc
  // comment, and `...inputPoolValues(this.inputs)` spread into the polygon uniform
  // write — auto-merged cleanly (disjoint from this branch's F3b edits); two adjacent
  // comments' prettier-reflow saved a couple lines back. Measured post-hook.
  // 1003→1009 (#2042 INC-1): the four all-zero anchor rows (+ flag-0 note) the
  // full-struct write() completeness net requires. MEASURED post-prettier.
  // 1009→1011 (#2042 INC-6): the two Mercator-anchor zero rows, same net.
  // 1011->1023 (#2286): MapRendererContent.destroy() -- the missing middle of the ownership
  // chain; forwards to the engine half.
  // 1023->1025 (#2325): MapRendererContent.destroy() now also releases the
  // GraticuleRenderer its own comment had flagged as a known gap -- one call plus
  // the comment line that replaces the gap note.
  'map/src/render/renderer.ts': 1025,
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
  // 1469→1512 (#1436): mip + anisotropy. The RHI had no vocabulary for either, so every
  // minified texture aliased; this backend is where the widening is hardest, because GL folds
  // two filter decisions into one enum and anisotropy is an EXTENSION that must degrade rather
  // than throw. PAID FOR FIRST by extracting `minFilterEnum` + `resolveAnisotropy` to
  // webgl2-texture-sampling.ts (−24, pure functions, no `this`, now testable without a device);
  // the residual +43 is the chain allocation in createTexture, the aniso clamp in createSampler,
  // and `generateMipmaps` — all of which need the device and cannot leave it. Measured post-hook.
  // 1512→1520 (#1436 round 2): the mip-COMPLETENESS fix. GL's default TEXTURE_MAX_LEVEL is
  // 1000, so a single-level texture sampled by a mipmap min-filter is incomplete and samples as
  // opaque BLACK — making the shared raster sampler trilinear blacked out the checker it also
  // serves (2409 of 619200 pixels survived). +8 is one line of code and seven of incident: the
  // texture that broke is the one nobody touched, which is the part a future reader needs.
  // 1520→1523 (RhiCaps.shaderLanguage): +3 — the new cap value plus the two-line note
  // that it is the advertised form of this file's own dual-source throw (createPipeline
  // requires vsCode/fsCode and never reads `code`). Pure declaration; no logic added.
  // 1523→1497 (#1046 F3b, measured post-hook): already 25 lines stale going in — the
  // ceiling was never lowered for shrinkage this file banked earlier. This session's
  // own doc-only edits (twin references retired to past tense, `?rhichain=1`/Inc-F4
  // present-tense framing corrected now the flip is done and the twin is deleted)
  // account for the rest.
  // 1497→1447 (#1703, measured post-hook): the storage-buffer emulation's create/write
  // pair, its GL format table and its typed-view rule moved to
  // rhi-webgl2/src/storage-data-texture.ts. The element axis (R32F/R32UI/R32I) would
  // have pushed this file over its ceiling; the ratchet's own instruction — extract,
  // don't grow — was the right call, since the data texture is one concern and the
  // device file only allocates, binds and deletes it.
  // 1447→1497 (#1796): the vertex-attrib enable/disable discipline fix — a
  // Gl2AttribState bitmask (context-wide, owned by WebGl2Device, threaded through every
  // WebGl2RenderPass constructor call) plus bindAttributes()'s reconcile-against-the-
  // live-mask rewrite, so a pipeline with fewer (or zero, the line pipeline) vertex
  // attributes than its predecessor no longer leaves stale enabled locations with no
  // bound buffer at draw time.
  // 1497→1521 (#1796 follow-up): a fresh mask=0 does not mean the ADOPTED gl context
  // has no attributes really enabled — gpu.ts hands a remount the SAME pooled context
  // a prior (destroyed) device left dirty (device-lifecycle.ts). The constructor now
  // does a ONE-TIME reconcile: disable every real location up to MAX_VERTEX_ATTRIBS
  // (feature-detected; fixtures that don't stub getParameter/disableVertexAttribArray
  // fall back to 16 and no-op).
  // 1521→1522 (#1190): the `renderBundles: false` caps line — the WebGL2 half of
  // the new render-bundle capability the VT bundle gate keys on.
  // 1522->1546 (#2369 F-7): createPipeline's compile+link block abandoned every
  // object it had created on three failing exits — a fragment-compile throw left
  // the vertex shader, a null createProgram left both, a link failure left both
  // plus the program — and WebGLShader/WebGLProgram are not GC-reclaimed on a
  // live context. The three inline cleanups collapse into ONE `linkProgram`
  // authority (createPipeline's own body shrinks to three lines); the growth is
  // the helper. Failure-path cleanup paying an ownership debt, not feature growth.
  // 1546->1564 (#2349): a fail-loud guard for a per-target `writeMask` ES 3.00 cannot
  // honour — `gl.colorMask` is one global, and the request was being dropped silently.
  // 1564->1565 (#2474): the `outOfFramePasses: false` caps line — the WebGL2 half of
  // the capability the globe drape's bake gate keys on. Exactly the shape of the
  // 1521->1522 `renderBundles` entry above.
  'rhi-webgl2/src/rhi-webgl2.ts': 1565,
  // 941→975 (#1371 atomic re-seed): `releaseSupersededTile` + `dropTile`, and the split of
  // `_releaseTileSlots` into a resource-release body the two share with eviction. Arena/pool
  // ownership is this class's whole reason to exist.
  // 975→946 (#1357): the pooled-buffer recycler moved out to gpu-buffer-pool.ts
  // (bucketing + entry cap + the new byte cap), which also orphaned the raw
  // `device` field — its only reader was the pool's createBuffer.
  // 946→1000 (#1515 compaction budget): the ratchet's own instruction was followed —
  // the POLICY (futility gate + per-pass relocation budget + its rationale
  // arithmetic) is a new file, render/arena-compaction-budget.ts, not new logic
  // here. What stays is the seam that cannot move: reading the two arenas'
  // live/high-water pair, flipping the charge cursor, re-arming a deferred grow
  // target vs a same-size compaction (distinct fields, this class's state), and
  // gating the two relocation arrays. The rest is the WHY — the every-frame
  // relocation loop this removes is provable from `compact()` leaving
  // bumpPtr === liveBytes, and that argument has to sit next to the code it
  // justifies. Lower this when the compaction/grow pair is extracted whole.
  // 1000→996 (#2405): two hand-rolled retired-buffer arrays — each with its own
  // push sites and its own drain loop stating one rule — became one shared
  // RetireQueue. A consolidation that pays for its own comments, so the number
  // comes DOWN rather than being held; RE-MEASURED post-prettier.
  // 1000→1004 (#2301, hunt 2026-09-02): `_releaseTileResources` carries the release
  // REASON (`keyRebound`) through to the hook — a parameter on the two release entry
  // points plus the note on `ReleaseTileHook` saying what a rebound key means.
  // Measured with `wc -l` on the post-prettier tree.
  // MERGE RE-MEASURE (2026-09-05, main <- issue-hunt branch, second merge): both sides
  // raised this key from a common base, so the merged file carries BOTH deltas and
  // neither side's number is right (§12). Measured 1000 with `wc -l` on the
  // post-prettier merged tree.
  'map/src/render/gpu-tile-store.ts': 1000,
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
  // 1011→1018 (#1791): +7 for re-clamping the azimuthal disc-detail boost's
  // selMaxZ to sourceMaxLevel — the boost was bypassing the general cz clamp.
  // 1018→1036 (#1792): the z=0 root split now requires `maxLevel >= 1` — on a
  // z=0-only archive it swapped the source's ONLY tile for four unresolvable
  // children, so the synthetic earth-surface show drew nothing off mercator/globe.
  // 1036→1059 (#1785): #1581 stopped clearing `_frameTileCacheLru` every frame, but
  // the `globeTilesSelected` diagnostic on `FrameDrawStats` is still reset every
  // frame and was only ever re-set on a fresh compute (the cache-MISS branch) — so
  // a static camera serving every frame from cache after the first left it reading
  // 0 forever despite a correct sphere selection and a correct draw. +23 = a new
  // `globeTilesSelected: number | null` field on `FrameTileCache` (stashed at
  // compute time) + re-setting the diagnostic from it on a cache HIT too.
  // 1059→1066 (#2091): the readiness gate pinned `_czPendingAdvance` on a
  // target the source could never reach (cz is clamped to `source.maxLevel`
  // right after the gate, so `cz === target` was unsatisfiable for any source
  // whose data stops below floor(z)) — `keepLoopWarm` reads that flag, so the
  // loop re-rendered every frame and the map NEVER fired `idle`. +7 = the
  // one-line reachability clamp on `target` plus the lesson comment that keeps
  // it from being "simplified" back out. (An adversarial review pass caught a
  // second edit as dead code — the `wantAdvance` false case was ALREADY
  // cleared by the pre-existing `} else {` on the same block — and it was
  // removed; the fix is the clamp alone, re-proven fail-before.)
  // 1066→1074 (#2093 follow-up, measured post-prettier per §12): `Selection.targetZ`, the
  // camera's own `min(floor(zoom), maxLevel)`, so the renderer can tell a readiness HOLD
  // (currentZ trailing the camera) from the LOD the camera asks for.
  // 1074->1073 (#2500): the open-coded sphere-family centre-lat branch became one
  // frameCenterLatOf call (the frame token's authority). A LOWERING.
  'map/src/render/tile-selection-cache.ts': 1073,
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
  // 990→992 (#1436): the tile texture asks for a chain and fills it after the upload. Two lines
  // plus the sentence saying why a basemap tile is the minified-appearance texture par
  // excellence. Measured post-hook.
  // 992→1012 (#1476, from main): the failed-tile backoff wiring the raster arm never got —
  // the `failedTiles` map, the clear on a URL-template change, one requestability guard in
  // each of the two request loops (leaf + parent-fallback), and noteFailure/delete on both
  // load chains. The POLICY is not here: it stays in tile-retry.ts, shared with the
  // hillshade arm, which is why this is +20 and not +80.
  // merge union — +19 (source maxzoom, the 404 class): a dataset has a deepest REAL level
  // and asking past it is a guaranteed 404, not a slow tile. Terrarium stops at z15 while
  // rasterCoverZoom adds +1 on a 256-px source, so every visible tile failed from about
  // camera z14.5 (verified: terrarium/16/13651/25075 404, its z15 parent 200). The
  // setSourceMaxzoom setter, the field, and the rationale on rasterCoverZoom itself. The
  // two are disjoint — #1476 bounds a storm the selector could not avoid, this stops the
  // selector creating one — so the ceilings SUM. Measured post-hook at 1032 rather than the
  // 992+20+19=1031 the arithmetic predicts; the ceiling is the MEASURED count, never the sum.
  // 1032→1031 (#1595/#1578, parallel on main, picked up while re-measuring for the #1046
  // F3b merge): tile-retry's scattered `tileRequestable`/`noteFailure` functions collapsed
  // into a `FailedTileLedger` class, and `rebuildForQuality` now destroys the draper instead
  // of dropping the reference — a clean net shrink this branch didn't cause but is
  // measuring honestly rather than leaving 1 line of stale headroom.
  // 1031→1029 (#1579, parallel on main, picked up in the #1594 merge): the WebGPU-only
  // `loadImageTexture` raw-device fork removed — both backends now load through the RHI
  // (`rhi.createTexture`/`copyExternalImage`/`generateMipmaps`), which also deletes the
  // `device: GPUDevice` field the fork was the only reader of.
  // 1029→1034 (#2137): the CPU trig table wiring. `vs_tile` used to build the
  // ~6.4e6 m ECEF from angles on the GPU, where every transcendental multiplies
  // the Earth radius (1.17e+3 m of ground displacement measured on SwiftShader);
  // the table hands it CPU-f64 sin/cos/N so it only multiplies. The 53-line
  // generator itself was EXTRACTED to raster-grid-trig.ts rather than grown here
  // — this ratchet's own instruction — so the +5 is the irreducible wiring: one
  // import, one call, and the two new struct fields the packer must write.
  // 1034->1037 (#2286): destroy() releases the draper whose only destroy lived in
  // rebuildForQuality(), so a quality toggle reached it and map teardown did not.
  // 1037->1056 (#2384 F-4): setUrlTemplate cleared failedTiles but not tileCache, and the
  // key is z/x/y with no url — so the old source's tiles answered for the new one, and
  // visible tiles are eviction-exempt so it never self-healed. The growth is the drop +
  // abort on a real URL change.
  // 1056→1061 (#2302, main merge): the flat-branch selector derivation LEFT this
  // file for flat-tile-selector.ts (the inert 'non-mercator' shim culled equirect /
  // natural_earth tiles in Mercator space while vs_tile drew them through the
  // display projection — a blank poleward band, ~166 px per edge at 60°N). Call-site
  // width only: a 6-line shim block became an 8-argument call prettier breaks over
  // 10 lines, plus one import; the misleading two-line shim comment went with the
  // shim. Same key raised on both sides (1034→1056 above on main, 1034→1038 on this
  // branch), so the merged file carries both deltas and neither side's number is
  // right (§12) — RE-MEASURED post-prettier (`wc -l`) on the merged tree.
  // 1061→1060 (#2507 merge): the `@xgis/geo` import line emptied on both sides. RE-MEASURED.
  // FOURTH merge (2026-09-05, main <- issue-hunt branch): this branch's own #2302 fix
  // (`selectFlatProjTiles`, +52 here, shared with HillshadeRenderer) was SUPERSEDED by
  // main's flat-tile-selector.ts and removed together with its `@xgis/map` re-export and
  // its parity test (main's `raster-non-merc-selection-parity.test.ts` carries the
  // stronger FIX/TEETH/CONTROL witness). The file is main's byte-for-byte again;
  // RE-MEASURED post-prettier (`wc -l`) on the merged tree.
  'map/src/render/raster-renderer.ts': 1060,
  // 889→906 (#1155 F3): cold-start burst enqueue cap — the `_coldStartBurst`
  // field + `setColdStartBurst` + the burst-selected 8/4 cap in enqueue().
  // 906→910 (#1155 F3 adjudication): the burst 8/4 pair now comes from the
  // shared `burstUploadBudget` authority (import + call + note) so the enqueue
  // cap and uploadBudgetFor's maxJobs can't drift out of lockstep.
  // 910→921 (#1402): the `replace` opt-out of `_dispatch`'s "already uploaded" short-circuit,
  // threaded through `uploadSync`. +11 is the two signatures, the amended guard, and the note
  // recording WHY the guard was a silent no-op for the one caller that meant to overwrite.
  // 921→923 (#2089): the tileOriginMerc argument at the two buildLineSegments
  // call sites (the ECEF endpoint-lane pack anchor).
  // #2247 raised 923 -> 951: the mid-render sync-upload cap. The cap CONSTANT and
  // its rationale were extracted to vector-tile-renderer-helpers (next to
  // burstUploadBudget, so the two per-frame upload budgets have one authority —
  // their living apart is what let them drift 234x), and the held-backlog push was
  // deduplicated into one `_hold`. What remains here is the feature itself, which
  // cannot leave the class without moving its private state.
  'map/src/render/upload-coordinator.ts': 951,
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
  // NEW ENTRY (#2118). point.ts was unlisted at 766 because it sat under NEW_FILE_CAP;
  // `circle-pitch-alignment: map` takes it to 921 and it needs a ceiling of its own. The
  // +155 is one feature and is mostly PROSE: the ground-basis block is ~45 lines of
  // arithmetic and ~40 lines of header explaining that it is the WGSL image of
  // map/src/text/ground-basis.ts — which authority it transcribes, why it is transcribed
  // instead of called (that module is CPU code over projector callbacks; a per-point CPU
  // basis would repack feat_data every frame), why both Jacobians are EXACT here rather
  // than finite differences, which px convention it works in, and why the globe stays
  // deferred. Not extract-worthy: it is one branch of one vertex entry point, reads four
  // uniform fields and the local `relPos`, and lifting it out would put the basis in a
  // different file from the quad expansion it exists to transform — but the basis math
  // itself IS extracted, into a named `ground_basis_2x2` fn, because inlining it pushed
  // `vs_point` past shader-static-analysis's 60-statement lint ceiling (80 measured). The
  // extraction moved ~33 statements out of the entry point and cost this file a few lines
  // of function scaffolding. MEASURED post-prettier
  // (`wc -l`), set EXACTLY to the count — headroom is re-justified per phase, never banked.
  'map/src/shaders/dsl/point.ts': 950,
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
  // 1587→1601 (#1947): buildPropertyTable takes the FeatureIdResolver and parks
  // each row at the feature's fid (the number decomposeFeatures stamps on the
  // geometry) instead of its array position, so data-driven paint stops reading
  // another feature's row. +14 = signature + index loop + the contract comment;
  // irreducible, the table and the resolver must be decided in one place.
  // 1601→1603 (#2089): CompiledTile.tileOriginMerc on both compile returns.
  // 1603->1616 (#2435, measured post-prettier): threading `tileZ` to the subdivision
  // so its angular gate can be per-tile-level. Ten of the thirteen lines are prettier
  // re-wrapping ONE call site — `tilePolygonPart(...)` crossed the print width at its
  // ninth argument and became eleven lines. The other three are the parameter and its
  // one-line doc. Not extract-able: a threaded parameter has nothing to extract to,
  // and the alternative (deriving z from `precisionMM` at the leaf) would hide the
  // dependency the gate now genuinely has.
  'compiler/src/tiler/vector-tiler.ts': 1616,
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
  // 1463→1473 (source maxzoom, the 404 class): a dataset has a deepest REAL level and asking
  // past it is a guaranteed 404, not a slow tile — terrarium stops at z15 while
  // rasterCoverZoom adds +1 on a 256-px source, so every visible tile failed from about
  // camera z14.5 (verified: terrarium/16/13651/25075 404, its z15 parent 200). +10: two source-property arms, their locals, and the pass-through.
  // 1473→1444 (#1550): the `symbol` block's own lowering — which elements make geometry, which
  // anchors exist, what an empty block means — moved to `ir/symbol-elements.ts` beside the
  // functions that implement it. The ratchet asked for this in as many words ("extract, don't
  // grow, then lower the ceiling") when the block grew here first; it was right.
  // 1444→1448: a CROSS-PR sum, not growth in one change. #1552 (user `fn` inlining) threaded
  // `inlineUserFns` through `lower()` (+4) concurrently with #1550's extraction (−29); each fit
  // its own base, and the union is 1448 — measured, per the merge playbook (stacked
  // non-overlapping edits SUM; never pick a side).
  // 1448→1452 (#1257): the raster-fade-duration accumulator field threaded through the
  // 4 existing raster-* sites (declare / acc-build / acc-extract / RenderNode-build).
  // 1452→1467 (#1069 smallest-honest-slice): the modifier-dispatch driver checks
  // dispatch()'s verdict and pushes X-GIS0028 when no MODIFIER_HANDLERS entry
  // consumed the item (previously a silent drop) — the gate must sit where the
  // dispatch verdict is known, same rationale as the X-GIS0013 gate a few lines up.
  // 1467→1514 (#1304): a `refresh: <seconds>` reserved source prop — a `refresh`
  // local, the `lowerSource` validation arm (NumberLiteral with unit null/'s'
  // only; non-negative; 0 collapses to undefined/"off"; unwraps a UnaryExpr `-`
  // over a NumberLiteral, mirroring `astLiteralToJS`'s own unwrap a few lines up,
  // so `refresh: -5` reports "non-negative" instead of a misleading "not a
  // number"), and the return-object field. Mirrors the existing `maxzoom`/
  // `minzoom` numeric-prop shape.
  // 1514→1519 (#2117 line-gradient): the `strokeGradientStops` local + its one-line why,
  // its acc read, the acc-literal key and the `gradientStops:` field on the emitted
  // StrokeValue — the four-site shape every stroke paint axis already has here, no new
  // branch. Headroom is re-justified per phase, never banked. MEASURED post-prettier.
  // 1514→1522 (#2118): `circlePitchAlignmentMap` through lower's three seams (the `let`
  // + its doc, the acc read, the two RenderNode spreads). The doc line earns its keep —
  // it is where the OPPOSITE spec defaults of the two circle pitch knobs are recorded, and
  // that asymmetry is the part a re-derivation gets wrong. MEASURED post-prettier (`wc -l`),
  // set EXACTLY to the count — headroom is re-justified per phase, never banked.
  // MERGE: main and this branch each raised this ceiling from a shared base;
  // neither side's number is right. MEASURED post-merge (`wc -l`): 1527.
  // 1527→1552 (#2544): the `fill:` / `stroke:` arms stop dropping an
  // unresolvable colour in silence — each gains an `else` and the two share
  // `warnUnresolvedColor` (X-GIS0029), and `applyStyleProperties` takes the
  // `diagnostics` sink. Same shape and same rationale as the X-GIS0028 raise
  // above: the gate must sit where the resolve verdict is known, and that is
  // this switch. MEASURED post-prettier (`wc -l`), set EXACTLY to the count.
  'compiler/src/ir/lower.ts': 1552,
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
  // 1357→1378 (#2166 icon-translate): the per-axis vec2 split on the
  // non-constant icon-translate arm — the isZoomInterpCandidate pre-gate, the
  // two vec2AxisZoomInterp lifts, the array-literal re-pair, and the comment
  // recording WHY this path re-pairs inside one binding while fill-/line-
  // translate emit an x/y utility pair. That asymmetry is the part a
  // re-derivation gets wrong, so it is written down rather than inferred.
  // MEASURED post-prettier (`wc -l`), set EXACTLY to the count — headroom is
  // re-justified per phase, never banked. RE-MEASURE after any merge with a
  // branch that also raised this key.
  // 1357→1365 (#2166 symbol-sort-key): the warn-and-drop else for the expression
  // form becomes an exprToXgis emit + a precise unconvertible-form warning, and the
  // block's comment now records WHY the constant arm stays first (fmtSigned already
  // spells a negative constant in the bracket form, so the two shapes share a
  // syntax). MEASURED post-prettier (`wc -l`), set EXACTLY to the count.
  // MERGE (#2166 icon-translate x #2166 symbol-sort-key): both branches raised this
  // key from 1357 — to 1378 and to 1365 — and the merged file takes BOTH deltas, so
  // neither number is correct here. RE-MEASURED post-merge with `wc -l`: 1386.
  // 1386→1384: the two symbol anchor guards collapsed onto the shared decision,
  // so this file SHRANK. The ratchet is shrink-only, so the ceiling follows it
  // down rather than banking the slack.
  // 1384->1396 (#2440): `text-optional: true` stops warning and emits the
  // `label-text-optional` utility; the non-constant form keeps a warning of its
  // own. MEASURED post-prettier.
  // 1396->1424 (#2331): four warn-and-drop else arms (icon-rotate, text-offset,
  // text-translate, symbol-placement) where a non-constant form used to vanish
  // with no diagnostic; each records WHY its form reaches the arm. MEASURED
  // post-prettier (`git show HEAD:<file> | wc -l`).
  // 1424->1434 (#2224): `viewport-glyph` joins the text-rotation-alignment enum
  // arm — the four-way condition prettier wraps to one value per line, plus the
  // five-line why (rejecting a spec-valid value emitted NO utility, so the layer
  // silently took the runtime's placement default). MEASURED post-prettier.
  // 1384→1400 (#2318): a constant text-opacity paired with a zoom-interpolated
  // text-color folded no alpha (label rendered opaque at every zoom), and the
  // data-driven text-color branch had no way to carry a constant text-opacity
  // at all. Both branches now fold/carry the alpha; +16 is the two fix sites
  // plus their why-comments (post-prettier, `wc -l`).
  // 1400→1428 (#2320): a non-constant text-max-width (zoom-interpolate or
  // legacy stops) fell through to the placement-gated spec-default arm and
  // silently emitted label-max-width-10, discarding the authored value with
  // zero warnings. The value is now folded through interpolateZoomCall ahead
  // of the emit chain, like the sibling text-padding / text-letter-spacing
  // arms, and a shape the fold does not recognise keeps the single default-10
  // arm plus a warning naming the property. +37 is that fold, the warning, the
  // review fold-in that gives a NEGATIVE folded stop the same diagnostic the
  // constant arm already had, and their why-comments (post-prettier, `wc -l`).
  // MERGE RE-MEASURE (2026-09-05, main <- issue-hunt branch, second merge): both sides
  // raised this key from a common base, so the merged file carries BOTH deltas and
  // neither side's number is right (§12). Measured 1449 with `wc -l` on the
  // post-prettier merged tree.
  // FIFTH merge (2026-09-05, main <- issue-hunt branch): this branch's own #2331 fix (the same
  // four warn-and-drop arms, +35 here) was SUPERSEDED by main's 2dd796b above and dropped;
  // its witness (layers-symbol-nonconstant-drop-warns.test.ts) passes against main's arms and
  // stays as distinct coverage. #2318 (+16) and #2320 (+37) from this branch stack on main's
  // 1424, so neither side's number is right (§12). RE-MEASURED post-prettier (`wc -l`) on the
  // merged tree.
  // MERGE RE-MEASURE (ninth main merge): both sides raised this key; 1487 is `wc -l`
  // on the post-prettier merged tree (§12 — never carry either side's number across).
  'compiler/src/convert/layers-symbol.ts': 1487,
  // 1187→1190 (#1664 review fold-in): label/icon colour joins fill and stroke as a
  // producer of `resolveColorTokenLiterals`. A token arm (`sky-300`) has no colour
  // terminal in the grammar, so it reached label-pass.ts as arithmetic, evaluated to
  // -300, and the label silently kept the layer default. +3 = the import + the two
  // wrapped call sites' shared 2-line why; the rewrite itself lives in lower-helpers.
  // 1190→941 (#2051, T4 CJK P1): foldLabelKnobs — the pure assembly half of the
  // label sub-pass — moved verbatim to lower-label-fold.ts so the writingMode knob
  // could land at zero net growth. LOWERED per this header's shrink rule — headroom
  // is re-justified per phase, never banked. MEASURED.
  // 941→952 (#2166 symbol-sort-key): the labelSortKeyExpr local, the
  // `label-sort-key` binding arm placed BETWEEN the constant fold and the X-GIS0005
  // fallthrough, its 5-line why (an earlier arm would capture `label-sort-key-[-3]`,
  // the converter's spelling of a negative CONSTANT), and the knob return entry.
  // MEASURED post-prettier (`wc -l`).
  // 952->963 (#2440): the `label-text-optional` utility branch, its local, and
  // the knob pass-through — the same three touch points `label-icon-optional`
  // has. MEASURED post-prettier.
  // 963->969 (#2224): the `label-rotation-alignment-viewport-glyph` parse arm
  // plus the two-line note that the two viewport utilities are an exact-match
  // pair, not a prefix pair. MEASURED post-prettier.
  // 969->973 (#2224): the local's type derived from LabelDef instead of
  // restating the enum, plus the 4-line why (the literal union was a second
  // authority and rejected the value the converter had already accepted).
  // MEASURED post-prettier.
  // 952→966 (#2320): the `label-max-width-[interpolate(zoom, …)]` arm — the
  // consumer half of the converter fold. Without it the folded utility hit the
  // X-GIS0005 fallthrough and LabelDef.maxWidth arrived undefined, which
  // text-stage reads as "no wrap at any zoom" (worse than the spec default the
  // fold replaced). +14 = the arm plus the why for seeding the single em value
  // from the last stop. MEASURED post-prettier (`wc -l`).
  // MERGE RE-MEASURE (2026-09-05, main <- issue-hunt branch, second merge): both sides
  // raised this key from a common base, so the merged file carries BOTH deltas and
  // neither side's number is right (§12). Measured 977 with `wc -l` on the
  // post-prettier merged tree.
  // MERGE RE-MEASURE (ninth main merge): both sides raised this key; 987 is `wc -l`
  // on the post-prettier merged tree (§12 — never carry either side's number across).
  'compiler/src/ir/lower-label.ts': 987,
  'compiler/src/tokens/colors.ts': 937,
  // 943→956 (#1302): RenderNodeArrowPaint sub-bundle (isArrow + arrowBearing).
  // 956→957 (merge union with #1305 RenderNodeCoveragePaint).
  // 957→966 (#1333): RenderNodeParticlePaint sub-bundle (isParticles) + its merge into
  // RenderNode's extends list.
  // 966→969 (#1418): the `flowPortrayal` field on RenderNode plus its doc comment. A field on
  // the IR node type is the whole point of the file; extracting one property would split the
  // node's shape across two places for no gain.
  // 969→980 (source maxzoom, the 404 class): a dataset has a deepest REAL level and asking
  // past it is a guaranteed 404, not a slow tile — terrarium stops at z15 while
  // rasterCoverZoom adds +1 on a 256-px source, so every visible tile failed from about
  // camera z14.5 (verified: terrarium/16/13651/25075 404, its z15 parent 200). +11: the two SourceDef fields and the doc that says why a tile outside them cannot exist.
  // 980→982 (#1257): rasterFadeDurationMs? field + doc comment on RenderNodeRasterPaint.
  // 982→989 (#1304): `SourceDef.refresh?: number` field + doc comment (the declarative
  // live-source polling interval).
  // 989→995 (#2117 line-gradient): `StrokeValue.gradientStops` + the 5-line doc that
  // records WHY the ramp replaces the solid colour and which arc it is sampled over.
  // Headroom is re-justified per phase, never banked. MEASURED post-prettier.
  // 989→995 (#2118): the `circlePitchAlignmentMap` RenderNode field + its doc, and a
  // correction to the sibling's doc, which claimed "viewport" was `circle-pitch-scale`'s
  // spec default. It is not — v8 defaults that knob to "map" — and the wrong claim was
  // load-bearing enough to be worth the lines. MEASURED post-prettier (`wc -l`), set EXACTLY
  // to the count — headroom is re-justified per phase, never banked.
  // 989→995 twice, INDEPENDENTLY: #2117 line-gradient added StrokeValue.gradientStops and
  // #2118 circle-pitch added ShowCommand.circlePitchAlignmentMap, each +6 from the same base.
  // Both branches therefore wrote the IDENTICAL ceiling line `995`, so git merged it with NO
  // CONFLICT while the file itself grew by BOTH deltas — the one shape of ceiling drift that
  // a conflict marker cannot warn about, and only the ratchet catches. MEASURED post-merge
  // (`wc -l`): 1001. Verified it is genuine growth, not a duplicated block: no interface,
  // type, const or function name occurs twice in the file.
  // 1006->1013 (#2440): `LabelDef.textOptional` + the contract doc. The WHY
  // lives once at text-stage.ts's `isTextOptional`; this doc states the field's
  // contract and points there. MEASURED post-prettier.
  // 1013->1015 (#2224): LabelDef.rotationAlignment gains the fourth spec value
  // in its type union, and its doc gains the two lines saying which side
  // `viewport-glyph` resolves to. MEASURED post-prettier.
  'compiler/src/ir/render-node.ts': 1015,
  // 912→932 (#2170 symbol half): the `*-translate-anchor` spec-default DECISION
  // extracted out of addTranslateAnchor into the exported `translateAnchorIsMap`
  // so the symbol emitter reads it too, plus its docstring recording WHY a second
  // copy existed (that copy is what drifted from the paint path since #2170).
  // MEASURED post-prettier (`wc -l`), set EXACTLY — no headroom banked.
  // 912→914 (#2166 background-inputs), from the SAME base: +2 on `addFillTranslate`'s
  // doc comment, which was WORSE than stale — it said the "map" anchor was "not yet
  // implemented" in the very file whose `addTranslateAnchor` implements it, and which
  // #2170 made the spec DEFAULT.
  // MERGE UNION: both sides raised this key from 912 and neither number is right — the
  // edits are in different regions of the file, so the merged file takes BOTH deltas
  // (§12: never pick a side, never max() the two). RE-MEASURED post-merge with `wc -l`.
  // 934→954 (#2329): the legacy `{type: "interval", stops: […]}` zoom
  // function was silently lowered as a linear interpolate — MapLibre's
  // evaluateIntervalFunction is a STEP (holds the greatest stop <= the
  // input). Added the `step` curve variant to interpolateZoomStops'
  // legacy branch + a step-emitting arm in interpolateZoomCall.
  // MEASURED post-prettier (`wc -l`), set EXACTLY — no headroom banked.
  'compiler/src/convert/paint-helpers.ts': 954,
  // 800→845 (#2008 C-tier): the split/join string builtins + the to-rgba
  // colour coercion added to callBuiltin's single-authority switch (the
  // #1066 comment on BUILTIN_FN_NAMES: every dispatchable name lives here,
  // not threaded into a second file) — 3 new BUILTIN_FN_NAMES entries + the
  // `split`/`join`/`to_rgba` case blocks with their spec-citation comments.
  // First CEILINGS entry for this file — it sat exactly at NEW_FILE_CAP
  // before (same situation emit-commands.ts hit at #1304, above).
  // 845→868 (#2166 B3): `assert_array` — the runtime half of Mapbox's
  // `["array", …]` type assertion, which the converter used to drop. Same
  // single-authority reason as the bump above: every name callBuiltin
  // dispatches lives in that one switch, so the case block (plus its
  // BUILTIN_FN_NAMES entry and the comment recording why the assertion is
  // load-bearing — `length`/`slice` accept strings) lands here rather than
  // in a second file.
  // 868→872 (#2385): the `?? ''` removal in the index-of arm is net zero lines; the
  // +4 is the comment recording WHY the coercion must stay bare (`''` is at index 0
  // of every string) — the exact defect a future "harden the null case" edit would
  // reintroduce. MEASURED post-prettier (`wc -l`), set EXACTLY to the count.
  'compiler/src/eval/evaluator-helpers.ts': 872,
  // Baselined 805 (#2471, main merge) — a genuine unrelated-PR collision, the same
  // shape as the #1602/#1603 one recorded above, and the §12 double-delta trap in its
  // purest form: NEITHER SIDE BREACHED ALONE. Common ancestor 791; main's #2454
  // (background-layer drop warnings) took it to 797; this branch's #2471 (Mapbox v3
  // `imports` lowering) took it to 799. The two edits are in different regions, so git
  // merged them with no conflict and the file took BOTH deltas — 805, red on main having
  // been green on both branches. Extraction is already spent on both sides: #2454 put its
  // logic in `background-layer-drop.ts` and #2471 put its in `style-imports.ts`, each
  // leaving a one-line call site here; what remains is the converter's own body, and the
  // only way under 800 now is deleting the comments that say WHY each call site sits
  // where it does — degrading the record to absorb someone else's delta. MEASURED
  // post-prettier on the MERGED tree (`wc -l`), set EXACTLY to the count, not picked
  // between sides. Shrink-only from here.
  'compiler/src/convert/mapbox-to-xgis.ts': 805,
  'blueprint/src/editor.ts': 1448,
  // 800→805 (#1304): `LoadCommand.refresh?: number` field + doc comment, and its
  // pass-through line in `emitCommands()`'s `loads` map (mirrors `maxzoom`/`minzoom`).
  // First CEILINGS entry for this file — it sat exactly at NEW_FILE_CAP before.
  // 805→810 (#2117 line-gradient): `LinePaint.strokeGradientStops` + doc + the one
  // `node.stroke.gradientStops` wire line. Headroom is re-justified per phase, never
  // banked. MEASURED post-prettier.
  // 805→812 (#2118): the `circlePitchAlignmentMap` field on CirclePaint + its doc, and the
  // node→ShowCommand carry. MEASURED post-prettier (`wc -l`), set EXACTLY to the count —
  // headroom is re-justified per phase, never banked.
  // MERGE: main and this branch each raised this ceiling from a shared base;
  // neither side's number is right. MEASURED post-merge (`wc -l`): 817.
  'compiler/src/ir/emit-commands.ts': 817,
  // 785→826 (#1269 item 3): retry backoff jitter, so tiles that fail together
  // don't retry in lockstep — the injectable-rng test seam (mirrors the log-throttle/
  // negative-cache module-state + test-only-setter shape already in this file) +
  // jitteredBackoffMs + its jitter-shape rationale doc comment. First CEILINGS entry
  // for this file — it crossed NEW_FILE_CAP (800) with this change.
  // 826→835 (#1269 item 3, adversarial review): full jitter swapped for EQUAL jitter —
  // full jitter let both backoff attempts land near zero simultaneously (witness
  // r1=r2=0.05 → 60ms total retry window vs the fixed schedule's 1200ms), burning all
  // 3 attempts inside a sub-second upstream blip ~2.7% of the time and paying the
  // 5-minute negative-cache penalty for it. The doc comment on jitteredBackoffMs was
  // rewritten (not just the formula swapped) to argue from this path's own economics —
  // 3 fixed attempts + a 5-minute exhaustion cost — rather than leave the prior AWS
  // unbounded-retry citation standing unexplained against a different formula.
  // #2391 lowered 835 -> 833: the header described `XGVTBinarySource` delegating to
  // `TileCatalog.loadFromURL` — a class and a method that no longer exist anywhere
  // (audit F-9; `.xgvt` gave way to PMTiles). Two lines of doc rot removed, so the
  // ceiling comes down with them per this file's own shrink-only rule.
  'data/src/vector-tile-loader.ts': 833,
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
