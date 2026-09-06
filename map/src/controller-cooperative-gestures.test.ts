// ═══ #1264 — cooperativeGestures contract gates (MapLibre parity) ═══
//
// TEST-ONLY. Fail-before authored against the target contract (issue #1264):
// stop an embedded map from hijacking page scroll. When enabled, a plain
// wheel does NOT zoom and is NOT preventDefault'd (the page scrolls) while a
// "Ctrl/⌘+scroll to zoom" hint fades in; Ctrl/⌘+wheel still zooms exactly as
// today. A single-finger TOUCH drag does NOT pan (a "two fingers" hint fades
// in); two-finger touch still pinch-zooms/pitches. Default OFF is
// byte-identical to pre-#1264 behaviour, and the flag is read live off
// `ControllerState` (no reattach) — same pattern #1265 established for
// `doubleClickZoomEnabled`/`boxZoomEnabled`.
//
// Idiom matches controller-dblclick-boxzoom.test.ts / controller-interaction-
// gate.test.ts (GATE 2): a stub canvas that REALLY registers listeners so
// synthetic events reach the controller's own handlers, a real Camera +
// PanZoomController, node env (no window/PointerEvent/document — plain-
// object synthetic events satisfy the fields the handlers read). The hint
// overlay additionally needs a `document`, which this node env does not have
// either — a minimal stub `document`/`navigator` (same duck-typing idiom as
// the stub canvas: real enough for controller.ts's `typeof document ===
// 'undefined'` guards to pass and its DOM calls to actually record state) is
// installed for the duration of each `it` that asserts on the hint element,
// and removed afterward so it can't leak into an unrelated test file.
//
// Regression pins (must stay green, unchanged behaviour):
//   - cooperativeGestures OFF (default, and the option simply absent): plain
//     wheel still zooms + still preventDefault's; single-finger (incl. touch)
//     drag still pans. Byte-identical to pre-#1264.
//   - the hint element/stylesheet is never created at all while OFF — so a
//     screenshot harness with the feature off can never see a stray node
//     (module-level style-injection + lazy per-instance element, mirroring
//     the #1265 box-zoom overlay's own "never paints a stray div" guarantee).

import { describe, it, expect } from 'vitest'
import { Camera } from './camera'
import { PanZoomController, type ControllerState } from './controller'

const W = 800,
  H = 800

// ── Stub canvas that REALLY registers listeners (mirrors GATE 2's
//    makeStubCanvas) so synthetic pointerdown/pointermove/pointerup/wheel
//    events reach the controller's own handlers. ──
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
    for (const fn of [...(listeners.get(type) ?? [])]) fn(ev)
  }
  return { canvas, fire }
}

function makeMercCamera(zoom = 6): Camera {
  const cam = new Camera(20, 30, zoom)
  cam.projType = 0
  cam.globeMode = false
  cam.bearing = 0
  cam.pitch = 0
  return cam
}

function ptr(
  pointerId: number,
  clientX: number,
  clientY: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { pointerId, clientX, clientY, button: 0, ctrlKey: false, ...extra }
}

/** Synthetic WheelEvent with a REAL preventDefault that flips a readable
 *  `defaultPrevented` flag — the harness's own oracle for "was the page
 *  scroll released" (#1264's core acceptance line), not a spy. */
function wheelEv(extra: Record<string, unknown> = {}): Record<string, unknown> & {
  defaultPrevented: boolean
} {
  const ev = {
    clientX: 400,
    clientY: 400,
    deltaY: -100,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    preventDefault() {
      ev.defaultPrevented = true
    },
    ...extra,
  }
  return ev as unknown as Record<string, unknown> & { defaultPrevented: boolean }
}

function state(overrides: Partial<ControllerState> = {}): () => ControllerState {
  return () => ({ projectionName: 'mercator', ...overrides })
}

