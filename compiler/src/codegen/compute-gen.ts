// ═══════════════════════════════════════════════════════════════════
// Compute-kernel WGSL emitter — first piece of P4
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 4 (wild-finding-starlight). The full P4 vision is to
// move every per-feature paint evaluation off the fragment shader
// and onto a single compute dispatch per frame:
//
//   compute pass:
//     for each feature in scene → eval data-driven exprs → write
//     packed RGBA into a storage buffer
//   draw pass:
//     fragment shader textureLoads / readsBuffer the pre-computed
//     value at the feature's fid
//
// This commit ships the FIRST piece: a pure WGSL string builder
// that converts ONE `match(get(.field), k0 -> v0, k1 -> v1, …, _ -> default)`
// expression into a compute kernel. Future commits wire it into:
//
//   - shader-gen (alternate code path that emits compute-kernel
//     references instead of inline if-else chains),
//   - runtime (the actual `ComputeDispatcher` call site that runs
//     the kernel once per frame and binds the output buffer to the
//     fragment shader),
//   - the dependency / CSE machinery (P0 Step 3) — only routes
//     expressions whose deps ⊆ {FEATURE} through compute; ZOOM-only
//     paths stay on the gradient-atlas path (P3).
//
// Why a pure string emitter:
//
//   - Unit-testable without a GPUDevice. The output is just text,
//     comparable byte-for-byte against an expected kernel.
//   - Mirrors the shader-gen.ts pattern (fragment match() emit) —
//     two emitters using the same canonical match() AST shape,
//     producing two specialised outputs for two execution models.
//   - Keeps the compute kernel + runtime dispatch decoupled. The
//     emitter doesn't know about ComputeDispatcher; the dispatcher
//     doesn't know how the WGSL was generated.
//
// What this module DOES NOT do:
//
//   - Emit anything besides match(). The full P4 vision covers
//     case(), interpolate() with feature deps, scale(), etc. Each
//     gets its own emit helper in a later commit.
//   - Decide whether to use compute. shader-gen's routing layer
//     picks compute vs inline if-else based on the variant's
//     deps + feature count, NOT this module.
//   - Compose multiple kernels. The runtime concatenates per-show
//     kernel emissions into one dispatched compute pass; this
//     emitter ships one match() at a time.

import { resolveColorToRgba } from '../tokens/colors'
import {
  fn, module, emitModule, storageBuffer, resource, builtin,
  If, Return, Var, Let, vec4, mix, pack4x8unorm, matchExpr, toI32, toU32, max,
  constExpr, constRef, arrayLit, arrayT,
  f32T, u32T, vec3uT, vec4uT, vec4fT, type Node, type ConstDecl,
} from '@xgis/shader-dsl'

/** Workgroup size used by every emitted kernel. 64 is the WebGPU
 *  spec's lowest-common-denominator that maps cleanly to NVIDIA
 *  warps (32) and AMD wavefronts (32 / 64) without sub-occupancy.
 *  Per-feature material eval has no shared-memory cooperation, so
 *  larger workgroups don't help. */
export const COMPUTE_WORKGROUP_SIZE = 64

/** Threshold (plan P5) above which `emitMatchComputeKernel` switches
 *  from an O(N) if-else chain to an O(1) `LUT[u32(v_field)]` access.
 *  For arm counts below this, the if-else is competitive (branch
 *  prediction + early-out per fragment) and avoids the WGSL const-
 *  array slot. For arm counts at/above, the constant LUT array is
 *  faster + scales — demotiles' 428-arm `ADM0_A3` country palette
 *  is the canonical real-fixture target.
 *
 *  16 picked to align with the plan's recommended threshold; OFM
 *  fixtures have no surviving match()'s above 8 arms so 16 is well
 *  past anything observed there. Adjust if profiling shows a
 *  different crossover. */
const MATCH_LUT_THRESHOLD = 16

