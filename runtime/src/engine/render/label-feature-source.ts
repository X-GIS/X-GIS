// ═══ LabelFeatureSource — CPU label-feature extraction ═══
//
// Extracted from VectorTileRenderer (Cluster F per
// docs/architecture/design/vtr-decomposition.md §4). The three
// forEach* methods walk the tile source's per-frame visible tile set
// and emit label anchors (point / line-segment / full-polyline) for
// the TextStage label path. They touch ZERO GPU state — only the tile
// source's CPU-side tile data + property table — which makes this the
// cleanest seam in the god-object (design §2 Cluster F).
//
// This owner holds the hot-path scratch collections + the across-frame
// line-label run cache + the per-frame FrameArena. VTR keeps thin
// forwarder methods so callers (label-pass.ts) are unchanged; it passes
// `source`, `stableKeys`, and `neededKeys` in as parameters because VTR
// owns those, not this collaborator.

import { bumpAlloc } from '@xgis/map'
import { FrameArena } from '@xgis/engine'
import type { TileCatalog } from '../../data/tile-catalog'

export class LabelFeatureSource {
  // Iter 132 perf: reused dedupe Set for forEachLabelFeature.
  private readonly _labelKeyScratch: Set<number> = new Set()
  /** iter 169 — Phase A slice 3: across-frame line-label run cache.
   *  forEachLineLabelPolyline showed 14% of drag CPU (iter-161
   *  profile) walking segments + dedup-longest-per-featId + Float64
   *  array slicing every frame for the SAME tiles. Tile geometry is
   *  immutable for a given tile-key, so the produced runs
   *  ({xs, ys, props, len} per featId) are camera-independent → cache
   *  them. Key: `${sliceLayer ?? '_'}:${tileKey}`. LRU-capped; stale
   *  entries for tiles no longer in `seen` evict naturally via LRU. */
  private readonly _lineLabelRunsCache = new Map<string, ReadonlyArray<{
    xs: Float64Array; ys: Float64Array; props: Record<string, unknown>
  }>>()
  private static readonly LINE_LABEL_RUNS_CACHE_MAX = 4096
  /** iter-236 (Plan A.2) — Scratch Map for forEachLabelFeature's
   *  per-tile `bestByFeatId`. Pre-iter-236 this was allocated fresh
   *  per tile inside the inner loop; at 270 tiles / frame × 60 fps
   *  that's 16 k Map allocations per second on Bright z=14 Seoul.
   *  Hoisted to a single instance + `.clear()` per tile, mirroring
   *  the `best` Map scratch pattern just below (line ~1382). */
  private readonly _scratchBestByFeatId = new Map<number, { mercX: number; mercY: number; firstIdx: number }>()
  /** iter-236 — Scratch array for the per-tile featId-emission
   *  ordering. Used to replace `[...map.entries()].sort()` (which
   *  allocates a fresh Array per tile). Cleared via `length = 0`. */
  private readonly _scratchOrderedFeatEntries: Array<[number, { mercX: number; mercY: number; firstIdx: number }]> = []
  /** iter-252 (Plan AAA A.2) — Scratch Map for forEachLineLabelFeature's
   *  per-call `best` Map. Pre-iter-252 each function call (per
   *  ShowCommand per frame) allocated fresh. Cleared at function
   *  entry, V8 retains hash buckets. */
  private readonly _scratchBestLineLabel = new Map<number, { a: number; b: number; len2: number }>()
  /** iter-243 (Plan AAA B.2) — per-frame scratch arena for VTR
   *  call-scope typed-array allocations (forEachLineLabelPolyline
   *  xs/ys Float64Array). Lifetime is single-call: views allocated
   *  during one forEachLineLabelPolyline invocation are read +
   *  resliced to permanent storage (tileRuns cache) within the
   *  same call. The next frame's `beginFrame()` resets the
   *  watermark and invalidates the in-flight views — safe because
   *  the function never retains its scratch refs across frames.
   *
   *  Sized 32 KB initial (~4096 polyline vertices at 8B each ×
   *  2 axes); auto-grows on overflow. */
  private readonly _frameArena = new FrameArena(32 * 1024)

  /** Reset the per-frame scratch arena. Called once per frame by VTR's
   *  beginFrame, before any forEachLineLabelPolyline calls. The previous
   *  frame's xs/ys views become invalid here, but callers don't retain
   *  them across frames (they reslice into tileRuns cache which copies
   *  into permanent storage). */
  beginFrame(): void {
    this._frameArena.beginFrame()
  }

