// Natural user-interaction primitives for e2e perf + visual tests.
//
// Snapshot Playwright actions (page.mouse.wheel once, then assert)
// don't catch jank during interaction. Real users pan/zoom/rotate/pitch
// over multiple seconds; frame budgets are blown when SOME frames
// stutter even though the steady-state is fast. These helpers drive
// rAF-based interaction sequences and collect per-frame timing so
// tests can assert "p95 < 50ms" / "max < 200ms" gates.
//
// Phase 8.1 of the X-GIS strict-spec/runtime parity plan.

import type { Page } from '@playwright/test'

export interface FrameTimings {
  /** Per-frame elapsed (ms) in chronological order. */
  frames: number[]
  /** Wall-clock ms from first to last frame. */
  totalMs: number
}

export interface InteractionOptions {
  /** Interaction duration in milliseconds. Frames are recorded
   *  throughout. Default 6000 (matches MapLibre/_perf-bright
   *  scenarios). */
  durationMs?: number
  /** Easing function applied to t∈[0,1] before interpolating
   *  start→end values. Default cubic ease-in-out. */
  easing?: (t: number) => number
  /** When true, prints per-frame timing summary via console.log
   *  inside the page (visible in Playwright trace logs). */
  verbose?: boolean
}

const DEFAULT_DURATION_MS = 6000

function defaultEaseInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/** Run a generic rAF-driven interaction. The body callback receives
 *  the eased progress in [0, 1] and an XGIS map handle from the page;
 *  it should call camera-setter methods (setCenter / setZoom / etc.)
 *  to apply the new state. Returns per-frame timings collected on
 *  the page side. */
export async function runInteraction(
  page: Page,
  bodyFn: (mapId: string, t: number) => void,
  opts: InteractionOptions = {},
): Promise<FrameTimings> {
  const durationMs = opts.durationMs ?? DEFAULT_DURATION_MS
  const easeKey = opts.easing ? opts.easing.toString() : null
  const verbose = opts.verbose === true

  return await page.evaluate(async ({ durationMs, bodySrc, easeSrc, verbose }) => {
    const map = (window as unknown as { __xgisMap?: unknown }).__xgisMap
    if (!map) throw new Error('runInteraction: window.__xgisMap not set — host page must expose it')
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const ease: (t: number) => number = easeSrc
      ? (new Function(`return (${easeSrc})`) as () => (t: number) => number)()
      : (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const body = new Function('mapId', 't', bodySrc) as (mapId: string, t: number) => void
    const start = performance.now()
    let prev = start
    const frames: number[] = []
    return new Promise<{ frames: number[]; totalMs: number }>((resolve) => {
      function step() {
        const now = performance.now()
        const elapsed = now - start
        const t = Math.min(1, elapsed / durationMs)
        const eased = ease(t)
        body('__xgisMap', eased)
        const dt = now - prev
        if (frames.length > 0) frames.push(dt) // skip first interval (warmup)
        else frames.push(0)
        prev = now
        if (t < 1) requestAnimationFrame(step)
        else {
          if (verbose) console.log(`[runInteraction] ${frames.length} frames, total ${(now - start).toFixed(0)}ms`)
          resolve({ frames: frames.slice(1), totalMs: now - start })
        }
      }
      requestAnimationFrame(step)
    })
  }, { durationMs, bodySrc: bodyFn.toString().replace(/^[^{]*{|}\s*$/g, ''), easeSrc: easeKey, verbose })
}

export function computeStats(timings: FrameTimings): {
  median: number; p95: number; p99: number; max: number; count: number
} {
  const sorted = [...timings.frames].sort((a, b) => a - b)
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!
  return {
    median: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted[sorted.length - 1] ?? 0,
    count: sorted.length,
  }
}

/** Helper sequences for the common interaction primitives. Each
 *  generates a body function suitable for passing to runInteraction. */
export const interactions = {
  pan(start: { lng: number; lat: number }, end: { lng: number; lat: number }): (mapId: string, t: number) => void {
    // Body is stringified and re-evaluated inside page.evaluate; do not
    // close over external variables — inline the start/end.
    // XGISMap.setCenter takes (lon, lat) as TWO scalars, not an array.
    const src = `
      const m = (window).__xgisMap;
      const lng = ${start.lng} + (${end.lng} - ${start.lng}) * t;
      const lat = ${start.lat} + (${end.lat} - ${start.lat}) * t;
      m.setCenter(lng, lat);
    `
    return new Function('mapId', 't', src) as never
  },
  zoom(start: number, end: number): (mapId: string, t: number) => void {
    const src = `
      const m = (window).__xgisMap;
      const z = ${start} + (${end} - ${start}) * t;
      m.setZoom(z);
    `
    return new Function('mapId', 't', src) as never
  },
  rotate(startBearing: number, endBearing: number): (mapId: string, t: number) => void {
    const src = `
      const m = (window).__xgisMap;
      const b = ${startBearing} + (${endBearing} - ${startBearing}) * t;
      m.setBearing(b);
    `
    return new Function('mapId', 't', src) as never
  },
  pitch(startPitch: number, endPitch: number): (mapId: string, t: number) => void {
    const src = `
      const m = (window).__xgisMap;
      const p = ${startPitch} + (${endPitch} - ${startPitch}) * t;
      m.setPitch(p);
    `
    return new Function('mapId', 't', src) as never
  },
}

export { defaultEaseInOutCubic }
