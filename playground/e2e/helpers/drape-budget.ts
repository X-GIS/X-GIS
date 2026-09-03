// ═══ #2094 — the globe fill drape's WHEN, readable from an e2e spec ═══
//
// The engine's own predicate is `drapesAtChordBudget` in
// map/src/render/globe-drape-budget.ts, and a spec CANNOT import it: raw-Node
// spec transpilation does not resolve the `@xgis/shared` import that both
// `@xgis/geo` and `compiler/src/tiler/subdivide-conforming.ts` pull in (the same
// constraint `_globe-positron-native-zoom-gate` already documents for the old
// ceiling literal). So the four LITERALS are parsed out of the engine sources —
// never mirrored — and the one line of arithmetic that combines them is repeated
// here.
//
// That repetition is the whole risk, and it is bounded on both sides: a literal
// that moves is picked up automatically, a literal that is RENAMED throws loudly
// from the test body, and the arithmetic itself is pinned against the real
// implementation by map/src/render/globe-drape-budget.test.ts (the closed form,
// the anchors, the #2435 peak) and against the real subdivision by
// compiler/src/tiler/subdivision-conformance.test.ts.
//
// Call from a test BODY, never at module scope: a module-scope read that throws
// aborts collection for every spec in the suite (#1638).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')

function literal(relPath: string, name: string): number {
  const src = readFileSync(join(REPO, relPath), 'utf8')
  const m = new RegExp(`(?:export )?const ${name} = ([0-9.]+)`).exec(src)
  if (!m) throw new Error(`could not read \`${name}\` from ${relPath}`)
  return Number(m[1])
}

/** The engine's live drape budget, read from its declaration. */
export function readChordBudgetPx(): number {
  return literal('map/src/render/globe-drape-budget.ts', 'GLOBE_DRAPE_CHORD_BUDGET_PX')
}

/** Mirror of `tileSegmentAngleRad` — the finest edge the tiler leaves on a tile of
 *  level `tileZ`, at the equator. Both constants are read from the subdivision
 *  authority. */
export function tileSegmentAngleRad(tileZ: number): number {
  const gateDeg = literal('compiler/src/tiler/subdivide-conforming.ts', 'MAX_TRI_DEGREES_FOR_PROJ')
  const depth = literal('compiler/src/tiler/subdivide-conforming.ts', 'MAX_TRI_SUBDIVIDE_DEPTH')
  const span = (2 * Math.PI) / 2 ** Math.max(0, tileZ)
  const gate = gateDeg * (Math.PI / 180)
  if (span <= gate) return span
  return span / 2 ** Math.min(depth, Math.ceil(Math.log2(span / gate)))
}

/** Mirror of `directChordErrorPx`: the screen deviation of the direct path's
 *  chords from the arcs they stand for. */
export function directChordErrorPx(drawnZ: number, cameraZoom: number): number {
  const tilePx = literal('geo/src/world-scale.ts', 'TILE_PX')
  const rPx = (tilePx * 2 ** cameraZoom) / (2 * Math.PI)
  return rPx * (1 - Math.cos(tileSegmentAngleRad(drawnZ) / 2))
}

/** Whether the engine is EXPECTED to bake→drape a source's fills at this camera.
 *
 *  @param sourceMaxLevel the source's deepest level — the drawn LOD is
 *                        `min(floor(cameraZoom), maxLevel)`, which is what the
 *                        renderer prices (tile-selection-cache.ts). */
export function expectDrape(sourceMaxLevel: number, cameraZoom: number): boolean {
  const drawnZ = Math.max(0, Math.min(Math.floor(cameraZoom), sourceMaxLevel))
  return directChordErrorPx(drawnZ, cameraZoom) > readChordBudgetPx()
}

/** The smallest source `maxLevel` that is SERVABLE at `cameraZoom` — i.e. the
 *  threshold a page-side filter can compare against, since the error falls
 *  monotonically as a source gets deeper. Derived from the budget, so a spec never
 *  hard-codes a level. Returns `Infinity` when no source depth clears the budget at
 *  this camera (which is itself a loud, meaningful answer for a gate's premise). */
export function minServableMaxLevel(cameraZoom: number): number {
  for (let ml = 0; ml <= 24; ml++) if (!expectDrape(ml, cameraZoom)) return ml
  return Infinity
}
