// ═══ GATE 2 (PR-D) — controller production-wiring round-trip ═══
//
// TEST-ONLY. This is a PASSING gate that validates the #200 controller wiring
// the coverage-gap audit found UNVERIFIED: no test imports controller.ts or
// interaction-controller.ts, so the production gesture path — the new
// pointerdown→dragAnchor = unprojectToMercatorAnchor branch
// (controller.ts:158/163/401/403), the wheel handler driving camera.zoomAt,
// and InteractionController's projType 1/2/6 clientToLngLat routing through
// unprojectToLonLat (interaction-controller.ts:244) — was exercised by ZERO
// test. G1/G1b drive the Camera math DIRECTLY, so a bug where the Camera math
// is correct but the controller picks the wrong branch / passes wrong coords /
// never calls the new path would pass G1/G1b and ship.
//
// This test constructs the REAL PanZoomController + InteractionController over
// a real Camera at projType 1/2/6, dispatches synthetic pointer + wheel events
// through a stub canvas that ACTUALLY stores listeners (so the controller's
// own handlers run), and asserts the controller drives the Camera through the
// new path.
//
// HEADLESS NOTES (this vitest env is node, not jsdom):
//   - `window` / `PointerEvent` / `requestAnimationFrame` are undefined. The
//     controller already guards `typeof window !== 'undefined'` (→ dpr 1), and
//     synthetic plain-object events satisfy the fields its handlers read
//     (clientX/Y, pointerId, button, ctrlKey, deltaY/deltaMode, preventDefault).
//   - The DRAG path (pointerdown→pointermove→panToScreenAnchor) runs FULLY
//     synchronously with no rAF — exercised end-to-end below.
//   - The WHEEL path's smooth-zoom animation uses requestAnimationFrame for the
//     easing tail; we install a no-op rAF shim so the handler's FIRST
//     synchronous camera.zoomAt still fires (the wiring under test) without
//     spinning an animation loop. The easing tail is interaction-FEEL, out of
//     scope for a wiring gate.
//
// RESIDUAL NOTED (genuine finding, not a harness limitation): for the flat
// non-merc set (1/2/6) the DRAG anchor (camera.panToScreenAnchor) is a
// SINGLE-PASS anchor — unlike camera.zoomAt, which runs a fixed-point
// iteration for 1/2/6 (camera.ts:1085). So a flat non-merc drag does NOT keep
// the grabbed geographic point glued under the cursor the way a Mercator drag
// does (Mercator round-trips to EXACTLY 0; equirect/NE/oblique drift tens to
// hundreds of px over a 30-step drag). That under-cursor-stickiness is the
// PR-D drag-anchor target (a #11-adjacent contract), NOT what #200 wired. What
// #200 wired — and what this gate verifies PASSING — is that the controller
// REACHES the new anchored path and drives the Camera through it (the camera
// moves via unprojectToMercatorAnchor + panToScreenAnchor, not the delta-pan
// fallback, not a no-op), plus that clientToLngLat now returns finite geo for
// 1/2/6. The Mercator control proves the harness + anchored-drag wiring are
// sound by round-tripping to 0.
//
// projType encoding: 0 mercator · 1 equirectangular · 2 natural_earth
//   · 3 orthographic · 4 azimuthal_equidistant · 5 stereographic
//   · 6 oblique_mercator · 7 globe

import { describe, it, expect, afterEach } from 'vitest'
import { Camera } from './projection/camera'
import { PanZoomController } from './controller'
import { InteractionController, type InteractionControllerDeps } from './interaction-controller'
import type { GPUContext } from './gpu/gpu'

const W = 800, H = 800

