// ═══ Paint property transitions (#1255) — MapLibre `*-transition` parity ═══
//
// setPaintProperty()'s continuous axes (fill/line colour, opacity family,
// line-width) RAMP to their new value over the map's paint-transition
// duration instead of popping in one frame. The mechanism rides the style
// system's EXISTING `time-interpolated` PropertyShape end-to-end:
//
//   begin*(): evaluate the axis' CURRENT value — whatever shape is live
//   (constant, zoom-interpolated at the current camera zoom, or a
//   mid-flight ramp, so rapid re-sets reverse smoothly from wherever they
//   are) — then write a two-stop non-looping time shape
//   `{ stops: [0 → from, duration → to], loop: false, delayMs: now }`.
//   The per-frame paint resolution (paint-shape-resolve.ts →
//   interpolateTime / interpolateTimeColor) renders the ramp with ZERO
//   renderer changes and clamps at `to` past the end by construction.
//
//   settle(): once now ≥ endMs, swap the ramp for `{ kind:'constant', to }`
//   — restoring every constant fast path (resolveColorShape → null, the
//   scene-idle skip) so a settled map is byte-identical to a direct set.
//
// hasActive() feeds shouldRenderThisFrame (the same keep-alive idiom as
// `_sceneHasAnimation` and the #1254 fade ledger), so frames keep coming
// exactly while a ramp is in flight. Callers gate on duration > 0 — a
// zero/absent duration never reaches the registry and takes the legacy
// instant-constant path, byte-identical to today.
//
// Non-goals (documented v1 scope): discrete properties (visibility,
// patterns, enums) never transition — MapLibre semantics; data-driven
// colour axes apply instantly (there is no single per-feature value to
// ramp from); colour interpolation is the naive linear RGB the existing
// time evaluator implements.

import type { PropertyShape } from '@xgis/compiler'
import { resolveColorShape, resolveNumberShape } from './render/paint-shape-resolve'

type Rgba = readonly [number, number, number, number]

/** Accessor closure pair for one NUMERIC paint axis inside a PaintShapes
 *  bundle (opacity, line-width). Closures rather than paths so the
 *  registry never reflects over bundle layout and the layer setter keeps
 *  full type safety. */
export interface NumberAxis {
  get(): PropertyShape<number>
  set(shape: PropertyShape<number>): void
}

/** Colour twin of {@link NumberAxis} (fill, stroke — nullable axes). */
export interface ColorAxis {
  get(): PropertyShape<Rgba> | null
  set(shape: PropertyShape<Rgba> | null): void
}

interface Entry {
  endMs: number
  settle(): void
}

function rgbaEq(a: Rgba, b: Rgba): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
}

export class PaintTransitionRegistry {
  private entries: Entry[] = []

  /** Ramp a numeric axis from its CURRENT evaluated value to `to`.
   *  Contract: callers only invoke with durationMs > 0 (duration 0 takes
   *  the caller's legacy instant path). An equal from/to writes the
   *  terminal constant directly — no entry, no keep-alive. */
  beginNumber(
    axis: NumberAxis,
    to: number,
    nowMs: number,
    durationMs: number,
    cameraZoom: number,
  ): void {
    const from = resolveNumberShape(axis.get(), cameraZoom, nowMs).value
    if (from === to) {
      axis.set({ kind: 'constant', value: to })
      return
    }
    axis.set({
      kind: 'time-interpolated',
      stops: [
        { timeMs: 0, value: from },
        { timeMs: durationMs, value: to },
      ],
      loop: false,
      easing: 'linear',
      delayMs: nowMs,
    })
    this.entries.push({
      endMs: nowMs + durationMs,
      settle: () => axis.set({ kind: 'constant', value: to }),
    })
  }

  /** Ramp a colour axis from its CURRENT evaluated value to `to`.
   *  `staticFrom` is the pre-set static hex (parsed) for the case where
   *  the axis shape is null and the flat show field was authoritative;
   *  when no from-value exists at all (data-driven axis, no static) the
   *  set applies instantly — today's behaviour. */
  beginColor(
    axis: ColorAxis,
    to: Rgba,
    nowMs: number,
    durationMs: number,
    cameraZoom: number,
    staticFrom: Rgba | null,
  ): void {
    const cur = axis.get()
    let from: Rgba | null
    if (cur !== null) {
      if (cur.kind === 'constant') {
        from = cur.value
      } else {
        const r = resolveColorShape(cur, cameraZoom, nowMs)
        from = r !== null ? r.value : staticFrom
      }
    } else {
      from = staticFrom
    }
    if (from === null || rgbaEq(from, to)) {
      axis.set({ kind: 'constant', value: to })
      return
    }
    axis.set({
      kind: 'time-interpolated',
      stops: [
        { timeMs: 0, value: from as [number, number, number, number] },
        { timeMs: durationMs, value: to as [number, number, number, number] },
      ],
      loop: false,
      easing: 'linear',
      delayMs: nowMs,
    })
    this.entries.push({
      endMs: nowMs + durationMs,
      settle: () => axis.set({ kind: 'constant', value: to }),
    })
  }

  /** Per-rendered-frame sweep: settle every ramp whose end has passed
   *  (the shape already clamps at `to`, so the swap is visually a no-op —
   *  it just restores the constant fast paths). Returns true while any
   *  ramp is still in flight. */
  settle(nowMs: number): boolean {
    if (this.entries.length === 0) return false
    const live: Entry[] = []
    for (const e of this.entries) {
      if (nowMs >= e.endMs) e.settle()
      else live.push(e)
    }
    this.entries = live
    return live.length > 0
  }

  /** Render keep-alive: true while any ramp is in flight (mirror of
   *  `_sceneHasAnimation` in shouldRenderThisFrame). */
  hasActive(): boolean {
    return this.entries.length > 0
  }

  /** Scene rebuild replaces every ShowCommand wholesale — pending ramps
   *  point into dead bundles; drop them without settling. */
  clear(): void {
    this.entries = []
  }

  /** Test / diagnostic surface. */
  get size(): number {
    return this.entries.length
  }
}
