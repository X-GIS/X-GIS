// ═══ Polygon SPLIT-mode module — derived from the legacy module by IR
//     transform (#2042 INC-4a) ═══
//
// The three-range rebind (docs/plans/2026-08-24-uniform-block-split.md)
// needs a polygon shader that reads FrameBlock(11) / ShowBlock(10) /
// TileBlock(7) instead of the single ring-staged `Uniforms`(0). Authoring a
// second module (or threading a mode through polygon.ts) was rejected: the
// entry functions are top-level consts whose IR is built once at import
// (module-scope eagerness — the dsl-runtime-hazard class), so a mode
// variable cannot reach them, and relocating ~500 lines into factories
// churns a ceiling-capped file and risks the legacy bytes.
//
// Instead the split module is DERIVED: take the assembled legacy module
// (data), rewrite every uniform read, and swap the struct + binding
// declarations. Two read forms exist and both are plain IR:
//   • DSL-built reads — `member` chains rooted at the block's binding
//     varref (`bindingRef('u', Uniforms)`; sot.ts),
//   • compiler-spliced paint expressions — dotted `varref` names
//     (`u.zoom`, varRefVec4's contract) emitted verbatim.
//
// Routing is derived from the three destination declarations THEMSELVES
// (the same source uniform-split-partition.test.ts reflects — no second
// authority). Retired lanes rewrite to their derived equivalents, so the
// legacy module's flag-selects survive as selects whose BOTH arms compute
// the recombined value — correct under either flag value, no fragile
// select-matching (CSE merges the identical subtractions at emit):
//   cam_ecef_off_h → vec4(tile_ecef_center_h − cam_ecef_center_h, .w =
//                     show.fill_antialias)          [the relocated flag lane]
//   cam_ecef_off_l → vec4(…_l − …_l, .w = show.fill_vertical_gradient)
//   cam_h / cam_l  → cam_merc_center_hl − tile_origin_merc_hl (.xy / .zw)
//   tile_origin_merc → tile_origin_merc_hl.xy
// A `u` read that matches NO destination and NO derivation throws at build
// time, naming the field — a partition gap must fail the emit, not render
// zeros (#600 class).
//
// Scope: WGSL only (the split pipeline family is WebGPU-only until the
// WebGL2 twin gets a consumer — plan doc, INC-2 note). Nothing binds this
// module yet; INC-4b builds the pipeline family. The structure gate
// (polygon-split-emit.test.ts) asserts the transform's completeness.

import { emitModule, reachFrom, rewriteExprsInFunc, vec2, vec4 } from '@xgis/shader-dsl'
import type { Expr } from '@xgis/shader-dsl'
import { buildPolygonModule, type PolygonVariantSpec } from './polygon'
import { tileBlockU } from './tile-block'
import { showBlockU } from './show-block'
import { frameBlockU } from './frame-block'

type ModuleDecl = ReturnType<typeof buildPolygonModule>

const FRAME_FIELDS = new Set(frameBlockU.struct.fields.map((f) => f.name))
const SHOW_FIELDS = new Set(showBlockU.struct.fields.map((f) => f.name))
const TILE_FIELDS = new Set(tileBlockU.struct.fields.map((f) => f.name))

const destNodeOf = (field: string): Expr | null =>
  FRAME_FIELDS.has(field)
    ? (frameBlockU.node.expr as Expr)
    : SHOW_FIELDS.has(field)
      ? (showBlockU.node.expr as Expr)
      : TILE_FIELDS.has(field)
        ? (tileBlockU.node.expr as Expr)
        : null

/** Derived replacements for the RETIRED legacy lanes (fresh tree per use —
 *  emit-time only, CSE dedups repeats). Built through the DSL so the shapes
 *  stay type-checked against the destination declarations. */
const derived: Record<string, () => Expr> = {
  cam_ecef_off_h: () => {
    const t = tileBlockU.field.tile_ecef_center_h
    const c = frameBlockU.field.cam_ecef_center_h
    return vec4(t.x.sub(c.x), t.y.sub(c.y), t.z.sub(c.z), showBlockU.field.fill_antialias).expr
  },
  cam_ecef_off_l: () => {
    const t = tileBlockU.field.tile_ecef_center_l
    const c = frameBlockU.field.cam_ecef_center_l
    return vec4(t.x.sub(c.x), t.y.sub(c.y), t.z.sub(c.z), showBlockU.field.fill_vertical_gradient)
      .expr
  },
  cam_h: () => {
    const m = frameBlockU.field.cam_merc_center_hl
    const o = tileBlockU.field.tile_origin_merc_hl
    return vec2(m.x.sub(o.x), m.y.sub(o.y)).expr
  },
  cam_l: () => {
    const m = frameBlockU.field.cam_merc_center_hl
    const o = tileBlockU.field.tile_origin_merc_hl
    return vec2(m.z.sub(o.z), m.w.sub(o.w)).expr
  },
  tile_origin_merc: () => {
    const o = tileBlockU.field.tile_origin_merc_hl
    return vec2(o.x, o.y).expr
  },
}