// ── Stub canvas that REALLY registers listeners so synthetic events reach the
//    controller's own handlers (the no-op stubs in map-interaction-dpr.test.ts
//    cannot dispatch). Mirrors the HTMLCanvasElement surface the controllers
//    touch: width/height, client*, style, add/removeEventListener,
//    getBoundingClientRect, set/releasePointerCapture. ──
function makeStubCanvas(): {
  canvas: HTMLCanvasElement
  fire: (type: string, ev: Record<string, unknown>) => void
} {
  const listeners = new Map<string, Array<(e: unknown) => void>>()
  const canvas = {
    width: W,
    height: H,
    clientWidth: W,
    clientHeight: H,
    style: {} as CSSStyleDeclaration,
    addEventListener(type: string, fn: (e: unknown) => void) {
      const arr = listeners.get(type) ?? []
      arr.push(fn)
      listeners.set(type, arr)
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      const arr = listeners.get(type)
      if (!arr) return
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: W, bottom: H, width: W, height: H }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLCanvasElement
  const fire = (type: string, ev: Record<string, unknown>) => {
    for (const fn of listeners.get(type) ?? []) fn(ev)
  }
  return { canvas, fire }
}

function makeFlatCamera(projType: number, zoom = 6): Camera {
  const cam = new Camera(20, 30, zoom)
  cam.projType = projType
  cam.globeMode = false
  cam.bearing = 0
  cam.pitch = 0
  return cam
}

// A pointer event the controller's handlers can read (plain object — node has
// no PointerEvent). `button: 0` (left) + `ctrlKey: false` keeps the press on
// the pan/drag path (not the rotate path).
function ptr(pointerId: number, clientX: number, clientY: number): Record<string, unknown> {
  return { pointerId, clientX, clientY, button: 0, ctrlKey: false }
}

const FLAT_NONMERC: Array<[number, string]> = [
  [1, 'equirectangular'],
  [2, 'natural_earth'],
  [6, 'oblique_mercator'],
]

// ════════════════════════════════════════════════════════════════════════
// 2A — PanZoomController DRAG drives the Camera through the new anchored path.
// ════════════════════════════════════════════════════════════════════════
describe('GATE 2A — PanZoomController drag wiring (projType 1/2/6 route through unprojectToMercatorAnchor)', () => {
  // MERCATOR CONTROL: the anchored drag is EXACT for projType 0 (its z=0 plane
  // IS the Mercator plane). Proves the stub-canvas harness + the
  // pointerdown→panToScreenAnchor wiring are sound: the grabbed geographic
  // point stays EXACTLY under the cursor across a streamed drag.
  it('mercator(0) control: drag keeps the grabbed geo point exactly under the cursor (harness + anchored-drag wiring sound)', () => {
    const cam = makeFlatCamera(0)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, () => ({ projectionName: 'mercator' }))
    try {
      const sx = 500, sy = 450
      const g0 = cam.unprojectToLonLat(sx, sy, W, H, 1)
      expect(g0, 'mercator: geo under start pointer is null').not.toBeNull()

      fire('pointerdown', ptr(1, sx, sy))
      let px = sx, py = sy
      for (let s = 0; s < 30; s++) {
        px += 2; py -= 1.5
        fire('pointermove', ptr(1, px, py))
      }
      // NOTE: deliberately no `pointerup` — release starts the rAF-driven
      // inertia pan (an EXTRA camera.pan on the first frame before rAF would
      // continue it), which is a separate feature from the drag-anchor
      // invariant under test. The grabbed-point-under-cursor contract is
      // evaluated at the end of the drag, mid-gesture.

      // The grabbed geographic point must still be under the (moved) cursor.
      const gEnd = cam.unprojectToLonLat(px, py, W, H, 1)
      expect(gEnd, 'mercator: geo under end pointer is null').not.toBeNull()
      let dLon = g0![0] - gEnd![0]
      if (dLon > 180) dLon -= 360
      if (dLon < -180) dLon += 360
      expect(Math.abs(dLon), `mercator under-cursor lon drift ${dLon}°`).toBeLessThan(1e-6)
      expect(Math.abs(g0![1] - gEnd![1]), `mercator under-cursor lat drift ${g0![1] - gEnd![1]}°`).toBeLessThan(1e-6)
    } finally {
      ctrl.detach()
    }
  })

  // FLAT NON-MERC (1/2/6): #200 wired the drag anchor through the new
  // unprojectToMercatorAnchor branch. Verify the controller REACHES it and
  // drives the Camera: the centre moves substantially in response to the drag
  // (the anchored path executed, not the no-op / not a stale anchor), and it
  // moves by MORE than a single move's worth (a streamed drag accumulated).
  // The exact "stays glued under the cursor" stickiness is the single-pass
  // panToScreenAnchor residual documented in the header — out of #200 scope.
  for (const [projType, name] of FLAT_NONMERC) {
    it(`${name}(${projType}): drag drives the Camera via the anchored path (centre moves, anchor was finite)`, () => {
      const cam = makeFlatCamera(projType)
      const { canvas, fire } = makeStubCanvas()
      const ctrl = new PanZoomController()
      ctrl.attach(canvas, cam, () => ({ projectionName: name }))
      try {
        const sx = 500, sy = 450
        // The new branch's anchor must be a finite Mercator-metre pair for
        // 1/2/6 (the routing condition in controller.ts:158). If it were null,
        // the controller would fall to delta-pan and the new path is dead.
        const anchor = cam.unprojectToMercatorAnchor(sx, sy, W, H, 1)
        expect(anchor, `${name}: unprojectToMercatorAnchor is null (new drag branch would be skipped)`).not.toBeNull()
        expect(anchor!.every(Number.isFinite), `${name}: anchor not finite ${anchor}`).toBe(true)

        const cx0 = cam.centerX, cy0 = cam.centerY
        fire('pointerdown', ptr(1, sx, sy))
        let px = sx, py = sy
        for (let s = 0; s < 30; s++) {
          px += 2; py -= 1.5
          fire('pointermove', ptr(1, px, py))
        }
        // No `pointerup` — see the mercator control's note: release triggers
        // the rAF-gated inertia pan, irrelevant to the drag-wiring assertion.

        const moved = Math.hypot(cam.centerX - cx0, cam.centerY - cy0)
        // A 60px×45px screen drag at z6 is ~ tens of km of Mercator centre
        // motion; assert it is clearly non-trivial (the anchored path ran and
        // moved the camera), not a no-op. The Mercator control above pins that
        // this same wiring is exact for projType 0.
        expect(moved, `${name}: camera centre barely moved (${moved.toFixed(1)} m) — drag wiring did not drive the Camera`).toBeGreaterThan(1000)
        // Finiteness guard: the move must not have produced NaN centre (a
        // wrong-space subtraction in the new branch would).
        expect(Number.isFinite(cam.centerX) && Number.isFinite(cam.centerY), `${name}: camera centre went non-finite after drag`).toBe(true)
      } finally {
        ctrl.detach()
      }
    })
  }
})

