// ═══ Camera animation (#1256) — easeTo / flyTo transition math + driver ═══
//
// Fills the CameraController's easeTo/flyTo aliases with real animation:
//
//   easeTo — one eased interpolation of center/zoom/bearing/pitch.
//   flyTo  — the van Wijk & Nuij (2003) optimal pan-and-zoom path: the
//            camera rises along a hyperbolic arc so start and destination
//            both stay in view, then descends (the Google-Earth flight).
//
// Frame model: the animator never writes the camera itself — every tick
// SAMPLES the path and applies it through the host's `jumpTo` (the single
// camera-write authority: maxBounds clamp, pole-limit dual clamp, warn
// contracts all apply per frame), and the TERMINAL tick applies the
// original target through the same jumpTo — so an animated arrival is
// bit-identical to a direct `jumpTo(target)` by construction.
//
// Interpolation spaces: longitude linearly in degrees along the SHORTEST
// wrap (±180-safe); latitude linearly in Mercator-Y meters (screen-true
// vertical motion; a pole-ward globe target beyond the Mercator limit
// saturates along the path and lands exactly via the terminal jumpTo's
// dual clamp); zoom linearly in zoom units (log₂ space); bearing along the
// shortest angular delta; pitch linearly.
//
// Cancellation: any EXTERNAL camera write between ticks (a user gesture, a
// programmatic jumpTo/setCenter) makes the next tick's raw-field snapshot
// mismatch → the animation cancels silently and the external write wins.
// This keeps the animator zero-coupled to the input controller.
//
// The render keep-alive rides the established idiom (`_sceneHasAnimation`,
// the #1254 fade ledger, the #1255 transition registry): the map polls
// `isActive()` in shouldRenderThisFrame and ticks once per rendered frame.

import { WORLD_MERC, TILE_PX, mercatorYToLat, lonLatToMercator } from '@xgis/geo'

export interface CameraTarget {
  lon: number
  lat: number
  zoom: number
  bearing: number
  pitch: number
}

/** Raw camera-field snapshot for the external-move detector. Values are
 *  whatever the host's camera stores (Mercator meters / degrees) — the
 *  animator only ever compares them against its own post-apply read. */
export interface RawCameraSnapshot {
  cx: number
  cy: number
  z: number
  b: number
  p: number
}

export interface CameraAnimHost {
  /** The single camera-write authority (CameraController.jumpTo). */
  jumpTo(opts: { center: [number, number]; zoom: number; bearing: number; pitch: number }): void
  /** Raw camera fields AFTER a jumpTo — stored and compared exactly
   *  (small epsilon) to detect external writes between ticks. */
  readRaw(): RawCameraSnapshot
}

// ─── Easing ────────────────────────────────────────────────────────

/** Cubic-bezier easing solver (CSS timing-function semantics, endpoints
 *  (0,0)/(1,1)). Newton iterations with a bisection fallback — exact
 *  enough (|err| < 1e-6) for animation sampling. */
export function cubicBezierEase(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
): (t: number) => number {
  const ax = 3 * p1x - 3 * p2x + 1
  const bx = 3 * p2x - 6 * p1x
  const cx = 3 * p1x
  const ay = 3 * p1y - 3 * p2y + 1
  const by = 3 * p2y - 6 * p1y
  const cy = 3 * p1y
  const sampleX = (u: number): number => ((ax * u + bx) * u + cx) * u
  const sampleY = (u: number): number => ((ay * u + by) * u + cy) * u
  const sampleDX = (u: number): number => (3 * ax * u + 2 * bx) * u + cx
  return (t: number): number => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    let u = t
    for (let i = 0; i < 6; i++) {
      const x = sampleX(u) - t
      if (Math.abs(x) < 1e-7) return sampleY(u)
      const d = sampleDX(u)
      if (Math.abs(d) < 1e-6) break
      u -= x / d
    }
    let lo = 0
    let hi = 1
    u = t
    while (hi - lo > 1e-7) {
      if (sampleX(u) < t) lo = u
      else hi = u
      u = (lo + hi) / 2
    }
    return sampleY(u)
  }
}