  /** Iterate every visible point feature in this tile source's
   *  current frame's stableKeys. Calls `fn` with absolute Mercator
   *  meters + a feature-property bag for each point. Used by the
   *  TextStage label path so per-feature labels (`label-["{.name}"]`
   *  on a vector-tile layer) can resolve text + project anchors
   *  without re-implementing the tile cache iteration here.
   *
   *  No-op for sources without point geometry (polygon-only layers
   *  return zero-length pointVertices arrays). */
  forEachLabel(
    source: TileCatalog,
    stableKeys: Iterable<number>,
    neededKeys: Iterable<number> | undefined,
    sliceLayer: string | undefined,
    fn: (mercX: number, mercY: number, props: Record<string, unknown>) => void,
  ): void {
    const table = source.getPropertyTable()
    const fieldNames = table?.fieldNames ?? []
    const values = table?.values ?? []

    // Walk BOTH neededKeys (camera-visible) AND stableKeys (broader
    // cache) for label features. We previously walked only neededKeys
    // to avoid label density mismatch when zoom-9 ancestors served as
    // fallback for missing zoom-14 tiles — but that exclusion HIDES
    // opposite-world tiles which only become cached after the camera
    // has panned past the antimeridian, while their features still
    // need label emissions on the current side via the caller's
    // projectLonLatCopies wrap. Visible repro (2026-05-13 OFM Bright
    // zoom=0.5/lon=175): tile 1/1/0 (east hemisphere, camera-near)
    // only carries antimeridian-wrap copies of Western-Hemisphere
    // features (Canada/UK/Portugal at mercX=±WORLD_MERC_HALF). With
    // neededKeys-only iteration the wrap copies were the ONLY anchors
    // emitted; the caller's name-dedup then permanently skipped the
    // real centroids living in tile 1/0/0 (camera-far). Drop wrap
    // copies in the emit step below AND broaden the tile set so the
    // real centroids are visited.
    //
    // DEDUP across world copies. Both `neededKeys` and stable copies
    // repeat the same canonical tileKey once per world copy. For
    // LABELS the caller in map.ts handles world-copy enumeration via
    // projectLonLatCopies, so iterating each tile's pointVertices N
    // times here only produces N× duplicate addLabel submissions at
    // the same canonical screen positions. With N=5 (full mercator
    // wrap) and the collision pass's "first place wins" greedy logic,
    // the duplicates create N² overdraw and can leak through the
    // dedup when bbox padding rounds inconsistently across iterations.
    // Visiting each tile ONCE here matches the per-feature iteration
    // count to the rendered label count.
    // Iter 132 perf: inline dedupe (was rawLabelKeys + new Set +
    // spread = 3 allocations per call). Reuse scratch Set, iterate
    // via Set.values() directly without array materialisation.
    const seen = this._labelKeyScratch
    seen.clear()
    if (neededKeys) for (const k of neededKeys) seen.add(k)
    for (const k of stableKeys) seen.add(k)
    for (const key of seen) {
      const tileData = source.getTileData(key, sliceLayer)
      // pointVertices is ECEF DSFUN stride-13:
      // [ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, fid, abs_lon, abs_lat, mx_h, mx_l, my_h, my_l].
      // The label dispatcher consumes absolute Mercator metres — read the
      // precise Mercator DSFUN tail (slots 9-12), NOT the lossy f32
      // abs_lon/abs_lat at 7/8.
      if (!tileData?.pointVertices || tileData.pointVertices.length < 13) continue
      const ptv = tileData.pointVertices
      // Prefer per-tile featureProps (PMTiles MVT path — each tile
      // carries its own properties Map). Fall back to the catalog-
      // level PropertyTable (XGVT path — pre-built shared table
      // indexed by global featId).
      const tileProps = tileData.featureProps
      // PMTiles MVT often carries antimeridian-wrap COPIES of point
      // features as separate vertices with the SAME featId — e.g.,
      // "North Atlantic Ocean" gets 3 points (lng=-40 real centroid +
      // lng=180 + lng=-180 wrap copies) so the polygon renderer can
      // draw it at any visible world copy. For LABELS each feature
      // should emit ONCE at its real centroid — the map.ts projector
      // handles world wrap itself, so emitting the wrap copies here
      // would stack duplicate country names at antimeridian-edge
      // positions.
      //
      // First pass: collect the BEST point per featId (the one whose
      // mercator-X falls strictly inside the world ±WORLD_MERC/2,
      // preferring centres away from the antimeridian seam). Second
      // pass emits in featId-encounter order so callers see a
      // deterministic sequence.
      const WORLD_MERC_HALF = 20037508.342789244  // π × earth_radius
      const ANTIMERIDIAN_TOL = 1.0  // metres; tile-edge wrap copies sit at exactly ±half
      // iter-236 (Plan A.2) — scratch Map reuse; clear per tile.
      // Pre-iter-236 was `new Map()` per tile = 270 alloc / frame
      // on Bright z=14 Seoul + GC pressure proportional.
      const bestByFeatId = this._scratchBestByFeatId
      bestByFeatId.clear()
      for (let i = 0; i < ptv.length; i += 13) {
        const featId = ptv[i + 6] | 0
        // Precise absolute Mercator from the DSFUN tail (slots 9-12). The f32
        // abs_lon/abs_lat at 7/8 lose ~1.35 m at |lon|≈127° (≈5.7 px at z20),
        // splaying the label off its feature; mx_h+mx_l is sub-mm at any zoom.
        const mercX = ptv[i + 9] + ptv[i + 10]
        const mercY = ptv[i + 11] + ptv[i + 12]
        const isInner = Math.abs(Math.abs(mercX) - WORLD_MERC_HALF) > ANTIMERIDIAN_TOL
        const existing = bestByFeatId.get(featId)
        if (!existing) {
          bestByFeatId.set(featId, { mercX, mercY, firstIdx: i })
        } else if (isInner) {
          // Real centroid beats any wrap-edge copy already stored.
          const existingIsInner = Math.abs(Math.abs(existing.mercX) - WORLD_MERC_HALF) > ANTIMERIDIAN_TOL
          if (!existingIsInner) bestByFeatId.set(featId, { mercX, mercY, firstIdx: existing.firstIdx })
        }
      }
      // Emit in featId-first-encounter order for caller determinism.
      // iter-236 (Plan A.2) — scratch array reuse; pre-iter-236 used
      // `[...map.entries()].sort()` which allocates a fresh Array
      // per tile. Clear via length = 0, fill via .push, sort in
      // place. Same final order, zero alloc.
      const ordered = this._scratchOrderedFeatEntries
      ordered.length = 0
      for (const entry of bestByFeatId) ordered.push(entry)
      ordered.sort((a, b) => a[1].firstIdx - b[1].firstIdx)
      for (const [featId, pt] of ordered) {
        // SKIP antimeridian-edge anchors. When a tile only contains
        // wrap copies of a feature (e.g., the East-Hemisphere tile
        // 1/1/0 carries Canada's wrap copy at mercX=+WORLD_MERC_HALF
        // so its polygon can render at the world's right edge), the
        // bestByFeatId selection above falls back to the wrap copy
        // because no inner alternative exists in THIS tile. Emitting
        // those copies as label anchors makes the caller's cross-tile
        // name-dedup (map.ts:3089 emittedPointNames) latch on to the
        // first one it sees — typically the camera-near tile's wrap
        // copy — and PERMANENTLY skip the real centroid living in the
        // opposite-world tile. Visible symptom (2026-05-13 OFM Bright
        // at zoom=0.5/lon=175): Canada, UK, Portugal, Mexico, Brazil
        // etc. all stack at the antimeridian column on screen.
        //
        // The caller (map.ts) handles world-copy projection through
        // `projectLonLatCopies` starting from the real centroid, so
        // wrap copies as label anchors are pure noise. Drop them.
        const atAntimeridian = Math.abs(Math.abs(pt.mercX) - WORLD_MERC_HALF) <= ANTIMERIDIAN_TOL
        if (atAntimeridian) continue

        let props: Record<string, unknown>
        if (tileProps) {
          props = tileProps.get(featId) ?? {}
        } else {
          const row = values[featId] as readonly (number | string | boolean | null)[] | undefined
          props = {}
          if (row) {
            for (let f = 0; f < fieldNames.length; f++) props[fieldNames[f]!] = row[f]
          }
        }
        fn(pt.mercX, pt.mercY, props)
      }
    }
  }

