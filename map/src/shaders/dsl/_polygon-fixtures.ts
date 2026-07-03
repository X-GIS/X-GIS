// ═══════════════════════════════════════════════════════════════════
// Polygon variant snapshot fixtures + DSL-emit helper (US-010 shared)
// ═══════════════════════════════════════════════════════════════════
//
// Shared definitions between:
//   - scripts/capture-polygon-snapshots.ts (writes baselines)
//   - polygon-variant-diff.test.ts (per-commit drift gate)
//
// Both producers run through `emitForFixture(fx)`, which converts the
// compiler-side `ShaderVariant` shape into the runtime polygon DSL
// composer's `ShaderVariantInfo` and emits via `emitPolygonWgsl`. The
// snapshot files therefore serve as the DSL emit's stable baseline:
// any composer change that perturbs the WGSL output surfaces as a
// byte-equal diff against the committed snapshot. Re-running the
// capture script refreshes the baseline.
//
// The diff is **byte-equal** (after the snapshot's `// baseline: ...`
// header is stripped), NOT an AST-equivalence diff against the
// legacy POLYGON_SHADER_SOURCE-based emit. The DSL composer's
// declaration order, paren density, and swizzle conventions differ
// structurally from the legacy template; pixel survey + CI render-
// gate validate semantic equivalence end-to-end, while this diff
// gate catches unintentional composer drift at commit time.

import { emitPolygonWgsl } from './polygon'

// ── Compiler-side variant shape mirror ──
//
// Mirrors the relevant fields of `@xgis/compiler`'s `ShaderVariant`.
// Keeping a local mirror avoids dragging the compiler workspace into
// the runtime test's import graph (which would create a cycle through
// the back-compat adapter).

interface FixtureVariant {
  readonly key: string
  readonly preamble: string
  readonly fillExpr: string
  readonly strokeExpr: string
  readonly fillPreamble?: string
  readonly strokePreamble?: string
  readonly needsFeatureBuffer: boolean
}

export interface Fixture {
  readonly slug: string
  readonly variant: FixtureVariant | null
  readonly pickEnabled: boolean
  readonly note: string
}

// ── Variant factory helper ──

const v = (over: Partial<FixtureVariant>): FixtureVariant => ({
  key: over.key ?? 'default',
  preamble: over.preamble ?? '',
  fillExpr: over.fillExpr ?? 'u.fill_color',
  strokeExpr: over.strokeExpr ?? 'u.stroke_color',
  fillPreamble: over.fillPreamble,
  strokePreamble: over.strokePreamble,
  needsFeatureBuffer: over.needsFeatureBuffer ?? false,
})

// Mirrors the compiler's match-arm chain shape: `var _mcXX: vec4f = ...;
// if (field0_id == 0u) { _mcXX = ...; }` chains injected into the
// fillPreamble / strokePreamble strings.

const landuseMatchChain = (armCount: number, varName: string): string => {
  const palette: ReadonlyArray<readonly [number, number, number, number]> = [
    [0.78, 0.91, 0.74, 1.0],
    [0.92, 0.86, 0.65, 1.0],
    [0.84, 0.8, 0.7, 1.0],
    [0.69, 0.85, 0.69, 1.0],
    [0.95, 0.78, 0.78, 1.0],
    [0.71, 0.78, 0.83, 1.0],
    [0.87, 0.74, 0.62, 1.0],
    [0.62, 0.74, 0.87, 1.0],
    [0.81, 0.67, 0.55, 1.0],
    [0.55, 0.81, 0.67, 1.0],
    [0.67, 0.55, 0.81, 1.0],
    [0.79, 0.79, 0.79, 1.0],
    [0.91, 0.91, 0.78, 1.0],
  ]
  const fallback = `vec4f(0.78, 0.78, 0.78, 1.0)`
  const lines: string[] = [`var ${varName}: vec4f = ${fallback};`]
  for (let i = 0; i < armCount; i++) {
    const c = palette[i % palette.length]!
    const head = i === 0 ? 'if' : 'else if'
    lines.push(
      `${head} (field0_id == ${i}u) { ${varName} = vec4f(${c[0].toFixed(2)}, ${c[1].toFixed(2)}, ${c[2].toFixed(2)}, ${c[3].toFixed(2)}); }`,
    )
  }
  return lines.join('\n  ')
}

