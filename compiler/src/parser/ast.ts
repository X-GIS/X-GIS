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
  | PresetStatement
  | ImportStatement
  | SymbolStatement
  | StyleStatement
  | IfStatement
  | ReturnStatement
  | ForStatement

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

// if condition { then } else { else }
export type IfStatement = {
  kind: 'IfStatement'
  condition: Expr
  thenBranch: Statement[]
  elseBranch: Statement[] | null
  line: number
}

// return expr
export type ReturnStatement = {
  kind: 'ReturnStatement'
  value: Expr | null
  line: number
}

// for i in start..end { body }
export type ForStatement = {
  kind: 'ForStatement'
  variable: string
  start: Expr
  end: Expr
  body: Statement[]
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
  | ArrayLiteral
  | ArrayAccess
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
  matchBlock?: MatchBlock  // match(field) { "val" -> color, ... }
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

export type ArrayLiteral = {
  kind: 'ArrayLiteral'
  elements: Expr[]
}

export type ArrayAccess = {
  kind: 'ArrayAccess'
  array: Expr
  index: Expr
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
  styleProperties: StyleProperty[]  // CSS-like properties: fill: stone-800
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

// preset military_track { | symbol-arrow stroke-black stroke-1 | ... }
export type PresetStatement = {
  kind: 'PresetStatement'
  name: string
  utilities: UtilityLine[]
  line: number
}

// import { name1, name2 } from "file.xgs"
export type ImportStatement = {
  kind: 'ImportStatement'
  names: string[]
  path: string
  line: number
}

// symbol arrow { path "M 0 -1 L -0.4 0.3 Z", anchor: center }
export type SymbolStatement = {
  kind: 'SymbolStatement'
  name: string
  elements: SymbolElement[]
  line: number
}

export type SymbolElement =
  | { kind: 'path'; data: string }
  | { kind: 'rect'; props: Record<string, number> }
  | { kind: 'circle'; props: Record<string, number> }
  | { kind: 'anchor'; value: string }

// style dark_land { fill: stone-800, stroke: slate-600, stroke-width: 1 }
export type StyleStatement = {
  kind: 'StyleStatement'
  name: string
  properties: StyleProperty[]
  line: number
}

// CSS-like property: fill: stone-800, stroke-width: 1, opacity: 0.8
export type StyleProperty = {
  kind: 'StyleProperty'
  name: string     // e.g., 'fill', 'stroke', 'stroke-width', 'opacity'
  value: string    // e.g., 'stone-800', '#ff0000', '1', '0.8'
  line: number
}

// A single utility item, e.g., z8:fill-red-500 or size-[speed/50]
export type UtilityItem = {
  kind: 'UtilityItem'
  modifier: string | null   // e.g., "z8", "friendly", "hover" (before the colon)
  name: string              // e.g., "fill-red-500", "stroke-2", "opacity-80"
  binding: Expr | null      // e.g., the expression inside [...] for data binding
}
