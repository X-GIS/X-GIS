// #2517 — ONE predicate for "this scene needs the sprite atlas", read by the
// lazy IconStage gate in label-pass.ts. Three reasons, each a Mapbox feature
// that draws from `sprite`:
//   1. an icon on a label show — `label-icon-image-<name>` (iconImage) or the
//      per-feature `label-icon-image-[<expr>]` (iconImageExpr, OFM POI layers);
//   2. a fill-pattern / line-pattern show (iter-177 / iter-178 — Liberty's
//      `landcover_wetland` + `road_area_pattern` declare no icon layer at all);
//   3. an inline `image(...)` inside a label's TEXT — Mapbox `["image", …]` in
//      a text-field / format section (#777 I-G).
// Until #2517 the gate knew only reasons 1 and 2, so a text-only style never
// fetched the sprite it declares and every inline image resolved to nothing —
// silently, because resolveInlineImageSprites drops an image whose atlas is
// absent by design ("keep the text, drop the image", the MapLibre rule for a
// MISSING sprite entry, which an un-fetched sprite is not). Extracted from
// label-pass.ts (at its LOC ceiling) so the three reasons are one authority
// with a unit test each, not an inline disjunction that grows a reason per
// incident.
import type { Expr, LabelDef, TextValue } from '@xgis/compiler'

/** The slice of a ShowCommand the predicate reads. */
export interface SpriteNeedShow {
  readonly label?: LabelDef
  readonly fillPattern?: string | null
  readonly linePattern?: string | null
}

/** True when any active label show references an icon or an inline image,
 *  or any show command carries a fill / line pattern. The caller still
 *  requires a `sprite` URL — without one there is nothing to fetch. */
export function spriteAtlasNeeded(
  labelShows: readonly SpriteNeedShow[],
  showCommands: readonly SpriteNeedShow[],
): boolean {
  return (
    labelShows.some((s) => s.label !== undefined && labelUsesSprite(s.label)) ||
    showCommands.some((s) => Boolean(s.fillPattern) || Boolean(s.linePattern))
  )
}

function labelUsesSprite(label: LabelDef): boolean {
  return (
    label.iconImage !== undefined ||
    (label as { iconImageExpr?: unknown }).iconImageExpr !== undefined ||
    textUsesInlineImage(label.text)
  )
}

/** Does the label's text expression call `image(...)`? `image` is the
 *  evaluator builtin that emits the inline-image marker the shaper carves out
 *  (compiler `eval/evaluator-helpers.ts`, `case 'image'`); the converter lowers
 *  Mapbox `["image", name]` to exactly that call, in a bare text-field or
 *  inside a `format` section, so a walk over every child expression finds it
 *  wherever the author put it. */
export function textUsesInlineImage(text: TextValue | undefined): boolean {
  if (text === undefined) return false
  if (text.kind === 'expr') return callsImage(text.expr.ast)
  return text.parts.some((p) => p.kind === 'interp' && callsImage(p.expr.ast))
}

function callsImage(e: Expr): boolean {
  switch (e.kind) {
    case 'FnCall':
      return (
        (e.callee.kind === 'Identifier' && e.callee.name === 'image') ||
        callsImage(e.callee) ||
        e.args.some(callsImage) ||
        (e.matchBlock !== undefined && e.matchBlock.arms.some((a) => callsImage(a.value)))
      )
    case 'BinaryExpr':
      return callsImage(e.left) || callsImage(e.right)
    case 'UnaryExpr':
      return callsImage(e.operand)
    case 'ConditionalExpr':
      return callsImage(e.condition) || callsImage(e.thenExpr) || callsImage(e.elseExpr)
    case 'ArrayLiteral':
      return e.elements.some(callsImage)
    case 'ObjectLiteral':
      return e.properties.some((p) => callsImage(p.value))
    case 'ArrayAccess':
      return callsImage(e.array) || callsImage(e.index)
    case 'FieldAccess':
      return e.object !== null && callsImage(e.object)
    case 'MatchBlock':
      return e.arms.some((a) => callsImage(a.value))
    default:
      // Literals, Identifier, InputRef — no children.
      return false
  }
}