/** Runtime override for the LUT threshold. Set
 *  `globalThis.__XGIS_MATCH_LUT_THRESHOLD = N` BEFORE the scene
 *  compiles to force LUT emission at a lower arm count for A/B
 *  benchmarks. Returns the override when set + >= 1, otherwise
 *  undefined so callers fall back to the const above. Used by the
 *  `_perf-compute-strategy.spec.ts` measurement spec — flip the
 *  threshold between runs to compare GPU timing on the same scene. */
function readMatchLutThresholdOverride(): number | undefined {
  if (typeof globalThis === 'undefined') return undefined
  const v = (globalThis as { __XGIS_MATCH_LUT_THRESHOLD?: number })
    .__XGIS_MATCH_LUT_THRESHOLD
  return typeof v === 'number' && v >= 1 ? v : undefined
}

/** Result of an emitter call. `wgsl` is the complete compute-shader
 *  module source ready to feed `createShaderModule`. `dispatchSize`
 *  helper tells the runtime how many workgroups to launch for a
 *  given feature count: `ceil(features / COMPUTE_WORKGROUP_SIZE)`. */
export interface ComputeKernel {
  wgsl: string
  /** WGSL function name to use as the pipeline entry point. Each
   *  emitter picks a distinct name (`eval_match`, `eval_case`,
   *  `eval_interpolate`) so the runtime can build separate
   *  ComputePipeline objects without name collision when multiple
   *  kernels share a pipeline-cache key family. */
  entryPoint: string
  /** Number of f32 slots per feature in the feat_data buffer the
   *  runtime must populate. The emitter packs one slot per field
   *  referenced (typed-array stride). */
  featureStrideF32: number
  /** Ordered field names the runtime must lay out in feat_data —
   *  matches the offsets the kernel reads. `fieldOffsets[i]` = i. */
  fieldOrder: string[]
  /** For kernels that match string-typed feature properties (today:
   *  only the match() kernel), the alphabetised pattern list per
   *  field. ID == index into the list; the runtime packer uses this
   *  to convert string feature values into f32 IDs before upload.
   *  Empty / absent for kernels whose predicates are pure numeric
   *  comparisons (ternary, interpolate). */
  categoryOrder?: Record<string, readonly string[]>
  /** Convenience: dispatch X count for a given total feature count. */
  dispatchSize(featureCount: number): number
}

/** One arm of the input match() expression. `pattern` is the string
 *  the kernel matches against the feature field value; the runtime
 *  assigns each pattern an integer ID at decode time (the
 *  categoryOrder convention from shader-gen). `colorHex` is the
 *  RGBA literal the kernel emits when the arm matches. */
export interface MatchArmSpec {
  pattern: string
  colorHex: string
}

/** Inputs for `emitMatchComputeKernel`. `fieldName` is the feature
 *  property the match() pivots on (a single FieldAccess). `arms` is
 *  the ordered, pattern-to-colour list. `defaultColorHex` is the
 *  fallback emitted when no arm matches (often the `_` arm or the
 *  compound-fill `#00000000` synthesised by merge-layers). */
export interface MatchEmitSpec {
  fieldName: string
  arms: MatchArmSpec[]
  defaultColorHex: string
}

/** Emit a complete WGSL compute kernel for one match() expression.
 *  Output layout:
 *
 *    @group(0) @binding(0) var<storage, read>       feat_data:  array<f32>;
 *    @group(0) @binding(1) var<storage, read_write> out_color:  array<u32>;
 *    @group(0) @binding(2) var<uniform>             u_count:    vec4<u32>;
 *
 *    @compute @workgroup_size(64)
 *    fn eval_match(@builtin(global_invocation_id) gid: vec3<u32>) {
 *      let fid = gid.x;
 *      if (fid >= u_count.x) { return; }
 *      let cls = feat_data[fid * STRIDE + 0];
 *      var color: vec4<f32>;
 *      if (cls == 0.0) { color = …; }
 *      else if (cls == 1.0) { color = …; }
 *      …
 *      else { color = …; }  // default
 *      out_color[fid] = pack4x8unorm(color);
 *    }
 *
 *  `u_count` uses a vec4<u32> wrapper so the uniform buffer is the
 *  16-byte minimum WebGPU requires for uniform bindings.
 */
