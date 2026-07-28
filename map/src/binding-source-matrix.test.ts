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

/** A binding's fate on one source kind: the file+token that consumes it, or why it cannot. */
type Cell = { consumer: { file: string; token: string } } | { na: string }

/** `filter:` — the binding that motivated this gate. */
const FILTER: Record<string, Cell> = {
  geojson: { consumer: { file: 'map.ts', token: 'applyFilter(' } },
  vector: { consumer: { file: 'render/vector-tile-renderer.ts', token: 'show.filterExpr' } },
  coverage: {
    consumer: {
      file: 'render/passes/dispatch-coverage-soundings.ts',
      token: 'filterAcceptsProps(',
    },
  },
  raster: { na: 'a raster tile has no features to filter' },
  'raster-dem': { na: 'a DEM has no features to filter' },
  binary: { na: 'pre-tiled XGVT — filtering happens at tile build time, not at draw' },
}

/** `| label-[…]` — the binding whose coverage cell was empty until #1366 INC-5. */
const LABEL: Record<string, Cell> = {
  geojson: { consumer: { file: 'render/passes/label-pass.ts', token: 'data.features' } },
  vector: { consumer: { file: 'render/passes/label-pass.ts', token: 'computeSliceKey(' } },
  coverage: {
    consumer: { file: 'render/passes/label-pass.ts', token: 'dispatchCoverageSoundings(' },
  },
  raster: { na: 'a raster tile carries no per-feature properties to label' },
  'raster-dem': { na: 'a DEM carries no per-feature properties to label' },
  binary: { consumer: { file: 'render/passes/label-pass.ts', token: 'computeSliceKey(' } },
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
      for (const kind of RUNTIME_SOURCE_KINDS) {
        if (!(kind in cells)) holes.push(`${binding} × ${kind}`)
      }
      for (const kind of Object.keys(cells)) {
        if (!(RUNTIME_SOURCE_KINDS as readonly string[]).includes(kind)) {
          holes.push(`${binding} × ${kind} — not a runtime source kind`)
        }
      }
    }
    expect(holes, `undeclared cells:\n${holes.join('\n')}`).toEqual([])
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
