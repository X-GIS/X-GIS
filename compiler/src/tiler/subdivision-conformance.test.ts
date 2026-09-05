// Conformance gate for `subdivideTriangleMM` (INC-0 of the non-Mercator
// direct-reprojection initiative, docs/architecture/design/nonmerc-vector-direct-reprojection.md).
//
// The subdivision authority must emit a CONFORMING mesh: no vertex may lie
// strictly interior to another triangle's edge (a "hanging node" / T-junction).
// The pre-INC-0 code decided refine/stop PER-TRIANGLE on maxEdge then did a
// uniform 3-midpoint 4-split, so two triangles sharing a SHORT edge disagreed
// on subdividing it whenever only one of them had another long edge — the
// midpoint became a hanging node on the shared edge. Invisible on Mercator
// (linear midpoint collinear with the chord) but on direct sphere reprojection
// the midpoint bows off the chord (sagitta) and a crack opens.
//
// This suite pins:
//   1. HANGING NODES === 0 on a jagged witness strip (fails hard on the
//      pre-change per-triangle code — the 458-node witness from the CPU probe).
//   2. Mercator-identity: the subdivided mesh tiles the polygon with EXACTLY
//      the shoelace area of the input rings (no gap, no overlap, no spillage) —
//      so the rasterized Mercator fill is unchanged. Every added vertex also
//      stays within the original triangulation's coverage.
//   3. A triangle-count report (console) for the 70x40 / 100x40 probe rectangles.

import { describe, it, expect } from 'vitest'
import earcut from 'earcut'
import { tessellatePolygonToArrays, lonLatToMercF64 } from './vector-tiler'
import { subdivideTriangleMM, vertexKey, tileSegmentAngleRad } from './subdivide-conforming'

const FEATURE_ID = 1

/** Convert a lon/lat ring to a Mercator-meter ring (the input shape
 *  tessellatePolygonToArrays expects). */
function ringToMM(lonLat: number[][]): number[][] {
  return lonLat.map(([lon, lat]) => lonLatToMercF64(lon, lat))
}

/** Jagged strip witness: one long top edge (spans `lonW` degrees -> marked)
 *  over a fine sub-2-degree sawtooth bottom (`nTeeth` teeth). earcut fans the
 *  strip into tall triangles that share SHORT interior edges; on the
 *  per-triangle code a tall triangle refines (its long edge > 2 deg) and drops
 *  a midpoint on a short shared edge whose neighbour does not refine -> hanging
 *  node. Mirrors the CPU probe's 458-node strip. */
function jaggedStripRingLonLat(
  nTeeth: number,
  lonW: number,
  latBase: number,
  toothH: number,
  topLat: number,
): number[][] {
  const pts: number[][] = []
  const nBottom = nTeeth * 2
  const x0 = -lonW / 2
  // Bottom sawtooth, left -> right. Each half-tooth is lonW/nBottom deg wide
  // (< 2 deg) so bottom edges are NEVER marked.
  for (let i = 0; i <= nBottom; i++) {
    const lon = x0 + (lonW * i) / nBottom
    const lat = latBase + (i % 2 === 1 ? toothH : 0)
    pts.push([lon, lat])
  }
  // Right side up, top edge (one long segment right -> left), left side down.
  pts.push([x0 + lonW, topLat])
  pts.push([x0, topLat])
  return pts
}

/** Axis-aligned lon/lat rectangle ring (CCW). */
function rectRingLonLat(
  lonMin: number,
  latMin: number,
  lonMax: number,
  latMax: number,
): number[][] {
  return [
    [lonMin, latMin],
    [lonMax, latMin],
    [lonMax, latMax],
    [lonMin, latMax],
  ]
}

/** Signed shoelace area (MM^2) of a single ring. */
function shoelaceArea(ring: number[][]): number {
  let a = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, y0] = ring[i]
    const [x1, y1] = ring[(i + 1) % n]
    a += x0 * y1 - x1 * y0
  }
  return a / 2
}

/** Total |area| of a triangle-soup (stride-3 verts, flat index list). */
function meshArea(verts: number[], idx: number[]): number {
  let total = 0
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t],
      b = idx[t + 1],
      c = idx[t + 2]
    const ax = verts[a * 3],
      ay = verts[a * 3 + 1]
    const bx = verts[b * 3],
      by = verts[b * 3 + 1]
    const cx = verts[c * 3],
      cy = verts[c * 3 + 1]
    total += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) * 0.5
  }
  return total
}

