// Conforming red-green triangle subdivision + outline densification for
// non-Mercator projections (INC-0 of the non-Mercator direct-reprojection
// design, docs/architecture/design/nonmerc-vector-direct-reprojection.md).
//
// Extracted verbatim from ./vector-tiler (pure code motion, mesh output
// byte-identical): the cluster is self-contained — it depends only on the
// leaf constants DSFUN_EARTH_R / DSFUN_DEG2RAD and imports nothing from
// vector-tiler, keeping the module graph cycle-free. vector-tiler re-imports
// `vertexKey`, `subdivideTriangleMM`, and `subdivideChainMM` from here.
import { DSFUN_EARTH_R, DSFUN_DEG2RAD } from './ecef-packing'

/** Vertex dedup key: quantize x/y to 1e6 (~0.1m) and pack into a
 *  single 53-bit-safe number combined with featureId.
 *
 *  Layout (all integer arithmetic, no string allocation):
 *    qx = (x * 1e6) | 0  → 32-bit signed; offset to non-negative via +2^31
 *    qy = (y * 1e6) | 0  → same
 *    key = (qx + 2^31) * 2^22 + (qy + 2^31 & 0x3FFFFF) ⊕ (fid * 0x9e3779b1)
 *
 *  Strict uniqueness for the (qx, qy, fid) triple isn't guaranteed by
 *  this packing — qy uses only 22 bits, dropping the high bits of any
 *  vertex more than ±2.1m × 2^22 / 1e6 ≈ ±2 billion meters from the
 *  origin (well outside the ±20M MM range used by Web Mercator), so
 *  collisions are mathematically impossible inside the planet.
 *  featureId is folded in via XOR with a 32-bit prime so distinct
 *  features at the same (qx, qy) hash to different cells.
 *
 *  Performance: previously a `${qx},${qy},${fid}` template literal
 *  allocated a new string per vertex (top-3 GC source in PMTiles v4
 *  perf profile). Numeric Map keys avoid both the allocation and the
 *  V8 internal string hash. */
export function vertexKey(x: number, y: number, fid: number): string {
  // Pre-MM refactor this was a packed int32 over (x*1e6, y*1e6, fid) —
  // valid when input was LL degrees (±180 → ±1.8e8 fits int32). After
  // the polygon pipeline moved to absolute Mercator meters, x/y range
  // ±2.0e7 m so x*1e6 ≈ ±2e13 OVERFLOWS int32 catastrophically — the
  // `| 0` truncation produced essentially random bits and adjacent
  // vertices collided into shared dedup slots. earcut then received
  // self-intersecting/degenerate index lists and emitted huge wedge
  // triangles spanning entire ocean tiles (visible as triangular
  // artifacts in pmtiles_layered at z=3-5).
  //
  // String key with 1mm quantization (Math.round(coord * 1000)) is
  // unambiguous, collision-free, and only ~2x slower than the broken
  // numeric hash on V8 (Map<string,number> internalises short ASCII
  // strings). Tessellation runs off-thread on the worker pool, so the
  // perf delta is invisible at the frame level.
  return `${Math.round(x * 1000)},${Math.round(y * 1000)},${fid | 0}`
}

// ── Triangle subdivision for non-Mercator projections ─────────────────
// earcut produces triangles whose edges are straight lines in MM. When the
// runtime renders under a non-Mercator projection (orthographic, oblique,
// etc.), the GPU rasterizer linearly interpolates triangle interiors in
// SCREEN space, so a triangle whose vertices span large angular distance
// renders as a screen-space-straight chord instead of curving along the
// surface. The visible artifacts are wedges, antimeridian shortcuts, and
// horizontal stripes at the Mercator clamp.
//
// Densifying the mesh — splitting any triangle whose edge exceeds
// MAX_TRI_DEGREES_FOR_PROJ in lon/lat angular distance into 4 sub-triangles
// at MM midpoints — reduces each chord to a smaller angular span, so the
// per-triangle screen-space approximation tracks the surface closely.
//
// Mirrors the legacy logic in runtime/src/loader/geojson.ts that was lost
// when GeoJSON polygon rendering moved to the tile-based pipeline. Linear
// MM midpoints (not great-circle slerp) are sufficient for the visible
// wedge artifact and stay consistent with the MM-throughout pipeline; a
// future quality pass could swap in geodesic midpoints for high-latitude
// polygons spanning >10° if needed.
const MAX_TRI_DEGREES_FOR_PROJ = 2
const MAX_TRI_SUBDIVIDE_DEPTH = 5

