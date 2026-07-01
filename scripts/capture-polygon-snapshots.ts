#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════════════
// Polygon variant snapshot capture — Phase 2.5 US-010 (DSL baseline).
// ═══════════════════════════════════════════════════════════════════
//
// Captures the current main HEAD's polygon shader output for the
// shared fixture set (8 variants — 4 production-style + 4 synthetic
// patterns). Snapshots become the DSL composer's emit baseline:
// `polygon-variant-diff.test.ts` byte-equal-diffs the current emit
// against the committed snapshot, surfacing any unintentional drift
// from a composer change.
//
// PR-B note: the previous capture path used POLYGON_SHADER_SOURCE +
// string.replace (legacy buildShaderFrozen) and the snapshots were
// the pre-PR-B emit. After PR-B's runtime rewire (US-008) the
// composer is the single emission seam — the snapshots now baseline
// the COMPOSER output, not the legacy template. Pixel survey +
// CI render-gate validate semantic equivalence end-to-end; this
// snapshot diff is the per-commit drift gate sitting one level
// above test ergonomics.
//
// Re-capture protocol: if a composer change intentionally perturbs
// the emit (e.g. const order, identifier rename, new helper fn),
// re-run this script to refresh snapshots; the diff-test's SHA-
// header ancestor check confirms the baseline is still reachable
// from HEAD.
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
import { FIXTURES, emitForFixture } from '../map/src/shaders/dsl/_polygon-fixtures'
// The projection graph is host-injected (configureProjections); the polygon emit reaches it
// via getGpuProjectionFuncs(), so configure before any emitForFixture (mirrors the vitest setup).
import { configureProjections } from '../map/src/shaders/dsl/projections'
import { PROJECTIONS } from '../engine/src/projection/projections-table'
configureProjections(PROJECTIONS)

const argBaseline = process.argv.find(a => a.startsWith('--baseline='))?.split('=')[1]
const baselineSha = argBaseline ?? execSync('git rev-parse HEAD').toString().trim()

const __filename = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(__filename), '..')
const dir = join(repoRoot, 'map/src/shaders/dsl/__polygon-variant-snapshots__')
mkdirSync(dir, { recursive: true })

let written = 0
for (const fx of FIXTURES) {
  const wgsl = emitForFixture(fx)
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
