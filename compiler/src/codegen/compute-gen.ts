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

import { resolveColor } from '../tokens/colors'

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
export const MATCH_LUT_THRESHOLD = 16

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

  const lines: string[] = []
  lines.push('// Auto-generated by compiler/src/codegen/compute-gen.ts')
  lines.push('// Per-feature match() evaluation — one workgroup invocation per fid.')
  lines.push('')
  lines.push('@group(0) @binding(0) var<storage, read> feat_data: array<f32>;')
  lines.push('@group(0) @binding(1) var<storage, read_write> out_color: array<u32>;')
  lines.push('@group(0) @binding(2) var<uniform> u_count: vec4<u32>;')
  lines.push('')

  // P5 LUT branch: at MATCH_LUT_THRESHOLD arms or more, emit a
  // constant array LUT + `LUT[u32(v_field)]` access instead of an
  // O(N) if-else chain. WGSL const-array values are baked into the
  // shader module — no runtime upload, no extra binding. Caveats:
  //   - Out-of-range index reads return 0 in WGSL spec, so the
  //     packer's "unknown value → ID outside arms range" sentinel
  //     produces transparent black, matching the legacy default-arm
  //     intent only for `defaultColorHex == '#00000000'`. For
  //     non-transparent defaults we explicitly clamp + branch.
  //   - WGSL const arrays cap at 16384 elements in current
  //     implementations — 428 (demotiles) is fine; multi-thousand
  //     arms would need a storage-buffer LUT instead (P5 follow-up).
  const useLut = sortedPatterns.length >= (readMatchLutThresholdOverride() ?? MATCH_LUT_THRESHOLD)
  if (useLut) {
    // Emit the const LUT — one vec4<f32> per arm, indexed by the
    // sorted-pattern position (matches packer's ID).
    const lutLines: string[] = []
    lutLines.push(
      `const LUT: array<vec4<f32>, ${sortedPatterns.length}> = array<vec4<f32>, ${sortedPatterns.length}>(`,
    )
    for (let i = 0; i < sortedPatterns.length; i++) {
      const arm = armByPattern.get(sortedPatterns[i]!)!
      const [r, g, b, a] = colorHexToRGBA(arm.colorHex)
      const comma = i === sortedPatterns.length - 1 ? '' : ','
      lutLines.push(`  vec4<f32>(${fmt(r)}, ${fmt(g)}, ${fmt(b)}, ${fmt(a)})${comma}`)
    }
    lutLines.push(');')
    lutLines.push('')
    lines.push(...lutLines)
  }

  lines.push(`@compute @workgroup_size(${COMPUTE_WORKGROUP_SIZE})`)
  lines.push('fn eval_match(@builtin(global_invocation_id) gid: vec3<u32>) {')
  lines.push('  let fid = gid.x;')
  lines.push('  if (fid >= u_count.x) { return; }')
  // Single field → stride 1 → offset 0. The full P4 emitter will
  // grow to handle multi-field match()/case combos with a real
  // stride > 1.
  lines.push(`  let v_${spec.fieldName} = feat_data[fid];`)
  lines.push('  var color: vec4<f32>;')

  if (useLut) {
    // O(1) LUT branch — clamp the ID to the valid arm range; any
    // index out of [0, N) falls through to the default branch so
    // unknown / sentinel feature values (packer maps these to
    // arms.length+) produce the explicit default colour.
    const [dr, dg, db, da] = colorHexToRGBA(spec.defaultColorHex)
    lines.push(`  let id = u32(max(0.0, v_${spec.fieldName}));`)
    lines.push(`  if (id < ${sortedPatterns.length}u) {`)
    lines.push(`    color = LUT[id];`)
    lines.push(`  } else {`)
    lines.push(`    color = vec4<f32>(${fmt(dr)}, ${fmt(dg)}, ${fmt(db)}, ${fmt(da)});`)
    lines.push(`  }`)
  } else {
    // Legacy if-else chain — mirrors shader-gen's match() WGSL
    // emission, branch-predicted per fragment. Cheaper than the
    // LUT path for small arm counts because there's no const-array
    // backing storage in the shader module.
    for (let i = 0; i < sortedPatterns.length; i++) {
      const pat = sortedPatterns[i]!
      const arm = armByPattern.get(pat)!
      const [r, g, b, a] = colorHexToRGBA(arm.colorHex)
      const keyword = i === 0 ? 'if' : 'else if'
      lines.push(
        `  ${keyword} (v_${spec.fieldName} == ${fmt(i)}) {`
        + ` color = vec4<f32>(${fmt(r)}, ${fmt(g)}, ${fmt(b)}, ${fmt(a)});`
        + ` }`,
      )
    }
    // Default branch — always present, mirrors shader-gen's
    // `fallbackColor`. Compound merge-layers commonly produces
    // `#00000000` (transparent fall-through) so non-listed feature
    // classes silently skip rendering.
    const [dr, dg, db, da] = colorHexToRGBA(spec.defaultColorHex)
    lines.push(
      `  else { color = vec4<f32>(${fmt(dr)}, ${fmt(dg)}, ${fmt(db)}, ${fmt(da)}); }`,
    )
  }

  lines.push('  out_color[fid] = pack4x8unorm(color);')
  lines.push('}')
  lines.push('')

  return {
    wgsl: lines.join('\n'),
    entryPoint: 'eval_match',
    featureStrideF32: 1,
    fieldOrder: [spec.fieldName],
    categoryOrder: { [spec.fieldName]: sortedPatterns },
    dispatchSize(featureCount: number): number {
      return Math.ceil(featureCount / COMPUTE_WORKGROUP_SIZE)
    },
  }
}

