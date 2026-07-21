// ═══ Camera animation — easeTo / flyTo programmatic navigation ═══
//
// #1256. Turns the two former jumpTo aliases into real transitions:
//   - easeTo: one eased interpolation of center/zoom/bearing/pitch over a
//     fixed duration (default cubic in-out).
//   - flyTo: the van Wijk & Nuij (2003) "Smooth and efficient zooming and
//     panning" optimal zoom-out-in path, arc-length parameterised, with the
//     near-equal-center degenerate collapsing to easeTo.
//
// SINGLE MUTATION AUTHORITY: every frame drives the SAME camera setter the
// controller / jumpTo already use — `applyCameraOpts` is wired to
// CameraController.jumpTo, so the per-frame write goes through one path and the
// render-loop keep-warm + move/zoom lifecycle events re-arm for free (the
// injected invalidate tags DirtyDomain.CAMERA, exactly the #1177 animated-zoom
// design case). The final tick snaps to the target via jumpTo(opts) so the
// settled camera is byte-identical to jumpTo(target) — no interpolation residue.
//
// The rAF loop mirrors controller.ts applyInertia / animateZoom: a
// self-rescheduling requestAnimationFrame that stores its pending handle and a
// live `active` guard so a queued frame bails after cancel(). It is NOT a second
// camera authority — it only calls applyCameraOpts. Cancel on any user gesture
// (the controller pointer/wheel handlers) and supersede on a new easeTo/flyTo.
//
// The clock (now/raf/cancelRaf) and the reduced-motion probe are injected so a
// stepped-clock unit test can drive the animation to completion deterministically
// and so a host without a frame source (SSR / node) collapses to an instant jump.

import { lonLatToMercator } from '@xgis/data'
import { mercatorYToLat, WORLD_MERC, TILE_PX } from '@xgis/geo'
import { activeBody } from '@xgis/shared'

/** Camera state in host units (lon/lat degrees, zoom level, degrees). */
export interface CameraPose {
  center: [number, number]
  zoom: number
  bearing: number
  pitch: number
}

/** The provided-fields subset a single frame writes — identical shape to
 *  jumpTo's argument. Omitted fields are left untouched by the setter. */
export interface CameraFrameOpts {
  center?: [number, number]
  zoom?: number
  bearing?: number
  pitch?: number
}

export interface EaseToOptions extends CameraFrameOpts {
  /** Transition length in ms. Default 500. */
  duration?: number
  /** Progress remap t∈[0,1]→[0,1]. Default cubic in-out. */
  easing?: (t: number) => number
}

export interface FlyToOptions extends CameraFrameOpts {
  /** Explicit transition length in ms; overrides the path-derived duration. */
  duration?: number
  /** Average velocity in screenfuls / second along the flight path. Default 1.2. */
  speed?: number
  /** van Wijk curvature ρ. Default 1.42 (the paper's average-case optimum). */
  curve?: number
}

/** Everything the animator needs from its host, all injectable for tests. */
export interface CameraAnimatorDeps {
  /** Live camera pose (read at movement start / supersede). */
  getPose(): CameraPose
  /** Apply provided fields — wired to CameraController.jumpTo (single authority). */
  applyCameraOpts(opts: CameraFrameOpts): void
  /** Viewport size in CSS px, for the van Wijk w0 reference span. */
  getViewport(): { width: number; height: number }
  /** projType (>=7 ⇒ globe ⇒ great-circle center path; else straight lerp). */
  getProjType(): number
  /** prefers-reduced-motion — collapse to an instant jump when true. */
  prefersReducedMotion(): boolean
  /** Monotonic clock in ms (performance.now). */
  now(): number
  /** Schedule a frame; return null when no frame source exists (SSR/node). */
  raf(cb: (t: number) => void): number | null
  /** Cancel a scheduled frame. */
  cancelRaf(handle: number): void
}

// ── Injectable-clock defaults (browser real infra; graceful in node) ──
export const defaultNow = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now()
export const defaultRaf = (cb: (t: number) => void): number | null =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : null
export const defaultCancelRaf = (handle: number): void => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
}

