// ═══ Dependency-direction ratchet (#929) ═══
//
// Pins the TARGET package-dependency graph of the monorepo and fails CI on any
// NEW cross-package src import outside it. The boundary principle (#929):
// modules have zero cross-correlation — the engine knows nothing about maps,
// backend adapters implement @xgis/rhi and know nothing about the domain or
// core policy. M3 proved a boundary survives only when violating it is a
// mechanical CI failure, not a review comment; this is that gate at
// import-graph granularity (near-zero maintenance — it breaks only on a
// structural change, never on a rename or comment edit).
//
// Successor to the deleted per-identifier webgpu-neutrality ratchet (#833 M1):
// engine backend-neutrality is now compiler-enforced (`types: []`); this test
// covers the remaining direction — adapters must not reach UP into engine /
// compiler, and no package may import outside its allowed set.
//
// BASELINE holds the known violations being burned down under #929. The
// ratchet convention applies: removing a baseline edge from the code MUST
// delete its BASELINE entry in the same commit (a stale entry fails below),
// so the baseline can only shrink.
//
// Lives in engine/src so the `engine-rhi-data` CI leg runs it — a new
// path would be CI-dark (the matrix shards by directory; see test.yml).

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Target allowed graph: package → the ONLY `@xgis/*` packages its src may
 *  import. Loosening an entry is a conscious, reviewable diff of this file. */
const ALLOWED: Record<string, readonly string[]> = {
  shared: [],
  geo: ['shared'],
  'shader-dsl': [],
  compiler: ['shader-dsl', 'shared'],
  blueprint: ['compiler'],
  rhi: [],
  engine: ['rhi', 'shader-dsl', 'shared'],
  // Backend adapters implement the RHI; shader-dsl is content-blind emit
  // machinery. engine/compiler are NOT allowed — see BASELINE + #929 A/B.
  'rhi-webgl2': ['rhi', 'shader-dsl'],
  'rhi-webgpu': ['rhi', 'shader-dsl'],
  data: ['shared', 'geo', 'compiler'],
  // Composition root: may import every library layer, never an app package.
  map: [
    'shared',
    'geo',
    'shader-dsl',
    'compiler',
    'blueprint',
    'rhi',
    'engine',
    'data',
    'rhi-webgl2',
    'rhi-webgpu',
  ],
  pipeline: [],
}

/** Legacy / app-layer packages outside the gate: runtime is the pre-#732
 *  monolith being retired; playground + site are consumers, not libraries. */
const EXEMPT = new Set(['runtime', 'playground', 'site'])

/** Known violations pinned for burn-down (#929 A/B). Shrink-only: removing
 *  the last offending import must delete the entry here in the same commit. */
const BASELINE: ReadonlyArray<readonly [pkg: string, dep: string]> = [
  ['rhi-webgl2', 'compiler'],
  ['rhi-webgpu', 'compiler'],
  // TYPE-only residue (#929 B burned the value-level imports): gpu.ts imports
  // the `RenderContext`/`BackendChoice` context family, whose engine home is
  // deliberate (see render-context.ts header) until the #834 M5 context
  // neutralization relocates it.
  ['rhi-webgpu', 'engine'],
  // Documented transitional home (#834 M5): both boot providers produce the
  // WebGPU-typed GPUContext, so the webgl2 provider lives in rhi-webgpu until
  // GPUContext neutralizes — then each provider moves to its backend package
  // (see rhi-webgpu/src/backend-providers.ts header) and this edge burns down.
  ['rhi-webgpu', 'rhi-webgl2'],
]

const IMPORT_RE = /(?:from\s*|import\s*\(\s*|import\s+)['"]@xgis\/([a-z0-9-]+)['"]?/g

const isTestPath = (p: string): boolean =>
  p.includes('.test.') ||
  p.includes('__tests__') ||
  p.includes('__test-support__') ||
  p.includes('test-setup')

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      yield* walk(full)
    } else if (entry.name.endsWith('.ts')) {
      yield full
    }
  }
}

interface Edge {
  pkg: string
  dep: string
  examples: string[]
}

function scanGraph(): Map<string, Edge> {
  const workspaces = (
    JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      workspaces: string[]
    }
  ).workspaces
  const edges = new Map<string, Edge>()
  for (const pkg of workspaces) {
    if (EXEMPT.has(pkg)) continue
    const src = join(REPO_ROOT, pkg, 'src')
    for (const file of walk(src)) {
      if (isTestPath(file)) continue
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(IMPORT_RE)) {
        const dep = m[1]!
        if (dep === pkg) continue
        const key = `${pkg} -> ${dep}`
        const edge = edges.get(key) ?? { pkg, dep, examples: [] }
        if (edge.examples.length < 3) edge.examples.push(relative(REPO_ROOT, file))
        edges.set(key, edge)
      }
    }
  }
  return edges
}

describe('dependency-direction ratchet (#929)', () => {
  const edges = scanGraph()

  it('scanner sanity — permanent structural edges are seen', () => {
    // engine→rhi and map→engine are permanent structural edges; if the scan
    // ever stops seeing them the walker/regex broke, not the codebase, and
    // the gate would be silently passing on nothing.
    expect(edges.has('engine -> rhi')).toBe(true)
    expect(edges.has('map -> engine')).toBe(true)
  })

  it('src imports stay inside the allowed graph (+ pinned baseline)', () => {
    const baseline = new Set(BASELINE.map(([p, d]) => `${p} -> ${d}`))
    const violations = [...edges.values()].filter(
      (e) => !(ALLOWED[e.pkg] ?? []).includes(e.dep) && !baseline.has(`${e.pkg} -> ${e.dep}`),
    )
    expect(
      violations.map((e) => `${e.pkg} -> @xgis/${e.dep} (e.g. ${e.examples.join(', ')})`),
      'NEW cross-package dependency outside the allowed graph. Either the ' +
        'import reaches across a boundary (fix the import — see #929) or the ' +
        'architecture genuinely changed (then widen ALLOWED here, in this ' +
        'commit, with a reviewable rationale).',
    ).toEqual([])
  })

  it('baseline only shrinks (stale entries must be deleted)', () => {
    const stale = BASELINE.filter(([p, d]) => !edges.has(`${p} -> ${d}`))
    expect(
      stale.map(([p, d]) => `${p} -> @xgis/${d}`),
      'Baseline edge no longer exists in src — burn-down achieved. Delete ' +
        'its BASELINE entry in this same commit so the ratchet locks the win.',
    ).toEqual([])
  })
})
