// ═══ Architecture ratchet gates — Phase 1 of the 2026-06-09 reckoning ═══
//
// These are NOT behavior tests. They LOCK structural invariants so the known
// debt cannot grow while it is being paid down — the "no enforcement → every
// decomposition regresses to the mean" master-root (reckoning §1.1 R1):
//
//   1. package DAG     — compiler/ must NEVER import @xgis/runtime (the one
//                        genuine structural asset: an acyclic package graph).
//   2. map↔render-loop — render-loop.ts must import ./map TYPE-only, so the
//                        runtime value-import cycle stays broken (commit 605479a5).
//   3. LOC ceilings    — the 15 current god-files (>800 LOC) may only SHRINK;
//                        no NEW source file may cross 800 LOC.
//   4. projType branch — `projType ===/!==` belongs ONLY in projections-table.ts;
//                        the current scattered sites are a frozen allowlist.
//
// A RATCHET: every number below is a high-water mark meant to drop over time,
// never rise. When you shrink a file or delete a projType branch, LOWER the
// baseline here in the same commit. GPU-free; runs in the CI `test` job.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SRC_DIRS = ['runtime/src', 'compiler/src', 'blueprint/src', 'shared/src']

function walkTs(absDir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(absDir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue
    const p = join(absDir, name)
    if (statSync(p).isDirectory()) out.push(...walkTs(p))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}
function rel(abs: string): string {
  return relative(ROOT, abs).split('\\').join('/')
}
function lineCount(abs: string): number {
  const s = readFileSync(abs, 'utf8')
  let n = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

const ALL_TS = SRC_DIRS.flatMap((d) => walkTs(join(ROOT, d)))

// ── Gate 1: package DAG ──────────────────────────────────────────────
describe('arch ratchet: package DAG (no compiler → runtime cycle)', () => {
  it('compiler/src never imports @xgis/runtime', () => {
    const re = /^\s*import\b[^\n]*from\s+['"](@xgis\/runtime|[^'"]*\/runtime\/src)/m
    const offenders = walkTs(join(ROOT, 'compiler/src'))
      .filter((f) => re.test(readFileSync(f, 'utf8')))
      .map(rel)
    expect(
      offenders,
      `compiler must not import @xgis/runtime — it would make the package graph cyclic (the one real structural asset):\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})

// ── Gate 2: map ↔ render-loop value-import cycle ─────────────────────
describe('arch ratchet: map ↔ render-loop value-import cycle stays broken', () => {
  it('render-loop.ts imports ./map as `import type` only', () => {
    const s = readFileSync(join(ROOT, 'runtime/src/engine/render-loop.ts'), 'utf8')
    // A VALUE import of ./map re-forms the runtime cycle (map.ts value-imports
    // render-loop.ts). `import type` is erased by tsc, so it does not.
    const valueImport = /^\s*import\s+(?!type\b)[^\n]*from\s+['"]\.\/map['"]/m
    expect(
      valueImport.test(s),
      'render-loop.ts must import ./map with `import type` only (see commit 605479a5) — a value import re-creates the map↔render-loop runtime cycle',
    ).toBe(false)
  })
})

// ── Gate 3: LOC ceilings (god-files shrink-only; no new god-files) ───
// High-water marks measured 2026-06-09. LOWER these as files shrink.
const LOC_CEILINGS: Record<string, number> = {
  // Bumped 3913→3924 for the sync-path (doUploadTile) line/outline/segment
  // buffer-leak fix: the 5 buffer declarations are hoisted ABOVE the try so
  // the catch backstop can reach them, and 5 cleanup statements (release the
  // pooled line/index buffers + destroy the lineRenderer-owned segment
  // buffers) mirror doUploadTileAsync's cleanupLineBuffers. Irreducible — the
  // async path already carries the identical structure; this closes the
  // asymmetric sync gap (throw before layerCache.set → leaked VRAM).
  // Bumped 3924→3934 for the bundle-cache compaction-UAF fix: capturing
  // runFrameMaintenance's new "compacted" return + invalidating every cached
  // render bundle (whose recorded buffer ref the arena swap retired) is
  // irreducible — the explanatory comment carries the bulk (mirrors the
  // async-upload buffer-identity guard; latent since bundles are default-OFF).
  // Bumped 3934→3938 for the continuous-zoom fill-interp fix: slot 44 (u.zoom)
  // must carry the fractional camera.zoom, not the integer tile-selection
  // lastZoom, or OFM zoom-interp fills + palette gradients snap at integer
  // boundaries. Adds a `currentCameraZoom` field (cached in render()) — net
  // +4 lines after trimming the slot-44 comment.
  // Bumped 3938→3948 for the empty-default-slice fix (#356-followup): the
  // classifyTile call site passes a hasNonEmptySliceInCatalog predicate so a
  // single-layer GeoJSON empty placeholder classifies as drop-empty instead of
  // being forced into a parent-fallback (+10 lines, irreducible inline closure).
  // Bumped 3948→3955 for the match()-variant null-feature-bg crash fix: the
  // per-tile fill loop resolves the feature bind group to null (not a lying `!`)
  // and skips the fill draw when absent — binding null with a dynamic offset
  // invalidated the whole encoder (black screen on non-mercator projections).
  // Lowered 3955→3923 for the Tier-2 zoom-direction prefetch extraction: the
  // tile-set math moved VERBATIM to tile-decision.computeZoomDirectionPrefetchKeys
  // (pure, unit-tested), leaving only the guard + prefetchTiles side-effect inline
  // (byte-identical execution order). Five now-unused imports also dropped.
  // Bumped 3923→3929 for the fill/line-pattern atlas-UV clobber fix (slots 19/23):
  // the two unconditional uf[19]/uf[23] writes split into _patternUniformActive /
  // _linePatternActiveForShow guarded writes + the 6-line rationale comment — the
  // shader reads those slots as the pattern v1, so the guard is irreducible.
  // Bumped 3929→3959 for BUG D4 (cancelStaleUploads byte-accounting leak): the
  // _releasePrebuiltSegments helper + its two drop-path call sites (queued +
  // held) null prebuiltLineSegments/prebuiltOutlineSegments on dropped uploads
  // whose TileData stays cached, keeping sizeOfTileData's segment-omission
  // invariant true so the byte-cap eviction stops under-firing. Shared helper.
  // Bumped 3959→3961 for the line-width dpr fix: the two writeLayerSlot call
  // sites (stroke + gap) each thread `dpr` into the layer uniform so vs_line's
  // screen-width clamp lands on the right NDC span (roads were 1/dpr too thin).
  // Bumped 3961→3962 for the point precision fix: the tile-point decode passes
  // the absolute Mercator DSFUN tail (slots 9-12) to addTilePoint.
  // Bumped 3962→3996 (mbx_batch2) for the fill-antialias / fill-extrusion-
  // vertical-gradient opt-out flags: two baked per-show fields + their render()
  // bake + the two uniform writes into the spare cam_ecef_off_{h,l}.w lanes +
  // the contract comments. Irreducible additive plumbing (no struct growth).
  // Bumped 3996→4011 (#420) for the light_dir_ecef pack: the camera-anchor
  // ENU→ECEF light rotation (camSinLon/camCosLon + 3 uniform writes) + the
  // basis-contract comment that ties it to polygon-mesh.ts's normals.
  'runtime/src/engine/render/vector-tile-renderer.ts': 4011,
  // Bumped 3361→3393 for the destroy()-completeness fix: cancelling the
  // EventDispatcher move-rAF + the pending-flush rAF, clearing _pendingPatches,
  // and removing the run()-installed window globals (__xgisReady/snapshot/
  // replay/trace) are irreducible teardown statements. map.ts decomposition
  // remains a tracked priority; shrink as the destroy body is extracted.
  // Bumped 3393→3412 for the updateFeature() tile-backed silent-drop fix:
  // a `{_vectorTile}`/`{_tileUrl}` marker passed the rawDatasets.has()
  // precondition, queued a patch that flush then discarded with no warn. The
  // `_tileBackedUpdateWarned` Set + the enqueue-time guard + the defensive
  // flush-time warn are irreducible (warn-once data-loss prevention).
  // Bumped 3412→3416 for the bounds-fit-gate parity fix: the programmatic
  // Mapbox-parity setters (jumpTo/easeTo/flyTo/fitBounds) must mark the
  // camera explicitly positioned — matching the pointer/wheel/keyboard
  // handlers — so a post-compile bounds-fit can't clobber a host-set camera.
  // Bumped 3416→3437 for the `map.project()` / `map.unproject()` public
  // accessors (MapLibre-API parity + the debug-measurement primitive): thin
  // delegates. project()'s logic was EXTRACTED to render-loop-helpers.ts
  // (projectLonLatToScreenCss); unproject() delegates to the camera's existing
  // unprojectToLonLat — only the public method shells live here. map.ts
  // decomposition remains the #1 tracked god-file priority.
  // Bumped 3437→3438 for addGlyphProvider's markLabelDirty re-arm (CJK glyph
  // re-raster fix: a runtime-added provider must repaint an idle map — 1 line).
  // Bumped 3438→3447 for the WOFF font-land glyph re-raster: fontsReady→
  // invalidateAllGlyphs + markLabelDirty (Canvas2D fallbacks upgrade on load).
  // Bumped 3447→3489 for the #360 F1 per-source polar-cap wiring: the cap
  // install/detach LOGIC lives in geojson-polar-cap-show.ts (map.ts stays
  // thin) — what remains here is irreducible host glue: the geojsonCapPoles
  // field + SourceManager dep, the `_polarCapHost()` adapter, the run()
  // install call, and the onWorldBandChange re-install/detach branch.
  // Bumped 3489→3494: the onWorldBandChange cap (re)install must trigger
  // rebuildLayers() so the cap show enters `vectorTileShows` (the dispatch
  // list is rebuilt from showCommands, not read raw) — else the cap tile is
  // cached but never selected/drawn. Irreducible host glue.
  // Bumped 3494→3496 (mbx_batch2) for the Mapbox `["pitch"]` identifier:
  // the render-path eval sites (applyFilter + per-feature paint/size eval)
  // inject `this.camera.pitch` alongside cameraZoom (2 lines).
  'runtime/src/engine/map.ts': 3496,
  // Bumped 1343→1344 for the opacity sub-1.5% round-trip fix (#274); comments
  // trimmed to the minimum, net +1 irreducible.
  // Bumped 1344→1348 for the polygon fill-stroke INSET default (US-002): a
  // thick outline straddled + ate the fill edge at CENTER; default fill+stroke
  // layers to inset (1 expr + 4 trimmed comment lines, irreducible behavior).
  // Re-baselined 1348→1404 (mbx_batch2): the branch had drifted to 1392 from
  // prior batch work (circle-translate / legacy $type-$id filters) without a
  // ceiling bump; +9 here for the fill-antialias-false /
  // fill-extrusion-vertical-gradient-false opt-out parse arms + the two
  // boolean accumulators + RenderNode return wiring. lower.ts decomposition
  // stays a tracked priority.
  'compiler/src/ir/lower.ts': 1404,
  // Bumped 1441→1449 for the CJK display-size floor on CURVED/line labels: the
  // point-loop floor (hasCjkIdeograph → Math.max(size, CJK_MIN_DISPLAY_PX*dpr))
  // mirrored onto the curved loop so dense Han road labels stop boxing out at
  // low zoom (1 raw→floored expr + the 5-line parity rationale, irreducible).
  // Bumped 1449→1453 for addGlyphProvider's invalidateAll wiring (CJK glyph
  // re-raster fix: a runtime-added provider re-rasters already-shaped fallbacks).
  // Bumped 1453→1459 for invalidateAllGlyphs() (WOFF font-land re-raster hook).
  // Bumped 1459→1465 for the italic-label synthetic-oblique flag (#416): a
  // labelItalic = (def.fontStyle==='italic') per loop (point + curved) + the
  // `italic:` field on the three TextDraw build sites so the renderer shears
  // CJK/Hangul glyphs (the italic glyph PBF serves ideographs upright).
  'runtime/src/engine/text/text-stage.ts': 1465,
  // Bumped 1509→1517 for the GeometryCollection decompose fix (RFC 7946
  // §3.1.8): decomposeFeatures' per-type switch is wrapped in an inner
  // recursive helper so a GeometryCollection member-decomposes under the
  // parent id instead of silently dropping. The wrapper signature + the
  // GeometryCollection branch + the rewritten outer loop are irreducible.
  // Bumped 1517→1551 for the antimeridian outline-seam fix: the
  // dropTileBoundaryEdges helper + its two outline-emit call sites drop
  // source edges coincident with a tile boundary (the lon ±180 dateline
  // splits Natural Earth bakes) so the polygon outline stops stroking a
  // full-height seam line in every world copy. Real-GPU-bisect-confirmed.
  // Bumped 1551→1577 for BUG T4 (hole-distribution drop): the
  // assignHoleBucket helper replaces the fragile single-vertex test in
  // BOTH boundary-split hole-distribution loops (tileLevel + compileSingleTile)
  // with a never-drop fallback chain (hole[0] → centroid → any vertex →
  // largest sub-outer). Net +26 after collapsing the two inline loops; the
  // helper is shared by both sites so it can't fold into either.
  // Fill/outline COINCIDENCE fix (d34aed2 made real): both outline-emit
  // sites now derive from the fill's `clipped` rings via the pre-existing
  // extractNonSyntheticArcs (#347 seam-strip preserved) instead of a
  // separate line-clip of the original ring — closing a ~3.8 m fill/stroke
  // gap at tile crossings. dropTileBoundaryEdges deleted (its job folds
  // into extractNonSyntheticArcs); dropConsecutiveDuplicates added (strips
  // the S-H closing-duplicate that would make a degenerate outline edge).
  // Net negative — stays under the 1570 cap.
  'compiler/src/tiler/vector-tiler.ts': 1570,
  // Bumped 915→917 (#420) for the UNIFORM_SIZE/SLOT 240→256 bump +
  // light_dir_ecef contract comment when the polygon Uniforms struct grew.
  'runtime/src/engine/render/renderer.ts': 917,
  // Lowered 776→254: extracted the text-layout family (text-anchor /
  // variable-anchor[-offset] / transform / offset / translate / radial-offset /
  // collision / rotate / letter-spacing / max-width / line-height / justify /
  // font / symbol-placement / rotation+pitch-alignment / symbol-spacing /
  // keep-upright) → convertTextLayoutProperties in layers-symbol.ts (the U6
  // sub-pass; behavior-preserving, byte-identical fixture SHA gate).
  'compiler/src/convert/layers.ts': 254,
  // layers-symbol.ts — the symbol-converter sub-pass module (text-paint / icon /
  // gap + the U6 text-layout family extracted from layers.ts). Over the 800 cap
  // because the lifted passes carry their hard-won v8-strict literal-unwrap +
  // enum-validation + clamp regression-guard comments VERBATIM (kept intact so
  // the byte-identical fixture SHA gate holds). It's a cohesive sub-converter,
  // not a god-file; baselined here, shrink as the comments distil.
  // Bumped 1052→1071 (mbx_batch2) for the icon-translate emit: the constant
  // [dx, dy] unwrap + the label-icon-translate-{x,y}-N split + the
  // icon-translate-anchor "map" warn (replacing the old single-line gap warn).
  'compiler/src/convert/layers-symbol.ts': 1071,
  // Bumped 1534→1574 for the arithmetic-arity fix (expr-arith-coalesce): the
  // variadic +/*, unary/binary -, and exact-2 //% forms each need a distinct
  // branch (was one over-strict shared comparison branch). Irreducible.
  // Lowered 1574→1071: extracted the interpolate family → expr-interpolate.ts
  // and the match family (convertMatch + matchToTernary + matchToBooleanFilter)
  // → expr-match.ts (behavior-preserving, byte-identical fixture SHA gate).
  // Re-baselined 1071→1116 (mbx_batch2): the file had drifted to 1102 from
  // prior batch work without a ceiling bump; +14 here for the `case 'pitch'`
  // arm (mirror of `case 'zoom'`) lowering Mapbox `["pitch"]` to the bare
  // pitch identifier.
  'compiler/src/convert/expressions.ts': 1116,
  // Bumped 1388→1417 for the tile-catalog lifecycle fixes (BUG 11/13): the
  // prewarm-pump _skeletonTimer/_stopped fields + destroy() cancel method, and
  // the hoisted evict-shield sweep, are irreducible (two real leaks). Catalog
  // decomposition remains a tracked priority.
  'runtime/src/data/tile-catalog.ts': 1417,
  // Bumped 1354→1356 for the undo-correctness fixes: tryConnect skipRecord param + insertReroute selEdge clear (two irreducible statements).
  // Bumped 1356→1370 for the deserialization guard (#353): sanitizeGraph() drops unknown node types + dangling edges at the load/paste/restore trust boundary.
  'blueprint/src/editor.ts': 1370,
  // Bumped 1187→1198 for the fill-translate→outline coupling fix: a fill's
  // outline (drawn through the line pipeline) must apply the SAME viewport
  // fill-translate the polygon VS does, or a translated fill's outline
  // separates from it (OFM building-top double-edge at deep zoom). The
  // guard + 2-axis apply are irreducible; the apply itself duplicates
  // polygon.ts:345 × 3 — extracting a shared `apply_fill_translate` (which
  // would net-shrink both files) is a tracked follow-up (blocked on the
  // polygon byte-equal snapshot gate).
  // Bumped 1198→1203 for the line-width dpr fix: a `dpr` field on LineLayer
  // (slot 46, was pad) + its vs_line accessor + the ×dpr factor on the
  // screen-width clamp's target_ndc, with load-bearing comments explaining the
  // CSS-px-target / device-px-viewport mismatch the factor corrects.
  // Bumped 1203→1212 for the screen-width clamp shrink fix: targetNdc is ~4×
  // miscalibrated vs the perspective viewport, so capping the scale at
  // max(ratio, 1) stops it shrinking every flat stroke to a fraction of its
  // width (roads rendered ~1/3 the MapLibre width). The added lines are the
  // load-bearing rationale comment for the cap.
  // Bumped 1212→1217 (#412 stray-`continue` line-pattern reachability fix, +5
  // rationale comment) then 1217→1233 (mbx line-translate: LineLayer struct
  // gains line_translate_x/y + 2 pads + the vs_line translate apply block).
  'runtime/src/engine/shader-dsl/shaders/line.ts': 1233,
  // Bumped 1171→1176 (#274 CSS color-fn whitespace), then 1176→1178 (#317) for
  // the two irreducible numeric match()-label arm-pattern cases (Number, and
  // Minus+Number). parser.ts decomposition remains a tracked priority.
  'compiler/src/parser/parser.ts': 1178,
  // Bumped 1139→1168 for the flat-Mercator fill-position precision fix: the
  // quantized fill VS (vs_main_ecef) now positions from TILE-LOCAL Mercator
  // (the f32 tail slots) via a dedicated localMerc ladder branch instead of
  // re-projecting the lossy absolute-degree slots — the branch + the absMerc
  // varying reconstruction are irreducible (they fix the ~10 px fill/outline
  // split at deep over-zoom). Extracting the shared flat-arm is a tracked
  // follow-up (blocked on the polygon-variant byte-equal snapshot gate).
  // Bumped 1168→1175 for the #398 disc-pole fix: vs_main_ecef gains a true_lat
  // vertex input + the ladder gains a discLat param the disc (flat_rel) arm
  // projects from (the Merc-clamped abs_lat left a ~550 km annular pole hole on
  // ortho/azimuthal/stereographic). Irreducible additive plumbing.
  // Bumped 1175→1187 (mbx_batch2) for the fill-antialias / fill-extrusion-
  // vertical-gradient opt-out WGSL gates: fs_fill wraps the rim-alpha
  // smoothstep in an `if (cam_ecef_off_h.w != 0)` (fill-antialias), and
  // vs_main_ecef_extruded ANDs an `cam_ecef_off_l.w != 0` flag into the
  // per-wall vertical-gradient test. Default (flag=1) byte-identical behavior.
  // Bumped 1187→1197 (#420) for the light_dir_ecef uniform: the struct field +
  // its contract comment + the extrude VS reading it (the raw light moved to
  // the CPU pack, rotated into the face_normal's ECEF frame).
  'runtime/src/engine/shader-dsl/shaders/polygon.ts': 1197,
  // Bumped 1067→1092 for the minZoom + setMaxBounds gesture-clamp correctness
  // fixes (#244/#248): the maxBounds clamp method + its 7 gesture-exit call
  // sites are irreducible. camera.ts decomposition remains a tracked priority.
  // Bumped 1092→1108 for BUG P4 (sphere-family maxBounds pole-reach): the
  // clampCenterToBounds sphere branch clamps centerLatDeg against the bbox's
  // TRUE latitudes (carried as northLat/southLat on _maxBoundsMerc) instead of
  // re-syncing from the Mercator-saturated centerY, so a maxBounds past ±85.05
  // no longer pins the globe centre below the pole. Cylindrical path unchanged.
  // Bumped 1108→1114 for the pan-inertia bearing-sign fix: camera.pan rotated
  // the screen delta by Rot(−bearing) instead of Rot(+bearing) (off by 2·θ, so
  // inertia flung the wrong way on a rotated map). The 6 added lines are the
  // contract comment tying the sign to panToScreenAnchor's MVP inverse.
  'runtime/src/engine/projection/camera.ts': 1114,
  // Bumped 1065→1067 for the curved-text early-return perf-mark balance fix:
  // the `total < spacingPx*0.5` curved branch was missing the two matching
  // perfMarkEnd('…line.emit')/('…line.polyline') calls its sibling returns
  // already make (lines ~867/889/906) — two irreducible balanced-mark lines.
  // Bumped 1067→1068 for the GeoJSON label-show `continue` (~452) perf-mark
  // balance fix: it was missing the matching perfMarkEnd('…label-dispatch.show')
  // the loop-tail makes (~1022) — one irreducible balanced-mark line.
  // Bumped 1068→1069 for the sprite-land render re-arm: IconStage onLanded =>
  // host.markLabelDirty() (sprite atlas land must repaint an idle map — 1 line).
  // Bumped 1069→1073 for the globe-label RTC focus fix: pass
  // camera.getECEFCenter() into makeLabelProjectors so the ECEF label projector
  // anchors against the same focus the globe RTC matrix subtracts (labels were
  // projected from absolute ECEF → floated off / vanished under pitch).
  // Bumped 1073→1087 for the one-way-arrow dedupe fix: extracted
  // lineLabelDeduped (exported pure predicate + the '' → never-dedupe guard
  // so text-less icon line layers stop collapsing to ~1 arrow per show).
  // Bumped to 1137 (#424 pointLabelPairKey + #417 one-way-arrow icon-collision
  // + #411 deep-zoom road-label screen-space subdivision) then 1137→1142 (mbx
  // icon-translate: dispatchIcon adds def.iconTranslateX/Y × dpr alongside
  // icon-offset, plus the def type fields + contract comment). Then 1142→1157
  // for the #402-C rebake-sig pixel-quantization: the exported dispatchCenterKey
  // helper (centre→px key, with the load-bearing rationale comment) + call site.
  'runtime/src/engine/render/passes/label-pass.ts': 1157,
  // VTR Unit-1 extraction (Cluster E-selection). The hysteresis +
  // readiness-gate logic was moved VERBATIM (plan §5 DO-NOT-SPLIT #2),
  // and its hard-won fix-history comments carry the bulk of the LOC —
  // just over the 800 cap. Baselined here; shrink as comments distil.
  'runtime/src/engine/render/tile-selection-cache.ts': 858,
  // renderer.ts Unit-1 extraction (PipelineFactory) — the pipeline /
  // bind-group-layout / atlas-stub construction + the three per-variant
  // builders (createVariantPipelines + createVariantPipelinesAsync +
  // buildVariantDescriptors, each a near-identical descriptor set) were
  // moved VERBATIM (rasterization-critical, CI has no GPU; plan §2 Unit 1).
  // Over the 800 cap because the verbatim descriptor sets + hard-won
  // fix-history comments (OIT cull, iter-130/186/197 etc.) carry the LOC.
  // Baselined here; shrink as the three builders converge (descriptor
  // factory) + comments distil.
  'runtime/src/engine/render/pipeline-factory.ts': 1193,
  // GpuTileStore — VTR Cluster-A extraction (the resident-tile memory core:
  // gpuCache + the three GPUArenas + byte-aware eviction + OOM forced eviction
  // + deferred compaction/AUTO-GROW). Over the 800 cap because the verbatim
  // arena lifecycle + its hard-won fix-history comments (#218 OOM, #288/#289
  // relocation→bundle-invalidation, #366 mid-render-destroy UAF, US-003 grow)
  // carry the LOC. Baselined here; decomposition is a tracked priority.
  // Bumped 870→903 for the at-ceiling eviction-futility short-circuit (a1):
  // two per-arena latch fields + the short-circuit + the per-frame reset +
  // the invariant comments (nothing frees mid-frame → re-scan is pure waste),
  // killing the ARENA-OOM per-frame O(resident) re-scan lag at z22+pitch.
  'runtime/src/engine/render/gpu-tile-store.ts': 903,
  // Baselined at 805 (mbx_batch2): point-renderer.ts crossed the 800 cap from
  // prior batch work (circle-translate / circle-blur). Not touched here;
  // baselined to keep the ratchet honest. Decomposition is a tracked follow-up.
  'runtime/src/engine/render/point-renderer.ts': 805,
  // Baselined at 820 (mbx_batch2): lower-label.ts is the label-knob lowering
  // sub-pass extracted from lower.ts; crossed 800 here for the icon-translate
  // accumulators + parse arms + knobs-interface + merge wiring. Cohesive
  // sub-lowerer, not a god-file; baselined, shrink as it converges.
  'compiler/src/ir/lower-label.ts': 820,
}
const NEW_FILE_CAP = 800

describe('arch ratchet: file size (shrink-only god-files, no new ones)', () => {
  it('no baselined god-file exceeds its locked ceiling', () => {
    const grown = Object.entries(LOC_CEILINGS)
      .map(([path, ceil]) => ({ path, n: lineCount(join(ROOT, path)), ceil }))
      .filter((x) => x.n > x.ceil)
      .map((x) => `${x.path}: ${x.n} > ceiling ${x.ceil} — extract, don't grow (then lower the ceiling)`)
    expect(grown, grown.join('\n')).toEqual([])
  })

  it(`no non-baselined source file exceeds ${NEW_FILE_CAP} LOC`, () => {
    const tooBig = ALL_TS
      .filter((f) => !(rel(f) in LOC_CEILINGS))
      .map((f) => ({ r: rel(f), n: lineCount(f) }))
      .filter((x) => x.n > NEW_FILE_CAP)
      .map((x) => `${x.r}: ${x.n} > ${NEW_FILE_CAP} — split it before it becomes a god-file`)
    expect(tooBig, tooBig.join('\n')).toEqual([])
  })
})

// ── Gate 5: layer import-direction (downward-only spine) ─────────────
// 2026-06-18 runtime redesign §2.1: runtime/src obeys a layered spine
//   L0 coords/camera → L1 gpu/platform → L2 data/io → L3 render → L4 facade
// where an import may target the SAME or a LOWER layer. The current upward
// edges (all L0 projection files reaching gpu/loader for constants /
// converters) are snapshotted below as a SHRINK-ONLY allowlist — exactly
// today's set — so this gate cannot false-positive; it fails only on a NEW
// upward edge. Type-only imports are erased by tsc (no runtime cycle) and are
// exempt, mirroring Gate 2's render-loop→map carve-out.
//
// To lower the baseline: sever an edge (redesign R-A/R-B/R-C — move the pure
// coord constants/converter down to L0) and DELETE its allowlist line. Never ADD.
const LAYER_OF = (relPath: string): number | null => {
  const p = relPath.replace(/\\/g, '/')
  if (p === 'runtime/src/engine/shaders/log-depth.ts') return 0
  if (p.startsWith('runtime/src/engine/projection/')) return 0
  if (p.startsWith('runtime/src/engine/gpu/')) return 1
  if (p.startsWith('runtime/src/engine/shaders/')) return 1
  if (p.startsWith('runtime/src/engine/shader-dsl/')) return 1
  if (p.startsWith('runtime/src/data/')) return 2
  if (p.startsWith('runtime/src/loader/')) return 2
  if (p.startsWith('runtime/src/engine/render/')) return 3
  if (p.startsWith('runtime/src/engine/text/')) return 3
  if (p.startsWith('runtime/src/engine/sprite/')) return 3
  if (p === 'runtime/src/engine/map.ts') return 4
  if (p === 'runtime/src/engine/controller.ts') return 4
  return null // unclassified (engine root files etc.) — not yet layered
}
const UPWARD_EDGE_ALLOWLIST: ReadonlySet<string> = new Set([
  'runtime/src/engine/projection/camera-helpers.ts=>runtime/src/engine/gpu/gpu-shared.ts',
  'runtime/src/engine/projection/camera.ts=>runtime/src/engine/gpu/gpu-shared.ts',
  'runtime/src/engine/projection/camera.ts=>runtime/src/engine/gpu/gpu.ts',
  'runtime/src/engine/projection/camera.ts=>runtime/src/loader/geojson.ts',
  'runtime/src/engine/projection/globe.ts=>runtime/src/engine/gpu/gpu-shared.ts',
  'runtime/src/engine/projection/view-matrix.ts=>runtime/src/engine/gpu/gpu-shared.ts',
])

describe('arch ratchet: layer import-direction (downward-only spine)', () => {
  it('no NEW upward cross-layer import edge beyond the snapshot allowlist', () => {
    const violations: string[] = []
    for (const f of ALL_TS) {
      const srcRel = rel(f)
      const srcLayer = LAYER_OF(srcRel)
      if (srcLayer === null) continue
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /\bfrom\s+['"](\.[^'"]+)['"]/.exec(line)
        if (!m) continue
        if (/^\s*(?:import|export)\s+type\b/.test(line)) continue // erased by tsc
        let tgt = relative(ROOT, resolve(dirname(f), m[1])).split('\\').join('/')
        if (!tgt.endsWith('.ts')) tgt += '.ts'
        const tgtLayer = LAYER_OF(tgt)
        if (tgtLayer === null) continue
        if (tgtLayer > srcLayer && !UPWARD_EDGE_ALLOWLIST.has(`${srcRel}=>${tgt}`)) {
          violations.push(`${srcRel} (L${srcLayer}) → ${tgt} (L${tgtLayer}): NEW upward edge — import downward or sever it (redesign §2)`)
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})

// ── Gate 4: projType branching confined to projections-table ─────────
// Occurrence counts of `projType ===/!==` outside projections-table.ts,
// frozen 2026-06-09. LOWER these as branches are routed through exported
// membership accessors (isCylindrical / isFlat / isOrtho / …).
const PROJTYPE_ALLOWLIST: Record<string, number> = {
  'runtime/src/engine/projection/camera.ts': 7,
  'runtime/src/engine/controller.ts': 6,
  'runtime/src/engine/projection/unproject.ts': 4,
  'runtime/src/loader/tiles-sse.ts': 3,
  'runtime/src/engine/render/raster-renderer.ts': 2,
  'runtime/src/engine/render/prefetch-scheduler.ts': 1,
  'runtime/src/engine/render/point-renderer.ts': 1,
  'runtime/src/data/tile-select.ts': 1,
}

describe('arch ratchet: projType branching confined to projections-table', () => {
  it('no source file exceeds its allowed projType-comparison count', () => {
    const violations: string[] = []
    for (const f of ALL_TS) {
      const r = rel(f)
      if (r.endsWith('projection/projections-table.ts')) continue
      const count = (readFileSync(f, 'utf8').match(/projType\s*[!=]==/g) || []).length
      const allowed = PROJTYPE_ALLOWLIST[r] ?? 0
      if (count > allowed) {
        violations.push(`${r}: ${count} projType comparisons > allowed ${allowed} — route through projections-table membership accessors`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})
