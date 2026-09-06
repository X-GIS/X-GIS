// ═══ Unified compiler diagnostics — one spanned channel (#1065) ═══
//
// Single authority for the `Diagnostic` shape shared by every compile
// stage — lexer/parser (parser-cursor.ts `error()` + parser.ts pragma
// gate), lower (ir/lower*.ts), and the Mapbox converter (convert/*).
// Before #1065 these were four disjoint channels: the parser threw a
// bare string on the FIRST error, lower collected `{ severity, code?,
// line? }` (warn/info only, no column), and the converter used a raw
// `string[]`. They now all speak this ONE record so a single consumer
// (the console surface today, the LSP + playground tomorrow) can render
// every finding uniformly.
//
// ── Code registry (X-GIS<NNNN>) ───────────────────────────────────────
// Codes are allocated once, here, and never re-used for a different
// meaning (a 5-year-stable identifier a user can grep + a doc can link).
//
//   X-GIS0001  warn   lower     Deprecated `z<N>:` zoom modifier         (ir/lower.ts)
//   X-GIS0002  warn   lower     Layer has no `source:` declaration       (ir/lower.ts)
//   X-GIS0003  warn   lower     Layer references an unknown source       (ir/lower.ts)
//   X-GIS0004  —      —         RESERVED (retired; never re-assign)
//   X-GIS0005  warn   lower     Bracket-binding utility has no handler   (ir/lower-bindings-paint.ts, ir/lower-label.ts)
//   X-GIS0006  warn   lower     Label utility has no handler             (ir/lower-label.ts)
//   X-GIS0007  warn   lower     Source declares both `data:` and `url:`  (ir/lower.ts)
//   X-GIS0008  error  parser    Missing / malformed version pragma       (parser.ts — #1064)
//   X-GIS0009  error  parser    File declares a newer major than this    (parser.ts — #1064)
//                               compiler implements
//   X-GIS0010  error  parser    Syntax error (generic; message carries   (parser-cursor.ts — #1065)
//                               the specific expectation)
//   X-GIS0011  warn   converter Mapbox-style conversion warning          (convert/* — #1065; message
//                               (generic; message carries the detail)     carries the detail)
//   X-GIS0012  error  lower     Unknown function name in a DataExpr      (ir/validate-fncalls.ts — #1066)
//   X-GIS0013  error  lower     Unknown utility (no registry prefix)     (ir/lower.ts, ir/lower-animation.ts —
//                               — nearest-name help                       #1067; utility-registry.ts is the authority)
//   X-GIS0014  error  lower     Preset call arity mismatch — wrong       (ir/preset-expand.ts — #1536)
//                               argument count for a (non-)parameterized
//                               preset; reported at the call-site line
//   X-GIS0015  error  lower     Recursive user fn (self or mutual) —     (ir/fn-inline.ts — #1535)
//                               fn bodies must form an acyclic call graph
//   X-GIS0016  error  lower     User-fn call arity mismatch              (ir/fn-inline.ts — #1535)
//   X-GIS0017  error  lower     Non-parameter bare identifier in a user- (ir/fn-inline.ts — #1535)
//                               fn body — params/zoom/pitch only; use
//                               `.field` for feature data
//   X-GIS0018  error  lower     Vector value in a scalar binding         (ir/expr-type.ts — #1537)
//                               position — read a lane (`.x`) instead
//   X-GIS0019  error  lower     `.field` absent from the source's        (ir/validate-schema-fields.ts
//                               declared `struct` schema, or a `schema:`   — #1537)
//                               naming no declared struct
//   X-GIS0020  error  lower     A shader stage block returns a non-vec4  (ir/expr-type.ts — #1538)
//                               value — the colour slot is vec4
//   X-GIS0021  error  parser    `input` declaration's type annotation    (parser-statements.ts — #1539)
//                               is not `f32`/`color`
//   X-GIS0022  error  parser    `input` declaration's default literal    (parser-statements.ts — #1539)
//                               kind doesn't match its declared type
//   X-GIS0023  error  lower     Duplicate `input` declaration (same      (ir/resolve-inputs.ts — #1539)
//                               name declared twice in one program)
//   X-GIS0024  warn   lower     `input` declared but never referenced    (ir/resolve-inputs.ts — #1539)
//                               by any expression in this program — NEVER
//                               drops the declaration (unlike the dead-
//                               source precedent): a host may legitimately
//                               setInput a knob the current style doesn't
//                               visibly use yet
//   X-GIS0025  error  lower     Reserved input-uniform-pool exhausted —  (ir/resolve-inputs.ts — #1539)
//                               more `f32`/`color` inputs declared than
//                               the fixed pool holds
//   X-GIS0026  error  lower     `input` reference reaches a paint        (ir/resolve-inputs.ts — #1539)
//                               property this milestone doesn't wire the
//                               uniform pool into (label/icon paint)
//   X-GIS0027  error  lower     `style:` names no declared preset —      (ir/preset-expand.ts — #1606)
//                               global or namespaced (`ns.name`)
//   X-GIS0028  error  lower     Modifier item (`hover:opacity-100`) has  (ir/lower.ts — #1069 slice)
//                               no lowering handler — only `fill-*` is
//                               wired under MODIFIER_HANDLERS today
//   X-GIS0030  error  lower     `source { type: … }` is neither a bare   (ir/lower.ts — #2549)
//                               built-in name nor a quoted custom key.
//                               NOTE 0029 is taken by #2544 (PR #2587),
//                               branched from the same base: both took
//                               'the next free code' and neither could
//                               see the other. Numbered 0030 here.
//                               built-in name nor a quoted custom
//                               registry key — previously a silent
//                               fallback to `geojson`
//
// NOTE: a `color`-typed input in a scalar position needs NO new code —
// ir/expr-type.ts's inferVecArity() treats a color input as vec4-arity,
// so the EXISTING X-GIS0018 (vector in scalar position) already rejects
// it, and X-GIS0020 (stage-block return type) already accepts a bare
// color-input stage body as a valid vec4 return, both for free.
// #1065 added only warn/info from lower (plumbing, not policy). #1066 is
// the first lower ERROR — `X-GIS0012` (unknown-function = error, L3 in the
// research doc) — raised through this same channel with no type migration,
// exactly what the `error` severity was reserved for. #1067's unknown-utility
// gate (`X-GIS0013`) follows the same shape for utility names.

