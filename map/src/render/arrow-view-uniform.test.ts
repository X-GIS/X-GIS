// ═══ GATE 1 of #1520 step 2 — the ROUND-TRIP IDENTITY ═══
//
// The arrow field rests on one claim: a node's geography and the place the node is DRAWN are the
// same point, checked through the very matrix the frame renders with. If they are not, every glyph
// is drawn somewhere the water it was sampled from is not — and the failure looks like a working
// field. Nothing about a still frame reveals it; the arrows are the right colour, the right size,
// and pointing the right way, at the wrong place.
//
// #1534 INVERTED THE DIRECTION and the gate followed. Under the screen lattice a node's screen
// position was given and its geography was recovered, so the identity was `project(unproject(node))
// === node`. Enumerating the ground lattice makes the geography exact by construction and the
// SCREEN position the derived half, so the identity is now measured there: place the node the way
// the VS places it — linearized model, then one Newton step — and project its own lon/lat forward.
// Same claim, same failure mode, measured on whichever half is derived.
//
// So this is the load-bearing gate, and it is deliberately NOT a render test. It exercises the
// REAL pipeline on both ends:
//
//   • the real CPU writer (`writeArrowViewUniform`) over a real `Camera`'s real MVP, and the bytes
//     it actually packs — the uniform is read back out of the std140 block, so a layout slip fails
//     here rather than silently feeding the shader a rotated frame;
//   • the real shader, through the DSL's own CPU lowering (`compileModuleJs`) — the same op tree
//     the GPU gets, not a JS restatement of it.
//
// The forward half is the projection ladder's own, taken from the same compiled module, so the two
// directions cannot drift into agreeing about a convention neither of them renders with.
//
// FAIL-BEFORE, and it is what makes the gate mean something: perturb any part of the uniform — the
// eye's set-back, a corner ray, the local frame, the sign of `crs.w` — and the whole lattice shifts
// or shears. `_perturb` below does exactly that, per field, and asserts the identity breaks.

import { describe, it, expect } from 'vitest'
import { module, compileModuleJs } from '@xgis/shader-dsl'
import { Camera } from '../camera/camera'
import { getGpuProjectionFuncs, PROJECTION_CONSTS } from '../shaders/dsl/projections'
import { UNPROJECT_FUNCS } from '../shaders/dsl/unproject-dsl'
import {
  ARROW_VIEW_FUNCS,
  ARROW_TRAIN_GLYPHS,
  ARROW_MAX_GROUND_NODES,
} from '../shaders/dsl/arrow-view'
import { globeForward } from '@xgis/geo'
import {
  arrowViewBlock,
  writeArrowViewUniform,
  arrowViewUniformBytes,
  type ArrowViewCamera,
  type ArrowViewGrid,
} from './arrow-view-uniform'

const W = 480
const H = 700
const DPR = 1
const BASE_PX = 34

/** A coverage box around the Chesapeake — the domain the S-111 fixtures live in. It is only used
 *  by `arrow_grid_uv`, which the identity below does not go through; it is supplied because the
 *  uniform has no optional fields. */
const GRID: ArrowViewGrid = {
  originLon: -77,
  originLat: 39.5,
  invSpanLon: 1 / 2,
  invSpanLat: -1 / 2,
}

const M = compileModuleJs(
  module({
    consts: PROJECTION_CONSTS,
    funcs: [...getGpuProjectionFuncs(), ...UNPROJECT_FUNCS, ...ARROW_VIEW_FUNCS],
  }),
)

/** Every `vec4f`, read back OUT of the packed std140 block — so the values the shader binding
 *  receives are literally the bytes the writer produced. */
const FIELDS = [
  'ray_bl',
  'ray_br',
  'ray_tl',
  'ray_tr',
  'eye',
  'up',
  'east',
  'north',
  'crs',
  'lattice',
  'hx',
  'hy',
  'hw',
] as const

function unpack(buf: ArrayBuffer): Record<string, number[]> {
  const f = new Float32Array(buf)
  const out: Record<string, number[]> = {}
  FIELDS.forEach((name, i) => {
    out[name] = [f[i * 4]!, f[i * 4 + 1]!, f[i * 4 + 2]!, f[i * 4 + 3]!]
  })
  return out
}

