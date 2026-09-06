export enum TokenType {
  // Literals
  Number, // 42, 3.14
  String, // "hello"
  Color, // #ff0000, #ccc
  Bool, // true, false

  // Identifiers & Keywords
  Identifier, // foo, bar
  Import, // import
  Source, // source
  Layer, // layer
  Background, // background
  Preset, // preset
  From, // from
  To, // to (keyframes alias for 100%)
  SymbolDef, // symbol
  Keyframes, // keyframes
  Fn, // fn — user-defined functions (#1535; reintroduced after the #1072 prune)
  Struct, // struct — source field schemas (#1537; reintroduced after the #1072 prune)
  Input, // input — host-contract declarations (#1539)

  // Units
  Px, // px
  M, // m
  Km, // km
  Nm, // nm
  Deg, // deg
  S, // s
  Ms, // ms

  // Symbols
  LParen, // (
  RParen, // )
  LBrace, // {
  RBrace, // }
  LBracket, // [
  RBracket, // ]
  Colon, // :
  Comma, // ,
  Dot, // .
  DotDot, // ..
  Arrow, // ->
  Pipe, // |
  Eq, // =
  EqEq, // ==
  BangEq, // !=
  Lt, // <
  Gt, // >
  LtEq, // <=
  GtEq, // >=
  Plus, // +
  Minus, // -
  Star, // *
  Slash, // /
  Percent, // %
  Amp, // &
  AmpAmp, // &&
  PipePipe, // ||
  QuestionQuestion, // ?? (nullish coalesce)
  Bang, // !
  Question, // ?
  At, // @ — shader stage blocks (`@color { … }`, #1538)

  // Special
  Newline,
  EOF,
}

export interface Token {
  type: TokenType
  value: string
  line: number
  col: number
  /** True when non-token source text — whitespace, a newline, or a
   *  comment — separated this token from its predecessor. The lexer is
   *  the only component that holds the source, so it is the single
   *  authority for this bit; a re-serializer that rebuilds source text
   *  from tokens (`captureFnCallAsString`) replays it instead of
   *  guessing where a space belongs. Absent (`undefined`) means the two
   *  tokens were written adjacent — `50%`, `120deg`, `.6`. (#2544) */
  spaceBefore?: boolean
}

const KEYWORDS: Record<string, TokenType> = {
  import: TokenType.Import,
  source: TokenType.Source,
  layer: TokenType.Layer,
  background: TokenType.Background,
  preset: TokenType.Preset,
  from: TokenType.From,
  to: TokenType.To,
  symbol: TokenType.SymbolDef,
  keyframes: TokenType.Keyframes,
  fn: TokenType.Fn,
  struct: TokenType.Struct,
  input: TokenType.Input,
  true: TokenType.Bool,
  false: TokenType.Bool,
}

const UNITS: Record<string, TokenType> = {
  px: TokenType.Px,
  m: TokenType.M,
  km: TokenType.Km,
  nm: TokenType.Nm,
  deg: TokenType.Deg,
  s: TokenType.S,
  ms: TokenType.Ms,
}

export function lookupKeyword(word: string): TokenType {
  return KEYWORDS[word] ?? TokenType.Identifier
}

export function lookupUnit(word: string): TokenType | null {
  return UNITS[word] ?? null
}

/** Can `name` be emitted as a BARE identifier, or must an emitter QUOTE it?
 *
 *  Two conditions, and the second is the one that is easy to miss. The name
 *  must match the identifier character class — that much is obvious from the
 *  grammar, and it is why the hyphenated `raster-dem` has to be quoted
 *  (`type: raster-dem` re-parses as the expression `raster - dem`). But it
 *  must ALSO not be a keyword: `readIdentifier` ends with `lookupKeyword`, so
 *  an identifier-shaped keyword never reaches the parser as an Identifier.
 *
 *  Measured on all 14 keywords, every one of which is identifier-shaped:
 *  twelve (`source`, `layer`, `input`, `fn`, …) make the parser THROW
 *  (`Unexpected token: source (Source)`) and kill the whole file, and
 *  `true` / `false` lower to the `geojson` default with the source's options
 *  silently dropped — the exact loss #2549 exists to prevent. Control:
 *  `custom_name` round-trips.
 *
 *  This is the SINGLE AUTHORITY for that rule, shared by every `type:`
 *  emitter (blueprint's codegen and the Mapbox converter), so the two cannot
 *  drift apart — and it is derived from `KEYWORDS` rather than restating it. */
export function isBareIdentifierSafe(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) && lookupKeyword(name) === TokenType.Identifier
}