/** Count vertices that lie STRICTLY INTERIOR (collinear + 0 < t < 1 in MM) to
 *  an edge of a triangle that does NOT reference them — the hanging-node /
 *  T-junction detector. A uniform-grid broad phase keeps it ~O(T) (each short
 *  edge only tests vertices in the few cells its bbox overlaps), so the strong
 *  witness stays well under the 3 s budget. */
function countHangingNodes(verts: number[], idx: number[]): number {
  const nV = verts.length / 3
  // Midpoints are exact linear combinations, so a collinear vertex sits on the
  // chord to ~1e-8 m; a genuinely off-edge vertex is km away. 1 mm separates
  // them with a huge margin.
  const DIST_TOL = 1e-3
  const T_EPS = 1e-9

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (let v = 0; v < nV; v++) {
    const x = verts[v * 3],
      y = verts[v * 3 + 1]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  const span = Math.max(maxX - minX, maxY - minY, 1)
  const gridN = Math.max(1, Math.floor(Math.sqrt(nV)))
  const cell = span / gridN
  const cellOf = (x: number, y: number): number =>
    Math.floor((x - minX) / cell) * (gridN + 2) + Math.floor((y - minY) / cell)
  const buckets = new Map<number, number[]>()
  for (let v = 0; v < nV; v++) {
    const k = cellOf(verts[v * 3], verts[v * 3 + 1])
    const b = buckets.get(k)
    if (b) b.push(v)
    else buckets.set(k, [v])
  }

  const hanging = new Set<number>()
  for (let t = 0; t < idx.length; t += 3) {
    const t0 = idx[t],
      t1 = idx[t + 1],
      t2 = idx[t + 2]
    const tri = [t0, t1, t2]
    for (let e = 0; e < 3; e++) {
      const e0 = tri[e],
        e1 = tri[(e + 1) % 3]
      const ax = verts[e0 * 3],
        ay = verts[e0 * 3 + 1]
      const bx = verts[e1 * 3],
        by = verts[e1 * 3 + 1]
      const ex = bx - ax,
        ey = by - ay
      const len2 = ex * ex + ey * ey
      if (len2 === 0) continue
      const invLen = 1 / Math.sqrt(len2)
      // Candidate vertices: those in cells overlapping the edge bbox (+DIST_TOL).
      const cx0 = Math.floor((Math.min(ax, bx) - DIST_TOL - minX) / cell)
      const cy0 = Math.floor((Math.min(ay, by) - DIST_TOL - minY) / cell)
      const cx1 = Math.floor((Math.max(ax, bx) + DIST_TOL - minX) / cell)
      const cy1 = Math.floor((Math.max(ay, by) + DIST_TOL - minY) / cell)
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const b = buckets.get(cx * (gridN + 2) + cy)
          if (!b) continue
          for (const v of b) {
            if (v === t0 || v === t1 || v === t2) continue
            if (hanging.has(v)) continue
            const vx = verts[v * 3],
              vy = verts[v * 3 + 1]
            const s = ((vx - ax) * ex + (vy - ay) * ey) / len2
            if (s <= T_EPS || s >= 1 - T_EPS) continue
            const perp = Math.abs((vx - ax) * ey - (vy - ay) * ex) * invLen
            if (perp < DIST_TOL) hanging.add(v)
          }
        }
      }
    }
  }
  return hanging.size
}

/** Original earcut edges (before subdivision) as [ [x0,y0,x1,y1], ... ], plus
 *  the set of original ring-vertex position keys. Used to classify how many
 *  ADDED vertices lie exactly on an original triangle edge. */
function originalEarcut(rings: number[][][]): {
  edges: number[][]
  origKeys: Set<string>
} {
  const flat: number[] = []
  const holes: number[] = []
  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holes.push(flat.length / 2)
    for (const [x, y] of rings[r]) flat.push(x, y)
  }
  const tris = earcut(flat, holes.length > 0 ? holes : undefined)
  const edges: number[][] = []
  const origKeys = new Set<string>()
  for (let i = 0; i < flat.length; i += 2)
    origKeys.add(`${Math.round(flat[i] * 1000)},${Math.round(flat[i + 1] * 1000)}`)
  for (let t = 0; t < tris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tris[t + e],
        b = tris[t + ((e + 1) % 3)]
      edges.push([flat[a * 2], flat[a * 2 + 1], flat[b * 2], flat[b * 2 + 1]])
    }
  }
  return { edges, origKeys }
}