interface Scene {
  cam: ArrowViewCamera
  view: Record<string, number[]>
  instances: number
}

/** Stand a real camera up, take the MVP the frame would render with, and pack the block. */
function scene(o: {
  lon: number
  lat: number
  zoom: number
  projType: number
  pitch?: number
  bearing?: number
  globe?: boolean
}): Scene {
  const c = new Camera(o.lon, o.lat, o.zoom)
  c.pitch = o.pitch ?? 0
  c.bearing = o.bearing ?? 0
  c.globeMode = o.globe ?? false
  const frame = c.getViewForProjection(o.projType, W, H, DPR)
  // The matrix buffer is preallocated and reused by the camera, so copy before packing.
  const cam: ArrowViewCamera = {
    matrix: Float32Array.from(frame.matrix),
    projType: o.projType,
    globeMode: c.globeMode,
    centerLon: o.lon,
    centerLat: o.lat,
    canvasWidth: W,
    canvasHeight: H,
    dpr: DPR,
  }
  const block = arrowViewBlock()
  const instances = writeArrowViewUniform(block, cam, GRID, {
    basePx: BASE_PX * DPR,
    strokeUnits: 0.06,
  })
  expect(instances, 'the camera has a usable inverse').not.toBeNull()
  return { cam, view: unpack(block.buffer), instances: instances! }
}

/** Bind the compiled module to one scene's uniforms. */
function bind(s: Scene): void {
  M.setBinding('arrow_view', s.view as never)
  M.setBinding('u', {
    proj_params: [s.cam.projType, s.cam.centerLon, s.cam.centerLat, 0],
    viewport: [W, H, 1, 0.03],
  } as never)
}

/** The FORWARD half, taken from the same compiled module the backward half came from.
 *
 *  Flat: the VS feeds `project_geom(abs) − project(clon, clat)` — `flat_rel` — into the MVP.
 *  3D: the VS feeds `ECEF(abs) − camECEF`. The globe path's world origin is `globeForward(centre)`
 *  and the ENU path's is the same anchor rotated, so the ECEF difference is the right world vector
 *  in both (the ENU one then needs the rotation the uniform's own east/north/up carry). */
function forwardNdc(s: Scene, lon: number, lat: number): [number, number] | null {
  const m = s.cam.matrix
  let world: [number, number, number]
  if (s.cam.projType > 6.5) {
    // `globeForward` IS `buildGlobeMatrix`'s own look-at target for the true globe, so the world
    // origin it subtracts is bit-identical to the one the matrix was built around.
    const p = globeForward(lon, lat)
    const o = globeForward(s.cam.centerLon, s.cam.centerLat)
    const d: [number, number, number] = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]
    // The ENU frame rotates that difference onto the world axes; the globe frame's axes ARE the
    // ECEF ones, in which case east/north/up is the identity rotation of the same vector.
    const dot = (a: number[]): number => a[0]! * d[0] + a[1]! * d[1] + a[2]! * d[2]
    world = s.cam.globeMode ? d : [dot(s.view.east!), dot(s.view.north!), dot(s.view.up!)]
  } else {
    const rel = M.fns.flat_rel(lon, lat, [s.cam.projType, s.cam.centerLon, s.cam.centerLat, 0], lon)
    world = [(rel as number[])[0]!, (rel as number[])[1]!, 0]
  }
  const w = m[3]! * world[0] + m[7]! * world[1] + m[11]! * world[2] + m[15]!
  if (!(Math.abs(w) > 1e-9)) return null
  const x = m[0]! * world[0] + m[4]! * world[1] + m[8]! * world[2] + m[12]!
  const y = m[1]! * world[0] + m[5]! * world[1] + m[9]! * world[2] + m[13]!
  return [x / w, y / w]
}

/** Screen position of a ground node, EXACTLY as the VS assembles it: the linearized model's guess
 *  plus the one Newton step taken against the backward map. Null when the VS would reject the node.
 *
 *  Run through the compiled module, not restated here — `arrow_uv_to_px` is the one exception, and
 *  only because it is an inline helper the emitter never makes a function of. */
