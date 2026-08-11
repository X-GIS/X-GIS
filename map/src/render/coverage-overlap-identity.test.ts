// ═══ ONE probe point, three authorities, ONE answer (#1500) ═══
//
// A mosaic coverage source holds several domains whose footprints overlap — the common real case
// being NESTED and unequal in resolution (`sfbofs` ⊂ `wcofs`). Three independent consumers each
// have to answer "which domain owns this water", and they answer it in three different places:
//
//   * the READOUT   — `XGISMap.getCoverage(id, at)` → `coverageHandleAt`, the value a click reports
//   * the DRAPE     — one alpha-blended quad per region, so the LAST one drawn is what the eye sees
//   * the ARROWS    — one screen lattice per region, with a suppression box per owned ground
//
// Each of those has already been wrong on its own terms, and each was fixed separately: the arrows
// drew BOTH fields over shared water (#1585 — double glyph density, which reads as a faster current
// than the data says), and the drape took its order from the renderer's LRU, so the overlap's winner
// was the most recently RE-ARMED region and flipped several times a second as forecast ticks landed
// (#1602). Both fixes point the consumer at the same authority: the region's index in the
// `_coverage` Map, via `regionPriority`.
//
// WHY THIS FILE EXISTS AT ALL, given both of those already have their own green gates. Three gates
// that each check one consumer against a rule stated three times can all stay green while the
// consumers drift apart from each other — which is the exact failure the two bugs above were, and
// checking the pairs is not the same as checking the identity. So this asserts the IDENTITY: for one
// probe point, the three name the same region, as a single check. ADR-0011 is the stated policy;
// this is the gate that fails when a future contributor reaches for the LRU or the batch array
// again, because both are right there and both look like relevance until a re-arm lands.

import { describe, it, expect } from 'vitest'
import { coverageFromGrids, type CoverageHandle, type CoverageInput } from '@xgis/data'
import { CoverageRenderer } from './coverage-renderer'
import { coverageCovers } from './coverage-bounds'
import { fieldOwnedBoxOf, type FieldOwnedBox } from './field-lattice-uniform'
import { coverageHandleAt, regionPriority, type CoverageSourceDeps } from '../coverage-source'
import { coverageArrowGrid } from '../coverage-arrow-show'
import { CompiledArrowStore } from '../graphics/compiled-arrow-store'
import type { CoverageRegionData, RawDataset } from '../map-types'

const SOURCE_ID = 'currents'
const BASIN = 'wcofs' // coarse, basin-wide
const LOCAL = 'sfbofs' // fine, local — nested inside the basin, and the MORE relevant of the two

/** No region claims this point. A distinct value rather than `undefined` so a reader that finds
 *  nothing is compared like any other answer instead of silently matching another `undefined`. */
const NONE = '(none)'

function gridHandle(
  origin: readonly [number, number],
  spacing: readonly [number, number],
): CoverageHandle {
  const input: CoverageInput = {
    product: 's111',
    origin: [origin[0], origin[1]],
    spacing: [spacing[0], spacing[1]],
    size: [8, 8],
    vertical: { datumCode: null, sign: 'up' },
    bands: [
      {
        name: 'surfaceCurrentSpeed',
        unit: 'knots',
        kind: 'f32',
        nodata: -9999,
        values: Float32Array.from(Array.from({ length: 64 }, (_, i) => (i % 5) + 1)),
      },
    ],
  }
  return coverageFromGrids(input)
}

// Geometry, stated once so the probe points below are checkable by hand:
//
//   wcofs  origin [8,48]  spacing 2     → cell edges [7,47,23,63]        node box [8,22]×[48,62]
//   sfbofs origin [12,52] spacing 0.5   → cell edges [11.75,51.75,15.75,55.75]  node box [12,15.5]×[52,55.5]
//
// The node box is half a cell INSIDE the cell edges, which is why the arrows own less ground than
// the drape covers (#1585) — a probe must sit inside the node boxes to be a question the arrow
// field can answer at all.
const OVERLAP: readonly [number, number] = [13, 53] // inside BOTH, on every derivation
const BASIN_ONLY: readonly [number, number] = [20, 60] // inside wcofs alone