/** How many ADDED vertices are NOT collinear with any original earcut edge.
 *  Reports the boundary/edge-split collinearity: added vertices that split an
 *  ORIGINAL edge sit on it; recursive INTERIOR midpoints (present in the
 *  pre-INC-0 red-split too) legitimately live inside a parent triangle. This is
 *  diagnostic; the binding Mercator-identity gate is exact area preservation. */
function countOffOriginalEdge(
  verts: number[],
  rings: number[][][],
): { addedTotal: number; offEdge: number } {
  const { edges, origKeys } = originalEarcut(rings)
  const DIST_TOL = 1e-3
  const T_EPS = 1e-9
  let addedTotal = 0
  let offEdge = 0
  const nV = verts.length / 3
  for (let v = 0; v < nV; v++) {
    const vx = verts[v * 3],
      vy = verts[v * 3 + 1]
    const key = `${Math.round(vx * 1000)},${Math.round(vy * 1000)}`
    if (origKeys.has(key)) continue // original ring vertex, not added
    addedTotal++
    let onEdge = false
    for (const [ax, ay, bx, by] of edges) {
      const ex = bx - ax,
        ey = by - ay
      const len2 = ex * ex + ey * ey
      if (len2 === 0) continue
      const s = ((vx - ax) * ex + (vy - ay) * ey) / len2
      if (s < -T_EPS || s > 1 + T_EPS) continue
      const perp = Math.abs((vx - ax) * ey - (vy - ay) * ex) / Math.sqrt(len2)
      if (perp < DIST_TOL) {
        onEdge = true
        break
      }
    }
    if (!onEdge) offEdge++
  }
  return { addedTotal, offEdge }
}

function tessellate(rings: number[][][]): { verts: number[]; idx: number[] } {
  const verts: number[] = []
  const idx: number[] = []
  const dedup = new Map<string, number>()
  tessellatePolygonToArrays(rings, FEATURE_ID, verts, idx, dedup)
  return { verts, idx }
}

describe('subdivideTriangleMM conforming subdivision (INC-0)', () => {
  it('emits a CONFORMING mesh (zero hanging nodes) on the jagged strip witness', () => {
    // 40 teeth, 70 deg wide, ~8 deg tall — the CPU-probe strip shape.
    const ring = ringToMM(jaggedStripRingLonLat(40, 70, 36, 0.6, 44))
    const rings = [ring]
    const { verts, idx } = tessellate(rings)

    const hanging = countHangingNodes(verts, idx)
    const triCount = idx.length / 3

    console.log(
      `[INC-0] jagged strip: ${verts.length / 3} verts, ${triCount} tris, hanging nodes = ${hanging}`,
    )

    expect(hanging).toBe(0)
  })

  it('preserves Mercator fill: subdivided mesh area == input polygon area (no gap/overlap/spillage)', () => {
    const ring = ringToMM(jaggedStripRingLonLat(40, 70, 36, 0.6, 44))
    const rings = [ring]
    const { verts, idx } = tessellate(rings)

    const polyArea = Math.abs(shoelaceArea(ring))
    const meshA = meshArea(verts, idx)
    const relErr = Math.abs(meshA - polyArea) / polyArea

    const { addedTotal, offEdge } = countOffOriginalEdge(verts, rings)

    console.log(
      `[INC-0] Mercator-identity: polyArea=${polyArea.toExponential(6)} meshArea=${meshA.toExponential(6)} relErr=${relErr.toExponential(3)}; addedVerts=${addedTotal} offOriginalEdge=${offEdge}`,
    )

    // Exact tiling of the polygon — the rasterized Mercator fill is unchanged.
    expect(relErr).toBeLessThan(1e-9)
  })

  it('reports triangle counts for the 70x40 and 100x40 probe rectangles', () => {
    const rect70 = ringToMM(rectRingLonLat(-35, 0, 35, 40)) // 70x40 low-lat
    const rect100 = ringToMM(rectRingLonLat(-50, 40, 50, 80)) // 100x40 high-lat

    const m70 = tessellate([rect70])
    const m100 = tessellate([rect100])

    const h70 = countHangingNodes(m70.verts, m70.idx)
    const h100 = countHangingNodes(m100.verts, m100.idx)

    console.log(
      `[INC-0] probe 70x40:  ${m70.idx.length / 3} tris, ${m70.verts.length / 3} verts, hanging=${h70}`,
    )

    console.log(
      `[INC-0] probe 100x40: ${m100.idx.length / 3} tris, ${m100.verts.length / 3} verts, hanging=${h100}`,
    )

    // Rectangles subdivide symmetrically; assert conformance here too.
    expect(h70).toBe(0)
    expect(h100).toBe(0)

    // Area preservation on both rectangles.
    for (const [ring, mesh] of [
      [rect70, m70],
      [rect100, m100],
    ] as const) {
      const polyArea = Math.abs(shoelaceArea(ring))
      const relErr = Math.abs(meshArea(mesh.verts, mesh.idx) - polyArea) / polyArea
      expect(relErr).toBeLessThan(1e-9)
    }
  })
})