function placeNode(jx: number, jy: number): { px: [number, number]; uv: [number, number] } | null {
  const node = M.fns.arrow_node_uv(jx, jy) as [number, number, number, number]
  const g = M.fns.arrow_node_ndc([node[0], node[1]]) as [number, number, number]
  if (g[2] < 0.5) return null // at or behind the eye plane
  const ndc: [number, number] = [g[0], g[1]]
  const ll = M.fns.arrow_screen_lonlat(ndc) as [number, number, number]
  if (ll[2] < 0.5) return null // no ground under the guess
  const b = M.fns.arrow_uv_basis(ndc, ll[0], ll[1]) as [number, number, number, number]
  const uvg = M.fns.arrow_grid_uv([ll[0], ll[1]]) as [number, number]
  const du = node[2] - uvg[0]
  const dv = node[3] - uvg[1]
  const fix: [number, number] = [b[0] * du + b[1] * dv, b[2] * du + b[3] * dv]
  return {
    px: [((ndc[0] + 1) / 2) * W + fix[0], ((1 - ndc[1]) / 2) * H + fix[1]],
    uv: [node[2], node[3]],
  }
}

/** grid-uv → lon/lat, the exact inverse of `arrow_grid_uv` over `GRID`. */
const uvLonLat = (u: number, v: number): [number, number] => [
  GRID.originLon + u / GRID.invSpanLon,
  GRID.originLat + v / GRID.invSpanLat,
]

/** Worst node error, in PIXELS, over the ground lattice this camera would actually draw: the
 *  distance between where the VS PUTS a node and where that node's own lon/lat PROJECTS.
 *
 *  This is the claim the whole field rests on. Under the screen lattice it was the round trip
 *  `project(unproject(node)) === node`; enumerating the ground lattice inverts the direction — the
 *  node's geography is now exact by construction and its screen position is what is derived — so
 *  the identity is measured on the derived half. A failure looks identical either way: arrows the
 *  right colour, the right size and pointing the right way, drawn where their water is not.
 *
 *  Only nodes the frame actually SHOWS are scored. A node off the side of the viewport is drawn by
 *  nobody, and near the horizon the model's guess degrades exactly where no glyph is visible;
 *  scoring it would measure the guard rather than the field. `null` when no node scored at all, so
 *  a silently empty sweep cannot read green. */
function worstPixelError(s: Scene): number | null {
  const v = s.view
  const nx = v.ray_bl![3]!
  const ny = v.ray_br![3]!
  const jx0 = v.lattice![2]!
  const jy0 = v.lattice![3]!
  let worst: number | null = null
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const p = placeNode(jx0 + ix, jy0 + iy)
      if (!p) continue
      const [lon, lat] = uvLonLat(p.uv[0], p.uv[1])
      const back = forwardNdc(s, lon, lat)
      if (!back) continue
      const tx = ((back[0] + 1) / 2) * W
      const ty = ((1 - back[1]) / 2) * H
      if (tx < 0 || tx > W || ty < 0 || ty > H) continue
      worst = Math.max(worst ?? 0, Math.hypot(p.px[0] - tx, p.px[1] - ty))
    }
  }
  return worst
}

// projType 0 mercator · 1 equirect · 2 natural earth · 3-5 azimuthal discs · 6 oblique mercator.
// The discs are IN, and that is #1524's result: Newton on the generated forward inverts them too,
// which `camera/unproject.ts` (returning null for 3/4/5) never could.
const FLAT = [0, 1, 2, 3, 4, 5, 6]