// ── Fixture set (8 fixtures — AC6 floor) ──

export const FIXTURES: readonly Fixture[] = [
  {
    slug: 'positron-constant',
    note: 'OFM Positron-shape — constant fill polygons (no variant override). Baseline default WGSL.',
    pickEnabled: false,
    variant: null,
  },
  {
    slug: 'bright-landuse-match13',
    note: 'OFM Bright-shape — variant-heavy land-cover with 13-arm match chain (matchExpr perf-gate boundary).',
    pickEnabled: false,
    variant: v({
      key: 'bright-landuse-match13',
      fillPreamble: landuseMatchChain(13, '_mcB1'),
      fillExpr: '_mcB1',
      needsFeatureBuffer: true,
    }),
  },
  {
    slug: 'liberty-zoom-interp',
    note: 'OFM Liberty-shape — zoom-interpolated fill with intermediate const + mix() at fillExpr.',
    pickEnabled: false,
    variant: v({
      key: 'liberty-zoom-interp',
      preamble: [
        'const LIB_STOP_0: vec4<f32> = vec4<f32>(0.80, 0.85, 0.90, 1.0);',
        'const LIB_STOP_1: vec4<f32> = vec4<f32>(0.70, 0.78, 0.88, 1.0);',
        'const LIB_STOP_2: vec4<f32> = vec4<f32>(0.60, 0.72, 0.86, 1.0);',
      ].join('\n'),
      fillExpr:
        'mix(LIB_STOP_0, mix(LIB_STOP_1, LIB_STOP_2, clamp((u.zoom - 10.0) / 4.0, 0.0, 1.0)), clamp((u.zoom - 6.0) / 4.0, 0.0, 1.0))',
    }),
  },
  {
    slug: 'demotiles-stroke-match',
    note: 'MapLibre demotiles-shape — 5-arm stroke match (regional palette).',
    pickEnabled: false,
    variant: v({
      key: 'demotiles-stroke-match',
      strokePreamble: landuseMatchChain(5, '_mcSD'),
      strokeExpr: '_mcSD',
      needsFeatureBuffer: true,
    }),
  },
  {
    slug: 'syn-match10',
    note: 'Synthetic — 10-arm match chain at the matchExpr ≥10-arm perf-gate boundary.',
    pickEnabled: false,
    variant: v({
      key: 'syn-match10',
      fillPreamble: landuseMatchChain(10, '_mcS10'),
      fillExpr: '_mcS10',
      needsFeatureBuffer: true,
    }),
  },
  {
    slug: 'syn-zoom3',
    note: 'Synthetic — 3-stop zoom-interpolated fill with consts + nested mix().',
    pickEnabled: false,
    variant: v({
      key: 'syn-zoom3',
      preamble: [
        'const Z3_0: vec4<f32> = vec4<f32>(1.0, 0.0, 0.0, 1.0);',
        'const Z3_1: vec4<f32> = vec4<f32>(0.0, 1.0, 0.0, 1.0);',
        'const Z3_2: vec4<f32> = vec4<f32>(0.0, 0.0, 1.0, 1.0);',
      ].join('\n'),
      fillExpr:
        'mix(Z3_0, mix(Z3_1, Z3_2, clamp((u.zoom - 12.0) / 4.0, 0.0, 1.0)), clamp((u.zoom - 8.0) / 4.0, 0.0, 1.0))',
    }),
  },
  {
    slug: 'syn-featdata',
    note: 'Synthetic — feat_data lookup (needsFeatureBuffer=true, fillExpr indexes feat_data[]).',
    pickEnabled: false,
    variant: v({
      key: 'syn-featdata',
      fillExpr:
        'vec4<f32>(feat_data[input.feat_id * 3u + 0u], feat_data[input.feat_id * 3u + 1u], feat_data[input.feat_id * 3u + 2u], 1.0)',
      needsFeatureBuffer: true,
    }),
  },
  {
    slug: 'syn-palette',
    note: 'Synthetic — palette-bound categorical sample (textureSampleLevel from color_grad_atlas).',
    pickEnabled: false,
    variant: v({
      key: 'syn-palette',
      preamble: [
        '@group(0) @binding(2) var color_grad_atlas: texture_2d<f32>;',
        '@group(0) @binding(4) var palette_samp: sampler;',
      ].join('\n'),
      fillExpr:
        'textureSampleLevel(color_grad_atlas, palette_samp, vec2<f32>(clamp((u.zoom - 0.0) / 20.0, 0.0, 1.0), 0.5), 0.0)',
    }),
  },
] as const