// ── Cross-LOD boundary conformance (design "skirt" prerequisite, re-measured) ──
//
// The design doc records, as CONFIRMED, that cross-LOD T-junctions "need a SKIRT,
// not endpoint-stitch", reasoning that a parent tile's edge and the two child
// sub-edges covering it "have DIFFERENT endpoints" so an endpoint-keyed rule cannot
// reconcile them. Half of that is wrong, and the wrong half is the load-bearing one:
// a marked edge always splits at its LINEAR MM MIDPOINT, and the midpoint of a parent
// tile's edge IS the shared endpoint of its two children — so the refinement is
// SELF-SIMILAR across LODs and the two sides agree by construction wherever the
// parent's edge is marked and has depth left.
//
// Two mechanisms can still break the agreement, and this suite measures both rather
// than asserting them away:
//   - z <= 2: MAX_TRI_SUBDIVIDE_DEPTH stops the parent one level short of what the
//     2-degree gate wants, while each child starts its own depth budget at 0 and gets
//     one level further;
//   - z >= 8: a tile edge is already under the gate, so the PARENT never splits while
//     the children still meet at the LOD boundary, which is then interior to the
//     parent's unsplit edge.
// Both leave a vertex of one mesh interior to the other's edge, and the gap that
// opens is the SAGITTA of the arc the un-split side spans. That is the quantity that
// decides whether a skirt is needed, so it is what is asserted here — bounded at
// SUB-DEVICE-PIXEL at every native zoom, which is why the globe's fill ceiling can
// reach z0 without one.
//
// Bound is deliberately the WORST case: the sphere's screen radius is 512*2^Z/(2*PI)
// px and the sagitta is taken unforeshortened (a limb-tangent edge). A tile facing
// the camera sees strictly less.

const MM_WORLD = 20037508.342789244

function mmToUnitSphere(x: number, y: number): [number, number, number] {
  const lon = ((x / MM_WORLD) * Math.PI) as number
  const lat = Math.atan(Math.sinh((y / MM_WORLD) * Math.PI))
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
}

/** Great-circle angle (radians) between two MM points. */
function centralAngleMM(ax: number, ay: number, bx: number, by: number): number {
  const a = mmToUnitSphere(ax, ay)
  const b = mmToUnitSphere(bx, by)
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))
  return Math.acos(dot)
}

/** Parameters (0..1 along A->B) of every vertex the subdivision places ON the
 *  segment A->B, for a triangle whose third vertex is C. */
function boundaryParams(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number[] {
  const verts: number[] = []
  const idx: number[] = []
  const dedup = new Map<string, number>()
  const add = (x: number, y: number): number => {
    const k = vertexKey(x, y, 0)
    const hit = dedup.get(k)
    if (hit !== undefined) return hit
    const i = verts.length / 3
    verts.push(x, y, 0)
    dedup.set(k, i)
    return i
  }
  subdivideTriangleMM(add(ax, ay), add(bx, by), add(cx, cy), 0, verts, idx, dedup, 0)
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const out = new Set<number>()
  for (let i = 0; i < verts.length / 3; i++) {
    const x = verts[i * 3]
    const y = verts[i * 3 + 1]
    const t = ((x - ax) * dx + (y - ay) * dy) / len2
    if (t < -1e-9 || t > 1 + 1e-9) continue
    if (Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) > 1e-6) continue
    out.add(Number(t.toFixed(12)))
  }
  return [...out].sort((p, q) => p - q)
}

