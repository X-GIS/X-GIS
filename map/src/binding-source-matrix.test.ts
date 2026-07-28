// ═══ Which layer bindings actually reach which SOURCE KIND ═══════════════════
//
// THE FAILURE THIS EXISTS FOR. `filter: .depth > 20` on a coverage layer compiled
// cleanly, lowered to `RenderNode.filter`, and thinned nothing — measured on the demo as 38
// numerals with the filter and 38 without. `| label-[…]` on a coverage layer did the same until
// #1366 INC-5. Neither was a typo the compiler could have caught: both are real bindings that
// lower correctly and then have no consumer on that source's path.
//
// WHY IT WAS UNDETECTABLE, structurally:
//
//   1. Each binding is implemented at a DIFFERENT STAGE per source kind. `filter` is
//      pre-applied to a FeatureCollection for geojson (map.ts `applyFilter`), folded into the
//      MVT worker's slice key for vector tiles (`computeSliceKey`), and applied per candidate
//      cell for a coverage grid. Nothing links the three, so a new source kind starts with an
//      empty column and every cell has to be filled by someone remembering.
//   2. The compiler is content-blind BY CHARTER, so it cannot ask "does this source's runtime
//      implement this binding?" — that would require it to know runtime capabilities.
//   3. `X-GIS0005` (lower-bindings-paint.ts) catches an UNKNOWN binding. `filter` is a known
//      binding that lowers fine. "Known binding, no consumer for this source kind" is not a
//      case anything modelled.
//   4. `RenderNode` is a superset struct, not a per-kind sum type: a coverage node and a
//      polygon node are the SAME TypeScript type, so the compiler can neither reject `filter`
//      on a grid nor require somebody to handle it.
//   5. The runtime reads bindings by field access. Not reading one is not an observable event.
//
// `RUNTIME_CAPABILITIES` does not cover this and should not be stretched to: it is the
// MapLibre spec-conformance table (fill-color, line-width…) and its drift gate binds
// spec-coverage↔runtime. This is a different axis — X-GIS's own bindings × source kind.
//
// WHAT THIS GATE DOES. It makes the matrix explicit and, crucially, ties every "supported"
// cell to a NAMED CONSUMER IN THE SOURCE. A matrix on its own is a wish list; the anchor scan
// is what makes a lie fail. And the rows are driven by `SOURCE_TYPES` — the compiler's own
// authority — so adding a source kind fails this gate until its column is declared, which is
// exactly the moment the question "does `filter` work here?" should be asked.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOURCE_TYPES } from '@xgis/compiler'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(HERE, rel), 'utf8')

/** Container-name aliases that `lower.ts` canonicalises before the IR or runtime sees them, so
 *  they are not separate runtime paths and get no column. Verified below, not assumed: each
 *  alias must still be a SOURCE_TYPES member, or this list has gone stale. */
const CANONICALISED_ALIASES = ['pmtiles', 'tilejson', 'hdf5', 'h5'] as const

/** Where a binding is evaluated. Not a label — the rule (see FILTER) is that a predicate runs
 *  where its operand lives, so a cell whose domain looks wrong for its operand is a design bug,
 *  not a formatting one. */
type Domain = 'cpu' | 'gpu'

/** A binding's fate on one draw path: the file+token that consumes it, or why it cannot.
 *
 *  `kind` is the SOURCE KIND when the row key names a draw path instead ('coverage/ramp'), so a
 *  source kind with several draw paths still resolves against SOURCE_TYPES. Cells keyed by a
 *  plain source kind leave it out. */
type Cell =
  | { consumer: { file: string; token: string }; domain: Domain; kind?: string }
  | { na: string; kind?: string }