export function emitMatchComputeKernel(spec: MatchEmitSpec): ComputeKernel {
  // Sort patterns alphabetically — must match shader-gen's
  // `sortedPatterns` (line ~227 in shader-gen.ts) so the runtime's
  // string→ID assignment lines up across fragment + compute paths.
  // Two kernels emitted from the same arm set produce IDENTICAL
  // category IDs; the per-feature buffer fills exactly once.
  const sortedPatterns = [...spec.arms.map(a => a.pattern)].sort()
  const armByPattern = new Map(spec.arms.map(a => [a.pattern, a]))

  const rgba = (hex: string): Node<'vec4<f32>'> => {
    const [r, g, b, a] = colorHexToRGBA(hex)
    return vec4(r, g, b, a)
  }

  // P5 LUT branch: at MATCH_LUT_THRESHOLD arms or more, a constant-array LUT +
  // `LUT[id]` (O(1)) beats a per-arm comparison. The LUT is a deliberate GPU-perf
  // STRATEGY (A/B'd by _perf-compute-strategy.spec via the __XGIS_MATCH_LUT_THRESHOLD
  // override). Both branches now author through the shader-dsl IR: the LUT is a
  // first-class `array<vec4<f32>, N>` module const (ConstDecl.valueExpr), and the
  // sub-threshold path lowers `matchExpr` → WGSL switch. Either way the kernel
  // inherits cse / const-fold / dce + the std430 layout — no hand-assembled WGSL.
  const useLut = sortedPatterns.length >= (readMatchLutThresholdOverride() ?? MATCH_LUT_THRESHOLD)
  const wgsl = useLut
    ? emitComputeKernelWgsl('eval_match', (fid, featData) => {
        // O(1) LUT branch — `id = u32(max(0.0, v))`, then `LUT[id]` for any id in
        // [0, N); out-of-range (the packer's unknown/sentinel id) falls to default.
        // `Let` pins the feat_data read below the fid-bounds guard (matching the
        // interpolate/ternary kernels) so out-of-range threads never index it.
        const lutType = arrayT(vec4fT, sortedPatterns.length)
        const v = Let(featData.at(fid)) // single field → stride 1 → offset 0
        const id = Let(toU32(max(v, 0))) // compute the LUT index once
        const color = Var(vec4fT)
        If(id.lt(sortedPatterns.length), () => {
          color.assign(constRef('LUT', lutType).at(id, vec4fT))
        }).else(() => {
          color.assign(rgba(spec.defaultColorHex))
        })
        return color
      }, [buildMatchLutConst(sortedPatterns, armByPattern)])
    : emitComputeKernelWgsl('eval_match', (fid, featData) => {
        const dflt = rgba(spec.defaultColorHex)
        // No arms → just the default colour (an empty match has no switch).
        if (sortedPatterns.length === 0) return dflt
        // Single field → stride 1 → offset 0. Scrutinee is the raw category id as
        // i32: the packer emits a non-negative arm index for a matched category and
        // -1 for unknown/unmatched (compute-feature-packer contract). `switch i32(v)`
        // matches an arm ONLY on an exact id, so -1 — and any id ≥ arm count — hits
        // `default`, exactly like the if-else chain's trailing `else` this replaces.
        // (NB: must NOT clamp with max(v,0) — that would alias -1 onto arm 0.)
        const id = toI32(featData.at(fid))
        return matchExpr(
          id,
          sortedPatterns.map((pat, i) => [i, rgba(armByPattern.get(pat)!.colorHex)] as const),
          dflt,
        )
      })

  return {
    wgsl,
    entryPoint: 'eval_match',
    featureStrideF32: 1,
    fieldOrder: [spec.fieldName],
    categoryOrder: { [spec.fieldName]: sortedPatterns },
    dispatchSize(featureCount: number): number {
      return Math.ceil(featureCount / COMPUTE_WORKGROUP_SIZE)
    },
  }
}