/** The resident set, in CATALOGUE RELEVANCE order — which is the order `itemsForView` ranks
 *  overlapping cells in (most overlap, ties toward the SMALLER bbox, i.e. the higher-resolution
 *  local cell) and the order the resolve arms them in. The local cell is therefore FIRST, and its
 *  `regionPriority` is 0. */
function fixture(): {
  handles: Map<string, CoverageHandle>
  deps: CoverageSourceDeps
} {
  const handles = new Map<string, CoverageHandle>([
    [LOCAL, gridHandle([12, 52], [0.5, 0.5])],
    [BASIN, gridHandle([8, 48], [2, 2])],
  ])
  const coverage = new Map<string, CoverageRegionData>(
    [...handles].map(([k, handle]) => [k, { handle }]),
  )
  const deps = {
    rawDatasets: new Map<string, RawDataset>([[SOURCE_ID, { _coverage: coverage }]]),
  } as unknown as CoverageSourceDeps
  return { handles, deps }
}

function makeRenderer(): CoverageRenderer {
  const tex = () => ({ destroy() {}, __tex: true })
  const ctx = {
    rhi: {
      backend: 'webgpu',
      createTexture: tex,
      createView: () => ({ __view: true }),
      createSampler: () => ({ __samp: true }),
      writeTexture: () => {},
      destroyTexture: () => {},
      createBuffer: () => ({ __buf: true }),
      writeBuffer: () => {},
      destroyBuffer: () => {},
      createBindGroupLayout: () => ({ __layout: true }),
      createPipeline: () => ({ __pipe: true }),
      createBindGroup: () => ({ __bg: true }),
      caps: { shaderLanguage: 'wgsl' },
    },
    canvas: { width: 800, height: 600 },
  }
  return new CoverageRenderer(ctx as unknown as ConstructorParameters<typeof CoverageRenderer>[0])
}

/** An advected batch reaches `add()` only with a device, both drapers and a frame-side source
 *  present; none of them is otherwise touched on this path (no instances are packed, and the
 *  batch bind group is built only for the static pair). So the stub is the four presence checks. */
function makeStore(): CompiledArrowStore {
  const store = new CompiledArrowStore()
  const rhi = {
    createBuffer: () => ({ __buf: true }),
    writeBuffer: () => {},
    destroyBuffer: () => {},
  }
  store.attach(rhi as never, { __draper: true } as never, { __advected: true } as never)
  store.setAdvectedSource({ arrowBindingFor: () => null } as never)
  return store
}

/** Arm ONE region into both consumers, each taking its priority from `regionPriority` — the same
 *  call the real arm path makes (`coverage-source.ts:215,220`), which is the whole point: the test
 *  must not compute relevance itself, or it would pin its own arithmetic instead of the engine's.
 *
 *  Clear-then-add is what a re-arm actually does (`armCoverageShow`), and it is exactly the step
 *  that moves a region to the back of `batches` and of the renderer's LRU. Calling it on the first
 *  arm too keeps the two paths one path. */
function arm(
  renderer: CoverageRenderer,
  store: CompiledArrowStore,
  deps: CoverageSourceDeps,
  region: string,
  handle: CoverageHandle,
): void {
  const priority = regionPriority(deps, SOURCE_ID, region)
  renderer.setCoverage(handle, { ramp: 's111-speed', priority }, region)
  store.clear([], region)
  store.add(
    new Float64Array(0),
    new Float64Array(0),
    new Float32Array(0),
    new Float32Array(0),
    [],
    0.06,
    1,
    region,
    { grid: coverageArrowGrid(handle), bandTable: new Float32Array(80), priority },
  )
}

function armAll(): {
  renderer: CoverageRenderer
  store: CompiledArrowStore
  handles: Map<string, CoverageHandle>
  deps: CoverageSourceDeps
} {
  const { handles, deps } = fixture()
  const renderer = makeRenderer()
  const store = makeStore()
  for (const [region, handle] of handles) arm(renderer, store, deps, region, handle)
  return { renderer, store, handles, deps }
}

