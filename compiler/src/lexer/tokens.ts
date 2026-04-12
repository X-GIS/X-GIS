export enum TokenType {
  // Literals
  Number, // 42, 3.14
  String, // "hello"
  Color, // #ff0000, #ccc
  Bool, // true, false

  // Identifiers & Keywords
  Identifier, // foo, bar
  Let, // let
  Fn, // fn
  Show, // show
  Place, // place
  View, // view
  On, // on
  If, // if
  Else, // else
  For, // for
  In, // in
  Return, // return
  Simulate, // simulate
  Analyze, // analyze
  Import, // import
  Struct, // struct
  Enum, // enum
  Source, // source
  Layer, // layer
  Preset, // preset
  From, // from
  Export, // export
  SymbolDef, // symbol
  Style, // style

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
  Bang, // !

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
  let: TokenType.Let,
  fn: TokenType.Fn,
  show: TokenType.Show,
  place: TokenType.Place,
  view: TokenType.View,
  on: TokenType.On,
  if: TokenType.If,
  else: TokenType.Else,
  for: TokenType.For,
  in: TokenType.In,
  return: TokenType.Return,
  simulate: TokenType.Simulate,
  analyze: TokenType.Analyze,
  import: TokenType.Import,
  struct: TokenType.Struct,
  enum: TokenType.Enum,
  source: TokenType.Source,
  layer: TokenType.Layer,
  preset: TokenType.Preset,
  from: TokenType.From,
  export: TokenType.Export,
  symbol: TokenType.SymbolDef,
  style: TokenType.Style,
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