/** `filter:` — the binding that motivated this gate, and then broke it (#1437).
 *
 *  A `coverage` layer has TWO draw paths, and the first version of this table had ONE cell for
 *  it: anchored to the sounding dispatch, it asserted "filter works on coverage" while the ramp
 *  drape ignored the clause entirely. That is the very shape the gate exists to catch — known
 *  binding, no consumer on this path — reproduced one level down, which is why cells now carry
 *  a DRAW PATH and the evaluation DOMAIN that goes with it.
 *
 *  The domain is not decoration. It records the rule the two coverage cells follow: a predicate
 *  is evaluated where its OPERAND lives, because that is where filtering removes downstream
 *  work. A feature property lives in a JS object, so filtering it on the CPU means the feature
 *  is never uploaded; a band value at a fragment lives in a texture, so filtering it on the GPU
 *  saves the LUT tap and the blend, and a CPU mask would be a full-grid pass plus an upload. */
const FILTER: Record<string, Cell> = {
  geojson: { consumer: { file: 'map.ts', token: 'applyFilter(' }, domain: 'cpu' },
  vector: {
    consumer: { file: 'render/vector-tile-renderer.ts', token: 'show.filterExpr' },
    domain: 'cpu',
  },
  'coverage/soundings': {
    kind: 'coverage',
    consumer: {
      file: 'render/passes/dispatch-coverage-soundings.ts',
      token: 'coverageCellPredicate(',
    },
    domain: 'cpu',
  },
  'coverage/ramp': {
    kind: 'coverage',
    consumer: { file: 'shaders/dsl/coverage-ramp.ts', token: 'filter({ v: raw' },
    domain: 'gpu',
  },
  raster: { na: 'a raster tile has no features to filter' },
  'raster-dem': { na: 'a DEM has no features to filter' },
  binary: { na: 'pre-tiled XGVT — filtering happens at tile build time, not at draw' },
}

/** `| label-[…]` — the binding whose coverage cell was empty until #1366 INC-5. */
const LABEL: Record<string, Cell> = {
  geojson: {
    consumer: { file: 'render/passes/label-pass.ts', token: 'data.features' },
    domain: 'cpu',
  },
  vector: {
    consumer: { file: 'render/passes/label-pass.ts', token: 'computeSliceKey(' },
    domain: 'cpu',
  },
  coverage: {
    consumer: { file: 'render/passes/label-pass.ts', token: 'dispatchCoverageSoundings(' },
    domain: 'cpu',
  },
  raster: { na: 'a raster tile carries no per-feature properties to label' },
  'raster-dem': { na: 'a DEM carries no per-feature properties to label' },
  binary: {
    consumer: { file: 'render/passes/label-pass.ts', token: 'computeSliceKey(' },
    domain: 'cpu',
  },
}

const MATRIX: ReadonlyArray<{ binding: string; cells: Record<string, Cell> }> = [
  { binding: 'filter', cells: FILTER },
  { binding: 'label', cells: LABEL },
]

/** The source kinds that are their own runtime path — SOURCE_TYPES minus the aliases. */
const RUNTIME_SOURCE_KINDS = SOURCE_TYPES.filter(
  (t) => !(CANONICALISED_ALIASES as readonly string[]).includes(t),
)

