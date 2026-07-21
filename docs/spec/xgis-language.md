# X-GIS Language Specification — Major 1

Status: **Normative (descriptive)**. Language version: **major `1`** (`XGIS_LANGUAGE_MAJOR`, #1064).
Scope: the surface grammar the compiler's hand-written lexer + recursive-descent
parser actually accept, plus the parse-time diagnostics they raise.

This document is derived construct-by-construct by reading the implementation. It
describes **reality, not aspiration**: where the implementation is internally
inconsistent it is tagged **(known divergence)**. When this document and the
implementation disagree, the implementation is authoritative and this document has a
bug.

> **Language work landed.** This spec describes `main` after the **#1072 / #1138**
> grammar prune: `let`, `fn`, `show`, `style`, and the imperative control-flow
> statements (`if` / `else` / `for` / `in` / `return`) were removed, and the former
> `style` block folded into `preset`. It also reflects #1065 (unified spanned
> diagnostics + parser multi-error recovery), #1071 (recursive import resolution +
> `import * as ns`), and #1066 (unknown-function lower errors, `X-GIS0012`).

## Source authority

The grammar has no generator; these files are the single source of truth. Section
references below cite them.

| Concern                                 | File                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Token kinds, keyword + unit tables      | `compiler/src/lexer/tokens.ts`                                                                                           |
| Tokenizer (lexical grammar)             | `compiler/src/lexer/lexer.ts`                                                                                            |
| Version pragma gate                     | `compiler/src/parser/parser.ts`, `compiler/src/language-version.ts`                                                      |
| Statement grammar                       | `compiler/src/parser/parser-statements.ts`                                                                               |
| Expression grammar                      | `compiler/src/parser/parser-expressions.ts`                                                                              |
| Shared token cursor                     | `compiler/src/parser/parser-cursor.ts`                                                                                   |
| AST node shapes                         | `compiler/src/parser/ast.ts`                                                                                             |
| Utility-vocabulary registry (semantics) | `compiler/src/ir/lower-bindings-registry.ts` and the `lower-bindings-*.ts` / `lower*.ts` / `utility-resolver.ts` ladders |
| Diagnostic codes (registry)             | `compiler/src/diagnostics/diagnostic.ts` header — single authority (#1065)                                               |

## Notation

EBNF-flavoured, tuned so that X-GIS's own `{ } [ ] | ( )` do not clash with the
metalanguage:

- Non-terminals are `lower-hyphen-case`.
- **Token classes** produced by the lexer are `UPPER_CASE` (`NUMBER`, `STRING`,
  `COLOR`, `BOOL`, `IDENT`, `UNIT`).
- **Terminals** — literal keywords and punctuation — are double-quoted: `"layer"`,
  `"{"`, `"|"`, `"->"`.
- `A?` optional, `A*` zero-or-more, `A+` one-or-more.
- `A | B` alternation; `( … )` grouping. The bare `|` `(` `)` are **meta**; the
  literal pipe / parens are the terminals `"|"` `"("` `")"`.
- `(* … *)` is a comment.
- Newlines are **not** grammatically significant: the parser cursor filters
  `Newline` tokens before parsing (`parser-cursor.ts` constructor). Layout in the
  examples is for humans only.

---

# 1. Lexical grammar

The lexer (`lexer.ts`) scans left-to-right, emitting a flat token stream terminated
by `EOF`. Whitespace (space, tab, `\r`) separates tokens and is otherwise discarded;
`\n` is emitted as `Newline` and later filtered by the parser cursor.

## 1.1 Comments

```
line-comment  = "//" (* to end of line *)
block-comment = "/*" (* … *) "*/"
```

Both comment forms are consumed by the lexer and never reach the parser. Block
comments do not nest (the first `*/` closes). Comments may appear anywhere including
**before the version pragma** — the pragma need only be the first _token_.

```xgis
// a leading comment
/* a block comment, may span lines */
xgis 1
```

## 1.2 Numbers

```
NUMBER = DIGIT+ ( "." DIGIT+ )? ( ("e" | "E") ("+" | "-")? DIGIT+ )?
DIGIT  = "0" … "9"
```

An integer or decimal, with an optional scientific-notation exponent. A leading sign
is **not** part of `NUMBER` — `-5` is a unary-minus expression over `NUMBER` `5`. A
`.` is only a decimal point when followed by a digit, so `0..10` lexes as `NUMBER`
`0`, `DotDot`, `NUMBER` `10` (the `..` token survives lexically but has no grammar
production since #1072). Scientific notation was added so Mapbox-derived JSON
(`1.5e-7`) round-trips (`lexer.ts` `readNumber`).

```xgis
xgis 1
source nums { i: 42  d: 3.14  sci: 1.5e-7 }
```

## 1.3 Unit-tagged numbers

```
UNIT = "px" | "m" | "km" | "nm" | "deg" | "s" | "ms"
```

Immediately after a `NUMBER`, a bare identifier that is exactly a unit keyword is
emitted as a distinct `UNIT` token (`lexer.ts` `readNumber` tail; table in
`tokens.ts` `UNITS`). A non-unit alpha run is _not_ consumed — `1.5em` lexes as
`NUMBER` `1.5` then `IDENT` `em`. In expression position a `NUMBER` followed by a
`UNIT` becomes a single `NumberLiteral` carrying `unit` (§3.12).

```xgis
xgis 1
source nums { dist: 10km  dur: 250ms }
```

## 1.4 Strings

```
STRING = '"' ( escape | (* any char except '"' *) )* '"'
escape = "\" ( "n" | "t" | "\" | '"' | (* any other char → literal *) )
```

Double-quoted. Recognised escapes are `\n`, `\t`, `\\`, `\"`; any other escaped
character passes through literally (`\x` → `x`) — lenient by design (`lexer.ts`
`readString`). Embedded raw newlines are permitted and advance the line counter. An
unterminated string is a hard lexer error (**"Unterminated string"**).

```xgis
xgis 1
source lbl { label: "Seoul \"downtown\"\nzone" }
```

## 1.5 Colors

```
COLOR  = "#" HEXDIG{3} | "#" HEXDIG{6} | "#" HEXDIG{8}
HEXDIG = DIGIT | "a"…"f" | "A"…"F"
```

`#RGB`, `#RRGGBB`, or `#RRGGBBAA`. The lexer consumes the maximal hex run after `#`
and rejects any other length as a hard error (**"Invalid color literal"**) — so
`#ff` and `#12345` do not lex (`lexer.ts` `readColor`).

```xgis
xgis 1
source palette { full: #f2efe9  short: #ccc  alpha: #ff000080 }
```

## 1.6 Booleans, identifiers, keywords

```
BOOL  = "true" | "false"
IDENT = (ALPHA | "_") (ALPHA | DIGIT | "_")*
ALPHA = "a"…"z" | "A"…"Z" | "_"
```

An identifier run is looked up in the keyword table (`tokens.ts` `KEYWORDS`); a hit
becomes that keyword token, `true`/`false` become `BOOL`, otherwise `IDENT`. The
keywords (major 1):

```
source  layer  background  preset  import  symbol  keyframes  from  to
```

Every keyword except `from` and `to` opens a top-level statement (§2). `from` and
`to` begin no statement — they are keyframe selectors / aliases (§2.11) and may also
appear as `utility-name` segments (§3.10). `true` / `false` are keyed in the same
table but lex as `BOOL`. The pre-#1072 reserved-only keywords (`let fn show style if
else for in return place view on simulate analyze struct enum export`) were removed
from the table — each now lexes as an ordinary `IDENT`.

## 1.7 Operators and punctuation

Emitted as fixed terminals (`lexer.ts` symbol tables). Two- and one-character forms:

```
"->"  ".."  "=="  "!="  "<="  ">="  "&&"  "||"  "??"
"("  ")"  "{"  "}"  "["  "]"  ":"  ","  "."  "|"  "="
"<"  ">"  "+"  "-"  "*"  "/"  "%"  "&"  "!"  "?"
```

Any character that starts none of the above is a hard lexer error (**"Unexpected
character"**), e.g. `@` or `$`.

---

# 2. Program and statements

```
program   = version-pragma statement*
statement = source-statement | layer-statement | background-statement
          | preset-statement | import-statement | symbol-statement
          | keyframes-statement
```

`parse()` (`parser.ts`) consumes the pragma, then loops `parseStatement` to `EOF`.
Dispatch is by the leading token via `STATEMENT_HANDLERS`
(`parser-statements.ts`); any token not in that map is a hard syntax error — the
language has **no** top-level expression statements (#1072, `parseStatement`).

## 2.0 Version pragma (mandatory, #1064)

```
version-pragma = "xgis" INTEGER          (* INTEGER = DIGIT+, a bare integer *)
```

The **first token** of every source must be the identifier `xgis` followed by a bare
integer major version (`parser.ts` `consumeVersionPragma`). Comments and blank lines
may precede it (they are already stripped). The major must be `>= 1` and `<=`
`XGIS_LANGUAGE_MAJOR` (`1` today). The pragma is validated and consumed but not
stored on the AST — nothing downstream reads it yet. Violations are **hard parse
errors** (thrown, never collected): see `X-GIS0008` / `X-GIS0009` (§4). `1.0` and
`1px` are rejected because they lex as a decimal / unit-tagged number, not a bare
integer.

```xgis
xgis 1
```

## 2.1 `let` — removed (#1072 / #1138)

`let` was removed. There is no binding statement; values live directly in block /
style properties and utility bindings. `let` now lexes as an ordinary `IDENT` and
begins no statement.

## 2.2 `source`

```
source-statement = "source" IDENT "{" ( block-property ","? )* "}"
```

Declares a named data source. The body is a set of `key: value` block properties
(§2.14); commas between them are optional. `type:` and `url:` (or an inline `data:`
object literal, §3.14) are the common keys, but the grammar constrains neither key
nor value — validation is a lowering concern.

```xgis
xgis 1
source world { type: geojson, url: "world.geojson" }
```

## 2.3 `layer`

```
layer-statement = "layer" IDENT "{" layer-item* "}"
layer-item      = utility-line | style-property | block-property ","?
```

The richest block. Each item is dispatched (`parseLayerStatement`): a `"|"` starts a
**utility line** (§2.12); a `fill|opacity|size|stroke|stroke-width` identifier
directly followed by `":"` is a **style property** (§2.14, CSS-like); anything else
is a **block property** (§2.14, `key: value`). The three item kinds may interleave
and are collected into three parallel lists on the AST node.

```xgis
xgis 1
source world { type: geojson, url: "world.geojson" }
layer land {
  source: world
  fill: stone-800
  | stroke-white stroke-2 opacity-80
}
```

## 2.4 `background`

```
background-statement = "background" "{" ( utility-line | style-property | block-property ","? )* "}"
```

Same body grammar as `layer` but nameless and sourceless — the Mapbox-style canvas
clear color. Stray block properties are tolerated and ignored (only the resolved
`fill` is consumed downstream).

```xgis
xgis 1
background { fill: sky-900 }
```

## 2.5 `preset`

```
preset-statement = "preset" IDENT "{" utility-line+ "}"
```

A named bundle of utility lines — the single reusable-style construct, into which the
former `style` block folded (#1072 / #1138, §2.6). Unlike `layer`, the body accepts
**only** utility lines — a non-`"|"` token is a hard error (**"Expected | in preset
block"**). How a layer consumes a preset is a lowering concern (see the registry,
§3.11).

```xgis
xgis 1
preset track { | symbol-arrow stroke-black stroke-1 }
```

## 2.6 `style` — removed (#1072 / #1138), folded into `preset`

The `style` block (a named set of CSS-like style properties) was removed; its role
folded into `preset` (§2.5), now the single reusable-style construct. `style` now
lexes as an ordinary `IDENT` and begins no statement.

## 2.7 `import`

```
import-statement = "import" STRING
                 | "import" "{" ( IDENT ","? )* "}" "from" STRING
                 | "import" "*" "as" IDENT "from" STRING
```

Three forms. `import "path"` (no names) is the **splice** form — every top-level
statement of the target is prepended to this program. `import { a, b } from "path"`
is the **cherry-pick** form. `import * as ns from "path"` (#1071) is the
**namespaced splice** — the target's block-level definitions are spliced under the
`ns.` prefix. `as` is not a reserved keyword; it is matched by identifier _value_ in
this one production. Resolution is a separate pass (`resolveImports`,
`compiler/src/module/resolver.ts`), not part of `parse()`; since #1071 it recurses
into nested imports with a cycle guard and raises collision diagnostics, and the
splice forms auto-detect a Mapbox `style.json` target and convert it first.

```xgis
xgis 1
import { basemap } from "./base.xgis"
import * as base from "./base.xgis"
import "https://example.com/mapbox-style.json"
```

## 2.8 `symbol`

```
symbol-statement = "symbol" IDENT "{" symbol-element* "}"
symbol-element   = "path" STRING
                 | "rect" numeric-props
                 | "circle" numeric-props
                 | "anchor" ":" IDENT
numeric-props    = ( IDENT ":" "-"? NUMBER )*
```

An icon/marker definition. Element keywords (`path`/`rect`/`circle`/`anchor`) are
matched as ordinary identifiers (they are not reserved keywords). `numeric-props`
reads `key: number` pairs, stopping before the next element keyword; a leading `-`
negates. Any other token is a hard error (**"Unexpected token in symbol block"**).

```xgis
xgis 1
symbol arrow { path "M 0 -1 L -0.4 0.3 Z" anchor: center }
```

## 2.9 `show` — removed (#1072 / #1138)

The legacy imperative `show` render form was removed. `show` now lexes as an ordinary
`IDENT` and begins no statement; declarative `layer` blocks (§2.3) are the render
surface.

## 2.10 `fn` — removed (#1072 / #1138)

Named functions were removed. `fn` now lexes as an ordinary `IDENT` and begins no
statement; the language has no user-defined functions or function bodies.

## 2.11 `keyframes`

```
keyframes-statement = "keyframes" IDENT "{" keyframe* "}"
keyframe            = frame-selector ":" utility-item*
frame-selector      = NUMBER "%"? | "from" | "to"
```

An animation timeline. Each row is a percentage (`0`–`100`; the `%` token is
optional), or the alias `from` (= 0) / `to` (= 100), then a `:` and a run of utility
items. A row ends at the next selector or `}` (`isKeyframeBoundary`). Frames are
sorted by percent after parsing. Utility items here must carry **no modifier**
(a modifier inside a keyframe is a hard error). A percent outside `0..100` is a hard
error.

> A `from` / `to` selector must be followed by `:` (grammar: `frame-selector ":"`),
> and `isKeyframeBoundary` requires that `:` lookahead. A bare leading `from`/`to`
> followed by `-` is therefore a utility _name_, not a selector, so keyframe utility
> names may begin with `from`/`to` (e.g. `to-blue-500`, `from-red-500`) — matching
> `parseUtilityName`'s leading-segment handling (§3.10) that also makes `fade-in` /
> `ease-in-out` work.

```xgis
xgis 1
keyframes pulse { 0%: opacity-100  50%: opacity-30  to: opacity-100 }
```

## 2.12 Utility lines and items

```
utility-line = "|" utility-item*                 (* until next "|", "}", or EOF *)
utility-item = ( IDENT ":" )? utility-name binding? binding-unit?
binding      = "-" "[" expression "]"
             | "[" expression "]"
             | data-style-call
binding-unit = UNIT | IDENT (* only if IDENT ∈ the unit set *)
data-style-call = (* when utility-name ∈ {fill,stroke,opacity}
                     and next IDENT ∈ {match,categorical,gradient} *)
                  expression match-block?
```

A utility line is a `"|"` followed by items up to the next `"|"`/`"}"`. Each item is
an optional `modifier:` prefix (`friendly:`, `hover:` — an `IDENT ":" IDENT`
lookahead, `isModifierPattern`), a hyphen-joined `utility-name` (§3.10), and an
optional data **binding**: `-[expr]`, `[expr]`, or — for `fill`/`stroke`/`opacity` —
a `match(...)`/`categorical(...)`/`gradient(...)` call (with an optional trailing
`match-block`, §3.13). A trailing unit after `]` is absorbed (`size-[expr]km`). The
parser records `modifier`, `name`, `binding`, `bindingUnit` verbatim and does **not**
validate the name against the vocabulary — see §3.11.

```xgis
xgis 1
source w { type: geojson, url: "w.geojson" }
layer roads {
  source: w
  | stroke-amber-500 stroke-2 hover:opacity-100
  | size-[.lanes * 2]px
  | fill match(.kind) { "hwy" -> #f59e0b, _ -> #9ca3af }
}
```

## 2.13 `if` / `else` / `for` / `in` / `return` — removed (#1072 / #1138)

The imperative control-flow statements were removed. `if`, `else`, `for`, `in`, and
`return` now lex as ordinary `IDENT`s and begin no statement; the `..` range token
(§1.2) survives lexically but has no grammar production. The language is purely
declarative.

## 2.14 Block properties and style properties

```
block-property = property-key ":" coalesce-expression
style-property = style-key ":" style-value
property-key   = IDENT | "source" | "layer"
style-key      = property-key ( "-" IDENT )*
style-value    = COLOR | NUMBER | BOOL | fn-call-text | utility-name
```

A **block property** (`source`/`layer` bodies) parses its value with
`parseCoalesce` — the precedence ladder **excluding** the ternary — keeping `??`
(`.height ?? 50` works). A `"|"` after the value always belongs to a utility
line: the expression-level pipe operator was removed (#1238), so no expression
production can consume it. A **style property** (CSS-like) takes a hyphen-joined key
(`stroke-width`) and a _string-valued_ payload: a color, number, bool, a paren-
balanced function-call captured verbatim as text (`rgba(255,0,0,0.5)`), or a
hyphen-joined utility name (`stone-800`). A key may also be the keyword `source` or
`layer` (via `expectIdentifierOrKeyword`); every other former keyword used here
(`style`, `view`, `on`) is now an ordinary `IDENT` and needs no special-casing.

```xgis
xgis 1
source w { type: geojson, url: "w.geojson" }
layer l { source: w  fill: rgba(30, 41, 59, 0.8)  stroke-width: 1 }
```

## 2.15 Expression statements — removed (#1072 / #1138)

There are no top-level expression statements. The former fallthrough that parsed a
bare expression (`42`, `[1, 2, 3]`, `x | round`, …) at statement position was
removed; any token that is not a statement keyword (§2) is now a hard syntax error
(`parseStatement`). Expressions appear only inside block / style properties and
utility bindings.

---

# 3. Expressions

A Pratt / precedence-climbing ladder (`parser-expressions.ts`). Lowest to highest
binding:

```
expression     = coalesce ( "?" expression ":" expression )?  (* ternary *)
coalesce       = logical-or ( "??" logical-or )*
logical-or     = logical-and ( "||" logical-and )*
logical-and    = comparison ( "&&" comparison )*
comparison     = additive ( ( "==" | "!=" | "<" | ">" | "<=" | ">=" ) additive )*
additive       = multiplicative ( ( "+" | "-" ) multiplicative )*
multiplicative = unary ( ( "*" | "/" | "%" ) unary )*
unary          = ( "-" | "!" ) unary | postfix
postfix        = primary postfix-op*
postfix-op     = arg-list | "." IDENT | "[" expression "]"
arg-list       = "(" ( expression ","? )* ")"
```

All binary levels are **left-associative** (each is a `while` loop folding left). The
ternary and `unary` are right-recursive.

> Note: `??` sits **between** the ternary and `||`, so `a || b ?? c` parses as
> `(a || b) ?? c`. `??` chains left-associatively (`a ?? b ?? c` → `(a ?? b) ?? c`);
> because `??` returns the first non-null operand this is value-equivalent to right
> association. (The source comment calling it "right-associative" is imprecise but
> semantically harmless.)

> Removed (#1238): the expression-level pipe operator
> (`x | round | clamp(0, 10)`) — pure sugar over nested calls
> (`clamp(round(x), 0, 10)`) whose `|` token collided with the utility-line `|`
> and swallowed a following utility block after any bare expression-valued
> utility (#1236). A `"|"` in expression position is now a generic syntax error
> (X-GIS0010); the `"|"` terminal belongs to utility lines alone.

```xgis
xgis 1
source w { type: geojson, url: "w.geojson" }
layer roads {
  source: w
  | size-[clamp(.base * 2 + 1, 0, 24) ?? 8]
  | fill-[.hostile ? #ef4444 : #22c55e]
  | opacity-[clamp(round(.speed), 0, 10)]
}
```

## 3.1 Primary expressions

```
primary = implicit-field | NUMBER-literal | STRING | COLOR | BOOL
        | IDENT | array-literal | object-literal | "(" expression ")"
```

## 3.10 Utility names (lexical family)

```
utility-name  = utility-seg ( "-" utility-seg )* trailing-unit?
utility-seg   = IDENT | NUMBER | COLOR | BOOL
              | "symbol" | "source" | "layer" | "preset" | "from" | "to"
trailing-unit = "px" | "m" | "km" | "nm" | "deg"
```

A hyphen-joined token chain (`parseUtilityName`) — the lexical shape of every
utility (`fill-red-500`, `stroke-2`, `ease-in-out`, `label-keep-upright-true`). It is
built from identifiers/numbers/colors plus a curated set of short keywords admitted
mid-name (so `ease-in`, `from-red-500` don't truncate). A hyphen only continues the
name when the token after it can be a name part; otherwise the `-` is left for the
expression grammar. A trailing spatial unit is folded into the name string.

## 3.11 The utility vocabulary is a separate registry

The parser treats a `utility-name` as an **opaque hyphen-joined string** — it does
not know `fill-*` from `stroke-*` from a typo. The ~78 utility _prefixes_ and their
semantics (paint, label, animation, raster, heatmap, extrusion, …) plus ~10 bare
utilities live entirely in the lowering ladders, not in this grammar. Authority:
`compiler/src/ir/lower-bindings-registry.ts` and the `lower-bindings-*.ts` /
`lower-label.ts` / `lower-animation.ts` / `utility-resolver.ts` handlers; inventory
and the "78 prefix" figure are catalogued in
`docs/research/2026-07-13-xgis-language-vs-peers.md` (lines 51, 278). An unknown
utility name is **syntactically valid** and is diagnosed only at lowering
(`X-GIS0005` / `X-GIS0006`, §4), never by `xgis validate`.

## 3.12 Number, string, color, bool, identifier literals

```
NUMBER-literal = NUMBER UNIT?          (* NumberLiteral { value, unit } *)
```

`NUMBER` optionally immediately followed by a `UNIT` token yields a single
`NumberLiteral` carrying the unit (§1.3). `STRING`/`COLOR`/`BOOL`/`IDENT` become the
corresponding literal / `Identifier` node.

```xgis
xgis 1
source lit {
  a: 12px
  b: "hello"
  c: #0ea5e9
  d: true
  e: mercator
}
```

## 3.13 Implicit field access, field/array access, calls, `match`

```
implicit-field = "." IDENT                       (* FieldAccess { object: null } *)
field-access   = postfix "." IDENT
array-access   = postfix "[" expression "]"
fn-call        = postfix arg-list
match-block    = "{" match-arm* "}"
match-arm      = ( STRING | IDENT | NUMBER | "-" NUMBER ) "->" match-value
match-value    = COLOR | utility-name | expression
```

A leading `.field` is implicit binding to the current datum. Postfix `.`/`[]`/`()`
chain over any primary. A call to the identifier `match` may carry a trailing
`match-block` in any expression position (`parsePostfix` / `parseMatchBlock`): arms
map a literal pattern (string, identifier, number, or bare negative number) to a
value, with `_` as the conventional default pattern. Arm values special-case a color
literal and a hyphen-joined utility name before falling back to a general expression.

```xgis
xgis 1
source feat {
  color: match(.iso) { "KOR" -> #ef4444, "JPN" -> #3b82f6, _ -> #d1d5db }
  deep: feature.props.rank
}
```

## 3.14 Array and object literals

```
array-literal  = "[" ( expression ","? )* "]"
object-literal = "{" ( object-key ":" expression ","? )* "}"
object-key     = STRING | IDENT
```

Array literals are ordinary comma-separated expression lists (trailing comma
tolerated). Object literals are value-position only — a bare `{` in expression
position is unambiguous (match blocks are identifier-prefixed). Object keys may be
string or identifier literals. The primary use is embedding inline GeoJSON in a
`source` `data:` property; lowering restricts `data:` values to JSON-literal
subtrees.

```xgis
xgis 1
source pts {
  type: geojson
  data: { "type": "FeatureCollection", "features": [] }
}
```

---

# 4. Diagnostics

Since #1065 every compile stage speaks ONE spanned `Diagnostic` record
(`{ code, severity, span, message, help? }`); the code registry lives in the
`compiler/src/diagnostics/diagnostic.ts` header and codes are never re-used. This
slice's `xgis validate` (lex + parse [+ resolve imports]) can only surface the
**parser** codes; the lowering/converter codes are listed for registry completeness.

| Code        | Layer     | Trigger                                                                     | Severity |
| ----------- | --------- | --------------------------------------------------------------------------- | -------- |
| `X-GIS0008` | parser    | version pragma missing / malformed / not first / non-integer / major `< 1`  | `error`  |
| `X-GIS0009` | parser    | major greater than `XGIS_LANGUAGE_MAJOR` ("written for a newer X-GIS")      | `error`  |
| `X-GIS0010` | parser    | generic syntax error — the message carries the specific expectation (#1065) | `error`  |
| `X-GIS0001` | lowering  | deprecated `z<N>:` zoom modifier                                            | `warn`   |
| `X-GIS0002` | lowering  | layer has no `source:`                                                      | `warn`   |
| `X-GIS0003` | lowering  | layer references an unknown source                                          | `warn`   |
| `X-GIS0005` | lowering  | unsupported utility silently dropped                                        | `warn`   |
| `X-GIS0006` | lowering  | unsupported `label-*` utility dropped                                       | `warn`   |
| `X-GIS0007` | lowering  | source declares both `data:` and `url:`                                     | `warn`   |
| `X-GIS0012` | lowering  | unknown function name in a data expression (#1066)                          | `error`  |
| `X-GIS0011` | converter | generic Mapbox-style conversion warning                                     | `warn`   |

`X-GIS0004` is RESERVED (retired; never re-assigned).

**Delivery.** The parser has two entry points (#1065): the default `parse()` throws
on the first error — a `ParseError`, a plain `Error` whose message keeps the
`[Parser] … at line L, col C` shape and which carries the first structured
`Diagnostic` (so `error.diagnostic.code` is the stable pin); `parseCollect()`
recovers at block boundaries / statement keywords and returns every error in one
pass. The version-pragma gate runs before the recovery loop in both modes — a
wrong-version file never half-parses. Lowering and converter diagnostics are
collected, never thrown.

## 4.1 Parse-error stability contract

Lexer errors are plain `Error`s with stable message fragments
(**"Unterminated string"**, **"Invalid color literal"**, **"Unexpected character"**
— the lexer was out of #1065's scope). Parser errors carry a stable **code**
(`X-GIS0008`/`X-GIS0009` at the pragma gate, `X-GIS0010` for every other syntax
error); their message **wording** (`Expected <Token>, got <Token>` /
`Unexpected token …`) is not a contract. The conformance corpus
(`compiler/src/__tests__/conformance/`) therefore pins the structured code where one
exists and a stable lexer fragment otherwise — never full parser message strings.