describe('GATE 1 — project(unproject(node)) === node, per projType (#1520)', () => {
  for (const projType of FLAT) {
    it(`projType ${projType}: every lattice node lands back on itself, sub-pixel`, () => {
      const s = scene({ lon: -76, lat: 38, zoom: 11, projType })
      bind(s)
      const worst = worstPixelError(s)
      expect(worst, `projType ${projType} recovered at least one node`).not.toBeNull()
      expect(worst!, `projType ${projType} worst node error (px)`).toBeLessThan(1)
    })
  }

  it('the globe recovers its lattice too — the branch a 2D forward cannot serve', () => {
    const s = scene({ lon: -76, lat: 38, zoom: 5, projType: 7, globe: true })
    bind(s)
    const worst = worstPixelError(s)
    expect(worst, 'the globe recovered at least one node').not.toBeNull()
    expect(worst!, 'globe worst node error (px)').toBeLessThan(1)
  })

  it('…and it holds at DEPTH, which is the zoom the whole change is about', () => {
    // z17 and z19 are where the per-cell generator painted literally nothing (#1520 measured
    // 0 pixels). They are also where an f32 inverse would shake: `globe.ts:358` recorded "~8 px
    // at screen centre and tens of px under motion at z17+", so a sub-pixel result here is the
    // direct evidence that the corner-ray formulation avoided that trap rather than inheriting it.
    for (const zoom of [13, 15, 17, 19]) {
      const s = scene({ lon: -76, lat: 38, zoom, projType: 0 })
      bind(s)
      expect(worstPixelError(s)!, `mercator z${zoom} worst node error (px)`).toBeLessThan(1)
    }
  })

  it('…and under PITCH and BEARING, where the eye is not over the world origin', () => {
    // THE ONE THE PLAN GOT WRONG. #1520 asserted the MVP's world space is "ENU at the camera";
    // it is anchored at the camera's GROUND point, and a pitched camera sets the eye back over it.
    // An implementation that assumed the eye at the origin is exact at pitch 0 and wrong by the
    // whole camera altitude here — so this case is the one that distinguishes them.
    for (const pitch of [0, 25, 50]) {
      for (const bearing of [0, 137]) {
        const s = scene({ lon: -76, lat: 38, zoom: 12, projType: 0, pitch, bearing })
        bind(s)
        expect(worstPixelError(s)!, `pitch ${pitch}, bearing ${bearing} (px)`).toBeLessThan(1)
      }
    }
  })
})

describe('GATE 1, fail-before — perturbing the uniform BREAKS the identity', () => {
  // A gate that cannot fail is not a gate (§12: "cut the specific mechanism"). Each field below is
  // nudged on its own, and the identity must break — which is what proves the assertions above are
  // reading the uniform rather than agreeing with themselves.
  // TWO BASES, because the fields are not all read on both branches: the local frame
  // (`up`/`east`/`north`) is what turns a 3D hit into lon/lat and is not consulted at all on a
  // flat projection, so perturbing it there proves nothing. Pitched in both cases — that is where
  // the eye's set-back is nonzero and `eye` becomes load-bearing.
  const FLAT_BASE = { lon: -76, lat: 38, zoom: 12, projType: 0, pitch: 35 }
  const GLOBE_BASE = { lon: -76, lat: 38, zoom: 5, projType: 7, globe: true, pitch: 25 }
  const FRAME = new Set(['up', 'east', 'north'])

  // `crs` is downstream of the identity — it is gated by GATE 2. The ground-lattice fields are not
  // downstream of it either, and for a more interesting reason: the model (`hx`/`hy`/`hw`) is only a
  // GUESS and the lattice is only which nodes are enumerated, so neither can move a node off itself.
  // The block below is their fail-before, and it is the one that proves the Newton step is live.
  const NOT_IDENTITY = new Set(['crs', 'lattice', 'hx', 'hy', 'hw'])

  for (const field of FIELDS) {
    if (NOT_IDENTITY.has(field)) continue
    it(`a perturbed ${field} moves the lattice off its own nodes`, () => {
      const clean = scene(FRAME.has(field) ? GLOBE_BASE : FLAT_BASE)
      bind(clean)
      expect(worstPixelError(clean)!).toBeLessThan(1)

      const dirty: Scene = { ...clean, view: { ...clean.view } }
      // 1 % on the xyz lanes. Small enough that nothing degenerates, large enough that a lattice
      // reading the field cannot possibly still land: at z12 one percent of a ray direction is
      // tens of pixels.
      dirty.view[field] = clean.view[field]!.map((v, i) => (i < 3 ? v * 1.01 + 1 : v))
      bind(dirty)
      const worst = worstPixelError(dirty)
      expect(worst, `${field} still recovered nodes`).not.toBeNull()
      expect(worst!, `${field} is load-bearing`).toBeGreaterThan(1)
    })
  }
})