// ── Emit helper ──
//
// All variant injection happens via post-emit string splice. The
// composer emits the default-uniform polygon shader (variant=null);
// then we splice:
//   - needsFeatureBuffer → @group(0) @binding(1) feat_data binding
//     after sprite_samp (composer omits it for null variant).
//   - variant.preamble (const decls / palette bindings) after the
//     feat_data binding splice anchor.
//   - variant.fillExpr + fillPreamble replace the default fill assign
//     (out.color = vec4<f32>((u.fill_color.rgb * wall_shade),
//     u.fill_color.w);) in fs_fill. Composer's default emit shape is
//     deterministic — see polygon.ts:defaultFillReturnStmts.
//   - variant.strokeExpr + strokePreamble replace the default stroke
//     assign analogously in fs_stroke.
//
// This Node-bridge-free approach mirrors what the legacy
// buildShaderFrozen() in scripts/capture-polygon-snapshots.ts did
// against POLYGON_SHADER_SOURCE, with the composer's default emit
// as the new anchor surface.

// Composer's default-path emit (verbatim, matches polygon.ts:
// defaultFillReturnStmts / defaultStrokeReturnStmts).
const DEFAULT_FILL_ASSIGN =
  'out.color = vec4<f32>((u.fill_color.rgb * wall_shade), u.fill_color.w);'
const DEFAULT_STROKE_ASSIGN =
  'out.color = vec4<f32>(u.stroke_color.rgb, (u.stroke_color.w * alpha_scale));'

export function emitForFixture(fx: Fixture): string {
  const { variant, pickEnabled } = fx
  let wgsl = emitPolygonWgsl(null, pickEnabled)
  if (!variant) return wgsl

  // Splice point for module-level variant decls is right after the
  // @group(0) @binding(6) sprite_samp line. needsFeatureBuffer + the
  // preamble (palette bindings, const decls) both inject here.
  const spriteSampMatch = wgsl.match(/^@group\(0\) @binding\(6\) [^\n]*\n/m)
  if (spriteSampMatch && spriteSampMatch.index !== undefined) {
    const insertAt = spriteSampMatch.index + spriteSampMatch[0].length
    let extras = ''
    if (variant.needsFeatureBuffer) {
      extras += '\n@group(0) @binding(1) var<storage, read> feat_data: array<f32>;\n'
    }
    if (variant.preamble) {
      extras += '\n// ── Specialized constants ──\n' + variant.preamble + '\n'
    }
    if (extras) {
      wgsl = wgsl.slice(0, insertAt) + extras + wgsl.slice(insertAt)
    }
  }

  // Fill / stroke return swap. fillExpr === 'u.fill_color' means the
  // variant is default-uniform (no override); leave the composer
  // default in place. Otherwise replace the default assign with the
  // variant-provided expression, prepending any matchPreamble chain.
  if (variant.fillExpr !== 'u.fill_color') {
    const matchCode = variant.fillPreamble ? `${variant.fillPreamble}\n  ` : ''
    wgsl = wgsl.replace(DEFAULT_FILL_ASSIGN, `${matchCode}out.color = ${variant.fillExpr};`)
  }
  if (variant.strokeExpr !== 'u.stroke_color') {
    const matchCode = variant.strokePreamble ? `${variant.strokePreamble}\n  ` : ''
    wgsl = wgsl.replace(DEFAULT_STROKE_ASSIGN, `${matchCode}out.color = ${variant.strokeExpr};`)
  }
  return wgsl
}
