// ═══ Shader Variant Generator: pure helpers ═══
// Side-effect-free helpers extracted from shader-gen.ts. None close
// over module-level mutable state; each is a pure transform of its
// inputs. Kept here so shader-gen.ts stays focused on the variant
// generation + value-processing core.

import { hexToRgba } from '../ir/render-node'
import { resolveColor } from '../tokens/colors'
import { canonicalJsonStringify } from './_util/canonical-json'

export function buildFieldMap(fields: Set<string>): Map<string, number> {
  const map = new Map<string, number>()
  let offset = 0
  for (const field of [...fields].sort()) {
    map.set(field, offset++)
  }
  return map
}

/** Stable short hash of the fill / stroke match-preamble bodies.
 *  Returns empty string when both are absent so non-match variants
 *  keep their existing cache key bytes unchanged.
 *
 *  Phase 2.5 US-010 prep — accepts either the legacy WGSL string
 *  match-preamble (pre-retarget compiler) or a NodeLike value (the
 *  matchExpr Node post-US-005). The Node path canonicalises the
 *  structural JSON before hashing so the cache identity stays stable
 *  across engines / Node.js versions (raw JSON.stringify's key-order
 *  is implementation-defined for non-numeric keys). Either input
 *  funnels through the same djb2 hash so the output bytes don't drift
 *  during the migration window. */
export function matchArmsKey(
  fillPre: string | { readonly expr: unknown } | undefined,
  strokePre: string | { readonly expr: unknown } | undefined,
): string {
  if (fillPre == null && strokePre == null) return ''
  const combined = `${toHashInput(fillPre)}${toHashInput(strokePre)}`
  if (combined.length === 0) return ''
  let h = 5381
  for (let i = 0; i < combined.length; i++) {
    h = (h * 33) ^ combined.charCodeAt(i)
    h |= 0
  }
  return `|m:${(h >>> 0).toString(36)}`
}

function toHashInput(v: string | { readonly expr: unknown } | undefined): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  // Node-shaped input: canonicalise its structural JSON so the hash
  // is stable across engines / Node.js versions (raw JSON.stringify
  // key-order is implementation-defined for non-numeric keys).
  return canonicalJsonStringify(v)
}

/** Resolve a color from an AST node (Identifier like "green-100") */
export function resolveColorFromAST(node: import('../parser/ast').Expr): [number, number, number, number] | null {
  if (node.kind === 'Identifier') {
    const hex = resolveColor(node.name)
    if (hex) return hexToRgba(hex)
  }
  if (node.kind === 'StringLiteral') {
    const hex = resolveColor(node.value)
    if (hex) return hexToRgba(hex)
  }
  // Hex literal direct from a synthesized AST (e.g. mergeLayers'
  // `match() { value -> #rrggbbaa }` arms) AND user-authored short
  // forms (`fill: #fff`). Without the 4/5 lengths the short form
  // would collapse to "no colour" — fragment match preambles end up
  // containing only the default variable declaration, variant cache
  // keys collide across compounds, and the wrong pipeline gets
  // shared. CSS allows 3/4/6/8 hex digits (lengths 4/5/7/9 with #).
  if (node.kind === 'ColorLiteral' && typeof node.value === 'string') {
    const hex = node.value
    if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) {
      return hexToRgba(hex)
    }
  }
  // Hyphenated color names parsed as subtraction: sky-300 → Identifier("sky") - NumberLiteral(300)
  if (node.kind === 'BinaryExpr' && node.op === '-'
      && node.left.kind === 'Identifier'
      && node.right.kind === 'NumberLiteral') {
    const colorName = `${node.left.name}-${node.right.value}`
    const hex = resolveColor(colorName)
    if (hex) return hexToRgba(hex)
  }
  // CSS rgb / rgba / hsl / hsla function call. Reconstruct the
  // source-text from the AST so the same parser in resolveColor()
  // (which already handles the string form) can produce hex.
  if (node.kind === 'FnCall' && node.callee.kind === 'Identifier') {
    const name = node.callee.name.toLowerCase()
    if (name === 'rgb' || name === 'rgba' || name === 'hsl' || name === 'hsla') {
      const reconstructed = reconstructCssFnCall(node)
      if (reconstructed) {
        const hex = resolveColor(reconstructed)
        if (hex) return hexToRgba(hex)
      }
    }
  }
  return null
}

/** Reconstruct a CSS-style function call string (e.g. "rgb(255, 0,
 *  0)" or "hsl(120deg, 50%, 50%)") from a parsed FnCall AST. Numeric
 *  literals and identifiers are emitted verbatim; anything else
 *  yields null so resolveColorFromAST falls through. */
function reconstructCssFnCall(call: { callee: import('../parser/ast').Expr; args: import('../parser/ast').Expr[] }): string | null {
  if (call.callee.kind !== 'Identifier') return null
  const parts: string[] = []
  for (const a of call.args) {
    const piece = exprToCssArg(a)
    if (piece === null) return null
    parts.push(piece)
  }
  return `${call.callee.name}(${parts.join(', ')})`
}

function exprToCssArg(node: import('../parser/ast').Expr): string | null {
  if (node.kind === 'NumberLiteral') return String(node.value)
  // `50%` parses as Identifier("%") preceded by a number? No — the
  // lexer doesn't produce a `%` token. CSS percent literals can't be
  // expressed in the parser today; users wanting hsl() must drop the
  // `%` (`hsl(120, 50, 50)` — the colour parser tolerates the
  // unitless form). Same story for `0.5` alpha which parses cleanly.
  if (node.kind === 'Identifier') return node.name
  // `120deg` / `0.5turn`: BinaryExpr would be wrong, but the lexer
  // recognises `deg` etc. as Px-equivalent unit tokens that stick to
  // the preceding number — so a user writing `hsl(120deg, ...)`
  // actually emits a single Identifier("120deg") via parseUtilityName
  // up the chain. Out of scope here.
  return null
}