// ─── #2435 — the gate is ABSOLUTE, and the screen scale is not ───────────────
//
// MAX_TRI_DEGREES_FOR_PROJ bounds an edge's ANGULAR span, but the screen size of
// that span grows with the tile level: a chord of angle T at native zoom deviates
// from its arc by `(TILE_PX*2^z/2pi)*(1-cos(T/2))` px, which DOUBLES per level
// while the gate holds T fixed. Where a tile edge falls under the gate it stops
// being split at all, and a finer neighbour then puts a vertex in the middle of
// that unsplit edge — a hanging node whose gap is the edge's own sagitta.
//
// So the gate takes a per-tile-level FLOOR: bounding the native-zoom sagitta at
// MAX_CHORD_SAGITTA_PX gives `theta <= sqrt(T_px*pi/32) * 2^(-z/2)`, and the
// MINIMUM with the absolute gate means no level refined today becomes coarser
// (z3 is depth-capped at 5 splits and the per-level angle there is LOOSER than
// the cap already delivers — applying it as a replacement rather than a floor
// would regress z3 from 0.049 px to 0.196 px).
//
// T_px = 0.25 is MEASURED, not derived, and two earlier derivations picked wrong.
// The quantity that closes #2435 is the CRACK — the coarser side's segment sagitta
// read at the FINER level's camera, i.e. twice that level's own chord error — and
// sizing on the chord instead picks a value that misses the target. Driving the
// real subdivision on a tile at ~lat 46 (NOT the equatorial closed form: a tile's
// vertical edge spans far less latitude than longitude there, and the gate marks on
// `max(|dlon|,|dlat|)`), worst crack across z0..z12 against realised triangle count
// on a coastline-shaped tile-filling ring:
//
//   T_px    worst crack (native)   realised cost      levels touched
//   absolute 2 deg  0.74 px        1.00x              —
//   0.5             0.39 px        2.09x @ z7         z6..z9
//   0.25            0.211 px       4.09x @ z7         z5..z9     <- here
//   0.125           0.176 px       5.66x @ z7         z4..z9
//
// 0.25 is the CHEAPEST value meeting #2435's closing criterion (~0.25 px at native
// zoom). Below it the curve flattens — z9..z12 are immovable for every T because
// their tile edges are already under the gate — so 0.125 buys 0.035 px for another
// 1.6x. The 4x here is measured on real geometry; the "4^extra-splits" bound is a
// fully-marked triangle and overstates it, because clipped polygon rings already
// carry short edges the gate never marks.
//
// What this does NOT do: close every LOD boundary. Conformance needs the parent and
// child split counts to differ by exactly one on their shared edge, which no
// per-level angular rule guarantees everywhere — tightening T RELOCATES the worst
// boundary rather than removing it (measured: z7 1.483 -> 0, z6 0 -> 0.774 at
// T=0.5). The claim is a bounded worst case, not a conforming mesh across LODs.
//
// It also does not make the gate impure per edge: every edge inside one tile is
// judged at that tile's z, so two triangles sharing an edge still always agree —
// the invariant `edgeExceedsGateMM` and the red-green closure rest on.
const MAX_CHORD_SAGITTA_PX = 0.25

