// ═══ Map Camera — 줌/패닝/회전/피치 ═══

import { lonLatToMercator } from '../loader/geojson'
import { WORLD_MERC } from './gpu-shared'
import { getMaxDpr } from './gpu'
import { computeLogDepthFc } from './wgsl-log-depth'

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
  /** Upper bound for `zoom`. Set by the Map based on source.maxLevel so
   *  that user pan/zoom input and hash restoration can't push us past the
   *  data's usable range (beyond which tile-local float32 precision and
   *  sub-tile generation cost both blow up). Default 22 = "effectively
   *  unlimited" for high-detail sources. */
  maxZoom = 22

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

  /** Core matrix + far-plane math. Writes the MVP into `this.rtcMatrix`
   *  and returns the far-plane value. Private helper shared by
   *  getRTCMatrix (matrix only) and getFrameView (matrix + far + fc). */
  private _buildRTCMatrix(canvasWidth: number, canvasHeight: number): number {
    const metersPerPixel = (40075016.686 / 256) / Math.pow(2, this.zoom)
    const m = this.rtcMatrix

    // ── Always use perspective path (no ortho/perspective discontinuity) ──
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

    // Near/far planes: cover all visible ground including horizon
    // maxViewAngle = angle from vertical to the top of the screen ray
    // When pitch + halfFov >= 90°, the top of the screen is past the horizon
    const maxViewAngle = Math.min(pitchRad + halfFov, Math.PI / 2 - 0.01)
    const farthestGround = altitude / Math.cos(maxViewAngle)
    // Near plane: 1% of altitude, but never smaller than 1 m. Log-depth
    // preserves precision at any near/far ratio, so the tiny floor only
    // protects against primitive clipping when the camera dips below ~1 m
    // above the ground (zoom ~22 + pitch 0).
    const near = Math.max(1.0, altitude * 0.01)
    const far = farthestGround * 1.5

    // Multiply two column-major 4×4 matrices into `out` array
    const mul4 = (out: number[], a: number[], b: number[]) => {
      for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++) {
          let s = 0
          for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
          out[c * 4 + r] = s
        }
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
    const t1 = Camera._t1, t2 = Camera._t2
    mul4(t1, Rx, Rz)      // t1 = Rx × Rz
    mul4(t2, T, t1)        // t2 = T × (Rx × Rz)
    mul4(Camera._t3, P, t2) // t3 = P × T × Rx × Rz

    for (let i = 0; i < 16; i++) m[i] = Camera._t3[i]
    return far
  }

  /** RTC matrix: perspective projection × view (pitch + bearing).
   *  When pitch=0, reduces to the same orthographic-like result as before.
   *  Discards the far-plane value — use getFrameView() when you also
   *  need far / log-depth. */
  getRTCMatrix(canvasWidth: number, canvasHeight: number): Float32Array {
    this._buildRTCMatrix(canvasWidth, canvasHeight)
    return this.rtcMatrix
  }

  /** Build the matrix + far + log-depth factor in a single call. No hidden
   *  state — callers get the far value directly and pass it to whatever
   *  uniform or shader needs it.
   *
   *  Note: `matrix` is a reference to the camera's preallocated
   *  `rtcMatrix` buffer (shared with getRTCMatrix). Copy the contents
   *  into your own uniform immediately; a subsequent call from the same
   *  camera overwrites this buffer. */
  getFrameView(canvasWidth: number, canvasHeight: number): {
    matrix: Float32Array
    far: number
    logDepthFc: number
  } {
    const far = this._buildRTCMatrix(canvasWidth, canvasHeight)
    return { matrix: this.rtcMatrix, far, logDepthFc: computeLogDepthFc(far) }
  }

  // Mercator Y limit: ±85.051129° → ±20037508.34m
  private static readonly MAX_Y = 20037508.34
  private static _t1 = new Array(16).fill(0)
  private static _t2 = new Array(16).fill(0)
  private static _t3 = new Array(16).fill(0)

  // ── MVP Inverse (for screen → world unprojection) ──
  private rtcMatrixInv = new Float32Array(16)

  /** Get the inverse of the RTC matrix (cached per frame) */
  getRTCMatrixInverse(canvasWidth: number, canvasHeight: number): Float32Array {
    const mvp = this.getRTCMatrix(canvasWidth, canvasHeight)
    invert4x4(mvp, this.rtcMatrixInv)
    return this.rtcMatrixInv
  }

  /** Unproject screen pixel to z=0 world plane (RTC-relative).
   *  Returns [x, y] in projection meters relative to camera center, or null if behind horizon. */
  unprojectToZ0(screenX: number, screenY: number, canvasWidth: number, canvasHeight: number): [number, number] | null {
    const inv = this.getRTCMatrixInverse(canvasWidth, canvasHeight)
    const ndcX = (screenX / canvasWidth) * 2 - 1
    const ndcY = 1 - (screenY / canvasHeight) * 2

    // Ray from near to far plane
    const n = mulVec4(inv, [ndcX, ndcY, -1, 1])
    const f = mulVec4(inv, [ndcX, ndcY, 1, 1])
    // Perspective divide
    const nx = n[0] / n[3], ny = n[1] / n[3], nz = n[2] / n[3]
    const fx = f[0] / f[3], fy = f[1] / f[3], fz = f[2] / f[3]

    // Intersect with z=0 plane
    const dz = fz - nz
    if (Math.abs(dz) < 1e-10) return null
    const t = -nz / dz
    if (t < 0) return null // behind camera

    return [nx + t * (fx - nx), ny + t * (fy - ny)]
  }

  /** Compute the maximum camera Y offset for the current zoom (content stays on screen) */
  private maxCameraY(canvasHeight: number): number {
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
    const metersPerPixel = (40075016.686 / 256) / Math.pow(2, this.zoom)
    const visibleHalf = (canvasHeight / dpr) * metersPerPixel / 2
    // Camera can move until the Mercator edge reaches the screen edge
    return Math.max(0, Camera.MAX_Y - visibleHalf)
  }

  /** Pan by CSS pixels (clientX/clientY delta), accounting for map rotation */
  pan(dx: number, dy: number, _canvasWidth: number, canvasHeight: number): void {
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
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
    this.zoom = Math.max(0, Math.min(this.maxZoom, this.zoom + delta))

    // Use CSS dimensions for offset calculation (screenX/Y are CSS coordinates)
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
    const cssWidth = canvasWidth / dpr
    const cssHeight = canvasHeight / dpr

    const oldMPP = (40075016.686 / 256) / Math.pow(2, oldZoom)
    const newMPP = (40075016.686 / 256) / Math.pow(2, this.zoom)

    // When pitched, zoom toward screen center only (perspective makes
    // screen-to-world mapping non-linear, causing jitter with offset zoom)
    if (this.pitch > 1) {
      // No center offset when pitched — zoom is centered
    } else {
      const offsetX = (screenX - cssWidth / 2)
      const offsetY = -(screenY - cssHeight / 2)
      this.centerX += offsetX * (oldMPP - newMPP)
      this.centerY += offsetY * (oldMPP - newMPP)
    }
    // Clamp after zoom: visible area changes with zoom level
    const maxY = this.maxCameraY(canvasHeight)
    this.centerY = Math.max(-maxY, Math.min(maxY, this.centerY))
  }
}