const DEG2RAD = Math.PI / 180

// ── Scalar helpers ──

/** Cubic in-out — the easeTo default (matches CSS ease-in-out feel). */
export function easeCubicInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Interpolate a bearing along the SHORTEST arc (−180,180]. */
export function lerpAngle(a: number, b: number, t: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180
  return a + d * t
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

// ── Center interpolators ──

function lonLatToUnit(lon: number, lat: number): [number, number, number] {
  const la = lat * DEG2RAD
  const lo = lon * DEG2RAD
  const cl = Math.cos(la)
  return [cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)]
}

function unitToLonLat(v: [number, number, number]): [number, number] {
  const lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG2RAD
  const lon = Math.atan2(v[1], v[0]) / DEG2RAD
  return [lon, lat]
}

/** Great-circle center interpolation (slerp on the unit sphere). Returns the
 *  angular distance ω (radians) alongside the position sampler so the caller
 *  can measure the flat-vs-globe path length in one place. */
function greatCirclePath(
  from: [number, number],
  to: [number, number],
): { omega: number; at: (f: number) => [number, number] } {
  const a = lonLatToUnit(from[0], from[1])
  const b = lonLatToUnit(to[0], to[1])
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))
  const omega = Math.acos(dot)
  if (omega < 1e-9) return { omega, at: () => [to[0], to[1]] }
  const s = Math.sin(omega)
  return {
    omega,
    at: (f: number) => {
      const wa = Math.sin((1 - f) * omega) / s
      const wb = Math.sin(f * omega) / s
      return unitToLonLat([a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb])
    },
  }
}

/** Straight line in Mercator-projected space (the flat-map center path).
 *  Returns the projected distance in metres alongside the sampler. */
function mercatorPath(
  from: [number, number],
  to: [number, number],
): { dist: number; at: (f: number) => [number, number] } {
  const p0 = lonLatToMercator(from[0], from[1])
  const p1 = lonLatToMercator(to[0], to[1])
  const dx = p1[0] - p0[0]
  const dy = p1[1] - p0[1]
  const earth = activeBody().sphereR
  return {
    dist: Math.hypot(dx, dy),
    at: (f: number) => {
      const mx = p0[0] + dx * f
      const my = p0[1] + dy * f
      // Inverse Mercator — matches CameraController.getCameraState so the
      // intermediate lon/lat re-projects cleanly through jumpTo.
      return [mx / (DEG2RAD * earth), mercatorYToLat(my)]
    },
  }
}

// ── van Wijk & Nuij (2003) optimal path ──

function cosh(x: number): number {
  return (Math.exp(x) + Math.exp(-x)) / 2
}
function sinh(x: number): number {
  return (Math.exp(x) - Math.exp(-x)) / 2
}
function tanh(x: number): number {
  return sinh(x) / cosh(x)
}

export interface FlyPath {
  /** Total path length in ρ-normalised "s" units. */
  S: number
  /** Path-derived duration in ms (before any explicit override). */
  duration: number
  /** Position along the ground path as a fraction f∈[0,1] at arc-length s. */
  uAt: (s: number) => number
  /** Visible-span ratio w(s)/w0 — >1 in the interior ⇒ zoom-out-in dip. */
  wAt: (s: number) => number
  /** Great-circle (globe) or Mercator straight-line center sampler by f∈[0,1]. */
  positionAt: (f: number) => [number, number]
}

export interface FlyPathParams {
  startCenter: [number, number]
  targetCenter: [number, number]
  startZoom: number
  targetZoom: number
  viewport: { width: number; height: number }
  greatCircle: boolean
  rho: number
  speed: number
}

/** Plan the van Wijk–Nuij trajectory. Works in world-fraction units (whole
 *  world = 1) so u1 (path length) and w0/w1 (viewport spans) share one scale —
 *  the algorithm is invariant to that common scale, and this keeps globe
 *  (great-circle) and flat (Mercator) path lengths dimensionally consistent. */