  /** Walk per-tile line geometry and emit one label anchor per UNIQUE
   *  feature (keyed by the stride-10 lineVertices' featId at index 4).
   *  Used when LabelDef.placement === 'line' so road / waterway names
   *  appear along their geometry instead of at a polygon-style centroid.
   *
   *  Callback receives BOTH segment endpoints in absolute mercator
   *  metres so the caller can project them through the active camera
   *  and compute a screen-space rotation angle (mercator-space angle
   *  diverges from screen-space at non-zero pitch or rotated bearing).
   *
   *  Per-feature segment selection: picks the LONGEST mercator
   *  segment within the tile rather than the first one encountered.
   *  First-segment was visibly broken on curved/multi-segment roads —
   *  the picked segment was usually a tiny clip-corner fragment whose
   *  tangent didn't match the road's overall direction, producing
   *  labels rotated arbitrarily and stuck at the tile boundary. The
   *  longest segment is the natural "main run" of the road inside
   *  the tile: representative tangent, midpoint sits along the
   *  visible road body. Mapbox's full anchor-on-curve placement
   *  remains a follow-up; this is a 90% solution for one-label-per-
   *  road maps. */
  forEachLineLabel(
    source: TileCatalog,
    stableKeys: Iterable<number>,
    neededKeys: Iterable<number> | undefined,
    sliceLayer: string | undefined,
    fn: (
      p1MercX: number, p1MercY: number,
      p2MercX: number, p2MercY: number,
      props: Record<string, unknown>,
    ) => void,
  ): void {
    const table = source.getPropertyTable()
    const fieldNames = table?.fieldNames ?? []
    const values = table?.values ?? []
    const DEG2RAD = Math.PI / 180
    const R = 6378137
    const LAT_LIMIT = 85.051129
    const clampLat = (v: number): number => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, v))
    const STRIDE = 10  // [mx_h, my_h, mx_l, my_l, feat_id, arc, tin_x, tin_y, tout_x, tout_y]

    // Same visible-only walk as forEachLabelFeature. Iter 133 perf:
    // reuse _labelKeyScratch Set for dedup.
    const seen = this._labelKeyScratch
    seen.clear()
    if (neededKeys) for (const k of neededKeys) seen.add(k)
    for (const k of stableKeys) seen.add(k)
    // Reusable across tiles to avoid per-tile Map allocation churn.
    // Holds the longest segment seen so far for each featId in the
    // CURRENT tile's iteration; cleared at tile boundary.
    // iter-252 — scratch reuse; clear at function entry.
    bumpAlloc('vtr.forEachLineLabelFeature.best.Map')
    const best = this._scratchBestLineLabel
    best.clear()
    for (const key of seen) {
      const tileData = source.getTileData(key, sliceLayer)
      if (!tileData?.lineVertices || !tileData?.lineIndices) continue
      const lv = tileData.lineVertices
      const li = tileData.lineIndices
      if (lv.length < STRIDE * 2 || li.length < 2) continue
      const tileMercX = tileData.tileWest * DEG2RAD * R
      const tileMercY = Math.log(Math.tan(Math.PI / 4 + clampLat(tileData.tileSouth) * DEG2RAD / 2)) * R
      const tileProps = tileData.featureProps
      best.clear()
      for (let i = 0; i < li.length; i += 2) {
        const a = li[i]! * STRIDE
        const b = li[i + 1]! * STRIDE
        const featId = lv[a + 4]! | 0
        // Defensive: a degenerate segment with mismatched featIds
        // would produce a label spanning two roads. Skip rather than
        // emit garbage.
        if ((lv[b + 4]! | 0) !== featId) continue
        // Squared mercator length is fine for max-comparison and
        // avoids a sqrt per segment.
        const dx = (lv[b]! + lv[b + 2]!) - (lv[a]! + lv[a + 2]!)
        const dy = (lv[b + 1]! + lv[b + 3]!) - (lv[a + 1]! + lv[a + 3]!)
        const len2 = dx * dx + dy * dy
        const cur = best.get(featId)
        if (cur === undefined || len2 > cur.len2) {
          best.set(featId, { a, b, len2 })
        }
      }
      for (const [featId, { a, b }] of best) {
        // DSFUN tile-local high+low → tile-local mercator → absolute.
        const ax = tileMercX + lv[a]! + lv[a + 2]!
        const ay = tileMercY + lv[a + 1]! + lv[a + 3]!
        const bx = tileMercX + lv[b]! + lv[b + 2]!
        const by = tileMercY + lv[b + 1]! + lv[b + 3]!
        let props: Record<string, unknown>
        if (tileProps) {
          props = tileProps.get(featId) ?? {}
        } else {
          const row = values[featId] as readonly (number | string | boolean | null)[] | undefined
          props = {}
          if (row) {
            for (let f = 0; f < fieldNames.length; f++) props[fieldNames[f]!] = row[f]
          }
        }
        fn(ax, ay, bx, by, props)
      }
    }
  }

  /** Iterate visible line-feature polylines (Mapbox `symbol-placement:
   *  line` with `symbol-spacing`). Unlike `forEachLineLabelFeature`
   *  which collapses each feature to its longest segment, this method
   *  yields the FULL polyline so the caller can walk it in screen
   *  space and place a label every `spacing` pixels.
   *
   *  Polylines are grouped by featId AND segment-chain continuity:
   *  `tessellateLineToArrays` writes consecutive segments
   *  `(0,1),(1,2),(2,3),…` so we detect chain breaks via index
   *  discontinuity. A MultiLineString feature produces multiple
   *  polyline calls (one per part).
   *
   *  Coordinates are absolute mercator metres — the caller projects
   *  to screen and decides spacing in pixels. */
  forEachLineLabelPolyline(
    source: TileCatalog,
    stableKeys: Iterable<number>,
    neededKeys: Iterable<number> | undefined,
    sliceLayer: string | undefined,
    fn: (
      polylineMercX: Float64Array,
      polylineMercY: Float64Array,
      props: Record<string, unknown>,
    ) => void,
  ): void {
    const table = source.getPropertyTable()
    const fieldNames = table?.fieldNames ?? []
    const values = table?.values ?? []
    const DEG2RAD = Math.PI / 180
    const R = 6378137
    const LAT_LIMIT = 85.051129
    const clampLat = (v: number): number => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, v))
    const STRIDE = 10

    // Same dedup rationale as forEachLabelFeature — iter 132/133 perf:
    // reuse _labelKeyScratch Set instead of `[...new Set(rawLabelKeys)]`
    // array+Set allocation per call.
    const seen = this._labelKeyScratch
    seen.clear()
    if (neededKeys) for (const k of neededKeys) seen.add(k)
    for (const k of stableKeys) seen.add(k)
    // Reusable buffers grown as needed — most polylines fit in 32 verts.
    // iter-243 (Plan AAA B.2) — xs/ys scratch from FrameArena
    // instead of `new Float64Array(64)`. Lifetime = single call;
    // resliced to permanent storage inside flushRun before this
    // function returns. iter-240 profile pinned init at 1820 / 3 s
    // + grow at 1 / 3 s; both eliminated.
    bumpAlloc('vtr.forEachLineLabelPolyline.xsys.FrameArena.init')
    let xs = this._frameArena.allocF64(64)
    let ys = this._frameArena.allocF64(64)
    for (const key of seen) {
      // iter-169 cache check FIRST — skip the getTileData lookup +
      // walk + dedup work entirely for tiles whose runs are cached.
      const cacheKey = `${sliceLayer ?? '_'}:${key}`
      const cachedRuns = this._lineLabelRunsCache.get(cacheKey)
      if (cachedRuns !== undefined) {
        // LRU touch.
        this._lineLabelRunsCache.delete(cacheKey)
        this._lineLabelRunsCache.set(cacheKey, cachedRuns)
        for (const run of cachedRuns) fn(run.xs, run.ys, run.props)
        continue
      }
      const tileData = source.getTileData(key, sliceLayer)
      if (!tileData?.lineVertices || !tileData?.lineIndices) continue
      const lv = tileData.lineVertices
      const li = tileData.lineIndices
      if (lv.length < STRIDE * 2 || li.length < 2) continue
      const tileMercX = tileData.tileWest * DEG2RAD * R
      const tileMercY = Math.log(Math.tan(Math.PI / 4 + clampLat(tileData.tileSouth) * DEG2RAD / 2)) * R
      const tileProps = tileData.featureProps

      // Walk segments, accumulate runs that form a contiguous polyline
      // (same feat_id AND segment[i].endIdx === segment[i+1].startIdx).
      // Emit each run as one polyline call.
      //
      // PER-TILE dedupe by featId: a road feature often breaks into
      // multiple disjoint polyline runs inside a single tile (its
      // geometry sliced by tile clip + non-monotone segment ordering),
      // and emitting a label run for each one stacks the same road
      // name 3-5× on top of itself at high zoom. We collect ALL runs
      // for each featId in this tile, keep the LONGEST one (most
      // representative of the road's true direction + the run least
      // likely to be a corner clip artifact), and emit only that.
      // Cross-tile dedupe is a separate concern handled in map.ts via
      // featId-Set tracking — featIds are tile-local in PMTiles MVT.
      type RunEntry = { xs: Float64Array; ys: Float64Array; len: number; props: Record<string, unknown> }
      bumpAlloc('vtr.forEachLineLabelPolyline.tileRuns.Map')
      const tileRuns = new Map<number, RunEntry>()
      let runFeatId = -1
      let runEndIdx = -1
      let runLen = 0  // number of vertices in xs/ys
      let runProps: Record<string, unknown> | null = null
      const flushRun = () => {
        if (runProps !== null && runLen >= 2) {
          let total = 0
          for (let j = 0; j < runLen - 1; j++) {
            const dxR = xs[j + 1]! - xs[j]!
            const dyR = ys[j + 1]! - ys[j]!
            total += Math.sqrt(dxR * dxR + dyR * dyR)
          }
          const existing = tileRuns.get(runFeatId)
          if (!existing || existing.len < total) {
            tileRuns.set(runFeatId, {
              xs: xs.slice(0, runLen),
              ys: ys.slice(0, runLen),
              len: total,
              props: runProps,
            })
          }
        }
        runLen = 0
        runProps = null
        runEndIdx = -1
      }
      const lookupProps = (featId: number): Record<string, unknown> => {
        if (tileProps) return tileProps.get(featId) ?? {}
        const row = values[featId] as readonly (number | string | boolean | null)[] | undefined
        const props: Record<string, unknown> = {}
        if (row) {
          for (let f = 0; f < fieldNames.length; f++) props[fieldNames[f]!] = row[f]
        }
        return props
      }
      const ensureCap = (need: number) => {
        if (need <= xs.length) return
        let cap = xs.length
        while (cap < need) cap *= 2
        // iter-243 — grow via arena instead of `new Float64Array`.
        // Previous allocations stay in the arena until next frame
        // (~watermark advance, ~half-wasted memory per grow chain);
        // acceptable for a per-call scratch that resets on
        // beginFrame.
        bumpAlloc('vtr.forEachLineLabelPolyline.xsys.FrameArena.grow')
        const nx = this._frameArena.allocF64(cap)
        const ny = this._frameArena.allocF64(cap)
        nx.set(xs); ny.set(ys)
        xs = nx; ys = ny
      }

      for (let i = 0; i < li.length; i += 2) {
        const aIdx = li[i]!
        const bIdx = li[i + 1]!
        const a = aIdx * STRIDE
        const b = bIdx * STRIDE
        const featId = lv[a + 4]! | 0
        if ((lv[b + 4]! | 0) !== featId) continue

        const startsNewRun = featId !== runFeatId || aIdx !== runEndIdx
        if (startsNewRun) {
          flushRun()
          runFeatId = featId
          runProps = lookupProps(featId)
          ensureCap(2)
          xs[0] = tileMercX + lv[a]! + lv[a + 2]!
          ys[0] = tileMercY + lv[a + 1]! + lv[a + 3]!
          xs[1] = tileMercX + lv[b]! + lv[b + 2]!
          ys[1] = tileMercY + lv[b + 1]! + lv[b + 3]!
          runLen = 2
        } else {
          ensureCap(runLen + 1)
          xs[runLen] = tileMercX + lv[b]! + lv[b + 2]!
          ys[runLen] = tileMercY + lv[b + 1]! + lv[b + 3]!
          runLen += 1
        }
        runEndIdx = bIdx
      }
      flushRun()
      // Emit the best (longest) run per featId for this tile.
      // iter-169: snapshot runs into an array so subsequent frames
      // skip the walk entirely. tileRuns Map is local to this
      // iteration; the array holds the runs (xs/ys are already
      // independent Float64Array slices made by flushRun).
      const runsArr: Array<{ xs: Float64Array; ys: Float64Array; props: Record<string, unknown> }> = []
      for (const run of tileRuns.values()) {
        runsArr.push({ xs: run.xs, ys: run.ys, props: run.props })
        fn(run.xs, run.ys, run.props)
      }
      // LRU cap.
      if (this._lineLabelRunsCache.size >= LabelFeatureSource.LINE_LABEL_RUNS_CACHE_MAX) {
        const oldest = this._lineLabelRunsCache.keys().next().value
        if (oldest !== undefined) this._lineLabelRunsCache.delete(oldest)
      }
      this._lineLabelRunsCache.set(cacheKey, runsArr)
    }
  }
}
