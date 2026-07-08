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
// RESIDUAL (B3) — RESOLVED: the flat non-merc (1/2/6) DRAG anchor
// (camera.panToScreenAnchor) used to be a SINGLE-PASS anchor — unlike
// camera.zoomAt, which runs a fixed-point iteration for 1/2/6 — so a flat
// non-merc drag slid the grabbed geographic point off the cursor (hundreds of
// px over a 30-step drag). Both gestures now share the camera-helpers.ts
// convergeFlatAnchor fixed-point loop; the under-cursor drag stickiness is
// oracle-gated in interaction-contract-gates.test.ts G1c (streamed 30-step
// drag < 1 px), NOT here. What #200 wired — and what this gate verifies
// PASSING — is that the controller REACHES the new anchored path and drives
// the Camera through it (the camera moves via unprojectToMercatorAnchor +
// panToScreenAnchor, not the delta-pan fallback, not a no-op), plus that
// clientToLngLat now returns finite geo for 1/2/6 and globe mode (#11
// ray↔sphere wiring — globe drag itself IS exactly round-trip-gated below).
// The Mercator control proves the harness + anchored-drag wiring are sound by
// round-tripping to 0.
//
// projType encoding: 0 mercator · 1 equirectangular · 2 natural_earth
//   · 3 orthographic · 4 azimuthal_equidistant · 5 stereographic
//   · 6 oblique_mercator · 7 globe

import { describe, it, expect, afterEach } from 'vitest'
import { Camera } from './camera'
import { buildGlobeMatrix, unprojectGlobe } from '@xgis/engine'
import { mercatorYToLat } from '@xgis/engine'
import { PanZoomController } from './controller'
import { InteractionController, type InteractionControllerDeps } from './interaction-controller'
import type { GPUContext } from '@xgis/rhi-webgpu'

