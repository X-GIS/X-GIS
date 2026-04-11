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
        isDragging = true
        lastX = e.clientX
        lastY = e.clientY
      } else if (activePointers.size === 2) {
        // Start pinch — calculate initial distance
        isDragging = false
        lastPinchDist = getPinchDistance(activePointers)
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (activePointers.size === 2) {
        // Pinch zoom
        const dist = getPinchDistance(activePointers)
        if (lastPinchDist > 0) {
          const scale = dist / lastPinchDist
          const delta = (scale - 1) * 3
          const center = getPinchCenter(activePointers)
          camera.zoomAt(delta, center.x, center.y, canvas.width, canvas.height)
        }
        lastPinchDist = dist
      } else if (isDragging && activePointers.size === 1) {
        // Single finger pan
        const dx = e.clientX - lastX
        const dy = e.clientY - lastY
        lastX = e.clientX
        lastY = e.clientY
        camera.pan(dx, dy, canvas.width, canvas.height)
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      activePointers.delete(e.pointerId)
      if (activePointers.size === 0) {
        isDragging = false
        lastPinchDist = 0
      } else if (activePointers.size === 1) {
        // Went from 2 fingers to 1 — restart single-finger drag
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

    // Smooth zoom — lerp to target, no spring overshoot
    let targetZoom = camera.zoom
    let zoomScreenX = 0, zoomScreenY = 0
    let animating = false

    const animateZoom = () => {
      const diff = targetZoom - camera.zoom
      if (Math.abs(diff) < 0.005) {
        if (diff !== 0) camera.zoomAt(diff, zoomScreenX, zoomScreenY, canvas.width, canvas.height)
        animating = false
        return
      }
      camera.zoomAt(diff * 0.2, zoomScreenX, zoomScreenY, canvas.width, canvas.height)
      requestAnimationFrame(animateZoom)
    }

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

function getPinchDistance(pointers: Map<number, { x: number; y: number }>): number {
  const pts = [...pointers.values()]
  if (pts.length < 2) return 0
  const dx = pts[1].x - pts[0].x
  const dy = pts[1].y - pts[0].y
  return Math.sqrt(dx * dx + dy * dy)
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
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null

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