describe('GATE 1c — the model is a GUESS and the Newton step is what makes it exact (#1534)', () => {
  // The placement is two parts: a linearized model, then one Newton step against the exact backward
  // map. Everything above measures the SUM. These measure the split — because a sum that is right
  // says nothing about which half did the work, and a Newton step that had quietly stopped being
  // applied would read identically until the day the model got worse.
  const BASE = { lon: -76, lat: 38, zoom: 12, projType: 0, pitch: 35 }

  /** Where the model alone would put a node, before the correction. */
  function guessPx(jx: number, jy: number): [number, number] | null {
    const n = M.fns.arrow_node_uv(jx, jy) as number[]
    const g = M.fns.arrow_node_ndc([n[0]!, n[1]!]) as [number, number, number]
    if (g[2] < 0.5) return null
    return [((g[0] + 1) / 2) * W, ((1 - g[1]) / 2) * H]
  }

  /** Worst distance, in px, between the model's raw guess and the corrected placement. */
  function worstCorrection(s: Scene): number {
    const v = s.view
    let worst = 0
    for (let iy = 0; iy < v.ray_br![3]!; iy++) {
      for (let ix = 0; ix < v.ray_bl![3]!; ix++) {
        const jx = v.lattice![2]! + ix
        const jy = v.lattice![3]! + iy
        const g = guessPx(jx, jy)
        const p = placeNode(jx, jy)
        if (!g || !p) continue
        worst = Math.max(worst, Math.hypot(p.px[0] - g[0], p.px[1] - g[1]))
      }
    }
    return worst
  }

  for (const field of ['hx', 'hy', 'hw'] as const) {
    it(`a perturbed ${field} moves the GUESS, and the Newton step puts it back`, () => {
      const clean = scene(BASE)
      bind(clean)
      expect(worstPixelError(clean)!, 'the clean placement is exact').toBeLessThan(1)

      const dirty: Scene = { ...clean, view: { ...clean.view } }
      dirty.view[field] = clean.view[field]!.map((x, i) => (i < 3 ? x * 1.01 + 1 : x))
      bind(dirty)
      // The perturbation is real — the model's own answer moved by pixels, not by rounding. This is
      // the half that fails if the correction is severed: the placement would move with it.
      expect(worstCorrection(dirty), `${field} moved the guess`).toBeGreaterThan(1)
      // …and the placement did not, because the correction is measured against the backward map and
      // not against the model.
      expect(worstPixelError(dirty)!, `${field} is corrected away`).toBeLessThan(1)
    })
  }

  it('a perturbed lattice step re-enumerates the nodes, and they are still exact', () => {
    // `lattice` decides WHICH ground nodes are drawn, not where any of them lands. Both halves are
    // asserted: the node set has to actually change (or the field is inert), and the identity has
    // to survive the change (or the placement was reading the step it was written with).
    const clean = scene({ lon: -76, lat: 38, zoom: 12, projType: 0 })
    bind(clean)
    const before = M.fns.arrow_node_uv(
      clean.view.lattice![2]! + 1,
      clean.view.lattice![3]!,
    ) as number[]
    const dirty: Scene = { ...clean, view: { ...clean.view } }
    dirty.view.lattice = [
      clean.view.lattice![0]! * 0.5,
      clean.view.lattice![1]! * 0.5,
      clean.view.lattice![2]!,
      clean.view.lattice![3]!,
    ]
    bind(dirty)
    const after = M.fns.arrow_node_uv(
      dirty.view.lattice![2]! + 1,
      dirty.view.lattice![3]!,
    ) as number[]
    expect(Math.abs(after[2]! - before[2]!), 'the step is load-bearing').toBeGreaterThan(1e-6)
    expect(worstPixelError(dirty)!, 'and the new nodes are placed exactly too').toBeLessThan(1)
  })
})