/** Generic parser syntax-error code — one code for every recoverable
 *  parse error; the `message` carries the specific expectation. */
export const PARSER_SYNTAX_ERROR = 'X-GIS0010'
/** Generic converter warning code — one code for every Mapbox-style
 *  conversion note; the `message` carries the specific detail. */
export const CONVERTER_WARNING = 'X-GIS0011'
/** Unknown function name in a DataExpr — a callee that is neither a
 *  built-in (`BUILTIN_FN_NAMES`), an evaluator special form, nor a
 *  user-declared `fn` (#1066). The `help` line carries the nearest-name
 *  suggestion. */
export const UNKNOWN_FUNCTION = 'X-GIS0012'
/** Unknown-utility error (#1067) — a utility name matching no prefix in the
 *  single utility registry (utility-registry.ts), in normal lowering AND in
 *  `keyframes` blocks. The `help` carries the nearest-name suggestion. */
export const UNKNOWN_UTILITY = 'X-GIS0013'
/** Preset call arity mismatch (#1536) — a `style: p(…)` / `apply-p(…)`
 *  argument list whose length differs from the preset's declared
 *  parameter list (including arguments passed to a zero-param preset).
 *  Reported at the call-site line; the preset is inlined unsubstituted
 *  so lowering stays total. */
export const PRESET_ARITY = 'X-GIS0014'
/** Recursive user fn (#1535) — the user-fn call graph must be acyclic
 *  (self or mutual recursion); compile-time inlining cannot terminate
 *  otherwise. Reported at the offending fn's declaration line. */
