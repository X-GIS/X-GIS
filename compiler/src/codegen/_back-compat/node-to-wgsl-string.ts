// ═══════════════════════════════════════════════════════════════════
// nodeToWgslString — DSL Node → WGSL string adapter (REMOVED IN STEP 14)
// ═══════════════════════════════════════════════════════════════════
//
// Phase 2.5 US-003 — keeps the compiler ↔ runtime boundary buildable
// across the in-flight retarget. The compiler-side emit sites migrate
// one at a time from string assembly to DSL Node construction (US-005);
// the runtime still consumes ShaderVariant.{fillExpr, strokeExpr} as
// strings during the in-between commits. This adapter converts a
// Node value (`{ expr: Expr }`) to the WGSL string the runtime expects.
//
// REMOVED IN STEP 14: once US-008's runtime rewire makes
// `emitPolygonWgsl(variant, ...)` consume Node values directly, this
// file (and the @back-compat directory) is deleted in the same commit.
//
// Implementation choice: self-contained `emitExpr` copy rather than a
// cross-workspace import. The compiler/tsconfig.json has
// `rootDir: ./src`, so a relative import of
// `runtime/src/engine/shader-dsl/core/backends/wgsl.ts` would push a
// runtime file into the compiler's TypeScript program (outside
// rootDir → tsc error). Adding `@xgis/runtime` as a compiler
// workspace dep would create a cycle (runtime already declares
// `@xgis/compiler` as a workspace dep, so runtime's package would
// then transitively depend on itself).
//
// Drift risk: the copy diverges from `runtime/.../wgsl.ts:emitExpr` if
// either file changes during the migration. The US-008 deletion
// commit closes the window. A small round-trip test in this directory
// (`node-to-wgsl-string.test.ts`) pins the boundary.

// Local Expr type — minimal duplicate of runtime IR shape. Kept here
// so the adapter is fully self-contained. The shape MUST stay in lock-
// step with `runtime/src/engine/shader-dsl/core/ir/nodes.ts` Expr union
// until US-008 deletes this file. Once the runtime migrates to Node-
// consuming variants, this type goes away with the file.

type Scalar = 'f32' | 'i32' | 'u32' | 'bool'

type ShaderType =
  | { readonly kind: 'scalar'; readonly scalar: Scalar }
  | { readonly kind: 'vec'; readonly n: 2 | 3 | 4; readonly elem: 'f32' | 'i32' | 'u32' }
  | { readonly kind: 'mat'; readonly n: 2 | 3 | 4; readonly elem: 'f32' }
  | { readonly kind: 'struct'; readonly name: string }
  | { readonly kind: 'array'; readonly elem: ShaderType; readonly size?: number }
  | { readonly kind: 'texture'; readonly dim: '2d'; readonly elem: 'f32' }
  | { readonly kind: 'sampler' }
  | { readonly kind: 'void' }

type BinOp = '+' | '-' | '*' | '/' | '%' | '&' | '|' | '^' | '<<' | '>>'
type CmpOp = '<' | '>' | '<=' | '>=' | '==' | '!='
type LogOp = '&&' | '||'

type Expr =
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
  | { readonly op: 'matchExpr'; readonly type: ShaderType; readonly scrutinee: Expr; readonly cases: ReadonlyArray<readonly [number, Expr]>; readonly default: Expr }

interface NodeLike { readonly expr: Expr }

// ── emitExpr copy ──
//
// Verbatim copy of `runtime/src/engine/shader-dsl/core/backends/wgsl.ts:emitExpr`
// at PR #150 main HEAD. Stays in sync until the US-008 deletion. The
// matchExpr case throws — the runtime's pre-emit lowerModule pass owns
// matchExpr-to-Stmt.switch hoisting; if a matchExpr reaches THIS path,
// the caller forgot to wrap the Node in a fn body first.

function f32Lit(v: number): string {
  if (Number.isInteger(v)) return `${v.toFixed(1)}`
  return `${v}`
}

function wgslType(t: ShaderType): string {
  switch (t.kind) {
    case 'scalar': return t.scalar
    case 'vec': return `vec${t.n}<${t.elem}>`
    case 'mat': return `mat${t.n}x${t.n}<${t.elem}>`
    case 'struct': return t.name
    case 'array': return t.size !== undefined ? `array<${wgslType(t.elem)},${t.size}>` : `array<${wgslType(t.elem)}>`
    case 'texture': return `texture_${t.dim}<${t.elem}>`
    case 'sampler': return 'sampler'
    case 'void': return 'void'
  }
}

function lit(value: number | boolean, t: ShaderType): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (t.kind === 'scalar' && t.scalar === 'u32') return `${value}u`
  if (t.kind === 'scalar' && t.scalar === 'i32') return `${value}`
  return f32Lit(value)
}

function emit(e: Expr): string {
  switch (e.op) {
    case 'lit': return lit(e.value, e.type)
    case 'constref':
    case 'param':
    case 'varref': return e.name
    case 'binop': return `(${emit(e.a)} ${e.bop} ${emit(e.b)})`
    case 'unop': return `(-${emit(e.a)})`
    case 'compare': return `(${emit(e.a)} ${e.cop} ${emit(e.b)})`
    case 'logical': return `(${emit(e.a)} ${e.lop} ${emit(e.b)})`
    case 'call': return `${e.fn}(${e.args.map(emit).join(', ')})`
    case 'member': return `${emit(e.base)}.${e.field}`
    case 'construct': return `${wgslType(e.type)}(${e.args.map(emit).join(', ')})`
    case 'select': return `select(${emit(e.ifFalse)}, ${emit(e.ifTrue)}, ${emit(e.cond)})`
    case 'index': return `${emit(e.base)}[${emit(e.idx)}]`
    case 'matchExpr': throw new Error('compiler/back-compat: matchExpr is fn-body-only — wrap the Node in an fn before stringifying')
  }
}

/**
 * Convert a DSL `Node`-shaped value (`{ expr: Expr }`) to its WGSL
 * string representation. Drop-in replacement for the legacy hand-built
 * WGSL strings during the in-flight Phase 2.5 retarget; the US-008
 * runtime rewire removes the need for this adapter entirely.
 */
export function nodeToWgslString(node: NodeLike): string {
  return emit(node.expr)
}