interface CrossLod {
  parent: number[]
  child: number[]
  parentOnly: number[]
  childOnly: number[]
  /** Worst screen gap in px at NATIVE camera zoom (Z = z). */
  gapPx: number
}

/** Subdivide a tile's left edge as the PARENT owns it, then as its two CHILDREN do,
 *  and compare the two point sets on the shared physical segment. */
function crossLodBoundary(z: number, tx: number, ty: number): CrossLod {
  const s = (2 * MM_WORLD) / 2 ** z
  const x0 = -MM_WORLD + tx * s
  const yTop = MM_WORLD - ty * s
  const yBot = yTop - s
  const yMid = (yTop + yBot) / 2
  const parent = boundaryParams(x0, yTop, x0, yBot, x0 + s, yTop)
  const top = boundaryParams(x0, yTop, x0, yMid, x0 + s / 2, yTop)
  const bot = boundaryParams(x0, yMid, x0, yBot, x0 + s / 2, yTop)
  const child = [
    ...new Set(
      [...top.map((t) => t / 2), ...bot.map((t) => 0.5 + t / 2)].map((t) => Number(t.toFixed(12))),
    ),
  ].sort((p, q) => p - q)
  const near = (set: number[], t: number) => set.some((u) => Math.abs(u - t) < 1e-9)
  const parentOnly = parent.filter((t) => !near(child, t))
  const childOnly = child.filter((t) => !near(parent, t))

  // The gap a disagreement opens = the sagitta of the arc the UN-SPLIT side spans
  // between the two of its own vertices that bracket the other side's extra vertex.
  const edgeAngle = centralAngleMM(x0, yTop, x0, yBot)
  const rPx = (512 * 2 ** z) / (2 * Math.PI)
  const span = (owner: number[], t: number): number => {
    let lo = 0
    let hi = 1
    for (const u of owner) {
      if (u <= t && u > lo) lo = u
      if (u >= t && u < hi) hi = u
    }
    return hi - lo
  }
  let gapPx = 0
  for (const t of childOnly) gapPx = Math.max(gapPx, sagittaPx(span(parent, t) * edgeAngle, rPx))
  for (const t of parentOnly) gapPx = Math.max(gapPx, sagittaPx(span(child, t) * edgeAngle, rPx))
  return { parent, child, parentOnly, childOnly, gapPx }
}

function sagittaPx(theta: number, rPx: number): number {
  return rPx * (1 - Math.cos(theta / 2))
}

describe('cross-LOD boundary conformance (the "skirt" prerequisite, measured)', () => {
  const LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14]
  const results = LEVELS.map((z) => ({
    z,
    ...crossLodBoundary(
      z,
      Math.max(0, Math.min(2 ** z - 1, Math.round(2 ** z * 0.53))),
      Math.max(0, Math.round(2 ** z * 0.39)),
    ),
  }))

  it('never leaves a PARENT vertex the children lack (the direction the design doc named)', () => {
    // A parent-only vertex would be a hanging node on the CHILD side -- the "different
    // endpoints" failure the doc predicted. Midpoint bisection makes it impossible:
    // every parent split point is reachable by the children's own recursion on the
    // same endpoints, at the same depth budget or better.
    for (const r of results) {
      expect({ z: r.z, parentOnly: r.parentOnly.length }).toEqual({ z: r.z, parentOnly: 0 })
    }
  })

  it('agrees EXACTLY wherever the parent edge is marked with depth to spare (z3-z7)', () => {
    for (const r of results.filter((r) => r.z >= 3 && r.z <= 7)) {
      expect({ z: r.z, childOnly: r.childOnly.length, gapPx: r.gapPx }).toEqual({
        z: r.z,
        childOnly: 0,
        gapPx: 0,
      })
    }
  })

  it('keeps the gap under a tenth of a device pixel through z0-z5 (what lets the fill ceiling reach z0)', () => {
    // z0-z2 disagree only because MAX_TRI_SUBDIVIDE_DEPTH stops the parent one level
    // short of what the gate wants while each child starts a fresh depth budget --
    // and at those levels the sphere is small enough on screen that the resulting
    // sagitta is invisible. This is the band #2094 opens by lowering the ceiling.
    for (const r of results.filter((r) => r.z <= 5)) {
      expect({ z: r.z, over: r.gapPx > 0.1 }).toEqual({ z: r.z, over: false })
    }
  })

  it('records the z8-z9 spike the ABSOLUTE 2-degree gate leaves (#2435)', () => {
    // A z8 tile edge spans ~1.4 degrees -- already under MAX_TRI_DEGREES_FOR_PROJ --
    // so the parent edge is never split while its two children still meet at the LOD
    // boundary, which is then interior to it. The gap is the parent edge's own
    // sagitta, and because the native-zoom screen scale doubles per level while the
    // gate does not move, it PEAKS exactly where the edge first falls under the gate.
    // Pinned so the per-tile-level granularity that fixes #2435 is visible here.
    const spike = results.filter((r) => r.z === 8 || r.z === 9)
    expect(spike.map((r) => ({ z: r.z, childOnly: r.childOnly.length }))).toEqual([
      { z: 8, childOnly: 1 },
      { z: 9, childOnly: 1 },
    ])
    expect(spike.every((r) => r.gapPx > 0.4)).toBe(true)
    console.log(
      'cross-LOD boundary: ' +
        results
          .map(
            (r) => `z${r.z} p=${r.parent.length} c=${r.child.length} gap=${r.gapPx.toFixed(3)}px`,
          )
          .join('  '),
    )
  })
})

