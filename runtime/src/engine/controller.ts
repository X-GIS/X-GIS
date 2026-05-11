// ═══ Map Controllers — 프로젝션에 따른 카메라 조작 ═══

import type { Camera } from './projection/camera'

export interface Controller {
  name: string
  attach(canvas: HTMLCanvasElement, camera: Camera, getState: () => ControllerState, events?: ControllerEvents): void
  detach(): void
}

export interface ControllerState {
  projectionName: string
  /** For orthographic: update center lon/lat and rebuild */
  setProjectionCenter?: (lon: number, lat: number) => void
}

/** Optional event callbacks the map wires into the controller so the
 *  layer-level event dispatcher can hook pointer activity. None of the
 *  callbacks block the controller's own pan/zoom/rotate handling — they
 *  fire on the same events with filtering applied (click only when no
 *  drag/rotate happened). */
export interface ControllerEvents {
  /** Fires from `pointerup` when the press-release was a click — i.e.
   *  the pointer never travelled past the click deadzone since
   *  `pointerdown`, and no rotation gesture was activated. */
  onClick?: (clientX: number, clientY: number, ev: PointerEvent) => void
  /** Fires on every `pointermove`, regardless of whether a drag is in
   *  progress. Hover dispatch lives downstream and rAF-coalesces. */
  onPointerMove?: (clientX: number, clientY: number, ev: PointerEvent) => void
  /** Fires when the pointer leaves the canvas. Lets hover dispatch
   *  emit a final `mouseleave` so layers don't get stuck thinking the
   *  cursor is still on them. */
  onPointerLeave?: (ev: PointerEvent) => void
  /** Fires on every `pointerdown`. Unlike `onClick`, no eligibility
   *  filtering — a press that turns into a drag still fires this. */
  onPointerDown?: (clientX: number, clientY: number, ev: PointerEvent) => void
  /** Fires on every `pointerup`. Pairs with `onPointerDown`. */
  onPointerUp?: (clientX: number, clientY: number, ev: PointerEvent) => void
  /** Fires on every wheel event. Listeners receive the wheel deltas via
   *  `event.originalEvent.deltaY` etc. The controller's own zoom logic
   *  still runs — listeners should not call `preventDefault` on the
   *  underlying browser event. */
  onWheel?: (clientX: number, clientY: number, ev: WheelEvent) => void
}

/** Movement distance (CSS px) at which a press-release stops being a
 *  click. 4px matches the threshold most browsers use for the synthetic
 *  `click` event after pointer events. */
const CLICK_DEADZONE_PX = 4

// ═══ PanZoom Controller — 평면 지도용 (Mercator, Equirectangular, Natural Earth) ═══

export class PanZoomController implements Controller {
  name = 'panzoom'
  private cleanup: (() => void) | null = null