export function planFlyPath(p: FlyPathParams): FlyPath {
  const rho = p.rho
  const rho2 = rho * rho

  // Center path + its length as a fraction of the world width.
  let u1: number
  let positionAt: (f: number) => [number, number]
  if (p.greatCircle) {
    const gc = greatCirclePath(p.startCenter, p.targetCenter)
    u1 = gc.omega / (2 * Math.PI) // ω radians over the 2π equator
    positionAt = (f) => gc.at(clamp01(f))
  } else {
    const mp = mercatorPath(p.startCenter, p.targetCenter)
    u1 = mp.dist / WORLD_MERC
    positionAt = (f) => mp.at(clamp01(f))
  }

  // Viewport span as a fraction of the world width at the start zoom, and the
  // matching end span (w1 = w0 / 2^(Δzoom)).
  const worldPx0 = TILE_PX * Math.pow(2, p.startZoom)
  const w0 = Math.max(p.viewport.width, p.viewport.height) / worldPx0
  const scale = Math.pow(2, p.targetZoom - p.startZoom)
  const w1 = w0 / scale

  const r = (i: 0 | 1): number => {
    const b =
      (w1 * w1 - w0 * w0 + (i ? -1 : 1) * rho2 * rho2 * u1 * u1) / (2 * (i ? w1 : w0) * rho2 * u1)
    return Math.log(Math.sqrt(b * b + 1) - b)
  }

  const r0 = r(0)
  let wAt = (s: number): number => cosh(r0) / cosh(r0 + rho * s)
  let uAt = (s: number): number => (w0 * ((cosh(r0) * tanh(r0 + rho * s) - sinh(r0)) / rho2)) / u1
  let S = (r(1) - r0) / rho

  // Guard the pure-zoom degenerate (u1→0 shielded upstream by the easeTo
  // fallback, but S can still be non-finite for a same-span same-center edge):
  // fall back to exponential zoom interpolation with no pan.
  if (!Number.isFinite(S)) {
    const k = w1 < w0 ? -1 : 1
    S = Math.abs(Math.log(w1 / w0)) / rho
    uAt = () => 0
    wAt = (s: number) => Math.exp(k * rho * s)
  }

  const duration = (1000 * S) / p.speed
  return { S, duration, uAt, wAt, positionAt }
}

// ── The animator ──

/** Two lon/lat centers are "the same place" for flyTo's degenerate check. ~1e-6°
 *  is well under a metre — below it van Wijk's u1 collapses and the path is a
 *  pure zoom, so we route to easeTo (the issue's degenerate fallback). */
function sameCenter(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6
}

/** Only the camera fields (drops duration/easing/speed/curve) — the exact opts
 *  the terminal snap and reduced-motion collapse hand to jumpTo, so the settled
 *  state is byte-identical to a plain jumpTo(target) for ANY partial opts. */
function cameraFields(o: CameraFrameOpts): CameraFrameOpts {
  return { center: o.center, zoom: o.zoom, bearing: o.bearing, pitch: o.pitch }
}

export class CameraAnimator {
  private handle: number | null = null
  private active = false

  constructor(private readonly deps: CameraAnimatorDeps) {}

  /** Whether a transition is currently in flight. */
  isActive(): boolean {
    return this.active
  }

  /** Abort an in-flight transition, leaving the camera at its current
   *  (interrupted) position. Called by the controller on any user gesture and
   *  by a superseding easeTo/flyTo. Idempotent. */
  cancel(): void {
    this.active = false
    if (this.handle !== null) {
      this.deps.cancelRaf(this.handle)
      this.handle = null
    }
  }