/** Build the read-rewriter for ONE legacy block shape. The polygon module's
 *  block is `struct Uniforms`; the line module's byte-mirror is
 *  `struct TileUniforms` (line.ts — same lanes, pads for the unread ones),
 *  so the SAME partition + derivations apply and only the struct tag
 *  differs. Exported for line-split.ts (#2042 INC-4c) — one rewriter
 *  authority, no drift. */
export const makeSplitRewriteRead =
  (legacyStructName: string) =>
  (e: Expr): Expr => {
    const isLegacyURef = (x: Expr): boolean =>
      x.op === 'varref' &&
      x.name === 'u' &&
      x.type.kind === 'struct' &&
      x.type.name === legacyStructName
    // DSL-built read: member rooted at the legacy binding varref.
    if (e.op === 'member' && isLegacyURef(e.base)) {
      const make = derived[e.field]
      if (make) return make()
      const dest = destNodeOf(e.field)
      if (!dest)
        throw new Error(
          `uniform split: 'u.${e.field}' has no destination block and no derivation — ` +
            'the Frame/Show/Tile partition (uniform-split-partition.test.ts) must cover it first',
        )
      return { ...e, base: dest }
    }
    // Compiler-spliced read: dotted varref name. Only partitioned paint/frame
    // lanes are legal here — a spliced read of a retired anchor lane has no
    // meaning and fails loud.
    if (e.op === 'varref' && e.name.startsWith('u.')) {
      const field = e.name.slice(2)
      const dest = destNodeOf(field)
      if (!dest)
        throw new Error(
          `uniform split: spliced read '${e.name}' has no destination block — ` +
            'compiler-generated expressions may only read partitioned lanes',
        )
      return { op: 'member', type: e.type, base: dest, field } as Expr
    }
    return e
  }

const rewriteRead = makeSplitRewriteRead('Uniforms')

/** Build the split-mode polygon module for `variant`/`pickEnabled` by
 *  transforming the legacy module. Pure derivation — polygon.ts's authored
 *  emit is untouched, so the legacy bytes cannot drift. */
export function buildPolygonSplitModule(
  variant: PolygonVariantSpec | null,
  pickEnabled: boolean,
): ModuleDecl {
  const legacy = buildPolygonModule(variant, pickEnabled)
  const structs = legacy.structs.map((s) =>
    s.name === 'Uniforms' ? [frameBlockU.decl, showBlockU.decl, tileBlockU.decl] : [s],
  )
  const bindings = legacy.bindings.flatMap((b) =>
    b.name === 'u' ? [frameBlockU.binding, showBlockU.binding, tileBlockU.binding] : [b],
  )
  return {
    ...legacy,
    structs: structs.flat(),
    bindings,
    funcs: legacy.funcs.map((f) => rewriteExprsInFunc(f, rewriteRead)),
  }
}

/** Split-mode WGSL emit — the INC-4b pipeline family's shader source. */
export const emitPolygonSplitWgsl = (
  variant: PolygonVariantSpec | null,
  pickEnabled: boolean,
): string => emitModule(buildPolygonSplitModule(variant, pickEnabled))

/** The three blocks the split rewrite creates, by binding NAME. They ARE the
 *  contents of the split group-0 layout (`PipelineFactory.SPLIT_FILL_LAYOUT_ENTRIES`,
 *  bindings 7/10/11) — `split-bind-eligibility.test.ts` pins the two to the same
 *  triple, so this stays a derivation of the layout rather than a fourth copy of it. */
const SPLIT_BLOCK_NAMES: ReadonlySet<string> = new Set([
  frameBlockU.binding.name,
  showBlockU.binding.name,
  tileBlockU.binding.name,
])

/** #2572 — can the pipeline whose entry points are `entryNames` draw through the
 *  split group-0 bind group? True iff those entries REACH no group-0 binding beyond
 *  the three split blocks.
 *
 *  The question is per-ENTRY-PAIR, which is why the emitted text cannot answer it:
 *  one module carries every entry point (nine on the polygon side, four on the line
 *  side) and its text is their UNION, so `fs_fill_pattern`'s sprite atlas (bindings
 *  5/6) appears in every polygon module — including the base one, whose fill entries
 *  touch neither. A driver validates statically-USED resources, so what it keeps is
 *  the reachable set; `reachFrom` is that same walk, over the IR and without an emit.
 *
 *  Throws when an entry name is not in the module. That is deliberate: an unreachable
 *  name would otherwise reach NOTHING, and the empty set fits every layout — the one
 *  way this check could answer "eligible" for a pipeline it never looked at. */
export function fitsSplitLayout(m: ModuleDecl, entryNames: readonly string[]): boolean {
  const entries = entryNames.map((name) => {
    const f = m.funcs.find((fn) => fn.name === name)
    if (!f) throw new Error(`fitsSplitLayout: no entry point '${name}' in the module`)
    return f
  })
  const reached = reachFrom(m, entries).bindings
  return !m.bindings.some(
    (b) => b.group === 0 && reached.has(b.name) && !SPLIT_BLOCK_NAMES.has(b.name),
  )
}
