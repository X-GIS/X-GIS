// ═══ SceneBuilder — imperative JS front-end to the .xgis compiler (#1194) ═══
//
// Constructs the SAME `Program` AST the parser produces (../parser/ast) and
// nothing else — a second FRONT-END, never a second semantics
// (docs/architecture/design/scene-builder.md). The lowering's binding-handler
// registry stays the single authority for utility meaning; the builder emits
// the same name strings / Expr shapes the parser yields, pinned per paired
// example by the parity gate (scene-builder-parity.test.ts): AST structural
// equality (line-masked) + byte-equal lowered SceneCommands.
//
// Deliberately UNTYPED at the utility level (`util('fill-red-500')`) — the
// registry is closures, so a derived typed surface would need a parallel
// declarative table = the #1189 two-authorities trap (design §2.3). Typed
// sugar arrives only alongside a paired example that exercises it.
//
// Leaf dependency: this module imports ONLY the AST types.

import type * as AST from '../parser/ast'

// ── Expression helpers (parser-output shapes) ──

/** `.FIELD` — implicit-object data-field access, e.g. `field('CONTINENT')`
 *  ≡ the DSL's `.CONTINENT`. */
export function field(name: string): AST.FieldAccess {
  return { kind: 'FieldAccess', object: null, field: name }
}

/** A bare identifier, e.g. `ident('geojson')` ≡ the DSL's unquoted `geojson`
 *  in `type: geojson`. (A JS string property value coerces to a QUOTED
 *  StringLiteral — use `ident` where the DSL text is unquoted.) */
export function ident(name: string): AST.Identifier {
  return { kind: 'Identifier', name }
}

export function num(value: number, unit: string | null = null): AST.NumberLiteral {
  return { kind: 'NumberLiteral', value, unit }
}

export function str(value: string): AST.StringLiteral {
  return { kind: 'StringLiteral', value }
}

/** A colour-token VALUE position (match arm / interpolate stop), spelled the
 *  way the parser sees the same DSL text (#1068): `#rrggbb` → ColorLiteral;
 *  `amber-600` → the `amber - 600` BinaryExpr parseExpr yields (lowering
 *  resolves it as a palette token); `white` → Identifier. */
export function colorToken(token: string): AST.Expr {
  if (token.startsWith('#')) return { kind: 'ColorLiteral', value: token }
  const m = /^([a-zA-Z][a-zA-Z-]*)-(\d+(?:\.\d+)?)$/.exec(token)
  if (m) return { kind: 'BinaryExpr', op: '-', left: ident(m[1]!), right: num(Number(m[2]!)) }
  return ident(token)
}

const valueExpr = (v: string | number | boolean | AST.Expr): AST.Expr => {
  if (typeof v === 'number') return num(v)
  if (typeof v === 'boolean') return { kind: 'BoolLiteral', value: v }
  if (typeof v === 'string') return str(v)
  return v
}

/** `interpolate(zoom, stop, value, stop, value, …)` — numeric values stay
 *  numbers; string values go through {@link colorToken}. */
export function interpolateZoom(...stops: Array<[number, number | string]>): AST.FnCall {
  const args: AST.Expr[] = [ident('zoom')]
  for (const [z, v] of stops) {
    args.push(num(z))
    args.push(typeof v === 'number' ? num(v) : colorToken(v))
  }
  return { kind: 'FnCall', callee: ident('interpolate'), args }
}

/** `match(.field) { pattern -> value, …, _ -> default }`. Arm values: string
 *  → {@link colorToken}; number/Expr as-is. Insertion order is arm order;
 *  the `'_'` key is the default arm. */
export function matchOn(
  fieldName: string,
  arms: Record<string, string | number | AST.Expr>,
): AST.FnCall {
  const matchArms: AST.MatchArm[] = Object.entries(arms).map(([pattern, v]) => ({
    pattern,
    value: typeof v === 'string' ? colorToken(v) : typeof v === 'number' ? num(v) : v,
  }))
  return {
    kind: 'FnCall',
    callee: ident('match'),
    args: [field(fieldName)],
    matchBlock: { kind: 'MatchBlock', arms: matchArms },
  }
}

// ── Builder ──

/** One utility item within a `|` line: a plain name (`'fill-stone-200'`) or a
 *  bound form (`{ name: 'opacity', binding: interpolateZoom(...) }` ≡
 *  `opacity-[interpolate(zoom, …)]`). */
export type UtilInput =
  | string
  | {
      name: string
      binding?: AST.Expr
      bindingUnit?: string | null
      modifier?: string | null
    }

const toUtilityItem = (u: UtilInput): AST.UtilityItem =>
  typeof u === 'string'
    ? { kind: 'UtilityItem', modifier: null, name: u, binding: null, bindingUnit: null }
    : {
        kind: 'UtilityItem',
        modifier: u.modifier ?? null,
        name: u.name,
        binding: u.binding ?? null,
        bindingUnit: u.bindingUnit ?? null,
      }

export class LayerBuilder {
  private properties: AST.BlockProperty[] = []
  private utilities: AST.UtilityLine[] = []
  private styleProperties: AST.StyleProperty[] = []

  /** `source: <name>` (a bare identifier reference, as the DSL spells it). */
  source(sourceName: string): this {
    return this.prop('source', ident(sourceName))
  }

  /** Generic `key: value` block property. JS string → quoted StringLiteral;
   *  use {@link ident} for the DSL's unquoted spellings. */
  prop(name: string, value: string | number | boolean | AST.Expr): this {
    this.properties.push({ kind: 'BlockProperty', name, value: valueExpr(value), line: 0 })
    return this
  }

  /** One `|` utility LINE (grouping is part of the AST — mirror the paired
   *  .xgis text's line structure for parity). */
  util(...items: UtilInput[]): this {
    this.utilities.push({ kind: 'UtilityLine', items: items.map(toUtilityItem), line: 0 })
    return this
  }

  /** @internal */
  _build(name: string): AST.LayerStatement {
    return {
      kind: 'LayerStatement',
      name,
      properties: this.properties,
      utilities: this.utilities,
      styleProperties: this.styleProperties,
      line: 0,
    }
  }
}

/** Branded compiled-scene handle — the public contract. The wrapped AST is
 *  semver-internal (design §2.1/C5); hosts obtain one ONLY via `build()`. */
export interface SceneProgram {
  readonly __xgisSceneProgram: true
  /** @internal — consumed by `map.runScene`; not a public format. */
  readonly program: AST.Program
}

export class SceneBuilder {
  private body: AST.Statement[] = []

  /** `source <name> { key: value, … }`. */
  source(name: string, props: Record<string, string | number | boolean | AST.Expr>): this {
    const properties: AST.BlockProperty[] = Object.entries(props).map(([k, v]) => ({
      kind: 'BlockProperty',
      name: k,
      value: valueExpr(v),
      line: 0,
    }))
    this.body.push({ kind: 'SourceStatement', name, properties, line: 0 })
    return this
  }

  /** `layer <name> { … }`. */
  layer(name: string, build: (l: LayerBuilder) => void): this {
    const lb = new LayerBuilder()
    build(lb)
    this.body.push(lb._build(name))
    return this
  }

  /** `background { | … }` (utilities only — fill resolution happens in lower). */
  background(...items: UtilInput[]): this {
    this.body.push({
      kind: 'BackgroundStatement',
      utilities: [{ kind: 'UtilityLine', items: items.map(toUtilityItem), line: 0 }],
      styleProperties: [],
      line: 0,
    })
    return this
  }

  build(): SceneProgram {
    return {
      __xgisSceneProgram: true,
      program: { kind: 'Program', body: this.body },
    }
  }
}