// ── Minimal stub DOM (document/navigator) — same duck-typing idiom as the
//    stub canvas above: real enough that controller.ts's `typeof document
//    === 'undefined'` guards pass and `createElement`/`appendChild`/
//    `setAttribute`/`classList`-free style+attribute writes actually land
//    somewhere inspectable, without pulling in jsdom. ──
interface StubEl {
  tagName: string
  style: Record<string, string>
  textContent: string
  attrs: Record<string, string>
  children: StubEl[]
  setAttribute(k: string, v: string): void
  getAttribute(k: string): string | undefined
  removeAttribute(k: string): void
  appendChild(child: StubEl): void
  remove(): void
}
function makeStubEl(tagName: string): StubEl {
  const el: StubEl = {
    tagName,
    style: {},
    textContent: '',
    attrs: {},
    children: [],
    setAttribute(k, v) {
      el.attrs[k] = v
    },
    getAttribute(k) {
      return el.attrs[k]
    },
    removeAttribute(k) {
      delete el.attrs[k]
    },
    appendChild(child) {
      el.children.push(child)
    },
    remove() {},
  }
  return el
}
// Node's built-in global `navigator` (Node 21+, minimal fetch-API shim) is a
// getter-only accessor property — a plain `globalThis.navigator = …` throws
// ("has only a getter"). `Object.defineProperty` + restoring the ORIGINAL
// descriptor (not just the value) is what actually swaps it safely both ways.
function installStubDom(navigatorPlatform: string | undefined): {
  bodyChildren: StubEl[]
  restore: () => void
} {
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document')
  const prevDocumentDesc = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const hadNavigator = Object.prototype.hasOwnProperty.call(globalThis, 'navigator')
  const prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const bodyChildren: StubEl[] = []
  const headChildren: StubEl[] = []
  Object.defineProperty(globalThis, 'document', {
    value: {
      head: { appendChild: (el: StubEl) => headChildren.push(el) },
      body: { appendChild: (el: StubEl) => bodyChildren.push(el) },
      createElement: (tag: string) => makeStubEl(tag),
    },
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgentData: { platform: navigatorPlatform }, userAgent: navigatorPlatform },
    configurable: true,
    writable: true,
  })
  const restore = () => {
    if (hadDocument && prevDocumentDesc)
      Object.defineProperty(globalThis, 'document', prevDocumentDesc)
    else delete (globalThis as { document?: unknown }).document
    if (hadNavigator && prevNavigatorDesc)
      Object.defineProperty(globalThis, 'navigator', prevNavigatorDesc)
    else delete (globalThis as { navigator?: unknown }).navigator
  }
  return { bodyChildren, restore }
}

// GATE 2B's bounded-synchronous-rAF shim (mirrors controller-dblclick-
// boxzoom.test.ts): runs each scheduled frame INLINE (hard-capped so a
// non-converging loop can't hang the test) so the wheel-zoom smooth-zoom
// ease actually converges within the test instead of throwing
// "requestAnimationFrame is not defined" after the first frame (this node
// env has none) — animateZoom's own `safe()` wrapper swallows that throw, so
// the zoom already changed either way, but the bounded shim keeps the run
// converged + quiet instead of leaving a caught error on stderr.
function installBoundedRAF(): () => void {
  const prev = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
  let frames = 0
  ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
    cb: FrameRequestCallback,
  ) => {
    if (frames++ < 2000) cb(0)
    return 0
  }
  return () => {
    if (prev === undefined)
      delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    else (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = prev
  }
}

