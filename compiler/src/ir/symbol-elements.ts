// ═══ `symbol` block elements → path geometry (#1550) ═══
//
// The grammar has documented four symbol elements since Major 1 (`docs/spec/xgis-language.md` §2.8)
// and the parser has built AST nodes for all four; only `path` ever reached the renderer. The other
// three were dropped in `lower.ts` with no diagnostic, which is worse than unimplemented: a symbol
// with no `path` registered NO shape, and the reference then fell through `getShapeId`'s `?? 0` to
// the built-in CIRCLE — so an author saw a plain circle and nothing anywhere said why. The
// specification's own example (`symbol arrow { path "…" anchor: center }`) was affected.
//
// `rect` and `circle` become PATHS here rather than a second geometry kind downstream. There is one
// path parser in the repo (`map/src/text/sdf-shape.ts`) and one SDF evaluator; adding a primitive
// would mean teaching both about a shape they can already express exactly. `circle` is four cubics
// because the pipeline keeps beziers as true curves (`kind: 2 = cubic`) instead of flattening them,
// so the circle is round at every zoom rather than round at the zoom someone chose a tolerance for.
//
// `anchor` is NOT applied here, and that is deliberate: placing it means knowing the geometry's
// bounding box, which means parsing the path — and the parser lives in the map package. Re-deriving
// a bbox here would be a second authority on what an SVG path means, so the anchor rides through to
// the single place that already parses (`ShapeRegistry.addUserShape`).

/** A lowered symbol: its geometry as paths, plus where its origin sits.
 *
 *  HERE rather than in `render-node.ts` because this module owns every rule about it (#1550), and
 *  because that file is at its LOC ceiling — the ratchet asked for the extraction and it was right.
 *  `render-node.ts` re-exports it, so every existing importer is unchanged. */
export interface SymbolDef {
  name: string
  paths: string[]
  /** Origin placement in the symbol's own bbox (#1550); absent = `center`. See symbol-elements.ts. */
  anchor?: string
}

/** Reads a numeric prop with a default — the grammar's `numeric-props` are all optional. */
const p = (props: Record<string, number>, key: string, dflt: number): number =>
  Number.isFinite(props[key]) ? props[key]! : dflt

/** Trim a float to a short, exact-enough decimal string. Keeps the emitted path readable, which
 *  matters because it is what a diagnostic or a snapshot shows the author. */
const n = (v: number): string => {
  const s = v.toFixed(4)
  return s.replace(/\.?0+$/, '') || '0'
}

/** `rect w: h:` (optionally `x:`/`y:` for the corner, default-centred) as a closed path. */
export function rectPath(props: Record<string, number>): string {
  const w = p(props, 'w', 1)
  const h = p(props, 'h', 1)
  const x = p(props, 'x', -w / 2)
  const y = p(props, 'y', -h / 2)
  return `M ${n(x)} ${n(y)} L ${n(x + w)} ${n(y)} L ${n(x + w)} ${n(y + h)} L ${n(x)} ${n(y + h)} Z`
}

/** `circle r:` (optionally `cx:`/`cy:`) as four cubic arcs.
 *
 *  `k = 4/3·(√2 − 1)` is the exact control-point offset for a quarter circle — the standard bezier
 *  circle constant, max radial error ~0.027 %. Not a tolerance anyone has to tune, because the
 *  curve is evaluated analytically rather than sampled. */
export function circlePath(props: Record<string, number>): string {
  const r = p(props, 'r', 0.5)
  const cx = p(props, 'cx', 0)
  const cy = p(props, 'cy', 0)
  const k = r * ((4 / 3) * (Math.SQRT2 - 1))
  const [x0, y0] = [cx + r, cy]
  return (
    `M ${n(x0)} ${n(y0)} ` +
    `C ${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} ` +
    `C ${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} ` +
    `C ${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} ` +
    `C ${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(x0)} ${n(y0)} Z`
  )
}

/** Where the symbol's origin sits relative to its own bounding box. Applied at registration, where
 *  the box is known. `center` is the historical default the renderer already behaves as.
 *
 *  NO CORNERS, and that is the language's constraint rather than an omission: the grammar's anchor
 *  value is an `IDENT` (§2.8) and identifiers carry no hyphen (§1.6) — `anchor: top-left` lexes as
 *  the expression `top - left` and dies in the symbol block with "Unexpected token: -". Adding
 *  corners means either a quoted-string form (`anchor: "top-left"`) or a hyphenated identifier
 *  class, and both are grammar changes governed by the parse-error stability contract (§4.1). Out
 *  of scope here; the five edge/centre anchors are what the language can actually express today. */
export const SYMBOL_ANCHORS = ['center', 'top', 'bottom', 'left', 'right'] as const

export type SymbolAnchor = (typeof SYMBOL_ANCHORS)[number]

export const isSymbolAnchor = (v: string): v is SymbolAnchor =>
  (SYMBOL_ANCHORS as readonly string[]).includes(v)

/** Lower a `symbol` block to its geometry, reporting what it could not use.
 *
 *  Here rather than in `lower.ts` because the LOC ratchet is right: the symbol block's own rules —
 *  which elements produce paths, which anchors exist, what an empty block means — belong beside the
 *  functions that implement them, not in the middle of the program-wide lowering loop. Returns null
 *  when the block declares no geometry at all; the diagnostic explains why, which is the whole point
 *  of #1550 (it used to return nothing and say nothing, and the reference resolved to a circle). */
export function lowerSymbol(
  stmt: { name: string; elements: readonly SymbolElementLike[]; line: number },
  diagnostics: DiagnosticSink[],
): { name: string; paths: string[]; anchor?: string } | null {
  const paths: string[] = []
  let anchor: string | undefined
  for (const el of stmt.elements) {
    if (el.kind === 'path') paths.push(el.data)
    else if (el.kind === 'rect') paths.push(rectPath(el.props))
    else if (el.kind === 'circle') paths.push(circlePath(el.props))
    else if (el.kind === 'anchor') {
      if (isSymbolAnchor(el.value)) anchor = el.value
      else
        diagnostics.push({
          severity: 'warn',
          code: 'X-GIS0015',
          span: { line: stmt.line, col: 1 },
          message:
            `Symbol "${stmt.name}" has \`anchor: ${el.value}\`, which is not a known anchor. ` +
            `Expected one of ${SYMBOL_ANCHORS.join(', ')}. The symbol is centred instead.`,
        })
    }
  }
  if (paths.length === 0) {
    diagnostics.push({
      severity: 'warn',
      code: 'X-GIS0016',
      span: { line: stmt.line, col: 1 },
      message:
        `Symbol "${stmt.name}" declares no geometry — it needs at least one \`path\`, \`rect\` ` +
        `or \`circle\`. References to it fall back to a circle.`,
    })
    return null
  }
  return { name: stmt.name, paths, ...(anchor ? { anchor } : {}) }
}

/** The AST element shapes this module reads, structurally — so it does not import the parser. */
type SymbolElementLike =
  | { kind: 'path'; data: string }
  | { kind: 'rect'; props: Record<string, number> }
  | { kind: 'circle'; props: Record<string, number> }
  | { kind: 'anchor'; value: string }

interface DiagnosticSink {
  severity: string
  code: string
  span: { line: number; col: number }
  message: string
}
