#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════════════
// Polygon variant snapshot capture — Phase 2.5 pre-flight (US-000).
// ═══════════════════════════════════════════════════════════════════
//
// Captures the CURRENT main HEAD's polygon shader output for a fixed
// set of synthetic + production-style ShaderVariant fixtures. The
// snapshot files are the baseline against which the Phase 2.5 diff-
// test gate (polygon-variant-diff.test.ts, US-010) checks that the
// post-retarget DSL-emitted WGSL is AST-equivalent to the legacy
// string-emit output.
//
// Capture is IN-PLACE: this script must be invoked from main HEAD
// BEFORE any Phase 2.5 code change lands (the type migration in
// US-004 would break the synthetic-variant construction below). Per
// the plan's pre-flight step 0, the script's output directory is
// committed in its own commit ahead of the matchExpr IR work.
//
// Re-capture protocol: if `main` advances during PR review, re-run
// this script to refresh snapshots; the diff-test's SHA-header gate
// fails on baseline drift with a clear error.
//
// Invocation:
//   bun scripts/capture-polygon-snapshots.ts
// Optional:
//   bun scripts/capture-polygon-snapshots.ts --baseline=<sha>
//     override the recorded baseline SHA (default: git rev-parse HEAD).

import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import {
  POLYGON_SHADER_SOURCE,
  FILL_RETURN_MARKER,
  STROKE_RETURN_MARKER,
} from '../runtime/src/engine/render/renderer-shaders'
import type { ShaderVariant } from '../compiler/src/codegen/shader-gen-types'

// ─── Pick-marker substitution (frozen replica of renderer.ts:54-95 ───
//
// Mirrors the EXACT logic of buildShader() at PR #150 HEAD. The
// script doesn't import buildShader directly because it's a module-
// internal function and isPickEnabled() depends on a runtime
// singleton that isn't loaded in this Node context. The frozen
// reimplementation is OK because US-000 captures one main snapshot
// per fixture; later iterations re-capture if main advances.

function applyPick(src: string, pickEnabled: boolean): string {
  return src
    .replace(/__PICK_FIELD__/g, pickEnabled ? '@location(1) @interpolate(flat) pick: vec2<u32>,' : '')
    .replace(/__PICK_WRITE__/g, pickEnabled ? 'out.pick = vec2<u32>(input.feat_id, u.pick_id);' : '')
}

function buildShaderFrozen(variant: ShaderVariant | null, pickEnabled: boolean): string {
  if (!variant || (!variant.preamble && !variant.needsFeatureBuffer)) {
    return applyPick(POLYGON_SHADER_SOURCE, pickEnabled)
  }
  let shader = POLYGON_SHADER_SOURCE
  const insertPoint = '@group(0) @binding(0) var<uniform> u: Uniforms;'

  let insertions = ''
  if (variant.needsFeatureBuffer) {
    insertions += '\n@group(0) @binding(1) var<storage, read> feat_data: array<f32>;\n'
  }
  if (variant.preamble) {
    insertions += '\n// ── Specialized constants ──\n' + variant.preamble + '\n'
  }
  if (insertions) {
    shader = shader.replace(insertPoint, insertPoint + insertions)
  }

  if (variant.fillExpr && variant.fillExpr !== 'u.fill_color') {
    const matchCode = variant.fillPreamble ? `${variant.fillPreamble}  ` : ''
    shader = shader.replace(FILL_RETURN_MARKER, `${matchCode}out.color = ${variant.fillExpr};`)
  }
  if (variant.strokeExpr && variant.strokeExpr !== 'u.stroke_color') {
    const matchCode = variant.strokePreamble ? `${variant.strokePreamble}  ` : ''
    shader = shader.replace(STROKE_RETURN_MARKER, `${matchCode}out.color = ${variant.strokeExpr};`)
  }
  return applyPick(shader, pickEnabled)
}

// ─── Variant factory helpers ────────────────────────────────────────
//
// Each fixture exercises a representative variant shape from the
// production codegen lane. Hand-authored rather than driven through
// convertMapboxStyle to keep the script standalone (no network, no
// style.json fetch) and to pin the AC6 fixture coverage floor.

function v(over: Partial<ShaderVariant>): ShaderVariant {
  return {
    key: over.key ?? 'default',
    preamble: over.preamble ?? '',
    fillExpr: over.fillExpr ?? 'u.fill_color',
    strokeExpr: over.strokeExpr ?? 'u.stroke_color',
    fillPreamble: over.fillPreamble,
    strokePreamble: over.strokePreamble,
    needsFeatureBuffer: over.needsFeatureBuffer ?? false,
    featureFields: over.featureFields ?? [],
    uniformFields: over.uniformFields ?? [],
    categoryOrder: over.categoryOrder ?? {},
    paletteColorGradients: over.paletteColorGradients ?? [],
    paletteScalarGradients: over.paletteScalarGradients ?? [],
    fillUsesPalette: over.fillUsesPalette ?? false,
    strokeUsesPalette: over.strokeUsesPalette ?? false,
    opacityUsesPalette: over.opacityUsesPalette ?? false,
    computeBindings: over.computeBindings,
  }
}

