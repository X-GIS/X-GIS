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

    const onPointerDown = (e: PointerEvent) => {
      isDragging = true
      lastX = e.clientX
      lastY = e.clientY
      canvas.setPointerCapture(e.pointerId)
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging) return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
      camera.pan(dx, dy, canvas.width, canvas.height)
    }

    const onPointerUp = () => {
      isDragging = false
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? -0.5 : 0.5
      camera.zoomAt(delta, e.clientX, e.clientY, canvas.width, canvas.height)
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    this.cleanup = () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }

  detach(): void {
    this.cleanup?.()
    this.cleanup = null
  }
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

    const scheduleRebuild = () => {
      if (this.rebuildTimer) clearTimeout(this.rebuildTimer)
      this.rebuildTimer = setTimeout(() => {
        const state = getState()
        state.setProjectionCenter?.(this.centerLon, this.centerLat)
      }, 50) // 50ms debounce
    }

    const onPointerDown = (e: PointerEvent) => {
      isDragging = true
      lastX = e.clientX
      lastY = e.clientY
      canvas.setPointerCapture(e.pointerId)
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging) return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY

      // 드래그 → 지구본 회전 (표면을 잡고 끄는 느낌)
      // 오른쪽 드래그 → 표면이 오른쪽으로 → 중심점은 서쪽으로 이동
      const sensitivity = 0.4
      this.centerLon -= dx * sensitivity
      this.centerLat += dy * sensitivity

      // 위도 클램프
      this.centerLat = Math.max(-89, Math.min(89, this.centerLat))

      // 경도 래핑
      if (this.centerLon > 180) this.centerLon -= 360
      if (this.centerLon < -180) this.centerLon += 360

      // 프로젝션 중심 업데이트 → GPU uniform이므로 즉시 (재테셀레이션 없음!)
      const state = getState()
      state.setProjectionCenter?.(this.centerLon, this.centerLat)
    }

    const onPointerUp = () => {
      isDragging = false
      // 드래그 끝나면 즉시 최종 rebuild
      if (this.rebuildTimer) clearTimeout(this.rebuildTimer)
      const state = getState()
      state.setProjectionCenter?.(this.centerLon, this.centerLat)
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? -0.3 : 0.3
      camera.zoomAt(delta, e.clientX, e.clientY, canvas.width, canvas.height)
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    this.cleanup = () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
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