describe('layer binding × source kind', () => {
  it('the alias list is still made of real SOURCE_TYPES members', () => {
    // Without this, a renamed alias would silently become an un-covered source kind that the
    // completeness check below never asks about — the matrix would go quiet, not red.
    for (const alias of CANONICALISED_ALIASES) {
      expect(SOURCE_TYPES as readonly string[], `${alias} is no longer a SOURCE_TYPE`).toContain(
        alias,
      )
    }
  })

  it('every binding declares a cell for every runtime source kind', () => {
    const holes: string[] = []
    for (const { binding, cells } of MATRIX) {
      // A cell's source kind is `kind` when the row key names a DRAW PATH, else the key
      // itself — so 'coverage/ramp' and 'coverage/soundings' both cover `coverage`, and a
      // source kind with several draw paths is still covered exactly once or more.
      const covered = new Set(Object.entries(cells).map(([key, c]) => c.kind ?? key))
      for (const kind of RUNTIME_SOURCE_KINDS) {
        if (!covered.has(kind)) holes.push(`${binding} × ${kind}`)
      }
      for (const kind of covered) {
        if (!(RUNTIME_SOURCE_KINDS as readonly string[]).includes(kind)) {
          holes.push(`${binding} × ${kind} — not a runtime source kind`)
        }
      }
      // A path-keyed row must SAY which kind it belongs to. Without this the `kind ?? key`
      // fallback above would silently accept 'coverage/ramp' as its own source kind, and the
      // completeness check would go quiet about `coverage` rather than red.
      for (const [key, c] of Object.entries(cells)) {
        if (key.includes('/') && c.kind === undefined) {
          holes.push(`${binding} × ${key} — a draw-path key must declare its source \`kind\``)
        }
      }
    }
    expect(holes, `undeclared cells:\n${holes.join('\n')}`).toEqual([])
  })

  it('every draw path of a MULTI-PATH source kind is spelled out separately', () => {
    // The #1437 regression, gated. A coverage layer draws a ramp AND numerals; one cell
    // covering both is how `filter:` came to be asserted-supported while the ramp ignored it.
    // Any source kind that some binding splits by draw path must stay split — collapsing it
    // back to a single cell is the exact move that made this gate lie.
    const split = new Map<string, Set<string>>()
    for (const { cells } of MATRIX) {
      for (const [key, c] of Object.entries(cells)) {
        if (!key.includes('/')) continue
        const kind = c.kind as string
        if (!split.has(kind)) split.set(kind, new Set())
        split.get(kind)!.add(key)
      }
    }
    for (const [kind, paths] of split) {
      expect(
        paths.size,
        `${kind} is split by draw path, so it needs more than one`,
      ).toBeGreaterThan(1)
    }
    // And the split that motivated all this must still be there, by name — a rename that
    // dropped one path would otherwise leave the rule above vacuously satisfied.
    expect([...(split.get('coverage') ?? [])].sort()).toEqual([
      'coverage/ramp',
      'coverage/soundings',
    ])
  })

  it('every supported cell declares WHERE it is evaluated', () => {
    // The domain is the rule this matrix now carries: a predicate is evaluated where its
    // operand lives. A cell that claims support without saying where cannot be checked
    // against that rule, and the rule is what keeps a texel predicate off the CPU.
    for (const { binding, cells } of MATRIX) {
      for (const [key, cell] of Object.entries(cells)) {
        if (!('consumer' in cell)) continue
        expect(['cpu', 'gpu'], `${binding} × ${key} has no evaluation domain`).toContain(
          cell.domain,
        )
      }
    }
    // Non-vacuity: at least one cell must be GPU-evaluated, or the axis is a constant column
    // that would stay green through the very regression it exists to catch.
    const domains = MATRIX.flatMap(({ cells }) =>
      Object.values(cells).flatMap((c) => ('consumer' in c ? [c.domain] : [])),
    )
    expect(domains).toContain('gpu')
    expect(domains).toContain('cpu')
  })

  it('every supported cell names a consumer that is really in that file', () => {
    // The load-bearing assertion. A cell claiming support must point at code that reads the
    // binding; deleting the consumer (or moving it) turns the claim red instead of leaving the
    // matrix asserting something that stopped being true.
    const broken: string[] = []
    for (const { binding, cells } of MATRIX) {
      for (const [kind, cell] of Object.entries(cells)) {
        if (!('consumer' in cell)) continue
        const { file, token } = cell.consumer
        let src: string
        try {
          src = read(file)
        } catch {
          broken.push(`${binding} × ${kind} → ${file} does not resolve`)
          continue
        }
        if (!src.includes(token)) broken.push(`${binding} × ${kind} → ${file} lacks "${token}"`)
      }
    }
    expect(broken, `broken consumer anchors:\n${broken.join('\n')}`).toEqual([])
  })

  it('every N/A cell says why', () => {
    // A bare "unsupported" is indistinguishable from "nobody got to it yet", which is how a
    // gap becomes permanent. The reason is what a reader needs to judge whether it still holds.
    for (const { binding, cells } of MATRIX) {
      for (const [kind, cell] of Object.entries(cells)) {
        if ('consumer' in cell) continue
        expect(cell.na.length, `${binding} × ${kind} has an empty reason`).toBeGreaterThan(10)
      }
    }
  })
})
