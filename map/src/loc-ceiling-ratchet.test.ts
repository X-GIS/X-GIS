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
  'map/src/render/vector-tile-renderer.ts': 4494,
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
  // 4336→4337 (pick pre-gate): ONE composition-root line — the `anyLayerListens`
  // dep wiring the EventDispatcher's pre-pick gate to InteractionController (which
  // already owns `xgisLayers` and the layer reverse-resolve, so the scan lives
  // there, not here). Without it `fireOnce` had to run a GPU pick readback BEFORE
  // it could ask whether anyone listened — the dep's own doc already promised to
  // "skip the pickAt/buildFeature path entirely" in that case. Dep injection at
  // the composition root; nothing extract-worthy (§2). Lower as #991 decomposes
  // map.ts.
  // 4337→4360 (#777 Phase II): the raster-dem → HillshadeRenderer wiring — the
  // hillshadeRenderer + _hillshadeShow fields, the two ctor init sites, the
  // rebuildLayers reset + `_dem`-marker arm branch, and the rebuildForQuality
  // hook. Irreducible: these are class-member declarations + the source-dispatch
  // arm that must sit in rebuildLayers where the source markers are read. The DEM
  // decode itself was extracted to hillshade-renderer.ts (armHillshadeSource).
  'map/src/map.ts': 4360,
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
  'map/src/text/text-stage.ts': 2066,
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
  'map/src/render/passes/label-pass.ts': 1906,
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
  'map/src/shaders/dsl/polygon.ts': 1339,
  'data/src/tile-catalog.ts': 1290,
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
  // 1205→1206 (#777 Phase II): the hillshadeRenderer.beginFrame() deferred-eviction
  // hook, next to rasterRenderer.beginFrame(). Irreducible: per-frame eviction must
  // run in the beginFrame sweep alongside the other tile renderers.
  'map/src/render-loop.ts': 1206,
  'map/src/render/point-renderer.ts': 1140,
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
  'rhi-webgl2/src/rhi-webgl2.ts': 1292,
  'map/src/render/renderer.ts': 965,
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
  'map/src/render/upload-coordinator.ts': 889,
  'map/src/shaders/dsl/projections.ts': 811,
  // #1005 — carried from the runtime arch-invariants Gate 3 (re-measured
  // 2026-07-13; lower.ts had shrunk 1452→1409, the tighter value carried).
  // 1790→1546 (INC-0 extract): the conforming red-green subdivision cluster
  // (vertexKey + subdivideTriangleMM / subdivideChainMM + their gate constants
  // and helpers) moved verbatim to tiler/subdivide-conforming.ts — pure code
  // motion, mesh output byte-identical; vector-tiler re-imports the three
  // consumed symbols. The extract answers INC-0's growth over the old ceiling
  // (extract, don't raise), per this gate's own message.
  'compiler/src/tiler/vector-tiler.ts': 1546,
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
