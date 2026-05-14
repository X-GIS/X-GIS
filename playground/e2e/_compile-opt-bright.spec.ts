// Compile-time optimisation report for OFM Bright.
//
// Walks the same compile pipeline the runtime uses, instrumented at
// each stage, and prints:
//
//   stage 0: raw Mapbox layers in bright.json
//   stage 1: after convertMapboxStyle (default — match() expansion ON)
//   stage 2: after convertMapboxStyle (compute=1 — match() bypass)
//   stage 3: after lex+parse+lower → IR scene (renderNodes count)
//   stage 4: after merge-layers pass
//   stage 5: after fold-trivial-stops
//   stage 6: after fold-trivial-case
//   stage 7: after dead-layer-elim
//   final  : StyleProfile (paint-shape kinds, deps, CSE, palette, compute plan)
//
// Pure node-side compile, no browser / GPU. Run via Playwright as a
// convenient harness because it already has the typescript import
// pipeline and __convert-fixtures path resolution in place.

import { test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { Lexer } from '../../compiler/src/lexer/lexer'
import { Parser } from '../../compiler/src/parser/parser'
import { lower } from '../../compiler/src/ir/lower'
import { optimize } from '../../compiler/src/ir/optimize'
import { mergeLayersPass } from '../../compiler/src/ir/passes/merge-layers'
import { foldTrivialStopsPass } from '../../compiler/src/ir/passes/fold-trivial-stops'
import { foldTrivialCasePass } from '../../compiler/src/ir/passes/fold-trivial-case'
import { deadLayerElimPass } from '../../compiler/src/ir/passes/dead-layer-elim'
import { getStyleProfile, formatStyleProfile } from '../../compiler/src/diagnostics/style-profile'

const __dirname = dirname(fileURLToPath(import.meta.url))

test('OFM Bright — compile-time optimisation breakdown', () => {
  const fixturePath = path.resolve(__dirname, '__convert-fixtures/bright.json')
  const raw = fs.readFileSync(fixturePath, 'utf8')
  const styleJson = JSON.parse(raw) as { layers: unknown[] }

  // ─── Stage 0: input ──────────────────────────────────────────
  const rawLayers = styleJson.layers.length
  // eslint-disable-next-line no-console
  console.log(`\n══ OFM Bright compile pipeline ══`)
  // eslint-disable-next-line no-console
  console.log(`stage 0  raw Mapbox layers:                ${rawLayers}`)

  // ─── Stage 1+2: Mapbox→XGIS conversion ───────────────────────
  const t1a = performance.now()
  const xgisDefault = convertMapboxStyle(styleJson as Parameters<typeof convertMapboxStyle>[0])
  const t1b = performance.now()
  const xgisCompute = convertMapboxStyle(
    styleJson as Parameters<typeof convertMapboxStyle>[0],
    { bypassExpandColorMatch: true },
  )
  const t1c = performance.now()

  // Count xgis `layer` blocks in each output (simple regex — the
  // converter emits `layer NAME {` at the top of each).
  const countLayers = (src: string) =>
    (src.match(/^\s*layer\s+/gm) ?? []).length
  const defaultLayers = countLayers(xgisDefault)
  const computeLayers = countLayers(xgisCompute)

  // eslint-disable-next-line no-console
  console.log(`stage 1  after convertMapboxStyle (default): ${defaultLayers}  (${(t1b - t1a).toFixed(1)} ms)`)
  // eslint-disable-next-line no-console
  console.log(`stage 2  after convertMapboxStyle (compute):  ${computeLayers}  (${(t1c - t1b).toFixed(1)} ms)`)
  // eslint-disable-next-line no-console
  console.log(`         expandPerFeatureColorMatch fan-out:  ${defaultLayers - computeLayers} extra layers`)

  // Continue the rest of the pipeline through DEFAULT (the typical
  // hot path). Repeating it for compute=1 below for completeness.

  // ─── Stage 3: lex → parse → lower ────────────────────────────
  const compileFullyInstrumented = (src: string, label: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n── pipeline (${label}) ──`)
    const t0 = performance.now()
    const tokens = new Lexer(src).tokenize()
    const t1 = performance.now()
    const program = new Parser(tokens).parse()
    const t2 = performance.now()
    const sceneRaw = lower(program)
    const t3 = performance.now()
    // eslint-disable-next-line no-console
    console.log(`  lex+parse+lower:                          ${sceneRaw.renderNodes.length} renderNodes  (lex ${(t1 - t0).toFixed(1)} / parse ${(t2 - t1).toFixed(1)} / lower ${(t3 - t2).toFixed(1)} ms)`)

    // ─── Stage 4-7: individual pass impact ─────────────────────
    // Run each pass STANDALONE on sceneRaw to attribute per-pass
    // reduction without composition order interfering.
    const afterMerge = mergeLayersPass.run(sceneRaw)
    const afterStops = foldTrivialStopsPass.run(sceneRaw)
    const afterCase = foldTrivialCasePass.run(sceneRaw)
    const afterDead = deadLayerElimPass.run(sceneRaw)
    // eslint-disable-next-line no-console
    console.log(`  merge-layers       (alone):              ${afterMerge.renderNodes.length}  Δ ${afterMerge.renderNodes.length - sceneRaw.renderNodes.length}`)
    // eslint-disable-next-line no-console
    console.log(`  fold-trivial-stops (alone):              ${afterStops.renderNodes.length}  Δ ${afterStops.renderNodes.length - sceneRaw.renderNodes.length}`)
    // eslint-disable-next-line no-console
    console.log(`  fold-trivial-case  (alone):              ${afterCase.renderNodes.length}  Δ ${afterCase.renderNodes.length - sceneRaw.renderNodes.length}`)
    // eslint-disable-next-line no-console
    console.log(`  dead-layer-elim    (alone):              ${afterDead.renderNodes.length}  Δ ${afterDead.renderNodes.length - sceneRaw.renderNodes.length}`)

    // Composed pipeline (mirrors runtime).
    const t4 = performance.now()
    const opt = optimize(sceneRaw, program)
    const t5 = performance.now()
    // eslint-disable-next-line no-console
    console.log(`  optimize() composed:                      ${opt.renderNodes.length}  (${(t5 - t4).toFixed(1)} ms)`)
    // eslint-disable-next-line no-console
    console.log(`  ── total reduction: ${sceneRaw.renderNodes.length} → ${opt.renderNodes.length}`
      + `  (${((1 - opt.renderNodes.length / sceneRaw.renderNodes.length) * 100).toFixed(1)}%)`)

    // ─── Stage final: StyleProfile (deps / CSE / palette / compute) ───
    const profile = getStyleProfile(opt)
    // eslint-disable-next-line no-console
    console.log(`\n  StyleProfile (formatted):`)
    // eslint-disable-next-line no-console
    console.log(formatStyleProfile(profile).split('\n').map(l => `    ${l}`).join('\n'))

    // ─── Feature-dep paint axis enumeration ────────────────────
    // Compute plan reports 1/114 feature-dep axes captured. Walk
    // every node × axis and dump (kind, AST top-level-kind) for
    // feature-dep axes so we can see WHY 113 are dropped.
    interface Axis { node: string; axis: string; valueKind: string; astKind: string | null }
    const allAxes: Axis[] = []
    const probe = (node: { name?: string; sourceLayer?: string }, axis: string, v: unknown): void => {
      if (typeof v !== 'object' || v === null) return
      const k = (v as { kind?: string }).kind
      if (!k) return
      let astKind: string | null = null
      if (k === 'data-driven') {
        const expr = (v as { expr?: { ast?: { kind?: string } } }).expr
        astKind = expr?.ast?.kind ?? null
      }
      allAxes.push({
        node: node.name ?? node.sourceLayer ?? '?',
        axis, valueKind: k, astKind,
      })
    }
    const featureAxes = allAxes.filter(a => a.valueKind === 'data-driven' || a.valueKind === 'conditional')
    for (const node of opt.renderNodes) {
      probe(node, 'fill', node.fill)
      probe(node, 'stroke.color', node.stroke?.color)
      probe(node, 'opacity', node.opacity)
      probe(node, 'size', node.size)
      probe(node, 'stroke.width', (node.stroke as unknown as { width?: unknown })?.width)
    }
    const byShape = new Map<string, number>()
    for (const a of allAxes) {
      const key = `${a.axis.padEnd(14)} kind=${a.valueKind}${a.astKind ? ' / ast=' + a.astKind : ''}`
      byShape.set(key, (byShape.get(key) ?? 0) + 1)
    }
    const shapes = [...byShape.entries()].sort((a, b) => b[1] - a[1])
    // eslint-disable-next-line no-console
    console.log(`\n  ALL paint axes (${allAxes.length} entries, feature/cond=${featureAxes.length}):`)
    for (const [shape, count] of shapes) {
      // eslint-disable-next-line no-console
      console.log(`    ${String(count).padStart(4)}× ${shape}`)
    }

    return { sceneRaw, opt, profile, timing: { lex: t1 - t0, parse: t2 - t1, lower: t3 - t2, optimize: t5 - t4 } }
  }

  compileFullyInstrumented(xgisDefault, 'compute=0 (default)')
  compileFullyInstrumented(xgisCompute, 'compute=1 (bypass match-expansion)')
})