  easeTo(opts: EaseToOptions): void {
    const target = cameraFields(opts)
    if (this.deps.prefersReducedMotion()) {
      this.cancel()
      this.deps.applyCameraOpts(target)
      return
    }
    const start = this.deps.getPose()
    const easing = opts.easing ?? easeCubicInOut
    const greatCircle = this.deps.getProjType() >= 7
    const centerAt =
      opts.center && !sameCenter(start.center, opts.center)
        ? greatCircle
          ? greatCirclePath(start.center, opts.center).at
          : mercatorPath(start.center, opts.center).at
        : null
    // A center that equals the start still writes the target on the terminal
    // snap; intermediate frames just don't move it.
    const wantCenter = opts.center !== undefined
    const wantZoom = opts.zoom !== undefined
    const wantBearing = opts.bearing !== undefined
    const wantPitch = opts.pitch !== undefined
    const sampler = (t: number): CameraFrameOpts => {
      const k = easing(t)
      const out: CameraFrameOpts = {}
      if (wantCenter) out.center = centerAt ? centerAt(k) : [start.center[0], start.center[1]]
      if (wantZoom) out.zoom = lerp(start.zoom, opts.zoom!, k)
      if (wantBearing) out.bearing = lerpAngle(start.bearing, opts.bearing!, k)
      if (wantPitch) out.pitch = lerp(start.pitch, opts.pitch!, k)
      return out
    }
    this.run(opts.duration ?? 500, sampler, target)
  }

  flyTo(opts: FlyToOptions): void {
    const target = cameraFields(opts)
    if (this.deps.prefersReducedMotion()) {
      this.cancel()
      this.deps.applyCameraOpts(target)
      return
    }
    const start = this.deps.getPose()
    // Degenerate near-equal-center ⇒ there is no pan to arc, so a van Wijk
    // path is undefined — collapse to a straight eased zoom/rotate (easeTo).
    if (!opts.center || sameCenter(start.center, opts.center)) {
      this.easeTo({
        center: opts.center,
        zoom: opts.zoom,
        bearing: opts.bearing,
        pitch: opts.pitch,
        duration: opts.duration,
      })
      return
    }
    const startZoom = start.zoom
    const targetZoom = opts.zoom ?? startZoom
    const path = planFlyPath({
      startCenter: start.center,
      targetCenter: opts.center,
      startZoom,
      targetZoom,
      viewport: this.deps.getViewport(),
      greatCircle: this.deps.getProjType() >= 7,
      rho: opts.curve ?? 1.42,
      speed: opts.speed ?? 1.2,
    })
    const wantBearing = opts.bearing !== undefined
    const wantPitch = opts.pitch !== undefined
    const sampler = (t: number): CameraFrameOpts => {
      const s = t * path.S
      const out: CameraFrameOpts = {
        center: path.positionAt(path.uAt(s)),
        // zoom = startZoom + log2(1/w(s)); w(s)>1 in the interior ⇒ zoom dips
        // below both endpoints then rises back — the optimal zoom-out-in arc.
        zoom: startZoom + Math.log2(1 / path.wAt(s)),
      }
      if (wantBearing) out.bearing = lerpAngle(start.bearing, opts.bearing!, t)
      if (wantPitch) out.pitch = lerp(start.pitch, opts.pitch!, t)
      return out
    }
    this.run(opts.duration ?? path.duration, sampler, target)
  }

  /** Self-rescheduling rAF driver. Supersedes any in-flight movement, snaps
   *  immediately when there is no frame source or a non-positive duration, and
   *  settles EXACTLY on `target` (not the interpolated value) on the last tick. */
  private run(
    duration: number,
    sampler: (t: number) => CameraFrameOpts,
    target: CameraFrameOpts,
  ): void {
    this.cancel()
    if (!(duration > 0)) {
      this.deps.applyCameraOpts(target)
      return
    }
    const start = this.deps.now()
    this.active = true
    const step = (): void => {
      if (!this.active) return // cancelled after this frame was queued
      const t = (this.deps.now() - start) / duration
      if (t >= 1) {
        this.deps.applyCameraOpts(target) // snap to target — no residue
        this.active = false
        this.handle = null
        return
      }
      this.deps.applyCameraOpts(sampler(t < 0 ? 0 : t))
      this.handle = this.deps.raf(step)
      if (this.handle === null) {
        // Frame source vanished mid-flight — settle rather than stall.
        this.deps.applyCameraOpts(target)
        this.active = false
      }
    }
    this.handle = this.deps.raf(step)
    if (this.handle === null) {
      // No frame source at all (SSR / node) — behave as an instant jump.
      this.deps.applyCameraOpts(target)
      this.active = false
    }
  }
}