/** The P5 LUT as a first-class `array<vec4<f32>, N>` module const — one
 *  `vec4<f32>` per arm, indexed by sorted-pattern position (matches the packer's
 *  ID). Authored via `constExpr` (ConstDecl.valueExpr) so WGSL/GLSL/CPU-oracle all
 *  spell it from the one IR value; baked into the module, no upload or extra
 *  binding. WGSL const arrays cap at 16384 elems (428 demotiles arms fine);
 *  multi-thousand arms would need a storage-buffer LUT. */
function buildMatchLutConst(
  sortedPatterns: string[],
  armByPattern: Map<string, MatchArmSpec>,
): ConstDecl {
  const elems = sortedPatterns.map(pat => {
    const [r, g, b, a] = colorHexToRGBA(armByPattern.get(pat)!.colorHex)
    return vec4(r, g, b, a)
  })
  return constExpr('LUT', arrayT(vec4fT, elems.length), arrayLit(vec4fT, ...elems))
}

/** A comparison operator usable in a compute-kernel predicate. */
export type ComputeCmpOp = '<' | '>' | '<=' | '>=' | '==' | '!='

/** A STRUCTURED `case`-style predicate over feature fields — NOT a raw WGSL
 *  string. `cmp` tests one field against a numeric literal; `and` conjoins two
 *  sub-predicates. `emitTernaryComputeKernel` lowers it to the shader-dsl IR
 *  (compare / logical Nodes referencing the loaded field), so the predicate
 *  flows through the same neutral emit + CPU oracle as every other expression
 *  instead of being spliced in as opaque text. Every `field` named here MUST
 *  appear in `TernaryEmitSpec.fields` (the kernel loads those from `feat_data`). */
export type ComputePredicate =
  | { readonly kind: 'cmp'; readonly field: string; readonly op: ComputeCmpOp; readonly value: number }
  | { readonly kind: 'and'; readonly left: ComputePredicate; readonly right: ComputePredicate }

/** One branch of a `case`-style ternary chain: a structured `pred` and the
 *  `colorHex` the branch returns when `pred` is true. */
export interface TernaryBranchSpec {
  pred: ComputePredicate
  colorHex: string
}

/** Inputs for `emitTernaryComputeKernel`. `fields` lists the feature
 *  field names referenced in any predicate, in the order they appear
 *  in `feat_data`. Stride == `fields.length`; offsets line up by
 *  index. `defaultColorHex` is the trailing else branch. */
export interface TernaryEmitSpec {
  fields: string[]
  branches: TernaryBranchSpec[]
  defaultColorHex: string
}

/** Emit a WGSL compute kernel for a `case`-style chain. The shape
 *  mirrors `emitMatchComputeKernel` so both kernels share the same
 *  binding layout, allowing the runtime to dispatch them through one
 *  pipeline-cache key family. The difference is purely the if-else
 *  body: match() pivots a single int comparison, case() takes an
 *  arbitrary boolean predicate per branch.
 *
 *  Branches preserve their input order — `case` semantics return the
 *  FIRST matching branch (vs match() arms which are mutually
 *  exclusive). The first emitted `if` is `spec.branches[0]`.
 */
