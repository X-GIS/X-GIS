// ═══════════════════════════════════════════════════════════════════
// node-types — compiler-side DSL Node vocabulary (permanent)
// ═══════════════════════════════════════════════════════════════════
//
// The structural mirror of the runtime shader-DSL IR `Expr` union plus the
// `NodeLike` seam type and the `wgslRaw` helper. These are the compiler's
// codegen vocabulary — NOT migration scaffolding — so they live here in a
// permanent home.
//
// Relocated out of the former `_back-compat/` directory: the type vocabulary
// landed here in PR 2e.B.1; the `nodeToWgslString` emit oracle (`node-to-wgsl.ts`)
// imports its types from here. The renderer splice-point that depended on the
// adapter retired in PR 2e.B.2.
//
// The `Expr` shape MUST stay in lock-step with
// `runtime/src/engine/shader-dsl/core/ir/nodes.ts` Expr union — the compiler
// can't import the runtime type directly (compiler/tsconfig.json's rootDir
// excludes runtime/, and the runtime package is the dependent in the
// workspace chain). The boundary is pinned by `node-to-wgsl.test.ts`.

type Scalar = 'f32' | 'i32' | 'u32' | 'bool'

export type ShaderType =
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
  | { readonly op: 'matchExpr'; readonly type: ShaderType; readonly scrutinee: Expr; readonly cases: ReadonlyArray<readonly [number, Expr]>; readonly default: Expr }
  // back-compat wrapper — carries a pre-built WGSL string so the compiler-side
  // emit sites can satisfy the Node-typed ShaderVariant fields without yet
  // constructing real Node values. `nodeToWgslString` unwraps this verbatim.
  // Retires with the renderer splice-point (PR 2e.B.2).
  | { readonly op: 'rawString'; readonly value: string }

/**
 * Structural Node mirror — the compiler can't import the runtime Node
 * class directly (compiler/tsconfig.json's rootDir excludes runtime/
 * and the runtime package is the dependent in the workspace chain).
 * Runtime's actual `Node<K>` is structurally assignable to this shape;
 * the typed `__k?: K` brand carries the WGSL key for type safety in
 * the compiler-side codegen.
 */
export interface NodeLike<K extends string = string> {
  readonly expr: Expr
  readonly __k?: K
}

/**
 * Wrap a pre-built WGSL string as a NodeLike so the compiler-side emit
 * sites can satisfy the Node-typed ShaderVariant fields where a real Node
 * value is not yet constructed. The renderer splice-point reconstructs the
 * string via `nodeToWgslString`; both retire in PR 2e.B.2.
 */
export function wgslRaw<K extends string>(s: string): NodeLike<K> {
  return { expr: { op: 'rawString', value: s } }
}