/** The finest angular gate (radians) applied inside a tile of level `tileZ`: the
 *  absolute rule, tightened to hold the native-zoom chord sagitta under
 *  MAX_CHORD_SAGITTA_PX, and never LOOSER than the absolute rule.
 *
 *  Clamped below at FAST_SKIP_ANGLE_RAD because `edgeExceedsGateMM`'s MM early-out
 *  claims an edge under FAST_SKIP_MM is "definitely below the gate" -- a claim that
 *  silently becomes false if the gate ever drops under it. The clamp costs nothing
 *  (it binds only at z >= 10, whose tile span is already finer than the per-level
 *  angle, so the gate does not bind there at all) and it keeps that early-out's
 *  premise true by construction rather than by coincidence. Pinned by
 *  `subdivision-conformance.test.ts`. */
export function tileGateRad(tileZ: number): number {
  const absolute = MAX_TRI_DEGREES_FOR_PROJ * (Math.PI / 180)
  const perLevel = Math.sqrt((MAX_CHORD_SAGITTA_PX * Math.PI) / 32) * 2 ** (-Math.max(0, tileZ) / 2)
  return Math.max(FAST_SKIP_ANGLE_RAD, Math.min(absolute, perLevel))
}

/** The angular span (radians) of the FINEST edge this subdivision leaves on a
 *  tile of level `tileZ`, at the equator — where a tile is widest and the budget
 *  that consumes this must survive.
 *
 *  A renderer pricing the DIRECT sphere path needs exactly this number: the
 *  screen error of a chord standing in for its arc is `R_px·(1 − cos(θ/2))`, and
 *  θ is what the tiler decided, not what the renderer wishes. It lives here
 *  rather than being re-derived at the call site because both constants below
 *  are module-private and a second copy of the rule would drift the day either
 *  moves (map/src/render/globe-drape-budget.ts is the consumer).
 *
 *  The recursion this mirrors: `edgeExceedsGateMM` marks an edge while its span
 *  exceeds MAX_TRI_DEGREES_FOR_PROJ, every marked edge is bisected at its MM
 *  midpoint, so the span halves per level until it is under the gate or
 *  MAX_TRI_SUBDIVIDE_DEPTH stops it — whichever comes first. A tile already
 *  under the gate is emitted whole, which is why the returned angle STOPS
 *  shrinking around z8 and the direct path's error peaks there (#2435). */
export function tileSegmentAngleRad(tileZ: number): number {
  const span = (2 * Math.PI) / 2 ** Math.max(0, tileZ)
  const gate = tileGateRad(tileZ)
  if (span <= gate) return span
  const splits = Math.min(MAX_TRI_SUBDIVIDE_DEPTH, Math.ceil(Math.log2(span / gate)))
  return span / 2 ** splits
}

function mmToLonLatDeg(x: number, y: number): [number, number] {
  const lon = x / DSFUN_EARTH_R / DSFUN_DEG2RAD
  const lat = (2 * Math.atan(Math.exp(y / DSFUN_EARTH_R)) - Math.PI / 2) / DSFUN_DEG2RAD
  return [lon, lat]
}

// lonLatDegToMM was the inverse of mmToLonLatDeg used by
// geodesicMidpointMM (iter 6, reverted iter 56). Removed with the
// geodesicMidpointMM revert; the slerp / Mercator round-trip
// pattern stays documented in the iter-56 commit body for any
// future projection-aware refinement.

/** Geodesic midpoint of two MM points: project both to lon/lat,
 *  slerp on the sphere at t=0.5, project back to MM. Used when a
 *  triangle's edges span enough latitude/longitude that the linear
 *  MM midpoint diverges visibly from the great-circle midpoint on
 *  globe / orthographic / stereographic projections (z=0..3 country
 *  polygons). For small edges the linear midpoint is already
 *  indistinguishable from slerp; the caller gates via edge span.
 *  Slerp is symmetric in t=0.5 so adjacent triangles sharing an edge
 *  produce identical midpoints — dedupMap keeps the mesh watertight. */
// NOTE: geodesicMidpointMM removed in iter 56 — iter 6 introduction
// caused z=0 banding artefacts on production deploy that iter 41's
// 60°-cap didn't fully fix. Reverted to pre-iter-6 linear-midpoint
// behaviour. Helper definition kept inline for reference if a
// future runtime-projection-aware refinement lands.
/*
function geodesicMidpointMM(x0: number, y0: number, x1: number, y1: number): [number, number] {
  const [lon0, lat0] = mmToLonLatDeg(x0, y0)
  const [lon1, lat1] = mmToLonLatDeg(x1, y1)
  const [mLon, mLat] = slerpLonLat(lon0, lat0, lon1, lat1, 0.5)
  return lonLatDegToMM(mLon, mLat)
}
*/