// ── `tileSegmentAngleRad` must equal what the subdivision ACTUALLY does ──────
//
// The renderer prices the direct sphere path with this number
// (map/src/render/globe-drape-budget.ts): the screen error of a chord standing in
// for its arc is `R_px·(1 − cos(theta/2))`, and theta is whatever the tiler left.
// The function is a CLOSED FORM over two module-private constants, so nothing but
// a test can stop it drifting from the recursion it summarises — and a drift here
// would silently mis-price every drape decision on the globe.
describe('tileSegmentAngleRad === the finest edge the real subdivision leaves', () => {
  it('matches the measured spacing on an EQUATORIAL tile edge, z1-z10', () => {
    for (let z = 1; z <= 10; z++) {
      const s = (2 * MM_WORLD) / 2 ** z
      // ty = 2^(z-1) puts this tile's TOP edge exactly on the equator, where a tile
      // spans the full 2*PI/2^z of longitude the closed form is written for.
      const x0 = -MM_WORLD + Math.round(2 ** z * 0.31) * s
      const params = boundaryParams(x0, 0, x0 + s, 0, x0, -s)
      let widest = 0
      for (let i = 1; i < params.length; i++) {
        widest = Math.max(widest, params[i] - params[i - 1])
      }
      const measuredRad = widest * ((2 * Math.PI) / 2 ** z)
      expect({ z, ok: Math.abs(measuredRad - tileSegmentAngleRad(z)) < 1e-9 }).toEqual({
        z,
        ok: true,
      })
    }
  })

  it('is clamped by the DEPTH cap where the gate alone cannot be reached (z0-z2)', () => {
    // A z0 edge spans 360 deg and the gate wants 2 deg: that is 7.5 bisections, and
    // MAX_TRI_SUBDIVIDE_DEPTH stops at 5. The returned angle is then the capped one,
    // not the gate — the low-zoom half of the sawtooth the budget has to survive.
    const deg = (r: number) => (r * 180) / Math.PI
    expect(deg(tileSegmentAngleRad(0))).toBeCloseTo(360 / 32, 9)
    expect(deg(tileSegmentAngleRad(1))).toBeCloseTo(180 / 32, 9)
    expect(deg(tileSegmentAngleRad(2))).toBeCloseTo(90 / 32, 9)
  })

  it('returns the WHOLE tile span once an edge is already under the gate (#2435)', () => {
    // From z8 a tile edge is under MAX_TRI_DEGREES_FOR_PROJ, so nothing splits and the
    // segment IS the tile. This is the peak the direct path's native-zoom error has,
    // and the reason #2435 asks for a per-tile-level granularity.
    for (const z of [8, 9, 10, 12, 14]) {
      expect({ z, whole: tileSegmentAngleRad(z) === (2 * Math.PI) / 2 ** z }).toEqual({
        z,
        whole: true,
      })
    }
    // ...and NOT below z8, where the gate is still doing work.
    for (const z of [3, 4, 5, 6, 7]) {
      expect({ z, whole: tileSegmentAngleRad(z) === (2 * Math.PI) / 2 ** z }).toEqual({
        z,
        whole: false,
      })
    }
  })
})
