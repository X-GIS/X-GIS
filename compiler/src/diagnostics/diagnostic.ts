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
//
// Lower currently emits only warn/info (no ERROR is invented by #1065 —
// this PR is plumbing, not policy, §2). The `error` severity exists at
// the type level so a later pass (e.g. unknown-function = error, L3 in
// the research doc) can raise one without another type migration.

/** Generic parser syntax-error code — one code for every recoverable
 *  parse error; the `message` carries the specific expectation. */
export const PARSER_SYNTAX_ERROR = 'X-GIS0010'
/** Generic converter warning code — one code for every Mapbox-style
 *  conversion note; the `message` carries the specific detail. */
export const CONVERTER_WARNING = 'X-GIS0011'

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