  attach(canvas: HTMLCanvasElement, camera: Camera, _getState: () => ControllerState, events?: ControllerEvents): void {
    // Wrap event handlers so any throw inside them surfaces with the real
    // stack via console.error instead of bubbling to window.onerror as the
    // useless cross-origin "Script error. @ :0:0" placeholder iOS WebKit
    // substitutes for opaque error events.
    const safe = <T extends (...a: never[]) => unknown>(label: string, fn: T): T =>
      ((...args: never[]) => {
        try { return fn(...args) }
        catch (e) { console.error('[ctrl ' + label + ']', (e as Error)?.stack ?? e) }
      }) as T

    let isDragging = false
    // World anchor for perspective-correct pan — captured at drag
    // start, used by camera.panToScreenAnchor each pointermove.
    let dragAnchor: [number, number] | null = null
    let lastX = 0
    let lastY = 0

    // Touch state for pinch-to-zoom
    const activePointers = new Map<number, { x: number; y: number }>()
    let lastPinchDist = 0

    // Click detection: track press location + cumulative pointer travel
    // since pointerdown. Click fires from pointerup when travel stays
    // under the deadzone AND no rotation gesture activated.
    let pressX = 0
    let pressY = 0
    let pressTravel = 0
    let pressEligible = false   // single-pointer + left-button press only

    // Double-tap zoom
    let lastTapTime = 0
    let lastTapX = 0
    let lastTapY = 0

    const onPointerDown = (e: PointerEvent) => {
      // Double-tap detection (single finger only)
      if (activePointers.size === 0) {
        const now = performance.now()
        const dt = now - lastTapTime
        const dist = Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY)
        if (dt < 300 && dist < 30) {
          // Double tap → zoom in
          const rDt = canvas.getBoundingClientRect()
          camera.zoomAt(1, e.clientX - rDt.left, e.clientY - rDt.top, canvas.width, canvas.height)
          lastTapTime = 0
          return
        }
        lastTapTime = now
        lastTapX = e.clientX
        lastTapY = e.clientY
      }
      events?.onPointerDown?.(e.clientX, e.clientY, e)

      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      canvas.setPointerCapture(e.pointerId)

      if (activePointers.size === 1) {
        // Click eligibility: only single-pointer left-button presses
        // count. Right-click (rotate) and multi-touch are excluded.
        pressEligible = e.button === 0 && !e.ctrlKey
        pressX = e.clientX
        pressY = e.clientY
        pressTravel = 0

        // Right-click or Ctrl+click → prepare rotate mode (activated on move)
        if (e.button === 2 || e.ctrlKey) {
          isRotatePending = true
          isRotating = false
          isDragging = false
          rotateStartX = e.clientX
          rotateStartY = e.clientY
          rotateActivated = false
        } else {
          isDragging = true
          isRotating = false
          lastX = e.clientX
          lastY = e.clientY
          lastMoveTime = performance.now()
          panVelX = 0; panVelY = 0
          inertiaAnimating = false
          // Capture the ABSOLUTE world point under the cursor at drag
          // start. panToScreenAnchor uses this to keep that exact world
          // location under the cursor as it moves — perspective-correct
          // at any pitch / bearing, idempotent against repeated calls.
          // `null` = ray missed the ground plane (e.g. cursor above
          // horizon at high pitch); fall back to delta-based pan in
          // that case.
          //
          // Convert clientX/Y (VIEWPORT-relative) to canvas-local via
          // bounding rect — the canvas may not sit at viewport (0,0)
          // (header / editor pane / etc), and unprojectToZ0 expects
          // coords in [0, canvas.width / canvas.height].
          const dprNow = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 8) : 1
          const r0 = canvas.getBoundingClientRect()
          const rel = camera.unprojectToZ0(
            (e.clientX - r0.left) * dprNow, (e.clientY - r0.top) * dprNow,
            canvas.width, canvas.height, dprNow,
          )
          dragAnchor = rel
            ? [camera.centerX + rel[0], camera.centerY + rel[1]]
            : null
        }
      } else if (activePointers.size === 2) {
        isDragging = false
        isRotating = false
        lastPinchDist = getPinchDistance(activePointers)
        lastPinchAngle = getPinchAngle(activePointers)
        lastPinchCenterY = getPinchCenter(activePointers).y
      }
    }

    // Prevent context menu on right-click
    canvas.addEventListener('contextmenu', safe('contextmenu', (e: Event) => e.preventDefault()))

    // Pan inertia
    let panVelX = 0, panVelY = 0
    let lastMoveTime = 0
    let inertiaAnimating = false

    const MAX_INERTIA_VEL = 15  // cap velocity (CSS px/frame)

    const applyInertia = safe('inertia', () => {
      if (Math.abs(panVelX) < 0.5 && Math.abs(panVelY) < 0.5) {
        inertiaAnimating = false
        return
      }
      camera.pan(panVelX, panVelY, canvas.width, canvas.height)
      panVelX *= 0.90
      panVelY *= 0.90
      requestAnimationFrame(applyInertia)
    })

    let isRotatePending = false  // right-click down, waiting for movement
    let isRotating = false       // actively rotating (after deadzone)
    let rotateActivated = false
    let rotateStartX = 0
    let rotateStartY = 0
    let lastRotateX = 0
    let lastRotateY = 0
    let lastPinchAngle = 0
    let lastPinchCenterY = 0

    const onPointerMove = (e: PointerEvent) => {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

      // Hover dispatch — fires every move regardless of drag/rotate state.
      // Downstream rAF coalesces, so a fast drag still only spends one
      // pickAt per frame.
      events?.onPointerMove?.(e.clientX, e.clientY, e)

      // Update press travel so pointerup can decide click vs drag.
      if (pressEligible) {
        pressTravel = Math.max(pressTravel, Math.hypot(e.clientX - pressX, e.clientY - pressY))
      }

      // Right-click pending → check deadzone to activate
      if (isRotatePending && !isRotating && activePointers.size === 1) {
        const dist = Math.hypot(e.clientX - rotateStartX, e.clientY - rotateStartY)
        if (dist < 3) return
        // Passed deadzone: activate rotation
        isRotatePending = false
        isRotating = true
        rotateActivated = true
        lastRotateX = e.clientX
        lastRotateY = e.clientY
      }

      // Active rotation: bearing (horizontal) + pitch (vertical)
      if (isRotating && activePointers.size === 1) {

        const dx = e.clientX - lastRotateX
        const dy = e.clientY - lastRotateY
        lastRotateX = e.clientX
        lastRotateY = e.clientY

        // Horizontal → bearing rotation
        camera.rotate(-dx * 0.5)
        // Vertical → pitch (drag up = increase pitch, drag down = decrease)
        camera.pitch = Math.max(0, Math.min(85, camera.pitch - dy * 0.3))
        return
      }

      if (activePointers.size === 2) {
        // Two-finger: rotation + pinch zoom + pitch (vertical drag)
        const angle = getPinchAngle(activePointers)
        if (lastPinchAngle !== 0) {
          let delta = angle - lastPinchAngle
          if (delta > 180) delta -= 360
          if (delta < -180) delta += 360
          camera.rotate(delta)
        }
        lastPinchAngle = angle

        const dist = getPinchDistance(activePointers)
        if (lastPinchDist > 0) {
          const scale = dist / lastPinchDist
          const delta = (scale - 1) * 3
          const center = getPinchCenter(activePointers)
          const rPin = canvas.getBoundingClientRect()
          camera.zoomAt(delta, center.x - rPin.left, center.y - rPin.top, canvas.width, canvas.height)
        }
        lastPinchDist = dist

        // Two-finger vertical drag → pitch
        // Only apply when both fingers move in same direction (parallel drag),
        // not during pinch-to-zoom (distance change dominates)
        const center = getPinchCenter(activePointers)
        if (lastPinchCenterY !== 0 && lastPinchDist > 0) {
          const dy = center.y - lastPinchCenterY
          const distChange = Math.abs(dist - lastPinchDist)
          const centerMove = Math.abs(dy)
          // Only pitch if vertical center movement >> distance change (parallel drag)
          if (centerMove > 2 && centerMove > distChange * 2) {
            camera.pitch = Math.max(0, Math.min(85, camera.pitch - dy * 0.3))
          }
        }
        lastPinchCenterY = center.y
      } else if (isDragging && activePointers.size === 1) {
        const dx = e.clientX - lastX
        const dy = e.clientY - lastY
        const now = performance.now()
        const dt = Math.max(1, now - lastMoveTime)

        // Track velocity for inertia (CSS pixels per frame at 60fps)
        panVelX = dx * (16 / dt)
        panVelY = dy * (16 / dt)

        lastX = e.clientX
        lastY = e.clientY
        lastMoveTime = now
        if (dragAnchor) {
          // Perspective-correct pan: keep the world point captured at
          // drag start under the cursor. unprojectToZ0 walks the live
          // MVP, so pitch + bearing are both honoured. Fast cursor
          // moves at high pitch correctly translate more world meters
          // per cursor pixel near the horizon.
          const r1 = canvas.getBoundingClientRect()
          camera.panToScreenAnchor(
            dragAnchor[0], dragAnchor[1],
            e.clientX - r1.left, e.clientY - r1.top,
            canvas.width, canvas.height,
          )
        } else {
          // Anchor missed ground (cursor above horizon at drag start)
          // — fall back to delta-based pan so the user can still drag
          // out of the no-ray-hit region.
          camera.pan(dx, dy, canvas.width, canvas.height)
        }
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      events?.onPointerUp?.(e.clientX, e.clientY, e)

      // Click dispatch: fires before any rotate snap / inertia logic so
      // listener handlers see the most recent camera state. Eligibility
      // gate filters out drags (travel > deadzone) and rotation gestures.
      if (pressEligible && activePointers.has(e.pointerId)
          && pressTravel < CLICK_DEADZONE_PX && !rotateActivated) {
        events?.onClick?.(e.clientX, e.clientY, e)
      }
      pressEligible = false

      activePointers.delete(e.pointerId)
      if (activePointers.size === 0) {
        // Start inertia only for fast flicks, cap velocity
        panVelX = Math.max(-MAX_INERTIA_VEL, Math.min(MAX_INERTIA_VEL, panVelX))
        panVelY = Math.max(-MAX_INERTIA_VEL, Math.min(MAX_INERTIA_VEL, panVelY))
        if (isDragging && (Math.abs(panVelX) > 2 || Math.abs(panVelY) > 2)) {
          if (!inertiaAnimating) {
            inertiaAnimating = true
            applyInertia()
          }
        }
        // Snap bearing on release (pitch is left as-is for smooth control)
        if (isRotating && rotateActivated) {
          // Bearing: snap to nearest 15°
          const SNAP = 15
          let b = ((camera.bearing % 360) + 360) % 360
          let target = Math.round(b / SNAP) * SNAP
          if (target === 360) target = 0
          camera.bearing = target

          // Pitch: only snap to 0 if very close (< 5°)
          if (camera.pitch < 2) camera.pitch = 0
        }
        isDragging = false
        dragAnchor = null
        isRotatePending = false
        isRotating = false
        rotateActivated = false
        lastPinchDist = 0
        lastPinchAngle = 0
        lastPinchCenterY = 0
      } else if (activePointers.size === 1) {
        isDragging = true
        isRotating = false
        const remaining = activePointers.values().next().value!
        lastX = remaining.x
        lastY = remaining.y
        lastMoveTime = performance.now()
        lastPinchDist = 0
        panVelX = 0; panVelY = 0
        // Re-capture the world anchor under the remaining finger.
        // Without this, dragAnchor is whatever was captured at the
        // original 1-finger drag start (before pinch), so the next
        // pointermove asks panToScreenAnchor to place that stale
        // world point under the lifted-to position — a visible jump
        // to the remaining finger's location.
        const dprUp = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 8) : 1
        const rUp = canvas.getBoundingClientRect()
        const relUp = camera.unprojectToZ0(
          (remaining.x - rUp.left) * dprUp, (remaining.y - rUp.top) * dprUp,
          canvas.width, canvas.height, dprUp,
        )
        dragAnchor = relUp
          ? [camera.centerX + relUp[0], camera.centerY + relUp[1]]
          : null
      }
    }

    const onPointerCancel = (e: PointerEvent) => {
      activePointers.delete(e.pointerId)
      if (activePointers.size === 0) {
        isDragging = false
        lastPinchDist = 0
      }
    }

    // Smooth zoom — lerp to target, no spring overshoot
    let targetZoom = camera.zoom
    let zoomScreenX = 0, zoomScreenY = 0
    let animating = false

    const animateZoom = safe('animateZoom', () => {
      const diff = targetZoom - camera.zoom
      if (Math.abs(diff) < 0.005) {
        if (diff !== 0) camera.zoomAt(diff, zoomScreenX, zoomScreenY, canvas.width, canvas.height)
        animating = false
        return
      }
      camera.zoomAt(diff * 0.2, zoomScreenX, zoomScreenY, canvas.width, canvas.height)
      requestAnimationFrame(animateZoom)
    })

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      events?.onWheel?.(e.clientX, e.clientY, e)
      const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.003)
      // CRITICAL: when no zoom animation is running, the cached
      // `targetZoom` may be stale. The controller captures it once
      // at attach time as `camera.zoom` (which is 0 — the default
      // Camera constructor value) BEFORE the demo runner applies
      // the URL hash camera state. So a freshly loaded `#15/...`
      // demo has camera.zoom=15 but targetZoom=0; the first wheel
      // computes diff=-15 and animateZoom does diff*0.2=-3 PER
      // FRAME, dropping the camera straight to z=0 in 5 frames.
      // User reported "초기 로드 줌이 15에서 처음 화면이 시작하고
      // 줌 아웃을 하면 바로 줌 0레벨로 이동" — that's this path.
      // Resync target to the live camera every time a wheel fires
      // and no animation is in flight.
      if (!animating) targetZoom = camera.zoom
      // If the wheel direction reversed relative to the pending animation,
      // drop any overshoot targetZoom accumulated past camera.zoom so the
      // user feels an immediate reversal instead of having to "un-wind" the
      // pending zoom-in before the zoom-out starts.
      const pending = targetZoom - camera.zoom
      if (pending * delta < 0) {
        targetZoom = camera.zoom
      }
      targetZoom = Math.max(0, Math.min(camera.maxZoom, targetZoom + Math.max(-1, Math.min(1, delta))))
      // Canvas-local cursor coords — same reason as the drag anchor
      // above: clientX/Y is viewport-relative, canvas may be offset
      // (header / panel above), and unprojectToZ0 needs coords in
      // canvas-local space to compute the zoom anchor correctly.
      const rWheel = canvas.getBoundingClientRect()
      zoomScreenX = e.clientX - rWheel.left
      zoomScreenY = e.clientY - rWheel.top
      if (!animating) {
        animating = true
        animateZoom()
      }
    }

    const onPointerLeave = (e: PointerEvent) => {
      events?.onPointerLeave?.(e)
    }

    const sPointerDown = safe('pointerdown', onPointerDown)
    const sPointerMove = safe('pointermove', onPointerMove)
    const sPointerUp = safe('pointerup', onPointerUp)
    const sPointerCancel = safe('pointercancel', onPointerCancel)
    const sPointerLeave = safe('pointerleave', onPointerLeave)
    const sWheel = safe('wheel', onWheel)

    canvas.addEventListener('pointerdown', sPointerDown)
    canvas.addEventListener('pointermove', sPointerMove)
    canvas.addEventListener('pointerup', sPointerUp)
    canvas.addEventListener('pointercancel', sPointerCancel)
    canvas.addEventListener('pointerleave', sPointerLeave)
    canvas.addEventListener('wheel', sWheel, { passive: false })

    this.cleanup = () => {
      canvas.removeEventListener('pointerdown', sPointerDown)
      canvas.removeEventListener('pointermove', sPointerMove)
      canvas.removeEventListener('pointerup', sPointerUp)
      canvas.removeEventListener('pointercancel', sPointerCancel)
      canvas.removeEventListener('pointerleave', sPointerLeave)
      canvas.removeEventListener('wheel', sWheel)
    }
  }

  detach(): void {
    this.cleanup?.()
    this.cleanup = null
  }
}