/** The regions the REAL `render()` loop draws, in the order it draws them.
 *
 *  Driven, not inspected — the #1587 shape, and `coverage-draw-order.test.ts` paid for it directly:
 *  an earlier cut of that file called `drawOrder()` and stayed green when the draw loop was reverted
 *  to `states.values()`, because a helper returning the right list says nothing about what the draw
 *  consumes. So this stubs the ONE collaborator the loop reaches per region (`draperFor`), records
 *  the state it is handed, and leaves everything else real. Kept in step with the sibling file's
 *  copy deliberately: both must break when the loop stops consuming the relevance order. */
function drawKeys(r: CoverageRenderer): string[] {
  const priv = r as unknown as {
    draperFor(s: { valueTex: unknown }): unknown
    states: Map<string, { valueTex: unknown }>
  }
  const byTex = new Map([...priv.states].map(([k, s]) => [s.valueTex, k]))
  const seen: string[] = []
  const real = priv.draperFor
  priv.draperFor = (s) => {
    seen.push(byTex.get(s.valueTex) ?? '?')
    return { bindGroup: () => ({ __bg: true }), draw() {} }
  }
  try {
    r.render({ __pass: true } as never, new Float32Array(16), [0, 0], [0, 0, 0, 0])
  } finally {
    priv.draperFor = real
  }
  return seen
}

interface AdvectedBatchProbe {
  region: string
  suppress: readonly FieldOwnedBox[]
  advected: { grid: Parameters<typeof fieldOwnedBoxOf>[0] } | null
}

const inBox = (b: FieldOwnedBox, [lon, lat]: readonly [number, number]): boolean =>
  lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north

/** THE READOUT's answer — `XGISMap.getCoverage(id, at)` is a direct delegation to this call
 *  (`map.ts:4747`), so this is the value a click on the chart reports. */
function readoutOwner(
  deps: CoverageSourceDeps,
  handles: Map<string, CoverageHandle>,
  at: readonly [number, number],
): string {
  const handle = coverageHandleAt(deps, SOURCE_ID, at)
  for (const [region, h] of handles) if (h === handle) return region
  return NONE
}

/** THE DRAPE's answer — of the regions whose grid covers the point, the one the real draw loop
 *  visits LAST. The blend is alpha-over and every region paints an opaque-at-full-opacity quad, so
 *  last drawn is the colour on the glass. */
function drapeOwner(
  renderer: CoverageRenderer,
  handles: Map<string, CoverageHandle>,
  at: readonly [number, number],
): string {
  const covering = drawKeys(renderer).filter((k) => coverageCovers(handles.get(k)!, at[0], at[1]))
  return covering.at(-1) ?? NONE
}

/** THE ARROW FIELD's answer — the one advected batch whose own node box holds the point and none of
 *  whose suppression boxes do. That `suppress` array is the very list the uniform writer hands the
 *  shader (`compiled-arrow-store.ts:377`), where four closed `step`s make exactly this test, so the
 *  CPU-side reading here is the same question the fragment asks. */
function arrowOwner(store: CompiledArrowStore, at: readonly [number, number]): string {
  const batches = (store as unknown as { batches: AdvectedBatchProbe[] }).batches
  const drawing = batches.filter(
    (b) =>
      b.advected !== null &&
      inBox(fieldOwnedBoxOf(b.advected.grid), at) &&
      !b.suppress.some((box) => inBox(box, at)),
  )
  // Not an incidental assertion: two batches drawing at one point IS #1585 (the doubled field), and
  // a reader that silently took the first would report an identity that holds while the screen shows
  // two domains at once.
  expect(
    drawing.map((b) => b.region),
    'exactly one region may draw arrows at a point',
  ).toHaveLength(1)
  return drawing[0]?.region ?? NONE
}