describe('#1264 — cooperativeGestures: wheel (MapLibre parity)', () => {
  it('(a) enabled + plain wheel: no zoom change, NOT defaultPrevented, hint element becomes visible', () => {
    const { restore, bodyChildren } = installStubDom('Win32')
    try {
      const cam = makeMercCamera(6)
      const { canvas, fire } = makeStubCanvas()
      const ctrl = new PanZoomController()
      ctrl.attach(canvas, cam, state({ cooperativeGestures: true }))
      try {
        const z0 = cam.zoom
        const ev = wheelEv()
        fire('wheel', ev)

        expect(cam.zoom, 'a blocked plain wheel changed zoom').toBe(z0)
        expect(ev.defaultPrevented, 'a blocked plain wheel called preventDefault').toBe(false)

        // The hint element is lazily created on the FIRST blocked gesture and
        // appended to document.body (mirrors the #1265 box-zoom overlay).
        expect(bodyChildren.length, 'no hint element was appended to document.body').toBe(1)
        const hint = bodyChildren[0]
        expect(hint.style.display, 'hint element is not shown (display)').toBe('block')
        expect(hint.style.opacity, 'hint element is not shown (opacity)').toBe('1')
        expect(hint.textContent, 'hint text is empty').not.toBe('')
        // navigator.platform = 'Win32' → the Windows hint text, not the Mac one.
        expect(hint.textContent).toContain('Ctrl')
      } finally {
        ctrl.detach()
      }
    } finally {
      restore()
    }
  })

  it('(a2) mac platform gets the ⌘ hint text instead of Ctrl', () => {
    const { restore, bodyChildren } = installStubDom('MacIntel')
    try {
      const cam = makeMercCamera(6)
      const { canvas, fire } = makeStubCanvas()
      const ctrl = new PanZoomController()
      ctrl.attach(canvas, cam, state({ cooperativeGestures: true }))
      try {
        fire('wheel', wheelEv())
        expect(bodyChildren[0].textContent).toContain('⌘')
      } finally {
        ctrl.detach()
      }
    } finally {
      restore()
    }
  })

  it('(a3) a CooperativeGesturesOptions override wins over the built-in default text', () => {
    const { restore, bodyChildren } = installStubDom('Win32')
    try {
      const cam = makeMercCamera(6)
      const { canvas, fire } = makeStubCanvas()
      const ctrl = new PanZoomController()
      ctrl.attach(
        canvas,
        cam,
        state({ cooperativeGestures: { windowsHelpText: 'custom hint text' } }),
      )
      try {
        fire('wheel', wheelEv())
        expect(bodyChildren[0].textContent).toBe('custom hint text')
      } finally {
        ctrl.detach()
      }
    } finally {
      restore()
    }
  })

  it('(a4) prefersReducedMotion:true marks the hint [data-reduced] (instant pop, no fade — #1260)', () => {
    const { restore, bodyChildren } = installStubDom('Win32')
    try {
      const cam = makeMercCamera(6)
      const { canvas, fire } = makeStubCanvas()
      const ctrl = new PanZoomController()
      ctrl.attach(canvas, cam, state({ cooperativeGestures: true, prefersReducedMotion: true }))
      try {
        fire('wheel', wheelEv())
        expect(bodyChildren[0].getAttribute('data-reduced')).toBe('')
      } finally {
        ctrl.detach()
      }
    } finally {
      restore()
    }
  })

  it('(b) enabled + Ctrl+wheel: zooms exactly as today AND IS defaultPrevented', () => {
    const restoreRAF = installBoundedRAF()
    try {
      const cam = makeMercCamera(6)
      const { canvas, fire } = makeStubCanvas()
      const ctrl = new PanZoomController()
      ctrl.attach(canvas, cam, state({ cooperativeGestures: true }))
      try {
        const z0 = cam.zoom
        const ev = wheelEv({ ctrlKey: true })
        fire('wheel', ev)
        expect(ev.defaultPrevented, 'a Ctrl+wheel zoom did not preventDefault').toBe(true)
        expect(cam.zoom, 'Ctrl+wheel did not zoom').not.toBe(z0)
      } finally {
        ctrl.detach()
      }
    } finally {
      restoreRAF()
    }
  })

  it('(b2) enabled + Cmd(meta)+wheel: zooms too (⌘ bypass on macOS)', () => {
    const restoreRAF = installBoundedRAF()
    try {
      const cam = makeMercCamera(6)
      const { canvas, fire } = makeStubCanvas()
      const ctrl = new PanZoomController()
      ctrl.attach(canvas, cam, state({ cooperativeGestures: true }))
      try {
        const z0 = cam.zoom
        fire('wheel', wheelEv({ metaKey: true }))
        expect(cam.zoom, 'Cmd+wheel did not zoom').not.toBe(z0)
      } finally {
        ctrl.detach()
      }
    } finally {
      restoreRAF()
    }
  })

  it("(d) disabled (default, option absent): plain wheel still zooms and still preventDefault's — byte-identical regression pin", () => {
    const restoreRAF = installBoundedRAF()
    try {
      const cam = makeMercCamera(6)
      const { canvas, fire } = makeStubCanvas()
      const ctrl = new PanZoomController()
      ctrl.attach(canvas, cam, state()) // no cooperativeGestures key at all
      try {
        const z0 = cam.zoom
        const ev = wheelEv()
        fire('wheel', ev)
        expect(ev.defaultPrevented, 'default-off wheel did not preventDefault (regression)').toBe(
          true,
        )
        expect(cam.zoom, 'default-off plain wheel did not zoom (regression)').not.toBe(z0)
      } finally {
        ctrl.detach()
      }
    } finally {
      restoreRAF()
    }
  })

  it('disabled: no hint element/stylesheet is ever created (no stray DOM node while OFF)', () => {
    const { restore, bodyChildren } = installStubDom('Win32')
    const restoreRAF = installBoundedRAF()
    try {
      const cam = makeMercCamera(6)
      const { canvas, fire } = makeStubCanvas()
      const ctrl = new PanZoomController()
      ctrl.attach(canvas, cam, state({ cooperativeGestures: false }))
      try {
        fire('wheel', wheelEv())
        fire('wheel', wheelEv({ ctrlKey: true }))
        expect(
          bodyChildren.length,
          'a hint element was created despite the feature being OFF',
        ).toBe(0)
      } finally {
        ctrl.detach()
      }
    } finally {
      restoreRAF()
      restore()
    }
  })
})

