// ═══ Map Camera — 줌/패닝/회전/피치 ═══

import { lonLatToMercator } from '../loader/geojson'
import { WORLD_MERC } from './gpu-shared'

export class Camera {
  /** Camera center in Web Mercator coordinates */
  centerX: number
  centerY: number
  /** Zoom level (0 = whole world, higher = closer) */
  zoom: number
  /** Map rotation in degrees (0 = north up, clockwise positive) */
  bearing = 0
  /** Camera pitch/tilt in degrees (0 = top-down, 85 = nearly horizontal) */
  pitch = 0

  /** Perspective field of view in degrees */
  static readonly FOV = 45

  constructor(lon = 0, lat = 0, zoom = 2) {
    const [mx, my] = lonLatToMercator(lon, lat)
    this.centerX = mx
    this.centerY = my
    this.zoom = zoom
  }

  /** Get the view-projection matrix as Float32Array (column-major 4x4) */
  getMatrix(canvasWidth: number, canvasHeight: number): Float32Array {
    // Scale: at zoom 0, the whole world (~40M meters) fits in the viewport
    // Each zoom level doubles the scale
    const metersPerPixel = (40075016.686 / 256) / Math.pow(2, this.zoom)
    const scaleX = 2 / (canvasWidth * metersPerPixel)
    const scaleY = 2 / (canvasHeight * metersPerPixel)

    // Translation: move camera center to origin
    const tx = -this.centerX * scaleX
    const ty = -this.centerY * scaleY

    // Column-major 4x4 orthographic matrix
    // prettier-ignore
    return new Float32Array([
      scaleX, 0,      0, 0,
      0,      scaleY, 0, 0,
      0,      0,      1, 0,
      tx,     ty,     0, 1,
    ])
  }

  // Preallocated RTC matrix (reused every frame)
  private rtcMatrix = new Float32Array(16)

  /** RTC matrix: perspective projection × view (pitch + bearing).
   *  When pitch=0, reduces to the same orthographic-like result as before. */
  getRTCMatrix(canvasWidth: number, canvasHeight: number): Float32Array {
    const metersPerPixel = (40075016.686 / 256) / Math.pow(2, this.zoom)
    const m = this.rtcMatrix

    if (this.pitch < 0.1) {
      // pitch ≈ 0: fast path — pure orthographic (exact same as before)
      const scaleX = 2 / (canvasWidth * metersPerPixel)
      const scaleY = 2 / (canvasHeight * metersPerPixel)
      const rad = -this.bearing * Math.PI / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      m[0] = scaleX * cos;  m[1] = scaleY * sin;  m[2] = 0; m[3] = 0
      m[4] = -scaleX * sin; m[5] = scaleY * cos;  m[6] = 0; m[7] = 0
      m[8] = 0;             m[9] = 0;             m[10] = 1; m[11] = 0
      m[12] = 0;            m[13] = 0;            m[14] = 0; m[15] = 1
      return m
    }

    // ── Perspective path ──
    // MVP = Perspective × Translate(0,0,-alt) × RotateX(pitch) × RotateZ(bearing)
    // Applied right-to-left: bearing → pitch → move camera up → project

    const fovRad = Camera.FOV * Math.PI / 180
    const halfFov = fovRad / 2
    const aspect = canvasWidth / canvasHeight
    const pitchRad = this.pitch * Math.PI / 180
    const bearingRad = -this.bearing * Math.PI / 180

    // Camera altitude in Mercator meters
    const viewHeightMeters = canvasHeight * metersPerPixel
    const altitude = viewHeightMeters / 2 / Math.tan(halfFov)

    // Tighter near/far for better depth precision
    // Near: close enough to not clip nearby geometry
    // Far: just enough to cover visible ground at max pitch
    const groundDist = altitude / Math.max(Math.cos(pitchRad), 0.01)
    const near = altitude * 0.5
    const far = groundDist * 3

    // Helper: multiply two column-major 4×4 matrices (A × B), reuses tmp array
    const tmp = Camera._mulTmp
    const mul = (a: number[], b: number[]): number[] => {
      for (let i = 0; i < 16; i++) tmp[i] = 0
      for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++)
          for (let k = 0; k < 4; k++)
            tmp[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
      const result = [...tmp] // copy because mul is chained
      return result
    }

    // Perspective matrix (column-major)
    const f = 1 / Math.tan(halfFov)
    const nf = 1 / (near - far)
    const P = [
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ]

    // Translate(0, 0, -altitude)
    const T = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, -altitude, 1,
    ]