export function emitTernaryComputeKernel(spec: TernaryEmitSpec): ComputeKernel {
  const stride = spec.fields.length
  const wgsl = emitComputeKernelWgsl('eval_case', (fid, featData) => {
    const rgba = (hex: string): Node<'vec4<f32>'> => {
      const [r, g, b, a] = colorHexToRGBA(hex)
      return vec4(r, g, b, a)
    }
    // Load every referenced field once (stride/offset addressing); CSE folds
    // repeat reads. Branch predicates reference these loaded Nodes by field
    // name — there is no `v_<field>` string indirection any more.
    const fieldNodes = new Map<string, Node<'f32'>>()
    spec.fields.forEach((f, i) => {
      const addr = stride === 1 ? fid : fid.mul(stride).add(i)
      fieldNodes.set(f, Let(featData.at(addr)))
    })
    const predToNode = (p: ComputePredicate): Node<'bool'> => {
      if (p.kind === 'and') return predToNode(p.left).and(predToNode(p.right))
      const fieldNode = fieldNodes.get(p.field)
      if (!fieldNode) {
        throw new Error(`compute-gen: predicate references field "${p.field}" not in spec.fields`)
      }
      switch (p.op) {
        case '<': return fieldNode.lt(p.value)
        case '>': return fieldNode.gt(p.value)
        case '<=': return fieldNode.le(p.value)
        case '>=': return fieldNode.ge(p.value)
        case '==': return fieldNode.eq(p.value)
        case '!=': return fieldNode.ne(p.value)
      }
    }
    // case() semantics: branches preserve input order, first match wins, the
    // default colour is the trailing else. An empty branch list collapses to
    // an unconditional default assignment (no bare `else`).
    const color = Var(vec4fT)
    if (spec.branches.length === 0) {
      color.assign(rgba(spec.defaultColorHex))
    } else {
      let chain = If(predToNode(spec.branches[0]!.pred), () => { color.assign(rgba(spec.branches[0]!.colorHex)) })
      for (let i = 1; i < spec.branches.length; i++) {
        const br = spec.branches[i]!
        chain = chain.elif(predToNode(br.pred), () => { color.assign(rgba(br.colorHex)) })
      }
      chain.else(() => { color.assign(rgba(spec.defaultColorHex)) })
    }
    return color
  })

  return {
    wgsl,
    entryPoint: 'eval_case',
    featureStrideF32: Math.max(1, stride),
    fieldOrder: [...spec.fields],
    dispatchSize(featureCount: number): number {
      return Math.ceil(featureCount / COMPUTE_WORKGROUP_SIZE)
    },
  }
}

/** One stop of a per-feature linear interpolation. The kernel reads
 *  the feature's `field` value and lerps between adjacent stops'
 *  colours by the normalised distance between their `input` values.
 *  Stops MUST be supplied in ascending `input` order — the emitter
 *  trusts the caller and walks them as ranges. */
export interface InterpolateStopSpec {
  input: number
  colorHex: string
}

/** Inputs for `emitInterpolateComputeKernel`. Linear interpolation
 *  only — exponential base / cubic-bezier curves are deferred (they
 *  need pow / smoothstep WGSL math, which is fine on GPU but bloats
 *  the kernel and isn't needed for the OFM/Bright corpus the plan
 *  targets). `fieldName` is the single feature property the
 *  expression pivots on. */
export interface InterpolateEmitSpec {
  fieldName: string
  stops: InterpolateStopSpec[]
}

/** Emit a WGSL compute kernel for `interpolate(linear, get(field),
 *  s0, c0, s1, c1, …, sN, cN)`. The kernel produces a piecewise-
 *  linear function from feature value → RGBA:
 *
 *    v <= s0           → c0
 *    s0 < v <= s1      → mix(c0, c1, (v - s0) / (s1 - s0))
 *    …
 *    sN-1 < v <= sN    → mix(cN-1, cN, (v - sN-1) / (sN - sN-1))
 *    v > sN            → cN
 *
 *  Shape mirrors match()/case() kernels exactly: same binding header,
 *  same pack4x8unorm output. The if-else chain is emitted in stop
 *  order (ascending input). Less than 2 stops is an error condition
 *  (no interpolation meaningful) — emitter returns a kernel that
 *  emits the first stop's colour unconditionally so the dispatch
 *  still runs.
 */
/** Shared compute-kernel SHELL, authored in the shader-dsl IR (NOT hand-built
 *  strings — charter §codegen, package-responsibilities.md). Every kernel has the
 *  identical binding header + `@compute @workgroup_size` entry + per-fid guard +
 *  `out_color[fid] = pack4x8unorm(color)` tail; only the per-feature COLOUR body
 *  varies. `buildColor` receives the `fid` index + the `feat_data` buffer and returns
 *  the vec4 colour Node (doing its own field loads + control flow). Routing the body
 *  through `emitModule` gives it cse / autoVars / const-fold / dce for free, and the
 *  std430/reflection layout — the whole reason this stops being a string builder. */