export const FN_RECURSION = 'X-GIS0015'
/** User-fn call arity mismatch (#1535) — argument count differs from the
 *  fn's declared parameter list. Reported at the call-site line; the call
 *  is left unrewritten so lowering stays total. */
export const FN_ARITY = 'X-GIS0016'
/** Non-parameter bare identifier in a user-fn body (#1535) — bodies may
 *  reference their params, `zoom`/`pitch`, and callable names only;
 *  feature data must be explicit `.field` access (prevents accidental
 *  capture). Reported at the fn's declaration line. */
export const FN_FREE_IDENTIFIER = 'X-GIS0017'
/** Vector value in a scalar binding position (#1537) — every `[…]`
 *  binding resolves to ONE number per feature, so a `vecN` there is an
 *  authoring error. Caught by type inference rather than rendered as a
 *  wrong-typed shader expression or an array-valued size. */
export const VECTOR_IN_SCALAR_POSITION = 'X-GIS0018'
/** Unknown field on a schema-annotated source (#1537) — the FIELD-side
 *  mirror of #1066's unknown-callee error. Opt-in: only sources that
 *  declare `schema:` are checked, so `.speeed` fails loudly there while
 *  unannotated sources keep fully dynamic access. */
export const UNKNOWN_SCHEMA_FIELD = 'X-GIS0019'
/** A `@color` / `@stroke` stage block whose body is not vec4 (#1538). The
 *  variant colour slot is `Node<'vec4<f32>'>`; anything else would compile
 *  a wrong-typed shader expression, so it fails at lower time instead. */
export const STAGE_RETURN_TYPE = 'X-GIS0020'
/** `input` declaration's type annotation is not `f32`/`color` (#1539). */
export const INPUT_BAD_TYPE = 'X-GIS0021'
/** `input` declaration's default literal kind doesn't match its declared
 *  type (#1539) — `f32` needs a `NumberLiteral` default, `color` a
 *  `ColorLiteral` default. */
export const INPUT_DEFAULT_TYPE_MISMATCH = 'X-GIS0022'
/** Duplicate `input` declaration (#1539) — the same name declared twice
 *  in one program. Reported at the second declaration's line. */
export const INPUT_DUPLICATE = 'X-GIS0023'
/** `input` declared but never referenced by any expression anywhere in
 *  this program (#1539). Warn-only — the declaration is NEVER dropped
 *  from emit (unlike the dead-`source` precedent in convert/*): a host
 *  may legitimately `setInput` a knob the current style doesn't visibly
 *  use yet (staged rollout, A/B toggle). */
export const INPUT_UNUSED = 'X-GIS0024'
/** Reserved input-uniform-pool exhausted (#1539) — the program declares
 *  more `f32` (or `color`) inputs than the fixed-size pool
 *  (map/src/shaders/dsl/consts.ts) holds for that type. */
export const INPUT_POOL_EXHAUSTED = 'X-GIS0025'
/** An `input` reference reaches a paint property this milestone doesn't
 *  wire the uniform pool into (#1539) — label/icon (text/icon) paint;
 *  only polygon/line/point carry the reserved pool today. */
export const INPUT_UNSUPPORTED_PAINT_TARGET = 'X-GIS0026'
/** `style: <name>` names no declared preset, global or namespaced (#1606) —
 *  previously a silent no-op that compiled clean into a blank layer. */
export const UNKNOWN_STYLE_PRESET = 'X-GIS0027'
/** Modifier item with no lowering handler (#1069 smallest-honest-slice) — a
 *  `<mod>:<utility>` item whose utility half matches no entry in
 *  `MODIFIER_HANDLERS` (today: only `fill-*`). Previously a silent drop, so
 *  the spec doc's own `hover:opacity-100` example compiled to a no-op. This
 *  is NOT the runtime `hover:`/`selected:` feature (unstarted) — it only
 *  turns the drop into a diagnostic. */
