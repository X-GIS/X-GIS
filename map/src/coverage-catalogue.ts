// ═══ A `coverage` source's URL may name a CATALOGUE of cells, not just one cell (#1453) ═══
//
// `type: raster` has always taken a URL and let the ENGINE decide, from the viewport, what to
// fetch. `type: coverage` did not: it read one cell at attach and never looked at the camera
// again, so everything viewport-shaped had to live in app code — the S-111 demo carried 860
// lines of it (bbox overlap, relevance ordering, a byte budget, an LRU, a concurrency cap),
// and S-102, which never got that machinery, hard-coded one cell and drew nothing elsewhere.
//
// WHY NOT A `{z}/{x}/{y}`-STYLE PLACEHOLDER. A tile key is COMPUTABLE from the viewport; an
// S-100 cell key is not. `cbofs`, `102US004MD1AF262297` — nothing about a bounding box
// produces those. A placeholder could only be filled from a `bbox → id` table, so the real
// question was never "put a schema in the link" but WHERE THAT TABLE LIVES. Inline in the
// style file does not scale past a demo; inside the engine puts NOAA domain knowledge in a
// content-blind layer and generalises to nothing.
//
// So it lives in the DATA, as the standard that already describes exactly this: a STAC
// (SpatioTemporal Asset Catalog) ItemCollection — a GeoJSON FeatureCollection whose features
// carry `bbox`, `datetime` and an `assets` map of hrefs. Inventing a house `catalog.json`
// instead would be `.xgcov` one level up: a bespoke container nothing else can write or read,
// against ADR-0010 and CLAUDE.md §12.
//
// This module is the PURE half — parse and select, no network, no arming. The driving lives in
// coverage-source.ts, the same split coverage-refresh.ts (policy) / coverage-source.ts
// (drives it) already uses.
//
// The cell-vs-catalogue discriminator itself is `isHdf5` in @xgis/data, tested against the
// same signature constant the HDF5 reader parses with — one authority for "is this HDF5",
// not a copy of the magic number over here.

import type { Bbox } from '@xgis/data'
import { xlog } from '@xgis/shared'

/** One cell a catalogue offers: the region key it arms under, where it is, and its URL. */
export interface CoverageCatalogueItem {
  /** STAC `id` — used verbatim as the region key, so `removeCoverageRegion(src, id)` and
   *  `getCoverage` keep addressing exactly what the catalogue named. */
  readonly id: string
  /** `[west, south, east, north]` in degrees. */
  readonly bbox: Bbox
  /** Absolute (or root-relative) cell URL, resolved against the catalogue's own URL. */
  readonly href: string
}

/** Resolve a catalogue-relative `href` against the catalogue's own URL. Mirrors the
 *  source-manager's rule so a catalogue and a declared source read a URL the same way:
 *  absolute and root-relative hrefs pass through, anything else hangs off the catalogue's
 *  directory. */
function resolveHref(href: string, catalogueUrl: string): string {
  if (href.startsWith('http') || href.startsWith('/')) return href
  const dir = catalogueUrl.slice(0, catalogueUrl.lastIndexOf('/') + 1)
  return dir + href
}

/** The asset holding the cell. STAC's convention is a `data` ROLE, but plenty of published
 *  catalogues only key it `data` — and a single-asset item means what it says. Tried in that
 *  order so a conforming catalogue and a minimal one both work. */
function dataHref(assets: Record<string, { href?: unknown; roles?: unknown }>): string | null {
  const entries = Object.entries(assets)
  const byRole = entries.find(([, a]) => Array.isArray(a?.roles) && a.roles.includes('data'))
  const byKey = entries.find(([k]) => k === 'data')
  const only = entries.length === 1 ? entries[0] : undefined
  const href = (byRole ?? byKey ?? only)?.[1]?.href
  return typeof href === 'string' && href.length > 0 ? href : null
}

/** STAC allows a 6-number 3D bbox (`[W, S, minZ, E, N, maxZ]`) beside the 4-number 2D one.
 *  Both reduce to the horizontal envelope, which is all a viewport intersection can use. */