/** The three answers for one point, as one value — so a test compares an IDENTITY rather than
 *  three separately-stated expectations that can each be updated to match a drifting consumer. */
function ownersAt(
  f: ReturnType<typeof armAll>,
  at: readonly [number, number],
): { readout: string; drape: string; arrows: string } {
  return {
    readout: readoutOwner(f.deps, f.handles, at),
    drape: drapeOwner(f.renderer, f.handles, at),
    arrows: arrowOwner(f.store, at),
  }
}

const agreed = (o: { readout: string; drape: string; arrows: string }): string => {
  expect(
    new Set([o.readout, o.drape, o.arrows]).size,
    `the three authorities disagree: readout=${o.readout} drape=${o.drape} arrows=${o.arrows}`,
  ).toBe(1)
  return o.readout
}

describe('coverage mosaic overlap — readout, drape and arrows name ONE region (#1500)', () => {
  it('over the overlap, all three name the MORE RELEVANT region', () => {
    const owner = agreed(ownersAt(armAll(), OVERLAP))
    // And they agree on the RIGHT one. Agreement alone is satisfiable by three consumers that are
    // wrong together — the coarse basin cell painting over the local forecast is the 2%-vs-45%
    // damage the eviction sibling of this bug already cost.
    expect(owner, 'the nested, higher-resolution local cell owns water it covers').toBe(LOCAL)
  })

  it('outside the overlap the answer is the ONLY region there — not a constant', () => {
    // Guards the gate against vacuity: a reader that always returned the first-armed region would
    // pass the case above and fail here.
    expect(agreed(ownersAt(armAll(), BASIN_ONLY))).toBe(BASIN)
  })

  it('A FORECAST RE-ARM MOVES NOTHING — the identity survives the reported symptom', () => {
    // THE BUG, in the form all three consumers had it. A re-arm fires per region on every forecast
    // tick and every playback frame; it moves the region to the back of the renderer's LRU and to
    // the end of the arrow store's `batches`. Anything that reads ownership off either of those
    // flips here, several times a second, and disagrees with a readout that never moved.
    const f = armAll()
    expect(agreed(ownersAt(f, OVERLAP))).toBe(LOCAL)

    arm(f.renderer, f.store, f.deps, BASIN, f.handles.get(BASIN)!) // the basin steps its hour
    expect(
      agreed(ownersAt(f, OVERLAP)),
      'the coarse basin re-armed; it must not take the water',
    ).toBe(LOCAL)

    arm(f.renderer, f.store, f.deps, LOCAL, f.handles.get(LOCAL)!) // and the local one steps too
    expect(agreed(ownersAt(f, OVERLAP))).toBe(LOCAL)
    expect(agreed(ownersAt(f, BASIN_ONLY))).toBe(BASIN)
  })

  it('all three derive from ONE authority — `regionPriority`, not three coincidences', () => {
    // The identity above is a property of the fixture's arm order as much as of the code. This pins
    // the mechanism: reverse the catalogue's relevance order and the SAME region must lose all three
    // answers together. Three consumers that happened to agree by three separate rules would come
    // apart here, because only one of the rules tracks the Map.
    const { handles: relevant } = fixture()
    const reversed = new Map<string, CoverageHandle>([
      [BASIN, relevant.get(BASIN)!],
      [LOCAL, relevant.get(LOCAL)!],
    ])
    const coverage = new Map<string, CoverageRegionData>(
      [...reversed].map(([k, handle]) => [k, { handle }]),
    )
    const deps = {
      rawDatasets: new Map<string, RawDataset>([[SOURCE_ID, { _coverage: coverage }]]),
    } as unknown as CoverageSourceDeps
    const renderer = makeRenderer()
    const store = makeStore()
    for (const [region, handle] of reversed) arm(renderer, store, deps, region, handle)

    expect(
      regionPriority(deps, SOURCE_ID, BASIN),
      'the basin is now the catalogue-relevant one',
    ).toBe(0)
    expect(agreed(ownersAt({ renderer, store, handles: reversed, deps }, OVERLAP))).toBe(BASIN)
  })
})