/** One branch of a `case`-style ternary chain. `pred` is the WGSL
 *  boolean expression that determines whether the branch fires; the
 *  emitter writes it verbatim into the kernel, so callers MUST emit
 *  WGSL syntax (e.g. `v_class == 2.0`, not the source `case` AST).
 *  `colorHex` is the colour the branch returns when `pred` is true.
 *
 *  Field references used inside `pred` MUST appear in `fields` so
 *  the emitter knows to load them from `feat_data` once at the top
 *  of the kernel. Multiple branches may share a field — each field
 *  is loaded exactly once. */
export interface TernaryBranchSpec {
  pred: string
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
  const lines: string[] = []
  lines.push('// Auto-generated by compiler/src/codegen/compute-gen.ts')
  lines.push('// case() / ternary chain — first matching predicate wins.')
  lines.push('')
  lines.push('@group(0) @binding(0) var<storage, read> feat_data: array<f32>;')
  lines.push('@group(0) @binding(1) var<storage, read_write> out_color: array<u32>;')
  lines.push('@group(0) @binding(2) var<uniform> u_count: vec4<u32>;')
  lines.push('')
  lines.push(`@compute @workgroup_size(${COMPUTE_WORKGROUP_SIZE})`)
  lines.push('fn eval_case(@builtin(global_invocation_id) gid: vec3<u32>) {')
  lines.push('  let fid = gid.x;')
  lines.push('  if (fid >= u_count.x) { return; }')

  // Load every referenced field once at the kernel top. Stride is
  // the field count; offsets match insertion order. Branches reference
  // these as `v_<fieldName>` in their predicate strings.
  const stride = spec.fields.length
  for (let i = 0; i < spec.fields.length; i++) {
    const f = spec.fields[i]!
    if (stride === 1) {
      lines.push(`  let v_${f} = feat_data[fid];`)
    } else {
      lines.push(`  let v_${f} = feat_data[fid * ${stride}u + ${i}u];`)
    }
  }

  lines.push('  var color: vec4<f32>;')

  for (let i = 0; i < spec.branches.length; i++) {
    const br = spec.branches[i]!
    const [r, g, b, a] = colorHexToRGBA(br.colorHex)
    const keyword = i === 0 ? 'if' : 'else if'
    lines.push(
      `  ${keyword} (${br.pred}) {`
      + ` color = vec4<f32>(${fmt(r)}, ${fmt(g)}, ${fmt(b)}, ${fmt(a)});`
      + ` }`,
    )
  }

  const [dr, dg, db, da] = colorHexToRGBA(spec.defaultColorHex)
  lines.push(
    `  else { color = vec4<f32>(${fmt(dr)}, ${fmt(dg)}, ${fmt(db)}, ${fmt(da)}); }`,
  )

  lines.push('  out_color[fid] = pack4x8unorm(color);')
  lines.push('}')
  lines.push('')