    // RotateX(-pitch) — tilt camera backward (look down at map from ahead)
    const cp = Math.cos(-pitchRad), sp = Math.sin(-pitchRad)
    const Rx = [
      1, 0, 0, 0,
      0, cp, sp, 0,
      0, -sp, cp, 0,
      0, 0, 0, 1,
    ]

    // RotateZ(bearing)
    const cb = Math.cos(bearingRad), sb = Math.sin(bearingRad)
    const Rz = [
      cb, sb, 0, 0,
      -sb, cb, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]

    // MVP = P × T × Rx × Rz  (right-to-left: bearing → pitch → translate → project)
    const MVP = mul(P, mul(T, mul(Rx, Rz)))

    for (let i = 0; i < 16; i++) m[i] = MVP[i]
    return m
  }

  // Mercator Y limit: ±85.051129° → ±20037508.34m
  private static readonly MAX_Y = 20037508.34
  private static _mulTmp = new Array(16).fill(0)

  /** Compute the maximum camera Y offset for the current zoom (content stays on screen) */
  private maxCameraY(canvasHeight: number): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const metersPerPixel = (40075016.686 / 256) / Math.pow(2, this.zoom)
    const visibleHalf = (canvasHeight / dpr) * metersPerPixel / 2
    // Camera can move until the Mercator edge reaches the screen edge
    return Math.max(0, Camera.MAX_Y - visibleHalf)
  }

  /** Pan by CSS pixels (clientX/clientY delta), accounting for map rotation */
  pan(dx: number, dy: number, canvasWidth: number, canvasHeight: number): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const metersPerPhysicalPixel = (40075016.686 / 256) / Math.pow(2, this.zoom)
    const metersPerCSSPixel = metersPerPhysicalPixel * dpr

    // Rotate screen delta by bearing to get map-space delta
    const rad = this.bearing * Math.PI / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const mapDx = dx * cos + dy * sin
    const mapDy = -dx * sin + dy * cos

    this.centerX -= mapDx * metersPerCSSPixel
    // Wrap X to stay within one world width (prevents infinite drift)
    const halfWorld = WORLD_MERC / 2
    if (this.centerX > halfWorld) this.centerX -= WORLD_MERC
    else if (this.centerX < -halfWorld) this.centerX += WORLD_MERC
    const maxY = this.maxCameraY(canvasHeight)
    const newY = this.centerY + mapDy * metersPerCSSPixel
    this.centerY = Math.max(-maxY, Math.min(maxY, newY))
  }

  /** Rotate by delta degrees */
  rotate(deltaDeg: number): void {
    this.bearing = ((this.bearing + deltaDeg) % 360 + 360) % 360
  }

  /** Reset bearing to north-up */
  resetBearing(): void {
    this.bearing = 0
  }

  /** Zoom by delta at CSS screen position (clientX/clientY) */
  zoomAt(delta: number, screenX: number, screenY: number, canvasWidth: number, canvasHeight: number): void {
    const oldZoom = this.zoom
    this.zoom = Math.max(0, Math.min(22, this.zoom + delta))

    // Use CSS dimensions for offset calculation (screenX/Y are CSS coordinates)
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const cssWidth = canvasWidth / dpr
    const cssHeight = canvasHeight / dpr

    const oldMPP = (40075016.686 / 256) / Math.pow(2, oldZoom)
    const newMPP = (40075016.686 / 256) / Math.pow(2, this.zoom)

    const offsetX = (screenX - cssWidth / 2)
    const offsetY = -(screenY - cssHeight / 2)

    this.centerX += offsetX * (oldMPP - newMPP)
    this.centerY += offsetY * (oldMPP - newMPP)
    // Clamp after zoom: visible area changes with zoom level
    const maxY = this.maxCameraY(canvasHeight)
    this.centerY = Math.max(-maxY, Math.min(maxY, this.centerY))
  }
}