function emitComputeKernelWgsl(
  entryName: string,
  buildColor: (fid: Node<'u32'>, featData: { at(i: Node<'u32'>): Node<'f32'> }) => Node<'vec4<f32>'>,
  consts: ConstDecl[] = [],
): string {
  const featData = storageBuffer('feat_data', f32T, { group: 0, binding: 0, access: 'read' })
  const outColor = storageBuffer('out_color', u32T, { group: 0, binding: 1, access: 'read_write' })
  const uCount = resource('u_count', vec4uT, { group: 0, binding: 2 }) // vec4<u32> — 16-byte UBO min
  const kernel = fn(entryName, { gid: builtin('global_invocation_id', vec3uT) }, ({ gid }) => {
    const fid = gid.x
    If(fid.ge(uCount.node.x), () => { Return() })
    const color = buildColor(fid, featData)
    outColor.at(fid).assign(pack4x8unorm(color))
  }, { stage: 'compute', workgroupSize: COMPUTE_WORKGROUP_SIZE })
  return emitModule(module({ consts, bindings: [featData.binding, outColor.binding, uCount.binding], funcs: [kernel] }))
}

export function emitInterpolateComputeKernel(spec: InterpolateEmitSpec): ComputeKernel {
  const rgba = (hex: string): Node<'vec4<f32>'> => {
    const [r, g, b, a] = colorHexToRGBA(hex)
    return vec4(r, g, b, a)
  }
  const wgsl = emitComputeKernelWgsl('eval_interpolate', (fid, featData) => {
    const v = Let(featData.at(fid)) // single field → stride 1 → offset 0
    const color = Var(vec4fT)
    if (spec.stops.length === 0) {
      color.assign(vec4(0, 0, 0, 0)) // degenerate (caller shouldn't reach) — valid WGSL
    } else if (spec.stops.length === 1) {
      color.assign(rgba(spec.stops[0]!.colorHex))
    } else {
      // first range: v <= s0 → c0 (clamp left)
      let chain = If(v.le(spec.stops[0]!.input), () => { color.assign(rgba(spec.stops[0]!.colorHex)) })
      // middle ranges: s[i-1] < v <= s[i] → mix(c[i-1], c[i], (v − s[i-1]) / (s[i] − s[i-1]))
      for (let i = 1; i < spec.stops.length; i++) {
        const prev = spec.stops[i - 1]!, curr = spec.stops[i]!
        const denom = curr.input - prev.input
        const safeDenom = denom === 0 ? 1 : denom // guard collide (caller bug); ordering makes prev<curr hold
        chain = chain.elif(v.le(curr.input), () => {
          color.assign(mix(rgba(prev.colorHex), rgba(curr.colorHex), v.sub(prev.input).div(safeDenom)))
        })
      }
      // trailing range: v > sN → cN (clamp right)
      const last = spec.stops[spec.stops.length - 1]!
      chain.else(() => { color.assign(rgba(last.colorHex)) })
    }
    return color
  })
  return {
    wgsl,
    entryPoint: 'eval_interpolate',
    featureStrideF32: 1,
    fieldOrder: [spec.fieldName],
    dispatchSize(featureCount: number): number {
      return Math.ceil(featureCount / COMPUTE_WORKGROUP_SIZE)
    },
  }
}

/** Resolve an arm/default colour spec to normalised RGBA for the compute
 *  kernels. Delegates to the canonical resolver in `tokens/` — colour
 *  resolution is the compiler's `tokens/` layer's job, not codegen's
 *  (charter §g, docs/architecture/package-responsibilities.md). */
function colorHexToRGBA(hex: string): [number, number, number, number] {
  return resolveColorToRgba(hex)
}
