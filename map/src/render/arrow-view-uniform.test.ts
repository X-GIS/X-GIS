// ═══ GATE 1 of #1520 step 2 — the ROUND-TRIP IDENTITY ═══
//
// The screen-lattice arrow field rests on one claim: a node's recovered geography, projected
// FORWARD again through the very matrix the frame renders with, lands back on that node. If it
// does not, every glyph is drawn somewhere the water it was sampled from is not — and the failure
// looks like a working field. Nothing about a still frame reveals it; the arrows are the right
// colour, the right size, and pointing the right way, at the wrong place.
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
  ARROW_SNAP_OVERSAMPLE,
} from '../shaders/dsl/arrow-view'
import { globeForward } from '@xgis/geo'
import {
  arrowViewBlock,
  arrowLatticeFor,
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

/** The nine `vec4f`, read back OUT of the packed std140 block — so the values the shader binding
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

/** Worst node error, in PIXELS, over the lattice this camera would actually draw. `null` when no
 *  node round-tripped (an entirely off-globe view), so a silently empty sweep cannot read green. */
function worstPixelError(s: Scene): number | null {
  const { nx, ny } = arrowLatticeFor(W, H, BASE_PX * DPR)
  let worst: number | null = null
  for (let seed = 0; seed < nx * ny; seed++) {
    const ndc = M.fns.arrow_seed_ndc(seed, nx, ny) as [number, number]
    const ll = M.fns.arrow_screen_lonlat(ndc) as [number, number, number]
    if (ll[2] < 0.5) continue // the node has no ground under it — nothing is claimed for it
    const back = forwardNdc(s, ll[0], ll[1])
    if (!back) continue
    // NDC → px: the ×2 the two directions share cancels, so this is a true pixel distance.
    const dx = ((back[0] - ndc[0]) * W) / 2
    const dy = ((back[1] - ndc[1]) * H) / 2
    worst = Math.max(worst ?? 0, Math.hypot(dx, dy))
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

  for (const field of FIELDS) {
    if (field === 'crs') continue // `crs` is downstream of the identity — it is gated by GATE 2
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

describe('the lattice the identity is measured over is the one that gets drawn', () => {
  it('is a function of the VIEWPORT, not of any grid — the whole point of #1520', () => {
    // The count used to be the coverage's drawable-cell count, which is why the field expired at
    // z17: `sub²` per cell scales with the GRID and almost none of it is on screen at depth. Here
    // it depends on the canvas and the glyph size and on nothing else, so it is the SAME at every
    // zoom, over every coverage.
    const a = arrowLatticeFor(W, H, BASE_PX)
    const b = arrowLatticeFor(W, H, BASE_PX)
    expect(a).toEqual(b)
    // …one train per node, `G` glyphs per train.
    expect(a.instanceCount).toBe(a.nx * a.ny * ARROW_TRAIN_GLYPHS)
    // …and it tracks the canvas: twice the area is about twice the nodes.
    const big = arrowLatticeFor(W * 2, H, BASE_PX)
    expect(big.nx).toBeGreaterThanOrEqual(a.nx * 2 - 1)
  })

  it('spends its budget near the ~294 glyphs a 480×700 canvas wants at 34 px spacing', () => {
    // The number #1520 derived when it measured the failure. Not a tuned constant — it falls out
    // of `S = δ·√G` (each seed owns S² px and contributes G glyphs), so it is asserted as a band
    // rather than a value: what would be a bug is an order of magnitude, which is what the grid-
    // proportional generator produced (96 k at z13, 355 M at z19).
    // WHAT THIS COUNTS CHANGED MEANING when the seed started snapping onto a ground lattice: the
    // screen lattice is now OVERSAMPLED (`ARROW_SNAP_OVERSAMPLE`) because the snap is many-to-one,
    // so this is the number of CLAIMANTS, not the number of glyphs drawn — the drawn density is
    // the ground lattice's, and two claimants on one ground node draw the same train coincidently.
    // The band is therefore the target scaled by the oversample, and it is still asserted as a
    // band rather than a value: what would be a bug is an order of magnitude, which is what the
    // grid-proportional generator produced (96 k at z13, 355 M at z19).
    const { instanceCount } = arrowLatticeFor(480, 700, 34)
    const over = ARROW_SNAP_OVERSAMPLE ** 2
    expect(instanceCount).toBeGreaterThan(200 * over)
    expect(instanceCount).toBeLessThan(500 * over)
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

  it('the block is sized from the reflected layout — nine vec4f, 144 B', () => {
    // The buffer the store allocates and the struct the shader reads come from ONE declaration.
    expect(arrowViewUniformBytes()).toBe(FIELDS.length * 16)
  })
})