// ═══ Matrix Utilities ═══

/** Multiply 4×4 matrix (column-major) by vec4 */
function mulVec4(m: Float32Array, v: number[]): number[] {
  return [
    m[0]*v[0] + m[4]*v[1] + m[8]*v[2] + m[12]*v[3],
    m[1]*v[0] + m[5]*v[1] + m[9]*v[2] + m[13]*v[3],
    m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]*v[3],
    m[3]*v[0] + m[7]*v[1] + m[11]*v[2] + m[15]*v[3],
  ]
}

/** Invert a 4×4 column-major matrix. Writes result into `out`. */
function invert4x4(m: Float32Array, out: Float32Array): boolean {
  const a00=m[0],a01=m[1],a02=m[2],a03=m[3]
  const a10=m[4],a11=m[5],a12=m[6],a13=m[7]
  const a20=m[8],a21=m[9],a22=m[10],a23=m[11]
  const a30=m[12],a31=m[13],a32=m[14],a33=m[15]

  const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10
  const b03=a01*a12-a02*a11, b04=a01*a13-a03*a11, b05=a02*a13-a03*a12
  const b06=a20*a31-a21*a30, b07=a20*a32-a22*a30, b08=a20*a33-a23*a30
  const b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32

  let det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06
  if (Math.abs(det) < 1e-15) return false
  det = 1 / det

  out[0]  = (a11*b11 - a12*b10 + a13*b09) * det
  out[1]  = (a02*b10 - a01*b11 - a03*b09) * det
  out[2]  = (a31*b05 - a32*b04 + a33*b03) * det
  out[3]  = (a22*b04 - a21*b05 - a23*b03) * det
  out[4]  = (a12*b08 - a10*b11 - a13*b07) * det
  out[5]  = (a00*b11 - a02*b08 + a03*b07) * det
  out[6]  = (a32*b02 - a30*b05 - a33*b01) * det
  out[7]  = (a20*b05 - a22*b02 + a23*b01) * det
  out[8]  = (a10*b10 - a11*b08 + a13*b06) * det
  out[9]  = (a01*b08 - a00*b10 - a03*b06) * det
  out[10] = (a30*b04 - a31*b02 + a33*b00) * det
  out[11] = (a21*b02 - a20*b04 - a23*b00) * det
  out[12] = (a11*b07 - a10*b09 - a12*b06) * det
  out[13] = (a00*b09 - a01*b07 + a02*b06) * det
  out[14] = (a31*b01 - a30*b03 - a32*b00) * det
  out[15] = (a20*b03 - a21*b01 + a22*b00) * det
  return true
}