describe('#1264 — cooperativeGestures: touch drag (MapLibre parity)', () => {
  it('(c) enabled + single-finger TOUCH drag: does not pan, hint element becomes visible', () => {
    const { restore, bodyChildren } = installStubDom('Win32')
    try {
      const cam = makeMercCamera(6)
      const { canvas, fire } = makeStubCanvas()
      const ctrl = new PanZoomController()
      ctrl.attach(canvas, cam, state({ cooperativeGestures: true }))
      try {
        const cx0 = cam.centerX,
          cy0 = cam.centerY
        fire('pointerdown', ptr(1, 300, 300, { pointerType: 'touch' }))
        fire('pointermove', ptr(1, 500, 500, { pointerType: 'touch' }))

        expect(cam.centerX, 'a blocked touch drag panned the camera (centerX)').toBe(cx0)
        expect(cam.centerY, 'a blocked touch drag panned the camera (centerY)').toBe(cy0)

        expect(bodyChildren.length, 'no hint element was appended for the blocked touch drag').toBe(
          1,
        )
        expect(bodyChildren[0].style.display).toBe('block')
        expect(bodyChildren[0].textContent).toContain('two fingers')
      } finally {
        ctrl.detach()
      }
    } finally {
      restore()
    }
  })

  it('(c2) enabled + single-finger MOUSE drag: still pans (only touch is blocked, mouse drag-pan is unaffected)', () => {
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, state({ cooperativeGestures: true }))
    try {
      const cx0 = cam.centerX,
        cy0 = cam.centerY
      fire('pointerdown', ptr(1, 300, 300, { pointerType: 'mouse' }))
      fire('pointermove', ptr(1, 500, 500, { pointerType: 'mouse' }))
      const moved = Math.hypot(cam.centerX - cx0, cam.centerY - cy0)
      expect(moved, 'a mouse drag did not pan while cooperativeGestures was on').toBeGreaterThan(
        1000,
      )
    } finally {
      ctrl.detach()
    }
  })

  it('(c3) enabled + two-finger TOUCH pinch: still zooms (pinch path is unaffected by the single-finger gate)', () => {
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, state({ cooperativeGestures: true }))
    try {
      const z0 = cam.zoom
      // P1=(400,400), P2=(440,400) → dist=40 (seeded on the 2nd pointerdown).
      fire('pointerdown', ptr(1, 400, 400, { pointerType: 'touch' }))
      fire('pointerdown', ptr(2, 440, 400, { pointerType: 'touch' }))
      // Pinch OUT: P2 → (520,400) → dist=120 (3x) → zoom should increase.
      fire('pointermove', ptr(2, 520, 400, { pointerType: 'touch' }))
      expect(
        cam.zoom,
        'a two-finger pinch did not zoom while cooperativeGestures was on',
      ).toBeGreaterThan(z0)
    } finally {
      ctrl.detach()
    }
  })

  // hunt 2026-09-02: #2295 — the pointerup 2→1 handoff re-armed isDragging
  // unconditionally, so the normal END of every pinch (lift one finger) handed
  // the remaining touch finger a drag-pan the #1264 gate had denied it at
  // pointerdown. (c4) pins the blocked case, (c5) pins that the handoff still
  // works when the gate does not apply.
  it('(c4) enabled + pinch then lift one finger: the remaining single TOUCH finger still does not pan (#2295)', () => {
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, state({ cooperativeGestures: true }))
    try {
      fire('pointerdown', ptr(1, 300, 300, { pointerType: 'touch' }))
      fire('pointerdown', ptr(2, 500, 300, { pointerType: 'touch' }))
      fire('pointerup', ptr(2, 500, 300, { pointerType: 'touch' }))
      const cx1 = cam.centerX,
        cy1 = cam.centerY
      fire('pointermove', ptr(1, 350, 300, { pointerType: 'touch' }))
      fire('pointermove', ptr(1, 400, 300, { pointerType: 'touch' }))
      expect(
        cam.centerX,
        'after pinch→one finger, a single touch finger panned the camera (centerX)',
      ).toBe(cx1)
      expect(
        cam.centerY,
        'after pinch→one finger, a single touch finger panned the camera (centerY)',
      ).toBe(cy1)
    } finally {
      ctrl.detach()
    }
  })

  it('(c5) disabled (default): pinch then lift one finger still hands the remaining finger a pan — #4 handoff regression pin', () => {
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, state()) // no cooperativeGestures key at all
    try {
      fire('pointerdown', ptr(1, 300, 300, { pointerType: 'touch' }))
      fire('pointerdown', ptr(2, 500, 300, { pointerType: 'touch' }))
      fire('pointerup', ptr(2, 500, 300, { pointerType: 'touch' }))
      const cx1 = cam.centerX,
        cy1 = cam.centerY
      fire('pointermove', ptr(1, 350, 300, { pointerType: 'touch' }))
      fire('pointermove', ptr(1, 400, 300, { pointerType: 'touch' }))
      const moved = Math.hypot(cam.centerX - cx1, cam.centerY - cy1)
      expect(
        moved,
        'default-off pinch→one-finger handoff did not pan (regression)',
      ).toBeGreaterThan(1000)
    } finally {
      ctrl.detach()
    }
  })

  it('(c6) enabled + pen and touch down, the PEN lifts: the remaining TOUCH finger still does not pan (#2295)', () => {
    // The 2->1 handoff used to ask the cooperativeGestures predicate about `e`,
    // the pointerup of the finger that LEFT. With a pen (or mouse) resting
    // beside a touch finger — a 2-in-1 with a palm down, the reported shape —
    // the answer came back "not touch", the drag armed, and the touch finger
    // panned the map exactly as it did before #2295. (c4) above cannot see it:
    // there both pointers are touch, so the lifted one's type is the remaining
    // one's type by accident.
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, state({ cooperativeGestures: true }))
    try {
      fire('pointerdown', ptr(1, 300, 300, { pointerType: 'pen' }))
      fire('pointerdown', ptr(2, 500, 300, { pointerType: 'touch' }))
      fire('pointerup', ptr(1, 300, 300, { pointerType: 'pen' }))
      const cx1 = cam.centerX,
        cy1 = cam.centerY
      fire('pointermove', ptr(2, 550, 300, { pointerType: 'touch' }))
      fire('pointermove', ptr(2, 600, 300, { pointerType: 'touch' }))
      expect(
        Math.hypot(cam.centerX - cx1, cam.centerY - cy1),
        'the remaining TOUCH finger panned after a pen lifted beside it',
      ).toBe(0)
    } finally {
      ctrl.detach()
    }
  })

  it('(c7) enabled + mouse and touch down, the TOUCH lifts: the remaining MOUSE drag still pans', () => {
    // The mirror of (c6), and the regression the same wrong read introduced:
    // reading the LIFTED touch pointer's type made the predicate deny a drag
    // that a mouse owns. cooperativeGestures only ever blocks touch.
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, state({ cooperativeGestures: true }))
    try {
      fire('pointerdown', ptr(1, 300, 300, { pointerType: 'mouse' }))
      fire('pointerdown', ptr(2, 500, 300, { pointerType: 'touch' }))
      fire('pointerup', ptr(2, 500, 300, { pointerType: 'touch' }))
      const cx1 = cam.centerX,
        cy1 = cam.centerY
      fire('pointermove', ptr(1, 350, 300, { pointerType: 'mouse' }))
      fire('pointermove', ptr(1, 400, 300, { pointerType: 'mouse' }))
      expect(
        Math.hypot(cam.centerX - cx1, cam.centerY - cy1),
        'the remaining MOUSE drag was blocked after a touch pointer lifted beside it',
      ).toBeGreaterThan(1000)
    } finally {
      ctrl.detach()
    }
  })

  it('(d) disabled (default, option absent): single-finger touch drag still pans — byte-identical regression pin', () => {
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    ctrl.attach(canvas, cam, state()) // no cooperativeGestures key at all
    try {
      const cx0 = cam.centerX,
        cy0 = cam.centerY
      fire('pointerdown', ptr(1, 300, 300, { pointerType: 'touch' }))
      fire('pointermove', ptr(1, 500, 500, { pointerType: 'touch' }))
      const moved = Math.hypot(cam.centerX - cx0, cam.centerY - cy0)
      expect(moved, 'default-off touch drag did not pan (regression)').toBeGreaterThan(1000)
    } finally {
      ctrl.detach()
    }
  })
})

