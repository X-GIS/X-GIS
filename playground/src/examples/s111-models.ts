// ═══ NOAA S-111 operational-forecast model registry (#1272 E-④) ═══
//
// NOAA publishes surface-current (S-111) forecasts as a set of REGIONAL operational
// forecast systems (OFS), each covering one estuary / bay / shelf. A viewport-driven
// "mosaic" picks WHICH model's cell to stream for the area on screen: pan from Chesapeake
// Bay to San Francisco Bay and the demo swaps cbofs → sfbofs. This is the model→bbox
// registry + the pure viewport-resolution the mosaic runs on each move-end; the actual
// coverage swap (setSource URL → `/noaa-s111/latest/<key>.h5`) + an LRU of loaded cells is
// the demo-runner wiring on top.
//
// The `bounds` are APPROXIMATE operational-domain envelopes (deg, [W, S, E, N]) — enough to
// pick a model for a viewport. The EXACT grid geometry always comes from the streamed cell's
// own S-100 metadata, never from here. Keys match the noaa-s111-pds S3 paths + the proxy's
// `/noaa-s111/latest/<key>.h5` route.

export interface S111Model {
  /** NOAA OFS key — the S3 path segment + the proxy `/latest/<key>.h5` model. */
  key: string
  /** Human-readable name. */
  name: string
  /** Approximate domain envelope [west, south, east, north] in degrees. */
  bounds: readonly [number, number, number, number]
}

/** The regional S-111 models the demo can stream (the proxy-supported set + the Great Lakes
 *  / Cook Inlet OFS). Ordered coarse→fine only for readability; selection is geometric. */
export const S111_MODELS: readonly S111Model[] = [
  { key: 'wcofs', name: 'U.S. West Coast', bounds: [-134.0, 30.0, -117.0, 49.0] },
  { key: 'gomofs', name: 'Gulf of Maine', bounds: [-72.0, 39.5, -63.0, 45.5] },
  { key: 'ngofs2', name: 'Northern Gulf of Mexico', bounds: [-98.5, 27.0, -87.5, 31.0] },
  { key: 'cbofs', name: 'Chesapeake Bay', bounds: [-77.3, 36.0, -74.9, 39.6] },
  { key: 'dbofs', name: 'Delaware Bay', bounds: [-75.9, 38.0, -74.2, 40.5] },
  { key: 'sfbofs', name: 'San Francisco Bay', bounds: [-123.2, 36.9, -121.3, 38.5] },
  { key: 'tbofs', name: 'Tampa Bay', bounds: [-83.2, 27.2, -82.4, 28.1] },
  { key: 'ciofs', name: 'Cook Inlet', bounds: [-155.0, 58.5, -148.0, 61.5] },
  { key: 'lsofs', name: 'Lake Superior', bounds: [-92.3, 46.4, -84.2, 49.1] },
  { key: 'lmhofs', name: 'Lake Michigan-Huron', bounds: [-88.2, 41.6, -79.7, 46.5] },
  { key: 'leofs', name: 'Lake Erie', bounds: [-83.6, 41.3, -78.8, 43.0] },
  { key: 'loofs', name: 'Lake Ontario', bounds: [-79.9, 43.1, -76.0, 44.4] },
]

/** Viewport (or any) bounds as [west, south, east, north] in degrees. */
export type Bounds = readonly [number, number, number, number]

/** Overlap AREA (deg²) of two [W,S,E,N] boxes; 0 when disjoint. */
function overlapArea(a: Bounds, b: Bounds): number {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  return w * h
}

const area = (b: Bounds): number => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])

/** Every model whose domain envelope overlaps `view`, most-overlap first. */
export function modelsForBounds(view: Bounds): S111Model[] {
  return S111_MODELS.map((m) => ({ m, o: overlapArea(view, m.bounds) }))
    .filter((x) => x.o > 0)
    .sort((x, y) => y.o - x.o)
    .map((x) => x.m)
}

/** The single best model for `view`: most overlap, ties broken toward the SMALLER domain
 *  (the more local, higher-resolution forecast). `null` when the viewport covers no model
 *  (e.g. mid-ocean / another continent) — the demo then shows no currents.
 *
 *  `currentKey` + `stickiness` add HYSTERESIS: near a region-boundary tie, a pure zoom (no pan)
 *  changes the viewport bbox enough to flip which model has marginally more raw overlap — with
 *  no bias that flip fires on every such zoom, hard-swapping the resident coverage (wiping every
 *  arrow) for a screen that mostly didn't move. The current model is kept unless a competitor
 *  beats its overlap by the `stickiness` margin (default +15%), so a decisive pan still switches
 *  normally while a boundary-adjacent zoom does not. */
export function bestModelForBounds(
  view: Bounds,
  currentKey?: string | null,
  stickiness = 1.15,
): S111Model | null {
  let best: S111Model | null = null
  let bestO = 0
  let currentO = 0
  for (const m of S111_MODELS) {
    const o = overlapArea(view, m.bounds)
    if (o <= 0) continue
    if (m.key === currentKey) currentO = o
    if (o > bestO || (o === bestO && best && area(m.bounds) < area(best.bounds))) {
      best = m
      bestO = o
    }
  }
  if (
    currentKey &&
    currentO > 0 &&
    best &&
    best.key !== currentKey &&
    bestO < currentO * stickiness
  ) {
    return S111_MODELS.find((m) => m.key === currentKey) ?? best
  }
  return best
}