  return {
    wgsl: lines.join('\n'),
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
export function emitInterpolateComputeKernel(spec: InterpolateEmitSpec): ComputeKernel {
  const lines: string[] = []
  lines.push('// Auto-generated by compiler/src/codegen/compute-gen.ts')
  lines.push('// Per-feature linear interpolation — piecewise lerp between stops.')
  lines.push('')
  lines.push('@group(0) @binding(0) var<storage, read> feat_data: array<f32>;')
  lines.push('@group(0) @binding(1) var<storage, read_write> out_color: array<u32>;')
  lines.push('@group(0) @binding(2) var<uniform> u_count: vec4<u32>;')
  lines.push('')
  lines.push(`@compute @workgroup_size(${COMPUTE_WORKGROUP_SIZE})`)
  lines.push('fn eval_interpolate(@builtin(global_invocation_id) gid: vec3<u32>) {')
  lines.push('  let fid = gid.x;')
  lines.push('  if (fid >= u_count.x) { return; }')
  lines.push(`  let v_${spec.fieldName} = feat_data[fid];`)
  lines.push('  var color: vec4<f32>;')

  if (spec.stops.length === 0) {
    // Degenerate: no stops at all. Emit transparent — caller
    // shouldn't reach this branch, but the kernel must still be
    // valid WGSL.
    lines.push('  color = vec4<f32>(0.0, 0.0, 0.0, 0.0);')
  } else if (spec.stops.length === 1) {
    const [r, g, b, a] = colorHexToRGBA(spec.stops[0]!.colorHex)
    lines.push(`  color = vec4<f32>(${fmt(r)}, ${fmt(g)}, ${fmt(b)}, ${fmt(a)});`)
  } else {
    // First range: v <= s0 → c0 (clamp left).
    const first = spec.stops[0]!
    const [r0, g0, b0, a0] = colorHexToRGBA(first.colorHex)
    lines.push(
      `  if (v_${spec.fieldName} <= ${fmt(first.input)}) {`
      + ` color = vec4<f32>(${fmt(r0)}, ${fmt(g0)}, ${fmt(b0)}, ${fmt(a0)});`
      + ` }`,
    )

    // Middle ranges: s[i-1] < v <= s[i] → mix.
    for (let i = 1; i < spec.stops.length; i++) {
      const prev = spec.stops[i - 1]!
      const curr = spec.stops[i]!
      const [pr, pg, pb, pa] = colorHexToRGBA(prev.colorHex)
      const [cr, cg, cb, ca] = colorHexToRGBA(curr.colorHex)
      const denom = curr.input - prev.input
      // Guard divide-by-zero (caller bug) by clamping to 1.0 if the
      // two stops collide; the emitted code never trips this at
      // runtime because the if-chain order makes prev<curr already
      // hold by stop ordering.
      const safeDenom = denom === 0 ? 1 : denom
      lines.push(
        `  else if (v_${spec.fieldName} <= ${fmt(curr.input)}) {`
        + ` let t = (v_${spec.fieldName} - ${fmt(prev.input)}) / ${fmt(safeDenom)};`
        + ` color = mix(`
        + `vec4<f32>(${fmt(pr)}, ${fmt(pg)}, ${fmt(pb)}, ${fmt(pa)}),`
        + ` vec4<f32>(${fmt(cr)}, ${fmt(cg)}, ${fmt(cb)}, ${fmt(ca)}),`
        + ` t);`
        + ` }`,
      )
    }

    // Trailing range: v > sN → cN (clamp right).
    const last = spec.stops[spec.stops.length - 1]!
    const [rN, gN, bN, aN] = colorHexToRGBA(last.colorHex)
    lines.push(
      `  else {`
      + ` color = vec4<f32>(${fmt(rN)}, ${fmt(gN)}, ${fmt(bN)}, ${fmt(aN)});`
      + ` }`,
    )
  }

  lines.push('  out_color[fid] = pack4x8unorm(color);')
  lines.push('}')
  lines.push('')

  return {
    wgsl: lines.join('\n'),
    entryPoint: 'eval_interpolate',
    featureStrideF32: 1,
    fieldOrder: [spec.fieldName],
    dispatchSize(featureCount: number): number {
      return Math.ceil(featureCount / COMPUTE_WORKGROUP_SIZE)
    },
  }
}

/** Parse a hex color literal (`#rrggbb` / `#rrggbbaa` / `#rgb` /
 *  `#rgba` / named via `resolveColor`) into normalised RGBA floats.
 *  Mirrors shader-gen's `resolveColorFromAST` but takes raw hex
 *  since the compute emitter has already extracted the arm value.
 */
function colorHexToRGBA(hex: string): [number, number, number, number] {
  // Accept named colors too — `resolveColor` returns null if the
  // input is already a hex literal that the lookup can't match.
  const resolved = hex.startsWith('#') ? hex : (resolveColor(hex) ?? hex)
  let r = 0, g = 0, b = 0, a = 1
  // Reject non-hex content — mirror of hexToRgba regex gate (d5c3e28).
  // Without it parseInt('zz', 16) = NaN propagated through to the
  // compute-shader colour branch and the GPU sampled undefined
  // behaviour.
  if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(resolved)) {
    return [0, 0, 0, 1]
  }
  if (resolved.length === 4) {
    // #RGB
    r = parseInt(resolved[1]! + resolved[1]!, 16) / 255
    g = parseInt(resolved[2]! + resolved[2]!, 16) / 255
    b = parseInt(resolved[3]! + resolved[3]!, 16) / 255
  } else if (resolved.length === 5) {
    // #RGBA
    r = parseInt(resolved[1]! + resolved[1]!, 16) / 255
    g = parseInt(resolved[2]! + resolved[2]!, 16) / 255
    b = parseInt(resolved[3]! + resolved[3]!, 16) / 255
    a = parseInt(resolved[4]! + resolved[4]!, 16) / 255
  } else if (resolved.length === 7) {
    // #RRGGBB
    r = parseInt(resolved.slice(1, 3), 16) / 255
    g = parseInt(resolved.slice(3, 5), 16) / 255
    b = parseInt(resolved.slice(5, 7), 16) / 255
  } else if (resolved.length === 9) {
    // #RRGGBBAA
    r = parseInt(resolved.slice(1, 3), 16) / 255
    g = parseInt(resolved.slice(3, 5), 16) / 255
    b = parseInt(resolved.slice(5, 7), 16) / 255
    a = parseInt(resolved.slice(7, 9), 16) / 255
  }
  return [r, g, b, a]
}

/** WGSL float literal — trims trailing zeros, ensures decimal point.
 *  Local copy to avoid a cross-module import of shader-gen's `fmt`. */
function fmt(n: number): string {
  if (Number.isInteger(n)) return `${n}.0`
  return n.toString()
}