/** Get-or-add a vertex (MM coords) into the dedup-mapped output array.
 *  Stride-3 layout: x, y, featureId. Returns the global vertex index. */
function getOrAddVertexMM(
  x: number,
  y: number,
  featureId: number,
  outVerts: number[],
  dedupMap: Map<string, number>,
): number {
  const key = vertexKey(x, y, featureId)
  let idx = dedupMap.get(key)
  if (idx === undefined) {
    idx = outVerts.length / 3
    outVerts.push(x, y, featureId)
    dedupMap.set(key, idx)
  }
  return idx
}

// 2° lon → 222 km in MM; lat is denser at high latitudes (lat 85: 1° ≈ 1500 km
// MM) so 50 km MM is a conservative bound that can NEVER exceed 2° in either
// direction (below 0.45° lon at any latitude AND below 0.5° lat at lat<85). An
// edge entirely below this is definitely below the angular gate, so it skips
// both projection and the subdivision decision — the common case at z>=8 (tile
// spans <0.7° at z=8).
const FAST_SKIP_MM = 50_000
/** The angular span FAST_SKIP_MM guarantees an edge is under (0.45 deg of lon at any
 *  latitude; the lat direction is looser still). `tileGateRad` is clamped to this so
 *  the early-out's "definitely below the gate" claim stays true by construction. */
const FAST_SKIP_ANGLE_RAD = 0.45 * (Math.PI / 180)

/** Per-EDGE refine decision: does this MM edge's angular span exceed
 *  MAX_TRI_DEGREES_FOR_PROJ? This is a PURE function of the two endpoints —
 *  symmetric in (a,b) (Math.abs of the deltas) and computed from the SAME
 *  deduped vertex coordinates on either side — so two triangles sharing an
 *  edge ALWAYS agree on whether to split it. That agreement is what makes the
 *  red-green closure in `subdivideTriangleMM` conforming (no hanging nodes).
 *  Mirrors the FAST_SKIP_MM early-out: an edge clearly below the gate returns
 *  false without projecting. */
function edgeExceedsGateMM(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  gateDeg: number,
): boolean {
  if (Math.abs(bx - ax) < FAST_SKIP_MM && Math.abs(by - ay) < FAST_SKIP_MM) return false
  const [lonA, latA] = mmToLonLatDeg(ax, ay)
  const [lonB, latB] = mmToLonLatDeg(bx, by)
  return Math.max(Math.abs(lonB - lonA), Math.abs(latB - latA)) > gateDeg
}

/** Recursively refine a triangle into a CONFORMING densified mesh: no vertex
 *  ever lies strictly interior to a neighbour triangle's edge (no hanging node
 *  / T-junction). INC-0 of the non-Mercator direct-reprojection design
 *  (docs/architecture/design/nonmerc-vector-direct-reprojection.md).
 *
 *  The refine decision is PER-EDGE (`edgeExceedsGateMM`), not per-triangle, so
 *  two triangles sharing an edge always agree on subdividing it. Red-green
 *  closure templates then re-triangulate a triangle whose edges are only
 *  partially marked, WITHOUT introducing a hanging node:
 *    - 3 marked edges → red 4-split (midpoints of all three edges),
 *    - 2 marked edges → 3 triangles (corner at the shared vertex + quad by one
 *      diagonal),
 *    - 1 marked edge  → 2 triangles (bisect the marked edge to the opposite
 *      vertex),
 *    - 0 marked edges → emit as-is.
 *  A marked edge is ALWAYS split exactly at its linear MM midpoint and an
 *  unmarked edge is NEVER split, in every template — so an edge's boundary
 *  treatment depends only on its endpoints, and both owners treat it
 *  identically. Split points are the pre-iter-6 LINEAR MM midpoints (NOT
 *  geodesic slerp — that caused z=0 Mercator banding, reverted iter 56,
 *  see :414), so the union of output triangles is EXACTLY the input triangle:
 *  the rasterized Mercator fill is unchanged (only extra collinear/interior
 *  vertices). Adjacent triangles share midpoints via dedupMap (keyed on
 *  x,y,featureId), keeping the mesh watertight. A shared edge is always reached
 *  at the same recursion depth on both sides, so the MAX_TRI_SUBDIVIDE_DEPTH
 *  cap fires symmetrically and cannot open a crack. */