/** MapLibre's default camera easing — the CSS `ease`-like curve. */
export const defaultCameraEase = cubicBezierEase(0.25, 0.1, 0.25, 1)

// ─── Angular / wrap helpers ────────────────────────────────────────

/** Shortest longitude delta from → to, in degrees ∈ (-180, 180]. */
export function shortestLonDelta(from: number, to: number): number {
  let d = (to - from) % 360
  if (d > 180) d -= 360
  if (d <= -180) d += 360
  return d
}

/** Shortest bearing delta from → to, in degrees ∈ (-180, 180]. */
export function shortestBearingDelta(from: number, to: number): number {
  return shortestLonDelta(from, to)
}

// ─── van Wijk & Nuij flight path ───────────────────────────────────

/** The vWN path in (u, w) space: `u` = distance travelled along the
 *  straight ground track (px at the START zoom), `w` = visible span (px,
 *  w0 at start). `S` is the total path parameter; sample with s ∈ [0, S].
 *  Formulation follows van Wijk & Nuij 2003 §3 (the MapLibre flyTo
 *  parameterisation). */
export interface FlyPath {
  S: number
  u(s: number): number
  w(s: number): number
}

export function makeFlyPath(w0: number, w1: number, u1: number, rho: number): FlyPath {
  // Degenerate ground track — pure zoom in place: w moves exponentially,
  // u stays 0 (vWN eq. 12).
  if (Math.abs(u1) < 1e-9) {
    const k = w1 < w0 ? -1 : 1
    const S = Math.abs(Math.log(w1 / w0)) / rho
    return {
      S,
      u: () => 0,
      w: (s) => w0 * Math.exp(k * rho * s),
    }
  }
  const rho2 = rho * rho
  const b = (i: 0 | 1): number => {
    const wi = i === 1 ? w1 : w0
    // vWN eq. 5: b(0) uses +rho²²u1², b(1) uses −rho²²u1² (the `i ? -1 : 1`
    // of the MapLibre parameterisation). Getting this backwards flips the
    // sign of S (the path length) → a zero/negative duration.
    const sign = i === 1 ? -1 : 1
    return (w1 * w1 - w0 * w0 + sign * rho2 * rho2 * u1 * u1) / (2 * wi * rho2 * u1)
  }
  const r = (i: 0 | 1): number => {
    const bi = b(i)
    return Math.log(Math.sqrt(bi * bi + 1) - bi)
  }
  const r0 = r(0)
  const r1 = r(1)
  const S = (r1 - r0) / rho
  return {
    S,
    u: (s) => (w0 / rho2) * (Math.cosh(r0) * Math.tanh(rho * s + r0) - Math.sinh(r0)),
    w: (s) => (w0 * Math.cosh(r0)) / Math.cosh(rho * s + r0),
  }
}

// ─── The animator ──────────────────────────────────────────────────

interface ActiveAnim {
  startMs: number
  durationMs: number
  target: CameraTarget
  /** Sample the path at eased/normalised progress k ∈ [0, 1]. */
  sample(k: number): CameraTarget
  ease(t: number): number
}

const RAW_EPS = 1e-9

export class CameraAnimator {
  private anim: ActiveAnim | null = null
  private expect: RawCameraSnapshot | null = null

  isActive(): boolean {
    return this.anim !== null
  }

  cancel(): void {
    this.anim = null
    this.expect = null
  }

  /** Begin an eased interpolation. `start`/`target` are resolved geo
   *  states (the controller merges partial opts with the current camera
   *  before calling). durationMs must be > 0 — the controller takes the
   *  instant jumpTo path otherwise. */
  easeTo(
    start: CameraTarget,
    target: CameraTarget,
    durationMs: number,
    ease: (t: number) => number = defaultCameraEase,
    nowMs: number,
  ): void {
    const dLon = shortestLonDelta(start.lon, target.lon)
    const my0 = lonLatToMercator(start.lon, start.lat)[1]
    const my1 = lonLatToMercator(target.lon, target.lat)[1]
    const dBearing = shortestBearingDelta(start.bearing, target.bearing)
    this.anim = {
      startMs: nowMs,
      durationMs,
      target,
      ease,
      sample: (k) => ({
        lon: start.lon + dLon * k,
        lat: mercatorYToLat(my0 + (my1 - my0) * k),
        zoom: start.zoom + (target.zoom - start.zoom) * k,
        bearing: start.bearing + dBearing * k,
        pitch: start.pitch + (target.pitch - start.pitch) * k,
      }),
    }
    this.expect = null
  }