const W = 800,
  H = 800

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
      const sx = 500,
        sy = 450
      const g0 = cam.unprojectToLonLat(sx, sy, W, H, 1)
      expect(g0, 'mercator: geo under start pointer is null').not.toBeNull()

      fire('pointerdown', ptr(1, sx, sy))
      let px = sx,
        py = sy
      for (let s = 0; s < 30; s++) {
        px += 2
        py -= 1.5
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
      expect(
        Math.abs(g0![1] - gEnd![1]),
        `mercator under-cursor lat drift ${g0![1] - gEnd![1]}°`,
      ).toBeLessThan(1e-6)
    } finally {
      ctrl.detach()
    }
  })

  // GLOBE (7) — the #11 wiring: the controller's globeMode branch captures the
  // grabbed LON/LAT via the ray↔sphere inverse (unprojectGlobeFromCamera) and
  // panToScreenAnchor's globe branch ground-tracks it. Like the mercator
  // control, assert the ROUND-TRIP: the grabbed sphere point is still under
  // the (moved) cursor at drag end — measured against the live globe MVP
  // oracle (unprojectGlobe), NOT the camera's own inverse. A unit-mixing
  // regression (lon/lat anchor fed to the Mercator-metre arm, or the phantom
  // flat-plane anchor restored) drifts ~0.06-0.1° (≈10px at z6) and fails.
  it('globe(7): drag keeps the grabbed sphere point under the cursor (globeMode ray↔sphere anchored drag)', () => {
    const cam = makeFlatCamera(7)
    cam.globeMode = true
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, () => ({ projectionName: 'globe' }))
    try {
      // Live globe MVP oracle — same reconstruction the interaction-contract
      // gates use (gzGlobeView): centre from the canonical Mercator metres.
      const globeView = () => {
        const clon = (cam.centerX / 6378137) * (180 / Math.PI)
        const clat = Math.max(-85.051129, Math.min(85.051129, mercatorYToLat(cam.centerY)))
        return buildGlobeMatrix(clon, clat, cam.zoom, cam.pitch, cam.bearing, W, H, cam.globeOrtho)
      }
      const sx = 500,
        sy = 450
      const g0 = unprojectGlobe(sx, sy, W, H, globeView())
      expect(g0, 'globe: sphere point under start pointer is null').not.toBeNull()

      fire('pointerdown', ptr(1, sx, sy))
      let px = sx,
        py = sy
      for (let s = 0; s < 30; s++) {
        px += 2
        py -= 1.5
        fire('pointermove', ptr(1, px, py))
      }
      // No `pointerup` — see the mercator control's note above.

      const gEnd = unprojectGlobe(px, py, W, H, globeView())
      expect(gEnd, 'globe: sphere point under end pointer is null').not.toBeNull()
      let dLon = g0![0] - gEnd![0]
      if (dLon > 180) dLon -= 360
      if (dLon < -180) dLon += 360
      // 5e-3° ≈ 0.5 px at z6 — measured ~7e-5° lon / 7e-6° lat through the
      // wired path (70× headroom), vs ~0.06° for the pre-fix phantom anchor.
      expect(Math.abs(dLon), `globe under-cursor lon drift ${dLon}°`).toBeLessThan(5e-3)
      expect(
        Math.abs(g0![1] - gEnd![1]),
        `globe under-cursor lat drift ${g0![1] - gEnd![1]}°`,
      ).toBeLessThan(5e-3)
    } finally {
      ctrl.detach()
    }
  })

  // FLAT NON-MERC (1/2/6): #200 wired the drag anchor through the new
  // unprojectToMercatorAnchor branch. Verify the controller REACHES it and
  // drives the Camera: the centre moves substantially in response to the drag
  // (the anchored path executed, not the no-op / not a stale anchor), and it
  // moves by MORE than a single move's worth (a streamed drag accumulated).
  // The exact "stays glued under the cursor" stickiness is oracle-gated in
  // interaction-contract-gates.test.ts G1c (B3 fixed — see header note).
  for (const [projType, name] of FLAT_NONMERC) {
    it(`${name}(${projType}): drag drives the Camera via the anchored path (centre moves, anchor was finite)`, () => {
      const cam = makeFlatCamera(projType)
      const { canvas, fire } = makeStubCanvas()
      const ctrl = new PanZoomController()
      ctrl.attach(canvas, cam, () => ({ projectionName: name }))
      try {
        const sx = 500,
          sy = 450
        // The new branch's anchor must be a finite Mercator-metre pair for
        // 1/2/6 (the routing condition in controller.ts:158). If it were null,
        // the controller would fall to delta-pan and the new path is dead.
        const anchor = cam.unprojectToMercatorAnchor(sx, sy, W, H, 1)
        expect(
          anchor,
          `${name}: unprojectToMercatorAnchor is null (new drag branch would be skipped)`,
        ).not.toBeNull()
        expect(anchor!.every(Number.isFinite), `${name}: anchor not finite ${anchor}`).toBe(true)

        const cx0 = cam.centerX,
          cy0 = cam.centerY
        fire('pointerdown', ptr(1, sx, sy))
        let px = sx,
          py = sy
        for (let s = 0; s < 30; s++) {
          px += 2
          py -= 1.5
          fire('pointermove', ptr(1, px, py))
        }
        // No `pointerup` — see the mercator control's note: release triggers
        // the rAF-gated inertia pan, irrelevant to the drag-wiring assertion.

        const moved = Math.hypot(cam.centerX - cx0, cam.centerY - cy0)
        // A 60px×45px screen drag at z6 is ~ tens of km of Mercator centre
        // motion; assert it is clearly non-trivial (the anchored path ran and
        // moved the camera), not a no-op. The Mercator control above pins that
        // this same wiring is exact for projType 0.
        expect(
          moved,
          `${name}: camera centre barely moved (${moved.toFixed(1)} m) — drag wiring did not drive the Camera`,
        ).toBeGreaterThan(1000)
        // Finiteness guard: the move must not have produced NaN centre (a
        // wrong-space subtraction in the new branch would).
        expect(
          Number.isFinite(cam.centerX) && Number.isFinite(cam.centerY),
          `${name}: camera centre went non-finite after drag`,
        ).toBe(true)
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
    if (prevRAF === undefined)
      delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
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
        fire('wheel', {
          clientX: 560,
          clientY: 410,
          deltaY: -120,
          deltaMode: 0,
          preventDefault() {},
        })
        expect(
          cam.zoom,
          `${name}: wheel did not change zoom (z0=${z0}, now=${cam.zoom})`,
        ).toBeGreaterThan(z0)
        expect(Number.isFinite(cam.zoom), `${name}: zoom went non-finite after wheel`).toBe(true)
      } finally {
        ctrl.detach()
      }
    })
  }

  // minZoom floor: a streamed zoom-OUT wheel must not push the camera below
  // camera.minZoom. controller.ts:474 clamps the easing TARGET; the bug floored
  // it at the literal 0, so setMinZoom(8) failed to constrain wheel zoom-out
  // (it fell to z0). Faithful harness: a BOUNDED synchronous rAF actually runs
  // the easing loop to convergence (the other GATE 2B tests use a no-op rAF and
  // only assert the FIRST zoomAt fired — that cannot reach the floor). We fire
  // many large zoom-out wheels and assert the settled camera.zoom never dips
  // below minZoom. Before the fix the target clamps at 0 and the camera eases to 0.
  it('mercator(0): streamed zoom-out wheel never drops below camera.minZoom', () => {
    // Bounded synchronous rAF: run each scheduled frame inline (so animateZoom
    // converges within the wheel handler's synchronous call) with a hard frame
    // cap so a non-converging loop can't hang the test.
    let frames = 0
    ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
      cb: FrameRequestCallback,
    ) => {
      if (frames++ < 2000) cb(0)
      return 0
    }

    const cam = makeFlatCamera(0, 10)
    cam.minZoom = 8
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, () => ({ projectionName: 'mercator' }))
    try {
      // deltaY>0 = wheel down = zoom OUT. Fire enough to overshoot the floor by
      // a wide margin (each event moves the target by at most 1 zoom level).
      for (let i = 0; i < 40; i++) {
        fire('wheel', {
          clientX: 400,
          clientY: 400,
          deltaY: +120,
          deltaMode: 0,
          preventDefault() {},
        })
      }
      expect(
        cam.zoom,
        `mercator: wheel zoom-out fell below minZoom (zoom=${cam.zoom}, minZoom=${cam.minZoom})`,
      ).toBeGreaterThanOrEqual(8)
      expect(Number.isFinite(cam.zoom), 'mercator: zoom went non-finite after streamed wheel').toBe(
        true,
      )
    } finally {
      ctrl.detach()
    }
  })
})

