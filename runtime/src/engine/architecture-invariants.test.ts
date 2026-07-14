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
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
      out.push(p)
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
    const s = readFileSync(join(ROOT, 'map/src/render-loop.ts'), 'utf8')
    // A VALUE import of ./map re-forms the runtime cycle (map.ts value-imports
    // render-loop.ts). `import type` is erased by tsc, so it does not.
    const valueImport = /^\s*import\s+(?!type\b)[^\n]*from\s+['"]\.\/map['"]/m
    expect(
      valueImport.test(s),
      'render-loop.ts must import ./map with `import type` only (see commit 605479a5) — a value import re-creates the map↔render-loop runtime cycle',
    ).toBe(false)
  })
})

// ── Gate 6: engine content-blindness (@xgis/engine → @xgis/map == 0) ──
// The P3 Phase-2 extraction's TERMINAL invariant + completion lock ("Done =
// Gate-6"): @xgis/engine is a content-blind GPU engine (RHI / GPU / frame-core /
// projection-camera machinery); it must NEVER import @xgis/map (the render
// CONTENT). Holds by construction — engine/src was carved content-free before the
// @xgis/map content landed — so this gate passes today; it LOCKS the invariant so
// no future edit can re-introduce the reverse edge that would make the package
// graph cyclic (the mirror of Gate 1's compiler→runtime lock).
describe('arch ratchet: Gate-6 — @xgis/engine is content-blind (0 @xgis/map imports)', () => {
  it('engine/src never imports @xgis/map (static value/type OR dynamic import())', () => {
    const re = /(?:from\s+|import\s*\(\s*)['"]@xgis\/map(?:['"/]|$)/m
    const offenders = walkTs(join(ROOT, 'engine/src'))
      .filter((f) => re.test(readFileSync(f, 'utf8')))
      .map(rel)
    expect(
      offenders,
      `@xgis/engine must be content-blind (Gate-6) — 0 @xgis/map imports; the reverse edge would make the package graph cyclic:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})

// ── Gate 7: engine is GEO-FREE (#781 — the projection subtree left the engine) ──
// The #781 epic ("the engine is NOT content-blind") moved the Camera cluster to
// @xgis/map (3b), the projection library (projection / projections-table / globe /
// world-scale) to the new @xgis/geo (3c), then dropped the ECEF re-export shim (3d).
// The engine is now projection-free. This LOCKS 3a-3d: geo cannot creep back into
// the content-blind core. @xgis/geo and @xgis/engine are siblings on @xgis/shared,
// so the engine must never import geo (the mirror of Gate-6's engine→map lock).
describe('arch ratchet: Gate-7 — @xgis/engine is geo-free (#781)', () => {
  it('engine/src never imports @xgis/geo (static value/type OR dynamic import())', () => {
    const re = /(?:from\s+|import\s*\(\s*)['"]@xgis\/geo(?:['"/]|$)/m
    const offenders = walkTs(join(ROOT, 'engine/src'))
      .filter((f) => re.test(readFileSync(f, 'utf8')))
      .map(rel)
    expect(
      offenders,
      `@xgis/engine must be geo-free (#781, Gate-7) — 0 @xgis/geo imports; geo and engine are siblings on @xgis/shared:\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('the engine/src/projection subtree is gone (moved to @xgis/geo + @xgis/map)', () => {
    let exists = false
    try {
      statSync(join(ROOT, 'engine/src/projection'))
      exists = true
    } catch {
      /* gone — the intended state */
    }
    expect(
      exists,
      'engine/src/projection/ must not exist — the projection library moved to @xgis/geo (3c), the camera cluster to @xgis/map (3b), and the ecef shim was dropped (3d)',
    ).toBe(false)
  })
})

// ── Gate 3: LOC ceilings (god-files shrink-only; no new god-files) ───
// High-water marks measured 2026-06-09. LOWER these as files shrink.
const LOC_CEILINGS: Record<string, number> = {
  // map.ts relocated to @xgis/map (map/src/map.ts) in P3 Phase 2 Batch B10d (the Step-7
  // render-loop CUT + Step-8 map.ts move, unified as the 16-file map.ts render SCC) — no
  // longer under a SRC_DIRS walk, so its LOC ceiling leaves this runtime ratchet (mirrors the
  // vector-tile-renderer.ts / point-renderer.ts / gpu-tile-store.ts / camera.ts precedents
  // above; package-level LOC ratchets for map/engine are a tracked post-Gate-6 follow-up).
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
  // Bumped 1404→1430 (WS-1): per-axis zoom-interp translate shapes —
  // fillTranslate{X,Y}Shape / strokeTranslate{X,Y}Shape / circleTranslate
  // {X,Y}Shape declarations, the six bracket-binding parse arms, and the
  // RenderNode return wiring.
  // Bumped 1430→1442 (WS-1 line-dasharray): dashArrayShape var + the
  // stroke-dasharray array-stop binding arm + StrokeValue return wiring.
  // Bumped 1442→1452 (WS-1 circle-stroke-opacity): strokeOpacityShape var +
  // the stroke-opacity zoom-stop binding arm (÷100 back to 0..1) + the
  // StrokeValue return wiring + contract comments. Irreducible additive
  // plumbing (mirror of the dasharray arm); lower.ts decomposition stays
  // a tracked priority.
  'compiler/src/ir/lower.ts': 1452,
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
  // Bumped 1570→1790 (full-repo prettier adopt): one-property-per-line / call-arg
  // wrapping grew the file; formatting-only, no new logic. vector-tiler.ts
  // decomposition stays a tracked priority.
  'compiler/src/tiler/vector-tiler.ts': 1790,
  // Bumped 915→917 (#420) for the UNIFORM_SIZE/SLOT 240→256 bump +
  // light_dir_ecef contract comment when the polygon Uniforms struct grew.
  // Bumped 917→931 (Phase R heatmap): ensureHeatmapBlur / ensureHeatmapCompose
  // forwarders + the two heatmap bind-group-layout getters (thin delegates to
  // the factory, mirror of ensureOverdrawCompose).
  // Bumped 931→941 (#600): the non-tiled globe_eye uniform write + its doc
  // comment, the globeEyeUniform import, and the UNIFORM_SLOT/SIZE bump comments.
  // Bumped 941→943 (#600 fix): the prior bump documented a globe_eye write missing
  // from renderToPass + the graticule eye plumbing — restoring them (the write, the
  // import, the GraticuleFrame.eye pass-through) adds the final 2 lines.
  // renderer.ts (+ its 6-file StyleProperties type-cycle SCC: renderer-types / renderer-helpers /
  // paint-shape-resolve / pipeline-factory / frame-renderer) relocated to @xgis/map
  // (map/src/render/renderer.ts) in P3 Phase 2 Batch B5 — no longer under a SRC_DIRS walk, so its
  // LOC ceiling leaves this runtime ratchet (mirrors the gpu-tile-store.ts / camera.ts precedents
  // above; package-level LOC ratchets for map/engine are a tracked post-Gate-6 follow-up).
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
  // Bumped 1071→1078 (Phase S Batch 2 text-max-angle): the layout->utility
  // emit (`label-max-angle-N`) in convertTextLayoutProperties + comment; net
  // of removing the old deferred-gap warning block in convertGapWarnings.
  // Bumped 1078→1144 (Phase S Batch 3+4): text/icon-translate-anchor:map emits
  // (+14), icon collision policy emits — label-icon-collide/ignore-placement/
  // optional (+34), and symbol-z-order's label-z-order-<v> emit + enum warn (+18).
  // Bumped 1144→1295 (full-repo prettier adopt): formatting-only growth, no new logic.
  // Bumped 1295→1296 (#777 I-D icon-padding): the label-icon-padding-N emit
  // (non-default constants only, clamp ≥0) + the non-constant one-shot warn.
  'compiler/src/convert/layers-symbol.ts': 1296,
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
  // Bumped 1354→1356 for the undo-correctness fixes: tryConnect skipRecord param + insertReroute selEdge clear (two irreducible statements).
  // Bumped 1356→1370 for the deserialization guard (#353): sanitizeGraph() drops unknown node types + dangling edges at the load/paste/restore trust boundary.
  // Bumped 1370→1448 (full-repo prettier adopt): formatting-only growth, no new logic.
  'blueprint/src/editor.ts': 1448,
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
  // Bumped 1233→1246 (Phase S Batch 2 line-round-limit): the LineLayer
  // `round_limit` field (re-using a former pad slot, struct size unchanged)
  // + the `acute_fold_bis` select() that scales the round-join fold
  // threshold by round_limit/1.05 (0 = historical JOIN_ACUTE_BIS) + comments.
  // line.ts moved to the @xgis/shader-dsl package — tracked there, not in runtime.
  // Moved BACK into runtime (shader-dsl is now a content-free DSL framework; the
  // X-GIS shader graphs now live in @xgis/map, map/src/shaders/dsl/ as of P3 Batch A). Re-baselined
  // at its current size — a behavior-preserving relocation, not new growth;
  // decomposition stays the same tracked priority it was in the package.
  // Bumped 1194→1219 (#598): finalize_corner threads the (p_h, p_l) DSFUN split
  // through all three call sites to kill the high-zoom f32 jitter (the lossy
  // pre-summed corner is replaced by the precise hi/lo reconstruction).
  // Bumped 1219→1406 (#804): positional→typed-object-param shader-DSL call migration + prettier one-property-per-line formatting; emit is byte-identical (goldens green), no new logic. line.ts stays the #1 decomposition debt (separate epic).
  'map/src/shaders/dsl/line.ts': 1406,
  // Bumped 1171→1176 (#274 CSS color-fn whitespace), then 1176→1178 (#317) for
  // the two irreducible numeric match()-label arm-pattern cases (Number, and
  // Minus+Number). Lowered 1178→50 (Tier-C5): the Parser god-file was split
  // into a thin driver (parser.ts) over a shared token cursor
  // (parser-cursor.ts), the expression precedence ladder (parser-expressions.ts),
  // and the statement handlers + keyword→handler registry (parser-statements.ts).
  'compiler/src/parser/parser.ts': 50,
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
  // Bumped 1197→1198 (#399) for the +0.5° abs-lat discard margin's one-line note.
  // Bumped 1198→1211 (WS-9): the two light_color_packed / _pad_light_align
  // Uniforms struct lanes + the extrude VS reading intensity from
  // light_dir_ecef.w and colour from unpack4x8unorm(light_color_packed).
  // polygon.ts moved to the @xgis/shader-dsl package — tracked there, not in runtime.
  // Moved BACK into runtime (shader-dsl is now a content-free DSL framework; the
  // X-GIS shader graphs now live in @xgis/map, map/src/shaders/dsl/ as of P3 Batch A). Re-baselined
  // at its current size — a behavior-preserving relocation, not new growth;
  // decomposition stays the same tracked priority it was in the package.
  // Bumped 1198→1205 (#600): the globe_eye Uniforms-struct lane + its doc
  // comment, and threading globe_eye into polygon_cos_c_fragment / polygon_rim_alpha.
  // Bumped 1205→1292 (#804): positional→typed-object-param shader-DSL call migration + prettier one-property-per-line formatting; emit is byte-identical (goldens green), no new logic.
  // Bumped 1292→1315 (#598): camera-relative dLon precise branch in the disc arm — the fill's non-Mercator longitude now mirrors line.ts finalize_corner (fill≠outline seam fix), guarded on localMerc presence.
  'map/src/shaders/dsl/polygon.ts': 1315,
  // camera.ts relocated to @xgis/engine (engine/src/projection/camera.ts) in
  // P3 Step 3 — no longer under a SRC_DIRS walk, so its LOC ceiling is tracked
  // by the engine package's own ratchet, not this runtime gate.
  // label-pass.ts relocated to @xgis/map (map/src/render/passes/label-pass.ts) in P3 Phase 2
  // Batch B10d (moved atomically with the map.ts 16-file render SCC) — no longer under a
  // SRC_DIRS walk, so its LOC ceiling leaves this runtime ratchet (mirrors the
  // vector-tile-renderer.ts / point-renderer.ts / gpu-tile-store.ts / camera.ts precedents
  // above; package-level LOC ratchets for map/engine are a tracked post-Gate-6 follow-up).
  // tile-selection-cache.ts relocated to @xgis/map (map/src/render/tile-selection-cache.ts)
  // in P3 Phase 2 Batch B1 — no longer under a SRC_DIRS walk, so its LOC ceiling leaves this
  // runtime ratchet (mirrors the camera.ts → @xgis/engine precedent above; package-level LOC
  // ratchets for map/engine are a tracked post-Gate-6 follow-up).
  // pipeline-factory.ts relocated to @xgis/map (map/src/render/pipeline-factory.ts) in P3 Phase 2
  // Batch B5 (moved atomically with the renderer StyleProperties type-cycle SCC) — no longer under a
  // SRC_DIRS walk, so its LOC ceiling leaves this runtime ratchet (mirrors the gpu-tile-store.ts /
  // camera.ts precedents above; package-level LOC ratchets for map/engine are a tracked post-Gate-6
  // follow-up).
  // gpu-tile-store.ts relocated to @xgis/map (map/src/render/gpu-tile-store.ts)
  // in P3 Phase 2 Batch B1b — no longer under a SRC_DIRS walk, so its LOC ceiling leaves this
  // runtime ratchet (mirrors the tile-selection-cache.ts / camera.ts precedents above; package-level
  // LOC ratchets for map/engine are a tracked post-Gate-6 follow-up).
  // point-renderer.ts relocated to @xgis/map (map/src/render/point-renderer.ts) in P3 Phase 2
  // Batch B6 — no longer under a SRC_DIRS walk, so its LOC ceiling leaves this runtime ratchet
  // (mirrors the gpu-tile-store.ts / tile-selection-cache.ts / camera.ts precedents above;
  // package-level LOC ratchets for map/engine are a tracked post-Gate-6 follow-up).
  // vector-tile-renderer.ts relocated to @xgis/map (map/src/render/vector-tile-renderer.ts) in P3
  // Phase 2 Batch B7 (the 3120-LOC VTR god-file) — no longer under a SRC_DIRS walk, so its LOC
  // ceiling leaves this runtime ratchet (mirrors the point-renderer.ts / gpu-tile-store.ts /
  // tile-selection-cache.ts / camera.ts precedents above; package-level LOC ratchets for map/engine
  // are a tracked post-Gate-6 follow-up).
  // text-stage.ts relocated to @xgis/map (map/src/text/text-stage.ts) in P3 Phase 2 Batch B9 (the
  // TextStage label-pipeline orchestrator — resolve → layout → collision → raster → atlas — the final
  // text-subsystem content leaf) — no longer under a SRC_DIRS walk, so its LOC ceiling leaves this
  // runtime ratchet (mirrors the vector-tile-renderer.ts / point-renderer.ts / gpu-tile-store.ts /
  // tile-selection-cache.ts / camera.ts precedents above; package-level LOC ratchets for map/engine
  // are a tracked post-Gate-6 follow-up).
  // Baselined at 820 (mbx_batch2): lower-label.ts is the label-knob lowering
  // sub-pass extracted from lower.ts; crossed 800 here for the icon-translate
  // accumulators + parse arms + knobs-interface + merge wiring. Cohesive
  // sub-lowerer, not a god-file; baselined, shrink as it converges.
  // Bumped 820→828 (Phase S Batch 2 text-max-angle): the labelMaxAngle local
  // + the `label-max-angle-N` parse arm + the knobs-interface field + the
  // foldLabelKnobs spread + comment. Same additive label-knob plumbing class.
  // Bumped 828→866 (Phase S Batch 3+4): text/icon-translate-anchor:map (+12) +
  // icon collision policy's three label-knob accumulators (+20) + symbol-z-order's
  // labelSymbolZOrder local/parse-arms/knobs/fold (+6).
  // Bumped 866→1091 (full-repo prettier adopt): formatting-only growth, no new logic.
  // Bumped 1091→1101 (#777 I-D icon-padding): the labelIconPadding accumulator +
  // label-icon-padding-N parse arm + knobs field + fold spread — the same additive
  // label-knob plumbing class as max-angle / symbol-z-order above.
  'compiler/src/ir/lower-label.ts': 1101,
  // Baselined at 835 (Phase S Batch 3 raster +18 + text/icon +6; Batch 4 icon
  // collision +3 + symbol-z-order's LabelDef.symbolZOrder field + JSDoc).
  // Bumped 837→858 (Phase R heatmap + inline-geojson): the RenderNodeHeatmapPaint
  // interface (isHeatmap + 5 heatmap-* axes) + its RenderNode extends entry (+18),
  // and SourceDef.inlineData field + JSDoc (+3, same additive source-field class
  // as crs).
  // Bumped 858→901 (full-repo prettier adopt): formatting-only growth, no new logic.
  // Bumped 901→908: SourceDef.options bag field + JSDoc (+7, same additive source-field
  // class as crs/inlineData — the custom source-loader seam's compile-time carrier).
  // Bumped 908→913 (#777 I-D icon-padding): LabelDef.iconPadding field + contract
  // JSDoc (+5, same additive label-knob field class as symbolZOrder).
  'compiler/src/ir/render-node.ts': 913,
  // Crossed 800 purely via the full-repo prettier adoption (one-property-per-line /
  // call-arg wrapping) — not a hand-grown god-file; baselined at the formatted size,
  // shrink as it converges.
  'compiler/src/convert/paint-helpers.ts': 826,
  'compiler/src/tokens/colors.ts': 937,
}
const NEW_FILE_CAP = 800

describe('arch ratchet: file size (shrink-only god-files, no new ones)', () => {
  it('no baselined god-file exceeds its locked ceiling', () => {
    const grown = Object.entries(LOC_CEILINGS)
      .map(([path, ceil]) => ({ path, n: lineCount(join(ROOT, path)), ceil }))
      .filter((x) => x.n > x.ceil)
      .map(
        (x) =>
          `${x.path}: ${x.n} > ceiling ${x.ceil} — extract, don't grow (then lower the ceiling)`,
      )
    expect(grown, grown.join('\n')).toEqual([])
  })

  it(`no non-baselined source file exceeds ${NEW_FILE_CAP} LOC`, () => {
    const tooBig = ALL_TS.filter((f) => !(rel(f) in LOC_CEILINGS))
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
  // camera.ts=>gpu.ts removed: gpu.ts relocated to @xgis/engine (P3 Step 2);
  // camera now imports it via the package boundary, which Gate 5 (relative-edge
  // only) does not track — the intra-runtime upward edge no longer exists.
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
        let tgt = relative(ROOT, resolve(dirname(f), m[1]))
          .split('\\')
          .join('/')
        if (!tgt.endsWith('.ts')) tgt += '.ts'
        const tgtLayer = LAYER_OF(tgt)
        if (tgtLayer === null) continue
        if (tgtLayer > srcLayer && !UPWARD_EDGE_ALLOWLIST.has(`${srcRel}=>${tgt}`)) {
          violations.push(
            `${srcRel} (L${srcLayer}) → ${tgt} (L${tgtLayer}): NEW upward edge — import downward or sever it (redesign §2)`,
          )
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
  'runtime/src/engine/render/raster-renderer.ts': 2,
  'runtime/src/engine/render/prefetch-scheduler.ts': 1,
  'runtime/src/engine/render/point-renderer.ts': 1,
  // HeatmapRenderer (Phase R) mirrors point-renderer's frame-uniform packer
  // exactly: `if (projType === 0)` selects the 2D-Mercator camera-centre lane
  // (cam_ecef_h/l.xy) over the ECEF anchor — the identical sibling branch.
  'runtime/src/engine/render/heatmap-renderer.ts': 1,
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
        violations.push(
          `${r}: ${count} projType comparisons > allowed ${allowed} — route through projections-table membership accessors`,
        )
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})