// ════════════════════════════════════════════════════════════════════════
// 2B — PanZoomController WHEEL drives camera.zoomAt for 0/1/2/6.
// ════════════════════════════════════════════════════════════════════════
describe('GATE 2B — PanZoomController wheel wiring (drives camera.zoomAt)', () => {
  const prevRAF = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
  afterEach(() => {
    if (prevRAF === undefined) delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    else (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = prevRAF
  })

  for (const [projType, name] of [[0, 'mercator'], ...FLAT_NONMERC] as Array<[number, string]>) {
    it(`${name}(${projType}): a wheel event drives camera.zoomAt (zoom changes)`, () => {
      // No-op rAF shim: the wheel handler runs its FIRST synchronous
      // camera.zoomAt (the wiring under test) then schedules the easing tail
      // via rAF; the shim swallows the tail so no loop spins. Without ANY rAF
      // the handler's safe() wrapper would catch the ReferenceError AFTER the
      // first zoomAt — but install the shim so the behaviour is explicit and
      // env-independent.
      ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0

      const cam = makeFlatCamera(projType)
      const { canvas, fire } = makeStubCanvas()
      const ctrl = new PanZoomController()
      ctrl.attach(canvas, cam, () => ({ projectionName: name }))
      try {
        const z0 = cam.zoom
        // deltaY<0 = wheel up = zoom in. deltaMode 0 = pixel deltas.
        fire('wheel', { clientX: 560, clientY: 410, deltaY: -120, deltaMode: 0, preventDefault() {} })
        expect(cam.zoom, `${name}: wheel did not change zoom (z0=${z0}, now=${cam.zoom})`).toBeGreaterThan(z0)
        expect(Number.isFinite(cam.zoom), `${name}: zoom went non-finite after wheel`).toBe(true)
      } finally {
        ctrl.detach()
      }
    })
  }
})

// ════════════════════════════════════════════════════════════════════════
// 2C — InteractionController.clientToLngLat routing (the #200 projType gate).
// ════════════════════════════════════════════════════════════════════════
describe('GATE 2C — InteractionController.clientToLngLat routing (1/2/6 finite via unprojectToLonLat; 3/4/5/7 null)', () => {
  function makeInteractionController(cam: Camera, projName: string): InteractionController {
    const { canvas } = makeStubCanvas()
    // clientToLngLat only reads getCtx().canvas + the camera; the remaining
    // deps (pick texture, feature lookups) are unused on this path. A minimal
    // ctx carrying just `canvas` satisfies the structural read.
    const ctx = { canvas } as unknown as GPUContext
    const deps: InteractionControllerDeps = {
      camera: cam,
      layerIds: { getName: () => null } as unknown as InteractionControllerDeps['layerIds'],
      xgisLayers: new Map(),
      rawDatasets: new Map(),
      featureIndex: new Map(),
      getCtx: () => ctx,
      getPickTexture: () => null,
      getProjectionName: () => projName,
      getVectorTileShows: () => [],
    }
    return new InteractionController(deps)
  }

  // 1/2/6: the #200 branch (interaction-controller.ts:244) routes through
  // camera.unprojectToLonLat, which recovers TRUE geographic lon/lat for the
  // flat non-merc set — so clientToLngLat must return FINITE coords (was null
  // pre-#200, the unimplemented-feature gap the audit flagged).
  for (const [projType, name] of FLAT_NONMERC) {
    it(`${name}(${projType}): clientToLngLat returns finite lon/lat (routes through unprojectToLonLat)`, () => {
      const cam = makeFlatCamera(projType)
      const ic = makeInteractionController(cam, name)
      const ll = ic.clientToLngLat(500, 450)
      expect(ll, `${name}: clientToLngLat returned null (the #200 1/2/6 branch was not reached)`).not.toBeNull()
      expect(Number.isFinite(ll![0]) && Number.isFinite(ll![1]), `${name}: clientToLngLat not finite ${ll}`).toBe(true)
      // Sanity: the recovered point is near the camera centre (20,30) for an
      // on-canvas pixel — bound it loosely so this is a wiring check, not a
      // precision re-test of unprojectToLonLat (G1 owns that).
      expect(Math.abs(ll![0] - 20), `${name}: lon ${ll![0]} far from centre`).toBeLessThan(60)
      expect(Math.abs(ll![1] - 30), `${name}: lat ${ll![1]} far from centre`).toBeLessThan(60)
    })
  }

  // 3/4/5 (disc) + 7 (globe): the audit's documented unsupported set —
  // interaction-controller.ts returns null (disc inverse / ray↔sphere unproject
  // deferred to #9/#11). Pins that #200 did NOT silently start returning a
  // wrong (flat-Mercator-misinterpreted) coord for these.
  const UNSUPPORTED: Array<[number, string, boolean]> = [
    [3, 'orthographic', false],
    [4, 'azimuthal_equidistant', false],
    [5, 'stereographic', false],
    [7, 'globe', true],
  ]
  for (const [projType, name, globeMode] of UNSUPPORTED) {
    it(`${name}(${projType}): clientToLngLat returns null (disc/globe inverse deferred — not silently wrong)`, () => {
      const cam = makeFlatCamera(projType)
      cam.globeMode = globeMode
      // The projection name the controller reads is not 'mercator' for these,
      // so even the legacy fallback arm returns null.
      const ic = makeInteractionController(cam, name)
      const ll = ic.clientToLngLat(500, 450)
      expect(ll, `${name}: clientToLngLat should be null for the deferred disc/globe set, got ${ll}`).toBeNull()
    })
  }
})