describe('#1264 — runtime toggle takes effect without reattach', () => {
  it('(e) flipping the state from off→on between events blocks the NEXT wheel with no reattach', () => {
    const restoreRAF = installBoundedRAF()
    try {
      const cam = makeMercCamera(6)
      const { canvas, fire } = makeStubCanvas()
      const ctrl = new PanZoomController()
      let coop: boolean | { windowsHelpText?: string } = false
      ctrl.attach(canvas, cam, () => ({ projectionName: 'mercator', cooperativeGestures: coop }))
      try {
        const z1 = cam.zoom
        fire('wheel', wheelEv()) // OFF — zooms
        expect(cam.zoom, 'wheel did not zoom while OFF').not.toBe(z1)

        coop = true // runtime flip — same controller instance, no re-attach
        const z2 = cam.zoom
        const ev = wheelEv()
        fire('wheel', ev)
        expect(cam.zoom, 'wheel still zoomed after a live ON flip (no reattach)').toBe(z2)
        expect(ev.defaultPrevented, "wheel still preventDefault'd after a live ON flip").toBe(false)
      } finally {
        ctrl.detach()
      }
    } finally {
      restoreRAF()
    }
  })

  it('(e2) flipping the state from on→off between events restores panning for the NEXT touch drag', () => {
    const cam = makeMercCamera(6)
    const { canvas, fire } = makeStubCanvas()
    const ctrl = new PanZoomController()
    let coop: boolean = true
    ctrl.attach(canvas, cam, () => ({ projectionName: 'mercator', cooperativeGestures: coop }))
    try {
      const cx0 = cam.centerX
      fire('pointerdown', ptr(1, 300, 300, { pointerType: 'touch' }))
      fire('pointermove', ptr(1, 500, 500, { pointerType: 'touch' }))
      expect(cam.centerX, 'touch drag panned while ON').toBe(cx0)
      // release the pointer cleanly before starting a fresh gesture
      fire('pointerup', ptr(1, 500, 500, { pointerType: 'touch' }))

      coop = false // runtime flip — same controller instance, no re-attach
      const cx1 = cam.centerX
      fire('pointerdown', ptr(2, 300, 300, { pointerType: 'touch' }))
      fire('pointermove', ptr(2, 500, 500, { pointerType: 'touch' }))
      const moved = Math.hypot(cam.centerX - cx1, 0)
      expect(moved, 'touch drag still blocked after a live OFF flip (no reattach)').toBeGreaterThan(
        1000,
      )
    } finally {
      ctrl.detach()
    }
  })
})