// ════════════════════════════════════════════════════════════════════════
// 2C — InteractionController.clientToLngLat routing (the #200 projType gate).
// ════════════════════════════════════════════════════════════════════════
describe('GATE 2C — InteractionController.clientToLngLat routing (1/2/6 finite via unprojectToLonLat; globeMode finite via ray↔sphere; untilted 3/4/5 null)', () => {
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
      getPickTextureDevice: () => null,
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
      expect(
        ll,
        `${name}: clientToLngLat returned null (the #200 1/2/6 branch was not reached)`,
      ).not.toBeNull()
      expect(
        Number.isFinite(ll![0]) && Number.isFinite(ll![1]),
        `${name}: clientToLngLat not finite ${ll}`,
      ).toBe(true)
      // Sanity: the recovered point is near the camera centre (20,30) for an
      // on-canvas pixel — bound it loosely so this is a wiring check, not a
      // precision re-test of unprojectToLonLat (G1 owns that).
      expect(Math.abs(ll![0] - 20), `${name}: lon ${ll![0]} far from centre`).toBeLessThan(60)
      expect(Math.abs(ll![1] - 30), `${name}: lat ${ll![1]} far from centre`).toBeLessThan(60)
    })
  }

  // GLOBE MODE (true globe 7 — same path serves the tilted discs the render
  // loop promotes to projType 7 + globeMode): clientToLngLat now routes
  // through the ray↔sphere inverse (#10/#11) and returns the REAL lon/lat
  // under the cursor (was null → [NaN,NaN] event coordinates); off the limb
  // it stays null (no ground under the pointer).
  it('globe(7): clientToLngLat returns finite on-sphere lon/lat; off-limb → null', () => {
    const cam = makeFlatCamera(7, 2)
    cam.globeMode = true
    const ic = makeInteractionController(cam, 'globe')
    const ll = ic.clientToLngLat(500, 450)
    expect(
      ll,
      'globe: clientToLngLat returned null on the visible sphere (the globeMode branch was not reached)',
    ).not.toBeNull()
    expect(
      Number.isFinite(ll![0]) && Number.isFinite(ll![1]),
      `globe: clientToLngLat not finite ${ll}`,
    ).toBe(true)
    // Near the (20,30) camera centre for an on-canvas pixel — a wiring check,
    // not a precision re-test (G5c/G5d pin the inverse's fidelity).
    expect(Math.abs(ll![0] - 20), `globe: lon ${ll![0]} far from centre`).toBeLessThan(60)
    expect(Math.abs(ll![1] - 30), `globe: lat ${ll![1]} far from centre`).toBeLessThan(60)
    // Off the limb: at z0 the sphere subtends a small disc; the canvas-corner
    // ray misses it → null (the [NaN,NaN] coercion stays for empty space).
    cam.zoom = 0
    const off = ic.clientToLngLat(2, 2)
    expect(off, `globe: corner pixel at z0 should miss the limb, got ${off}`).toBeNull()
  })

  // UNTILTED 3/4/5 (flat disc set): still unsupported — the flat-disc inverse
  // is the SEPARATE #9 contract (globeMode is false at pitch 0, so the
  // ray↔sphere branch does not apply). Pins that the globe wiring did NOT
  // silently start returning a wrong (flat-Mercator-misinterpreted) coord.
  const UNSUPPORTED: Array<[number, string]> = [
    [3, 'orthographic'],
    [4, 'azimuthal_equidistant'],
    [5, 'stereographic'],
  ]
  for (const [projType, name] of UNSUPPORTED) {
    it(`${name}(${projType}): clientToLngLat returns null (untilted disc inverse deferred to #9 — not silently wrong)`, () => {
      const cam = makeFlatCamera(projType)
      // The projection name the controller reads is not 'mercator' for these,
      // so even the legacy fallback arm returns null.
      const ic = makeInteractionController(cam, name)
      const ll = ic.clientToLngLat(500, 450)
      expect(
        ll,
        `${name}: clientToLngLat should be null for the deferred untilted disc set, got ${ll}`,
      ).toBeNull()
    })
  }
})