function getPinchDistance(pointers: Map<number, { x: number; y: number }>): number {
  const pts = [...pointers.values()]
  if (pts.length < 2) return 0
  const dx = pts[1].x - pts[0].x
  const dy = pts[1].y - pts[0].y
  return Math.sqrt(dx * dx + dy * dy)
}

function getPinchAngle(pointers: Map<number, { x: number; y: number }>): number {
  const pts = [...pointers.values()]
  if (pts.length < 2) return 0
  return Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * 180 / Math.PI
}

function getPinchCenter(pointers: Map<number, { x: number; y: number }>): { x: number; y: number } {
  const pts = [...pointers.values()]
  if (pts.length < 2) return pts[0] ?? { x: 0, y: 0 }
  return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
}

// ═══ Trackball Controller — 지구본용 (Orthographic) ═══

export class TrackballController implements Controller {
  name = 'trackball'
  private cleanup: (() => void) | null = null
  private centerLon = 0
  private centerLat = 20

  attach(canvas: HTMLCanvasElement, camera: Camera, getState: () => ControllerState, _events?: ControllerEvents): void {
    let isDragging = false
    let lastX = 0
    let lastY = 0

    const activePointers = new Map<number, { x: number; y: number }>()
    let lastPinchDist = 0

    const onPointerDown = (e: PointerEvent) => {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      canvas.setPointerCapture(e.pointerId)

      if (activePointers.size === 1) {
        isDragging = true
        lastX = e.clientX
        lastY = e.clientY
      } else if (activePointers.size === 2) {
        isDragging = false
        lastPinchDist = getPinchDistance(activePointers)
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (activePointers.size === 2) {
        const dist = getPinchDistance(activePointers)
        if (lastPinchDist > 0) {
          const scale = dist / lastPinchDist
          const delta = (scale - 1) * 2
          const center = getPinchCenter(activePointers)
          const rPi2 = canvas.getBoundingClientRect()
          camera.zoomAt(delta, center.x - rPi2.left, center.y - rPi2.top, canvas.width, canvas.height)
        }
        lastPinchDist = dist
      } else if (isDragging && activePointers.size === 1) {
        const dx = e.clientX - lastX
        const dy = e.clientY - lastY
        lastX = e.clientX
        lastY = e.clientY

        const sensitivity = 0.4
        this.centerLon -= dx * sensitivity
        this.centerLat += dy * sensitivity
        this.centerLat = Math.max(-89, Math.min(89, this.centerLat))
        if (this.centerLon > 180) this.centerLon -= 360
        if (this.centerLon < -180) this.centerLon += 360

        const state = getState()
        state.setProjectionCenter?.(this.centerLon, this.centerLat)
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      activePointers.delete(e.pointerId)
      if (activePointers.size === 0) {
        isDragging = false
        lastPinchDist = 0
        const state = getState()
        state.setProjectionCenter?.(this.centerLon, this.centerLat)
      } else if (activePointers.size === 1) {
        isDragging = true
        const remaining = activePointers.values().next().value!
        lastX = remaining.x
        lastY = remaining.y
        lastPinchDist = 0
      }
    }

    const onPointerCancel = (e: PointerEvent) => {
      activePointers.delete(e.pointerId)
      if (activePointers.size === 0) {
        isDragging = false
        lastPinchDist = 0
      }
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? -0.3 : 0.3
      const rW = canvas.getBoundingClientRect()
      camera.zoomAt(delta, e.clientX - rW.left, e.clientY - rW.top, canvas.width, canvas.height)
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerCancel)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    this.cleanup = () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('wheel', onWheel)
    }
  }

  detach(): void {
    this.cleanup?.()
    this.cleanup = null
  }
}

// ═══ 프로젝션에 따라 자동 선택 ═══

export function controllerForProjection(projName: string): Controller {
  switch (projName) {
    case 'orthographic':
      return new TrackballController()
    default:
      return new PanZoomController()
  }
}