// Mirrors the compiler's actual matchArmsKey output. Real codegen
// emits `var _mcXX: vec4f = vec4f(...); if (field0_id == 0u) { _mcXX = ...; }`
// inside fillPreamble; the snapshot bakes one such chain verbatim.
function landuseMatchChain(armCount: number, varName: string): string {
  const palette = [
    [0.78, 0.91, 0.74, 1.0], [0.92, 0.86, 0.65, 1.0], [0.84, 0.80, 0.70, 1.0],
    [0.69, 0.85, 0.69, 1.0], [0.95, 0.78, 0.78, 1.0], [0.71, 0.78, 0.83, 1.0],
    [0.87, 0.74, 0.62, 1.0], [0.62, 0.74, 0.87, 1.0], [0.81, 0.67, 0.55, 1.0],
    [0.55, 0.81, 0.67, 1.0], [0.67, 0.55, 0.81, 1.0], [0.79, 0.79, 0.79, 1.0],
    [0.91, 0.91, 0.78, 1.0],
  ]
  const fallback = `vec4f(0.78, 0.78, 0.78, 1.0)`
  const lines: string[] = [`var ${varName}: vec4f = ${fallback};`]
  for (let i = 0; i < armCount; i++) {
    const c = palette[i % palette.length]!
    const head = i === 0 ? 'if' : 'else if'
    lines.push(`${head} (field0_id == ${i}u) { ${varName} = vec4f(${c[0]!.toFixed(2)}, ${c[1]!.toFixed(2)}, ${c[2]!.toFixed(2)}, ${c[3]!.toFixed(2)}); }`)
  }
  return lines.join('\n  ')
}

// ─── Fixture set (8 fixtures per AC6 floor) ─────────────────────────

const FIXTURES: { slug: string; variant: ShaderVariant | null; pickEnabled: boolean; note: string }[] = [
  // ── 4 production-style fixtures ──
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
      categoryOrder: {
        class: ['cemetery','commercial','farmland','forest','grass','industrial','park','playground','recreation_ground','residential','rock','sand','wetland'],
      },
      uniformFields: ['fill_color'],
      needsFeatureBuffer: true,
      featureFields: ['class'],
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
      fillExpr: 'mix(LIB_STOP_0, mix(LIB_STOP_1, LIB_STOP_2, clamp((u.zoom - 10.0) / 4.0, 0.0, 1.0)), clamp((u.zoom - 6.0) / 4.0, 0.0, 1.0))',
      uniformFields: ['fill_color'],
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
      categoryOrder: { region: ['af','am','as','eu','oc'] },
      uniformFields: ['stroke_color'],
      needsFeatureBuffer: true,
      featureFields: ['region'],
    }),
  },

  // ── 4 representative synthetic patterns ──
  {
    slug: 'syn-match10',
    note: 'Synthetic — 10-arm match chain at the matchExpr ≥10-arm perf-gate boundary.',
    pickEnabled: false,
    variant: v({
      key: 'syn-match10',
      fillPreamble: landuseMatchChain(10, '_mcS10'),
      fillExpr: '_mcS10',
      categoryOrder: { k: Array.from({length: 10}, (_, i) => `c${i}`) },
      uniformFields: ['fill_color'],
      needsFeatureBuffer: true,
      featureFields: ['k'],
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
      fillExpr: 'mix(Z3_0, mix(Z3_1, Z3_2, clamp((u.zoom - 12.0) / 4.0, 0.0, 1.0)), clamp((u.zoom - 8.0) / 4.0, 0.0, 1.0))',
      uniformFields: ['fill_color'],
    }),
  },
  {
    slug: 'syn-featdata',
    note: 'Synthetic — feat_data lookup (needsFeatureBuffer=true, fillExpr indexes feat_data[]).',
    pickEnabled: false,
    variant: v({
      key: 'syn-featdata',
      fillExpr: 'vec4<f32>(feat_data[input.feat_id * 3u + 0u], feat_data[input.feat_id * 3u + 1u], feat_data[input.feat_id * 3u + 2u], 1.0)',
      needsFeatureBuffer: true,
      featureFields: ['r', 'g', 'b'],
      uniformFields: ['fill_color'],
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
      fillExpr: 'textureSampleLevel(color_grad_atlas, palette_samp, vec2<f32>(clamp((u.zoom - 0.0) / 20.0, 0.0, 1.0), 0.5), 0.0)',
      paletteColorGradients: [0],
      fillUsesPalette: true,
      uniformFields: [],
    }),
  },
]

// ─── Capture loop ───────────────────────────────────────────────────

const argBaseline = process.argv.find(a => a.startsWith('--baseline='))?.split('=')[1]
const baselineSha = argBaseline ?? execSync('git rev-parse HEAD').toString().trim()

const __filename = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(__filename), '..')
const dir = join(repoRoot, 'runtime/src/engine/shader-dsl/shaders/__polygon-variant-snapshots__')
mkdirSync(dir, { recursive: true })

let written = 0
for (const fx of FIXTURES) {
  const wgsl = buildShaderFrozen(fx.variant, fx.pickEnabled)
  const keyInput = fx.variant?.key ?? `__bare-pick${fx.pickEnabled ? '1' : '0'}__`
  const hash = createHash('sha256').update(keyInput).digest('hex').slice(0, 12)
  const filename = `${fx.slug}-${hash}.wgsl`
  const filePath = join(dir, filename)
  const header = [
    `// baseline: ${baselineSha}`,
    `// fixture: ${fx.slug}`,
    `// variant.key: ${keyInput}`,
    `// pick: ${fx.pickEnabled}`,
    `// note: ${fx.note}`,
    '',
  ].join('\n')
  writeFileSync(filePath, header + wgsl + '\n', 'utf-8')
  console.log(`wrote ${filename}  (${wgsl.length} bytes)`)
  written++
}

console.log(`\n${written}/${FIXTURES.length} snapshots written to ${dir}`)
console.log(`baseline: ${baselineSha}`)
