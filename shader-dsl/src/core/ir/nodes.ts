// ═══ Shader DSL — IR node + declaration interfaces ═══
//
// The pure data shapes of the IR: expression nodes (Expr), statement nodes
// (Stmt), and module-level declarations. No Node class, no runtime helpers —
// just the structural types the authoring layer (node.ts/builder.ts) builds and
// the backends consume. Imports only types.ts.

import type { ShaderType } from './types'

// ── Expression nodes ──

export type BinOp = '+' | '-' | '*' | '/' | '%' | '&' | '|' | '^' | '<<' | '>>'
export type CmpOp = '<' | '>' | '<=' | '>=' | '==' | '!='
export type LogOp = '&&' | '||'

export type Expr =
  | { readonly op: 'lit'; readonly type: ShaderType; readonly value: number | boolean }
  | { readonly op: 'constref'; readonly type: ShaderType; readonly name: string }
  | { readonly op: 'param'; readonly type: ShaderType; readonly name: string }
  | { readonly op: 'varref'; readonly type: ShaderType; readonly name: string }
  | { readonly op: 'binop'; readonly type: ShaderType; readonly bop: BinOp; readonly a: Expr; readonly b: Expr }
  | { readonly op: 'unop'; readonly type: ShaderType; readonly a: Expr }
  | { readonly op: 'compare'; readonly type: ShaderType; readonly cop: CmpOp; readonly a: Expr; readonly b: Expr }
  | { readonly op: 'logical'; readonly type: ShaderType; readonly lop: LogOp; readonly a: Expr; readonly b: Expr }
  | { readonly op: 'call'; readonly type: ShaderType; readonly fn: string; readonly args: readonly Expr[] }
  | { readonly op: 'member'; readonly type: ShaderType; readonly base: Expr; readonly field: string }
  | { readonly op: 'construct'; readonly type: ShaderType; readonly args: readonly Expr[] }
  | { readonly op: 'select'; readonly type: ShaderType; readonly cond: Expr; readonly ifTrue: Expr; readonly ifFalse: Expr }
  | { readonly op: 'index'; readonly type: ShaderType; readonly base: Expr; readonly idx: Expr }
  // `match (scrutinee) { case v0: e0; ...; default: dflt }`. The WGSL backend
  // pre-emit pass (core/passes/match-lower.ts) lowers every matchExpr inside
  // an fn body into a hoisted `{ Stmt.var slot, Stmt.switch }` pair + a
  // varref to the slot; emitExpr never sees a `matchExpr` Expr post-lowering.
  // The CPU backend evaluates the scrutinee then returns the matched case's
  // value or the default. Phase 2.5 (US-001).
  | { readonly op: 'matchExpr'; readonly type: ShaderType; readonly scrutinee: Expr; readonly cases: ReadonlyArray<readonly [number, Expr]>; readonly default: Expr }

// ── Statement nodes ──

export type Stmt =
  | { readonly s: 'let'; readonly name: string; readonly expr: Expr }
  | { readonly s: 'var'; readonly name: string; readonly type: ShaderType; readonly init?: Expr }
  | { readonly s: 'assign'; readonly target: Expr; readonly expr: Expr }
  | { readonly s: 'assignOp'; readonly target: Expr; readonly bop: BinOp; readonly expr: Expr }
  | { readonly s: 'if'; readonly arms: ReadonlyArray<{ readonly cond: Expr; readonly body: readonly Stmt[] }>; readonly elseBody?: readonly Stmt[] }
  | { readonly s: 'return'; readonly expr?: Expr }
  | { readonly s: 'for'; readonly init: Stmt; readonly cond: Expr; readonly update: Stmt; readonly body: readonly Stmt[] }
  | { readonly s: 'switch'; readonly scrut: Expr; readonly cases: ReadonlyArray<{ readonly value: number; readonly body: readonly Stmt[] }>; readonly defaultBody?: readonly Stmt[] }
  | { readonly s: 'break' }
  | { readonly s: 'continue' }
  | { readonly s: 'discard' }
  // Phase 2.5 US-007 — composer-swap marker. The polygon DSL module
  // (shaders/polygon.ts) lays down a placeholder Stmt at each
  // variant-injection site (`fill-return` / `stroke-return`); the
  // composer (emitPolygonWgsl) walks the cloned module and replaces
  // each placeholder with the variant's fill-/stroke- return expr.
  // emitStmt emits a defensive `// __placeholder: ${tag}` comment if
  // a placeholder leaks past the composer; the CPU backend throws
  // (the comment would silently no-op a missing return). The
  // lowerModule pre-emit pass treats placeholder as a leaf — no
  // matchExpr lowering descends into it.
  | { readonly s: 'placeholder'; readonly tag: string }
  // Phase 2 PR 2e.B.2 — raw WGSL passthrough. Carries a pre-built WGSL
  // fragment emitted verbatim (at the enclosing body indent) before the
  // surrounding statements. Used by the polygon composer's fill/stroke
  // preamble slot to inject the compiler-emitted match `_mcSS` chain
  // string directly, retiring the renderer's former post-emit string
  // splice (+ the compiler-side nodeToWgslString copy). GPU-only: the
  // CPU backend throws (raw WGSL has no CPU evaluation), and the
  // lowerModule pass treats it as a leaf (no sub-Expr to lower).
  | { readonly s: 'raw'; readonly wgsl: string }

// ── Module-level declarations ──

export interface ConstDecl {
  readonly name: string
  readonly type: ShaderType
  /** Value emitted by the WGSL backend (the truncated shader constant). */
  readonly wgslValue: number
  /** Value used by the CPU backend (full-precision, matching the mirror). */
  readonly cpuValue: number
}

export interface StructField {
  readonly name: string
  readonly type: ShaderType
  /** Optional WGSL field attribute(s) for I/O structs, e.g.
   *  `@builtin(position)`, `@location(0)`, `@location(0) @interpolate(flat)`. */
  readonly attr?: string
}
export interface StructDecl { readonly name: string; readonly fields: readonly StructField[] }

export type AddressSpace = 'uniform' | 'storage'
export interface BindingDecl {
  readonly group: number
  readonly binding: number
  readonly name: string
  readonly space: AddressSpace
  /** storage access — read | read_write (ignored for uniform). */
  readonly access?: 'read' | 'read_write'
  readonly type: ShaderType
}

export interface FuncDecl {
  readonly name: string
  readonly params: readonly { name: string; type: ShaderType; builtin?: string; location?: number }[]
  readonly ret: ShaderType
  readonly body: readonly Stmt[]
  /** Stage / pipeline attributes emitted before `fn` (e.g. `@compute`,
   *  `@workgroup_size(64)`). Empty for ordinary helper functions. */
  readonly attrs?: readonly string[]
  /** Return-value attribute for a bare (non-struct) stage output, e.g. a
   *  fragment `-> @location(0) vec4<f32>`. */
  readonly retAttr?: string
  /** Documented MISRA single-exit DEVIATION — when true the single-exit static
   *  rule skips this fn (it has an intentional early return, e.g. a guard that
   *  skips an expensive loop). Use sparingly, with a comment stating why. */
  readonly allowEarlyReturn?: boolean
}

export interface ModuleDecl {
  readonly consts: readonly ConstDecl[]
  readonly structs: readonly StructDecl[]
  readonly bindings: readonly BindingDecl[]
  readonly funcs: readonly FuncDecl[]
}

/** An entry-point parameter — carries a `@builtin(...)` or a `@location(n)`. */
export interface EntryParam { readonly name: string; readonly type: ShaderType; readonly builtin?: string; readonly location?: number }