function horizontalBbox(raw: unknown): Bbox | null {
  if (!Array.isArray(raw)) return null
  const n = raw.length === 6 ? [raw[0], raw[1], raw[3], raw[4]] : raw.length === 4 ? raw : null
  if (!n || !n.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  const [w, s, e, north] = n as number[]
  // A degenerate or inverted envelope can never intersect a viewport usefully, and letting it
  // through would put an item in every wanted set with an overlap of zero.
  if (!(w! < e!) || !(s! < north!)) return null
  return [w!, s!, e!, north!] as Bbox
}

/** Read a STAC ItemCollection into the cells it offers.
 *
 *  Throws when the document is not an ItemCollection at all — that is a misconfigured source,
 *  and a coverage that silently draws nothing is the exact failure mode §12 warns about. An
 *  individual malformed ITEM is skipped with a warning instead: one bad entry in a published
 *  catalogue must not cost the user every other cell in it.
 *
 *  `label` names the source in those messages; `catalogueUrl` resolves relative hrefs. */
export function parseCoverageCatalogue(
  doc: unknown,
  catalogueUrl: string,
  label: string,
): CoverageCatalogueItem[] {
  const features = (doc as { features?: unknown })?.features
  if (!Array.isArray(features)) {
    throw new Error(
      `[X-GIS] ${label} — the URL is not an S-100 cell (no HDF5 signature) and not a STAC ` +
        `ItemCollection either (no \`features\` array). A coverage \`url:\` must be one or ` +
        `the other.`,
    )
  }
  const items: CoverageCatalogueItem[] = []
  const seen = new Set<string>()
  for (const f of features as { id?: unknown; bbox?: unknown; assets?: unknown }[]) {
    const id = typeof f?.id === 'string' ? f.id : typeof f?.id === 'number' ? String(f.id) : null
    const bbox = horizontalBbox(f?.bbox)
    const assets = (f?.assets ?? {}) as Record<string, { href?: unknown; roles?: unknown }>
    const href = typeof assets === 'object' && assets !== null ? dataHref(assets) : null
    if (!id || !bbox || !href) {
      xlog.warn(`[X-GIS] ${label} — skipping a catalogue item with no usable id/bbox/asset href`)
      continue
    }
    // A duplicate id would arm two different cells under ONE region key, so the second silently
    // replaces the first — the multi-region collapse #1272 E-④ was about, one level up.
    if (seen.has(id)) {
      xlog.warn(`[X-GIS] ${label} — skipping a duplicate catalogue item id "${id}"`)
      continue
    }
    seen.add(id)
    items.push({ id, bbox, href: resolveHref(href, catalogueUrl) })
  }
  return items
}

/** One catalogue-backed source's live residency state. Held beside `rawDatasets` (not inside
 *  its `_coverage` marker) so the marker stays exactly what it says it is — the resident
 *  regions — and this stays what the DRIVER needs to decide the next set. */
export interface CoverageCatalogueState {
  /** The catalogue document's own URL, kept for a later re-read of a rolling catalogue. */
  readonly url: string
  readonly items: readonly CoverageCatalogueItem[]
  /** What the latest resolve decided should be resident, most-relevant first. */
  wanted: string[]
  /** Regions the GPU budget evicted while they were still WANTED. The budget is full, so
   *  re-arming them now would evict a neighbour and re-enter on the next move — a thrash
   *  across move-ends that draws nothing new. Cleared when the wanted SET actually changes,
   *  which is the only event that can make room. */
  readonly suppressed: Set<string>
  /** Regions with a read in flight, so a second resolve mid-fetch cannot double-request one. */
  readonly inFlight: Set<string>
}

/** The camera's `[[W,S],[E,N]]` bounds as the `[W,S,E,N]` envelope a resolve intersects with,
 *  or null when the camera cannot answer yet (pre-first-frame) — a non-finite bound would
 *  overlap every item's bbox by NaN and want the whole catalogue. */
export function viewBbox(bounds: [[number, number], [number, number]]): Bbox | null {
  const [[w, s], [e, n]] = bounds
  if (![w, s, e, n].every(Number.isFinite)) return null
  return [w, s, e, n]
}

/** Overlap AREA (deg²) of two `[W,S,E,N]` boxes; 0 when disjoint. */
function overlapArea(a: Bbox, b: Bbox): number {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  return w * h
}

const area = (b: Bbox): number => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])

/** Every item whose bbox overlaps `view`, MOST RELEVANT FIRST — most overlap, ties broken
 *  toward the SMALLER bbox.
 *
 *  The tie-break is the load-bearing half, not a nicety: a bay-sized viewport sits ENTIRELY
 *  inside both its local cell and the basin-wide one (San Francisco Bay is inside sfbofs *and*
 *  wcofs), so both overlaps equal the whole view and raw area cannot separate them. Preferring
 *  the smaller bbox picks the higher-resolution local cell.
 *
 *  This is `modelsForBounds`' rule, kept verbatim from the demo it is replacing — only its home
 *  changes, and it is content-blind now: item bboxes, not a NOAA model registry.
 *
 *  No hysteresis, deliberately. The demo needed it because a boundary-adjacent zoom flipped
 *  WHICH SINGLE cell was resident, wiping the other; the resident SET does not churn on such a
 *  zoom (both neighbours are simply loaded), and the forecast axis reads the first-armed region,
 *  which a re-resolve does not reorder. */
export function itemsForView(
  items: readonly CoverageCatalogueItem[],
  view: Bbox,
): CoverageCatalogueItem[] {
  return items
    .map((it) => ({ it, o: overlapArea(view, it.bbox) }))
    .filter((x) => x.o > 0)
    .sort((x, y) => y.o - x.o || area(x.it.bbox) - area(y.it.bbox))
    .map((x) => x.it)
}
