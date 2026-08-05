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
