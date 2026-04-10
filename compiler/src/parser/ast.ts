// ═══ AST Node Types for X-GIS ═══

export type Program = {
  kind: 'Program'
  body: Statement[]
}

export type Statement =
  | LetStatement
  | ShowStatement
  | FnStatement
  | ExprStatement
  | SourceStatement
  | LayerStatement

// let world = load("countries.geojson")
export type LetStatement = {
  kind: 'LetStatement'
  name: string
  value: Expr
  line: number
}

// show world { fill: #f2efe9, stroke: #ccc, 1px }
export type ShowStatement = {
  kind: 'ShowStatement'
  target: Expr
  block: ShowBlock
  line: number
}

export type ShowBlock = {
  kind: 'ShowBlock'
  properties: ShowProperty[]
}

// fill: #f2efe9 or stroke: #ccc, 1px or shape: arrow
export type ShowProperty = {
  kind: 'ShowProperty'
  name: string
  values: Expr[]
  line: number
}

// fn name(params) -> ReturnType { body }
export type FnStatement = {
  kind: 'FnStatement'
  name: string
  params: Param[]
  returnType: string | null
  body: Statement[]
  line: number
}

export type Param = {
  name: string
  type: string
}

// Expression as statement (function call, etc.)
export type ExprStatement = {
  kind: 'ExprStatement'
  expr: Expr
  line: number
}

// ═══ Expressions ═══

export type Expr =
  | NumberLiteral
  | StringLiteral
  | ColorLiteral
  | BoolLiteral
  | Identifier
  | FieldAccess
  | FnCall
  | BinaryExpr
  | UnaryExpr
  | PipeExpr
  | MatchBlock

export type NumberLiteral = {
  kind: 'NumberLiteral'
  value: number
  unit: string | null // 'px', 'm', 'km', 'deg', etc.
}

export type StringLiteral = {
  kind: 'StringLiteral'
  value: string
}

export type ColorLiteral = {
  kind: 'ColorLiteral'
  value: string // '#ff0000'
}

export type BoolLiteral = {
  kind: 'BoolLiteral'
  value: boolean
}

export type Identifier = {
  kind: 'Identifier'
  name: string
}

// .field access (data binding)
export type FieldAccess = {
  kind: 'FieldAccess'
  object: Expr | null // null means implicit current data (e.g., .speed)
  field: string
}

// load("file"), clamp(4, 24), etc.
export type FnCall = {
  kind: 'FnCall'
  callee: Expr
  args: Expr[]
}

// a + b, a > b, etc.
export type BinaryExpr = {
  kind: 'BinaryExpr'
  op: string
  left: Expr
  right: Expr
}

// -x, !x
export type UnaryExpr = {
  kind: 'UnaryExpr'
  op: string
  operand: Expr
}

// expr | transform | transform
export type PipeExpr = {
  kind: 'PipeExpr'
  input: Expr
  transforms: FnCall[]
}

// { hostile: #ff0000, friendly: #00ff00, _: #808080 }
export type MatchBlock = {
  kind: 'MatchBlock'
  arms: MatchArm[]
}

export type MatchArm = {
  pattern: string // key name or '_' for default
  value: Expr
}

// ═══ New syntax: source/layer/utility (DESIGN.md v3) ═══

// source world { type: geojson, url: "./data/countries.geojson" }
export type SourceStatement = {
  kind: 'SourceStatement'
  name: string
  properties: BlockProperty[]
  line: number
}

// layer districts { source: neighborhoods, | fill-blue-400 stroke-white stroke-2 }
export type LayerStatement = {
  kind: 'LayerStatement'
  name: string
  properties: BlockProperty[]
  utilities: UtilityLine[]
  line: number
}

// Generic key: value property used in source/layer blocks
export type BlockProperty = {
  kind: 'BlockProperty'
  name: string
  value: Expr
  line: number
}

// A single | line: | fill-red-500 stroke-white stroke-2 opacity-80
export type UtilityLine = {
  kind: 'UtilityLine'
  items: UtilityItem[]
  line: number
}

// A single utility item, e.g., z8:fill-red-500 or size-[speed/50]
export type UtilityItem = {
  kind: 'UtilityItem'
  modifier: string | null   // e.g., "z8", "friendly", "hover" (before the colon)
  name: string              // e.g., "fill-red-500", "stroke-2", "opacity-80"
  binding: Expr | null      // e.g., the expression inside [...] for data binding
}