describe('GATE 1b — the lattice is anchored to the GROUND (#1534)', () => {
  /** Every enumerated node's absolute grid-uv, as a rounded key set. */
  function nodeUvs(s: Scene): Set<string> {
    const v = s.view
    const out = new Set<string>()
    for (let iy = 0; iy < v.ray_br![3]!; iy++) {
      for (let ix = 0; ix < v.ray_bl![3]!; ix++) {
        const n = M.fns.arrow_node_uv(v.lattice![2]! + ix, v.lattice![3]! + iy) as number[]
        out.add(`${n[2]!.toFixed(9)},${n[3]!.toFixed(9)}`)
      }
    }
    return out
  }

  it('a PANNED camera keeps the nodes it still sees — the whole point of #1534', () => {
    // The screen lattice's failure, as an identity rather than as a pixel diff: a node is a patch
    // of water, so panning may add nodes and drop nodes but must never MOVE one. Under the screen
    // lattice every node moved with the viewport and this intersection was empty.
    const a = scene({ lon: -76, lat: 38, zoom: 12, projType: 0 })
    bind(a)
    const ua = nodeUvs(a)
    const b = scene({ lon: -76.02, lat: 38, zoom: 12, projType: 0 })
    bind(b)
    const ub = nodeUvs(b)
    const kept = [...ua].filter((k) => ub.has(k))
    expect(kept.length, 'the overlap keeps its nodes').toBeGreaterThan(ua.size * 0.5)
  })

  it('…and the enumeration is a BIJECTION — no two instances land on one node', () => {
    // The rejected approach's exact failure mode (#1534): snapping a screen lattice to the ground
    // is many-to-one, so nodes collapse and the field thins. Enumeration cannot do that, and this
    // is what says so.
    const s = scene({ lon: -76, lat: 38, zoom: 12, projType: 0, pitch: 40 })
    bind(s)
    expect(nodeUvs(s).size).toBe(s.view.ray_bl![3]! * s.view.ray_br![3]!)
  })

  it('holds its spacing near the ~294 glyphs a 480×700 canvas wants at 34 px', () => {
    // The number #1520 derived when it measured the per-cell generator's failure. Not a tuned
    // constant — it falls out of `S = δ·√G` (each seed owns S² px and contributes G glyphs), so it
    // is asserted as a band: what would be a bug is an order of magnitude, which is what the
    // grid-proportional generator produced (96 k at z13, 355 M at z19). The band is wider than the
    // screen lattice's because the step is quantised to a power of two in uv, which can be up to
    // √2 off the wanted spacing on each axis.
    for (const zoom of [11, 13, 15, 17, 19]) {
      const s = scene({ lon: -76, lat: 38, zoom, projType: 0 })
      expect(s.instances, `z${zoom} instances`).toBeGreaterThan(100)
      expect(s.instances, `z${zoom} instances`).toBeLessThan(1600)
      expect(s.instances % ARROW_TRAIN_GLYPHS, 'G glyphs per node').toBe(0)
    }
  })

  it('bounds a near-horizon view by COARSENING, so the count stays finite', () => {
    // A pitched camera sees ground to the skyline, so the visible uv box is far larger than a
    // screenful is worth. The cap is enforced by halving the resolution rather than by dropping the
    // far nodes, which would end the field on a straight line across open water.
    const s = scene({ lon: -76, lat: 38, zoom: 9, projType: 0, pitch: 60 })
    expect(s.instances / ARROW_TRAIN_GLYPHS).toBeLessThanOrEqual(ARROW_MAX_GROUND_NODES)
  })

  it('reports NO view — and therefore draws nothing — for a singular matrix', () => {
    // An all-zero or orthographic MVP has no finite eye. Reporting it is the honest outcome: a
    // lattice built from a divide by zero is glyphs at undefined coordinates, which some drivers
    // rasterize as a full-screen triangle.
    const cam: ArrowViewCamera = {
      matrix: new Float32Array(16),
      projType: 0,
      globeMode: false,
      centerLon: 0,
      centerLat: 0,
      canvasWidth: W,
      canvasHeight: H,
      dpr: 1,
    }
    expect(writeArrowViewUniform(arrowViewBlock(), cam, GRID, { basePx: 34, strokeUnits: 0 })).toBe(
      null,
    )
  })

  it('the block is sized from the reflected layout — thirteen vec4f, 208 B', () => {
    // The buffer the store allocates and the struct the shader reads come from ONE declaration.
    expect(arrowViewUniformBytes()).toBe(FIELDS.length * 16)
  })
})