export function subdivideTriangleMM(
  i0: number,
  i1: number,
  i2: number,
  featureId: number,
  outVerts: number[],
  outIdx: number[],
  dedupMap: Map<string, number>,
  depth: number,
  /** The level of the tile whose geometry this is. Selects the angular gate
   *  (`tileGateRad`) — constant across one tile, so two triangles sharing an edge
   *  still always agree on marking it (#2435). */
  tileZ: number,
): void {
  const x0 = outVerts[i0 * 3],
    y0 = outVerts[i0 * 3 + 1]
  const x1 = outVerts[i1 * 3],
    y1 = outVerts[i1 * 3 + 1]
  const x2 = outVerts[i2 * 3],
    y2 = outVerts[i2 * 3 + 1]

  // Fast MM-space early-out: if all edges are clearly below the angular gate,
  // no edge is marked → emit as-is without projecting. (Same threshold as
  // edgeExceedsGateMM's per-edge early-out, so a shared sub-50 km edge is
  // treated identically whether reached via this whole-triangle skip or the
  // per-edge test on a neighbour that failed the skip — consistency is what
  // keeps the mesh conforming.)
  if (
    Math.abs(x1 - x0) < FAST_SKIP_MM &&
    Math.abs(y1 - y0) < FAST_SKIP_MM &&
    Math.abs(x2 - x1) < FAST_SKIP_MM &&
    Math.abs(y2 - y1) < FAST_SKIP_MM &&
    Math.abs(x0 - x2) < FAST_SKIP_MM &&
    Math.abs(y0 - y2) < FAST_SKIP_MM
  ) {
    outIdx.push(i0, i1, i2)
    return
  }

  if (depth >= MAX_TRI_SUBDIVIDE_DEPTH) {
    outIdx.push(i0, i1, i2)
    return
  }

  const gateDeg = tileGateRad(tileZ) * (180 / Math.PI)
  const marked01 = edgeExceedsGateMM(x0, y0, x1, y1, gateDeg)
  const marked12 = edgeExceedsGateMM(x1, y1, x2, y2, gateDeg)
  const marked20 = edgeExceedsGateMM(x2, y2, x0, y0, gateDeg)
  const nMarked = (marked01 ? 1 : 0) + (marked12 ? 1 : 0) + (marked20 ? 1 : 0)

  if (nMarked === 0) {
    outIdx.push(i0, i1, i2)
    return
  }

  const mid = (ia: number, ib: number): number => {
    const ax = outVerts[ia * 3],
      ay = outVerts[ia * 3 + 1]
    const bx = outVerts[ib * 3],
      by = outVerts[ib * 3 + 1]
    // Commutative (ax+bx===bx+ax in IEEE-754), so mid(ia,ib)===mid(ib,ia) to
    // the bit — both neighbours dedup to the same midpoint index.
    return getOrAddVertexMM((ax + bx) * 0.5, (ay + by) * 0.5, featureId, outVerts, dedupMap)
  }
  const recurse = (a: number, b: number, c: number): void =>
    subdivideTriangleMM(a, b, c, featureId, outVerts, outIdx, dedupMap, depth + 1, tileZ)

  if (nMarked === 3) {
    // Red 4-split.
    const a = mid(i0, i1),
      b = mid(i1, i2),
      c = mid(i2, i0)
    recurse(i0, a, c)
    recurse(a, i1, b)
    recurse(c, b, i2)
    recurse(a, b, c)
    return
  }

  if (nMarked === 1) {
    // Green 1-edge: bisect the marked edge to the opposite vertex (2 triangles).
    if (marked01) {
      const m = mid(i0, i1)
      recurse(i0, m, i2)
      recurse(m, i1, i2)
    } else if (marked12) {
      const m = mid(i1, i2)
      recurse(i1, m, i0)
      recurse(m, i2, i0)
    } else {
      const m = mid(i2, i0)
      recurse(i2, m, i1)
      recurse(m, i0, i1)
    }
    return
  }

  // Green 2-edge: corner triangle at the vertex shared by the two marked edges,
  // plus the remaining quad cut by one diagonal (3 triangles). Winding follows
  // the parent i0→i1→i2 order.
  if (!marked20) {
    // marked e01,e12 share vertex i1; unmarked e20.
    const a = mid(i0, i1),
      b = mid(i1, i2)
    recurse(a, i1, b)
    recurse(i0, a, b)
    recurse(i0, b, i2)
  } else if (!marked01) {
    // marked e12,e20 share vertex i2; unmarked e01.
    const b = mid(i1, i2),
      c = mid(i2, i0)
    recurse(b, i2, c)
    recurse(i1, b, c)
    recurse(i1, c, i0)
  } else {
    // marked e20,e01 share vertex i0; unmarked e12.
    const c = mid(i2, i0),
      a = mid(i0, i1)
    recurse(c, i0, a)
    recurse(i2, c, a)
    recurse(i2, a, i1)
  }
}