  /** Begin a vWN flight. `viewportPx` is the screen span the path's `w`
   *  is measured against (max(width, height) CSS px — the MapLibre
   *  convention). Returns the resolved duration (opts.duration, or the
   *  vWN `S / speed` when absent) so the controller can decide the
   *  degenerate instant case; a returned 0 means "nothing to fly". */
  flyTo(
    start: CameraTarget,
    target: CameraTarget,
    opts: { durationMs?: number; speed?: number; curve?: number },
    viewportPx: number,
    nowMs: number,
    ease: (t: number) => number = defaultCameraEase,
  ): number {
    const rho = opts.curve !== undefined && opts.curve > 0 ? opts.curve : 1.42
    const speed = opts.speed !== undefined && opts.speed > 0 ? opts.speed : 1.2
    const w0 = Math.max(1, viewportPx)
    const w1 = w0 / Math.pow(2, target.zoom - start.zoom)
    const dLon = shortestLonDelta(start.lon, target.lon)
    const my0 = lonLatToMercator(start.lon, start.lat)[1]
    const my1 = lonLatToMercator(target.lon, target.lat)[1]
    // Ground-track length in px at the START zoom: Mercator meters / mpp.
    const mppAtStart = WORLD_MERC / TILE_PX / Math.pow(2, start.zoom)
    const dxMeters = (dLon / 360) * WORLD_MERC
    const dyMeters = my1 - my0
    const u1 = Math.hypot(dxMeters, dyMeters) / mppAtStart
    const path = makeFlyPath(w0, w1, u1, rho)
    if (!(path.S > 0) || !Number.isFinite(path.S)) return 0
    const durationMs =
      opts.durationMs !== undefined && opts.durationMs >= 0
        ? opts.durationMs
        : (path.S / speed) * 1000
    if (!(durationMs > 0)) return 0
    const frac = (s: number): number => (u1 < 1e-9 ? 0 : path.u(s) / u1)
    this.anim = {
      startMs: nowMs,
      durationMs,
      target,
      ease,
      sample: (k) => {
        const s = path.S * k
        const f = frac(s)
        return {
          lon: start.lon + dLon * f,
          lat: mercatorYToLat(my0 + (my1 - my0) * f),
          zoom: start.zoom + Math.log2(w0 / path.w(s)),
          bearing: start.bearing + shortestBearingDelta(start.bearing, target.bearing) * k,
          pitch: start.pitch + (target.pitch - start.pitch) * k,
        }
      },
    }
    this.expect = null
    return durationMs
  }

  /** Advance one frame: cancel on an external camera write, apply the
   *  eased sample through the host's jumpTo, and land the TERMINAL frame
   *  on the exact original target (bit-identical to a direct jumpTo). */
  tick(nowMs: number, host: CameraAnimHost): void {
    const a = this.anim
    if (a === null) return
    if (this.expect !== null) {
      const raw = host.readRaw()
      const e = this.expect
      if (
        Math.abs(raw.cx - e.cx) > RAW_EPS ||
        Math.abs(raw.cy - e.cy) > RAW_EPS ||
        Math.abs(raw.z - e.z) > RAW_EPS ||
        Math.abs(raw.b - e.b) > RAW_EPS ||
        Math.abs(raw.p - e.p) > RAW_EPS
      ) {
        this.cancel()
        return
      }
    }
    const t = (nowMs - a.startMs) / a.durationMs
    if (t >= 1) {
      const tg = a.target
      this.cancel()
      host.jumpTo({ center: [tg.lon, tg.lat], zoom: tg.zoom, bearing: tg.bearing, pitch: tg.pitch })
      return
    }
    const s = a.sample(a.ease(t < 0 ? 0 : t))
    host.jumpTo({ center: [s.lon, s.lat], zoom: s.zoom, bearing: s.bearing, pitch: s.pitch })
    this.expect = host.readRaw()
  }
}
