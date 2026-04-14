// ═══ Map Controllers — 프로젝션에 따른 카메라 조작 ═══

import type { Camera } from './camera'

export interface Controller {
  name: string
  attach(canvas: HTMLCanvasElement, camera: Camera, getState: () => ControllerState): void
  detach(): void
}

export interface ControllerState {
  projectionName: string
  /** For orthographic: update center lon/lat and rebuild */
  setProjectionCenter?: (lon: number, lat: number) => void
}

// ═══ PanZoom Controller — 평면 지도용 (Mercator, Equirectangular, Natural Earth) ═══

export class PanZoomController implements Controller {
  name = 'panzoom'
  private cleanup: (() => void) | null = null

  attach(canvas: HTMLCanvasElement, camera: Camera, _getState: () => ControllerState): void {
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
    let lastX = 0
    let lastY = 0

    // Touch state for pinch-to-zoom
    const activePointers = new Map<number, { x: number; y: number }>()
    let lastPinchDist = 0

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
          camera.zoomAt(1, e.clientX, e.clientY, canvas.width, canvas.height)
          lastTapTime = 0
          return
        }
        lastTapTime = now
        lastTapX = e.clientX
        lastTapY = e.clientY
      }
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      canvas.setPointerCapture(e.pointerId)

      if (activePointers.size === 1) {
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
          camera.zoomAt(delta, center.x, center.y, canvas.width, canvas.height)
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
        camera.pan(dx, dy, canvas.width, canvas.height)
      }
    }

    const onPointerUp = (e: PointerEvent) => {
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
        lastPinchDist = 0
        panVelX = 0; panVelY = 0
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
      const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.003)
      targetZoom = Math.max(0, Math.min(22, targetZoom + Math.max(-1, Math.min(1, delta))))
      zoomScreenX = e.clientX
      zoomScreenY = e.clientY
      if (!animating) {
        animating = true
        animateZoom()
      }
    }

    const sPointerDown = safe('pointerdown', onPointerDown)
    const sPointerMove = safe('pointermove', onPointerMove)
    const sPointerUp = safe('pointerup', onPointerUp)
    const sPointerCancel = safe('pointercancel', onPointerCancel)
    const sWheel = safe('wheel', onWheel)

    canvas.addEventListener('pointerdown', sPointerDown)
    canvas.addEventListener('pointermove', sPointerMove)
    canvas.addEventListener('pointerup', sPointerUp)
    canvas.addEventListener('pointercancel', sPointerCancel)
    canvas.addEventListener('wheel', sWheel, { passive: false })

    this.cleanup = () => {
      canvas.removeEventListener('pointerdown', sPointerDown)
      canvas.removeEventListener('pointermove', sPointerMove)
      canvas.removeEventListener('pointerup', sPointerUp)
      canvas.removeEventListener('pointercancel', sPointerCancel)
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

  attach(canvas: HTMLCanvasElement, camera: Camera, getState: () => ControllerState): void {
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
          camera.zoomAt(delta, center.x, center.y, canvas.width, canvas.height)
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
      camera.zoomAt(delta, e.clientX, e.clientY, canvas.width, canvas.height)
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