export const UNHANDLED_MODIFIER = 'X-GIS0028'
/** A `source`'s `type:` value that the grammar cannot read as a NAME (#2549) —
 *  neither a bare identifier (`type: geojson`) nor a quoted string
 *  (`type: "x-kr-admin"`). The motivating case is an unquoted hyphenated
 *  registry key: the identifier grammar has no hyphen, so `type: x-kr-admin`
 *  parses as the expression `x - kr - admin`, and lowering used to leave its
 *  `geojson` initialiser standing with no report — the source silently changed
 *  meaning, options and all. */
export const SOURCE_TYPE_NOT_A_NAME = 'X-GIS0030'

/** A 1-based, document-relative source span. `line`/`col` are always
 *  present; `endLine`/`endCol` are optional (a point diagnostic omits
 *  them). Convention: when only a line is known — the situation the
 *  pre-#1065 lower diagnostics were in (`line?` with no column) — `col`
 *  is set to 1 (the lower push sites write `{ line, col: 1 }`).
 *  Converter diagnostics, which
 *  derive from position-less Mapbox JSON, use the document-start span
 *  `{ line: 1, col: 1 }`. */
export interface Span {
  line: number
  col: number
  endLine?: number
  endCol?: number
}

export type Severity = 'error' | 'warn' | 'info'

/** One compile-time finding. `code` (X-GIS<NNNN>, see the registry
 *  above) and `span` are REQUIRED — the whole point of #1065 is that
 *  every diagnostic is greppable and locatable. `help` is an optional
 *  second line ("what to do about it"). */
export interface Diagnostic {
  code: string
  severity: Severity
  span: Span
  message: string
  help?: string
}

/** Bridge for the converter's raw-string warning channel: wrap a
 *  message string as a `warn` Diagnostic. The Mapbox converter operates
 *  on JSON that carries no line/col, so the span defaults to document
 *  start. Keeps the message BYTE-IDENTICAL so the many tests that pin
 *  converter warning strings stay green. */
export function warningDiagnostic(message: string, code: string = CONVERTER_WARNING): Diagnostic {
  return { code, severity: 'warn', span: { line: 1, col: 1 }, message }
}

/** Compatibility accessor: project a Diagnostic list back onto the bare
 *  message strings some callers/tests still consume (the converter's
 *  `string[]` shape). */
export function diagnosticMessages(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.message)
}

/** The structured error the parser throws in its default (throw-on-
 *  first) mode. It is a plain `Error` — so every existing `try/catch`
 *  and `.message` consumer keeps working — but additionally carries the
 *  first structured {@link Diagnostic} for callers that want the code +
 *  span without re-parsing the message string. */
export class ParseError extends Error {
  readonly diagnostic: Diagnostic
  constructor(diagnostic: Diagnostic, message: string) {
    super(message)
    this.name = 'ParseError'
    this.diagnostic = diagnostic
  }
}

/** A minimal accumulator for diagnostics gathered across one compile
 *  (used by the parser's recovering `parseCollect` mode; also the merge
 *  point for the LSP/playground to combine parser + lower + converter
 *  findings into one list). Deliberately tiny — a growable array with a
 *  severity query; it is NOT a policy engine. */
export class DiagnosticCollector {
  private readonly items: Diagnostic[] = []

  add(diagnostic: Diagnostic): this {
    this.items.push(diagnostic)
    return this
  }

  /** The collected diagnostics, in insertion order. */
  get all(): Diagnostic[] {
    return this.items
  }

  get length(): number {
    return this.items.length
  }

  hasErrors(): boolean {
    return this.items.some((d) => d.severity === 'error')
  }
}