/** Densify a polygon-OUTLINE MM chain by inserting linear-MM midpoints on any
 *  segment whose lon/lat angular span exceeds MAX_TRI_DEGREES_FOR_PROJ — the SAME
 *  gate `subdivideTriangleMM` applies to the FILL's triangle edges. The clipped-ring
 *  outline is stroked as straight chords (`augmentChainWithArc` inserts no vertices),
 *  so on globe / non-Mercator projections a long low-zoom edge cuts straight across the
 *  sphere while the densified fill boundary curves (issue #585). Densifying the outline
 *  with the fill's gate makes the stroke follow the same curve as the fill it traces.
 *  Linear midpoints are collinear with the parent segment, so fill/outline coincidence
 *  (the d34aed2 invariant) is preserved. This revives the densification cc497884 added
 *  and #387's parallel outline path silently dropped on merge.
 *
 *  Returns the densified chain; the original endpoints are always preserved in order. */
export function subdivideChainMM(chain: number[][], tileZ: number): number[][] {
  if (chain.length < 2) return chain
  // Reuses the module-level FAST_SKIP_MM (50 km MM, below 0.45° lon / 0.5° lat
  // at any latitude < 85) so a short segment skips the projection entirely —
  // the same early-out the FILL subdivision uses.
  const out: number[][] = [chain[0]]
  // Same per-tile-level gate as the FILL (#2435) — the outline must be densified to
  // the fill's granularity or the two stop coinciding.
  const gateDeg = tileGateRad(tileZ) * (180 / Math.PI)
  const emit = (ax: number, ay: number, bx: number, by: number, depth: number): void => {
    if (
      depth < MAX_TRI_SUBDIVIDE_DEPTH &&
      (Math.abs(bx - ax) >= FAST_SKIP_MM || Math.abs(by - ay) >= FAST_SKIP_MM)
    ) {
      const [lonA, latA] = mmToLonLatDeg(ax, ay)
      const [lonB, latB] = mmToLonLatDeg(bx, by)
      if (Math.max(Math.abs(lonB - lonA), Math.abs(latB - latA)) > gateDeg) {
        const mx = (ax + bx) * 0.5,
          my = (ay + by) * 0.5
        emit(ax, ay, mx, my, depth + 1)
        emit(mx, my, bx, by, depth + 1)
        return
      }
    }
    out.push([bx, by])
  }
  for (let i = 1; i < chain.length; i++) {
    emit(chain[i - 1][0], chain[i - 1][1], chain[i][0], chain[i][1], 0)
  }
  return out
}
