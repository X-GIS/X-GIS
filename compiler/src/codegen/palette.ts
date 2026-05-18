// ═══════════════════════════════════════════════════════════════════
// Palette — IR-level "literal pool" + zoom-stop gradient collector
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 3 component. Walks a compiled Scene's RenderNodes; every
// paint property whose deps ⊆ {ZOOM} (constant or zoom-interpolated)
// gets pulled into a centralised pool with a stable index. Downstream
// passes (P3.2 GPU storage texture, P3.3 shader-gen rewrite) consume
// these indices to emit `textureSampleLevel(palette, ...)` instead of
// per-frame uniform writes.
//
// Why a single collector (vs per-RenderNode local pools):
//
//   - Cross-layer dedup. OFM Bright has many polygons with the same
//     hex (#f0e8f8 for school, hospital, etc.) — one slot, many
//     consumers.
//   - One storage texture allocation per Scene. Per-layer allocations
//     would explode bind-group churn at draw time.
//   - Index space is the source of truth shared between codegen and
//     runtime — both walk the Palette via the same find* helpers.
//
// What this module DOES NOT do:
//
//   - GPU upload. `palette-texture.ts` (runtime) consumes the pool
//     and produces tier-0 textures.
//   - Shader rewriting. shader-gen integration happens in P3.3.
//   - Per-RenderNode assignment annotation. Shader-gen looks up
//     by value at codegen time — keeps annotation lean.
//   - Time-interpolated, data-driven, conditional, zoom-time shapes.
//     Those stay on the existing CPU-resolve path; P4 (compute eval)
//     handles data-driven, P3.4 (zoom-time table) is a follow-up.

import type { Scene, RenderNode, ColorValue, ZoomStop } from '../ir/render-node'
import type { PropertyShape, RGBA } from '../ir/property-types'

// ─── Pool entry shapes ─────────────────────────────────────────────

/** One zoom-stop ramp for a color property. The runtime bakes it
 *  into one row of an Nx1 RGBA8 storage texture; HW linear sampling
 *  interpolates between adjacent stops at draw time. `base` carries
 *  the Mapbox `["exponential", N]` curve base; 1 (or undefined) = linear. */
export interface ColorGradient {
  stops: readonly ZoomStop<RGBA>[]
  base: number
}

/** Scalar (numeric) zoom-stop ramp. Mirrors ColorGradient one channel
 *  at a time — runtime stores into r32float storage texture. */
export interface ScalarGradient {
  stops: readonly ZoomStop<number>[]
  base: number
}

/** Frozen view of the collected pool. Indices are stable within a
 *  Scene compile run — referenced from shader emit + runtime bind.
 *  All arrays are dedup'd by value (rgbaEqual / stops-shape-match). */
export interface Palette {
  readonly colors: readonly RGBA[]
  readonly scalars: readonly number[]
  readonly colorGradients: readonly ColorGradient[]
  readonly scalarGradients: readonly ScalarGradient[]
  /** Lookup the index of a previously-added RGBA. Returns -1 if not
   *  in the pool; consumers MUST treat -1 as "fall back to legacy
   *  per-frame uniform" (don't crash). */
  findColor(rgba: RGBA): number
  findScalar(value: number): number
  findColorGradient(g: ColorGradient): number
  findScalarGradient(g: ScalarGradient): number
}

// ─── Equality + hashing ────────────────────────────────────────────

const NUMBER_EPS = 1e-9

function numbersEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < NUMBER_EPS
}

function rgbaEqual(a: RGBA, b: RGBA): boolean {
  return numbersEqual(a[0], b[0]) && numbersEqual(a[1], b[1])
    && numbersEqual(a[2], b[2]) && numbersEqual(a[3], b[3])
}

/** Canonical string for a zoom-stop array. Two gradients dedup iff
 *  their canonical strings match — accounts for ordering (stops MUST
 *  arrive sorted; the lower pass enforces this) and the `base` curve. */
function colorGradientKey(g: ColorGradient): string {
  const parts: string[] = [`b=${g.base.toFixed(6)}`]
  for (const s of g.stops) {
    parts.push(
      `z=${s.zoom.toFixed(6)},r=${s.value[0].toFixed(6)},`
      + `g=${s.value[1].toFixed(6)},b=${s.value[2].toFixed(6)},`
      + `a=${s.value[3].toFixed(6)}`,
    )
  }
  return parts.join('|')
}

function scalarGradientKey(g: ScalarGradient): string {
  const parts: string[] = [`b=${g.base.toFixed(6)}`]
  for (const s of g.stops) {
    parts.push(`z=${s.zoom.toFixed(6)},v=${s.value.toFixed(6)}`)
  }
  return parts.join('|')
}

// ─── Builder ───────────────────────────────────────────────────────

/** Mutable accumulator. `collectPalette` constructs one, walks the
 *  Scene, then freezes it via `build()`. Tests + downstream consumers
 *  use the immutable `Palette` view. */
class PaletteBuilder {
  // Float-precision RGBA equality means we can't key a Map by tuple
  // identity. Use two-layer keying: bucket by quantised first channel
  // for fast scan, then linear-search the bucket with rgbaEqual.
  private readonly colors: RGBA[] = []
  private readonly scalars: number[] = []
  private readonly colorGradients: ColorGradient[] = []
  private readonly scalarGradients: ScalarGradient[] = []
  private readonly colorGradientIndex = new Map<string, number>()
  private readonly scalarGradientIndex = new Map<string, number>()

  addColor(rgba: RGBA): number {
    for (let i = 0; i < this.colors.length; i++) {
      if (rgbaEqual(this.colors[i]!, rgba)) return i
    }
    const idx = this.colors.length
    this.colors.push([rgba[0], rgba[1], rgba[2], rgba[3]] as const as RGBA)
    return idx
  }

  addScalar(value: number): number {
    // Coerce non-finite (NaN/Infinity) inputs to 0 — `numbersEqual`
    // (epsilon compare) fails on NaN vs NaN (`Math.abs(NaN - NaN) <
    // eps` is false), so every NaN would carve its own slot AND the
    // renderer would read NaN at draw time. The downgrade-to-0
    // sentinel keeps the palette bounded and renders as the
    // numerically-safe default while the upstream pipeline's
    // separate NaN gates (palette.ts ingestNumberShape, IR
    // optimize.ts opacity/size const-fold) surface the bad input.
    if (!Number.isFinite(value)) value = 0
    for (let i = 0; i < this.scalars.length; i++) {
      if (numbersEqual(this.scalars[i]!, value)) return i
    }
    const idx = this.scalars.length
    this.scalars.push(value)
    return idx
  }

  addColorGradient(stops: readonly ZoomStop<RGBA>[], base: number | undefined): number {
    const g: ColorGradient = { stops, base: base ?? 1 }
    const key = colorGradientKey(g)
    const cached = this.colorGradientIndex.get(key)
    if (cached !== undefined) return cached
    const idx = this.colorGradients.length
    this.colorGradients.push(g)
    this.colorGradientIndex.set(key, idx)
    // Also pull every stop's value into the constant color pool so
    // shader-gen can fall back to a literal if the gradient ends up
    // being constant-folded after this pass.
    for (const s of stops) this.addColor(s.value)
    return idx
  }

  addScalarGradient(stops: readonly ZoomStop<number>[], base: number | undefined): number {
    const g: ScalarGradient = { stops, base: base ?? 1 }
    const key = scalarGradientKey(g)
    const cached = this.scalarGradientIndex.get(key)
    if (cached !== undefined) return cached
    const idx = this.scalarGradients.length
    this.scalarGradients.push(g)
    this.scalarGradientIndex.set(key, idx)
    for (const s of stops) this.addScalar(s.value)
    return idx
  }

  build(): Palette {
    const colors = this.colors as readonly RGBA[]
    const scalars = this.scalars as readonly number[]
    const colorGradients = this.colorGradients as readonly ColorGradient[]
    const scalarGradients = this.scalarGradients as readonly ScalarGradient[]
    return {
      colors,
      scalars,
      colorGradients,
      scalarGradients,
      findColor(rgba: RGBA): number {
        for (let i = 0; i < colors.length; i++) {
          if (rgbaEqual(colors[i]!, rgba)) return i
        }
        return -1
      },
      findScalar(value: number): number {
        for (let i = 0; i < scalars.length; i++) {
          if (numbersEqual(scalars[i]!, value)) return i
        }
        return -1
      },
      findColorGradient(g: ColorGradient): number {
        const key = colorGradientKey(g)
        for (let i = 0; i < colorGradients.length; i++) {
          if (colorGradientKey(colorGradients[i]!) === key) return i
        }
        return -1
      },
      findScalarGradient(g: ScalarGradient): number {
        const key = scalarGradientKey(g)
        for (let i = 0; i < scalarGradients.length; i++) {
          if (scalarGradientKey(scalarGradients[i]!) === key) return i
        }
        return -1
      },
    }
  }
}

// ─── ColorValue + PropertyShape walkers ────────────────────────────

function ingestColor(b: PaletteBuilder, value: ColorValue): void {
  switch (value.kind) {
    case 'none':
      return
    case 'constant':
      b.addColor(value.rgba)
      return
    case 'zoom-interpolated':
      b.addColorGradient(value.stops, value.base)
      return
    case 'time-interpolated':
      // Time stops aren't ZOOM-only — they don't qualify for this
      // pass's pool. CPU resolve path handles them. We still ingest
      // the BASE color so a P4 const-fold can reference it via the
      // palette if needed (constant-base is the common case).
      b.addColor(value.base)
      return
    case 'data-driven':
    case 'conditional':
      // Not eligible — feature / conditional deps exceed {ZOOM}.
      // Leave to the data-driven / compute path.
      return
  }
}

function ingestNumberShape(b: PaletteBuilder, shape: PropertyShape<number>): void {
  switch (shape.kind) {
    case 'constant':
      // Number.isFinite gate — NaN/Infinity shape.value would
      // pollute the palette (numbersEqual(NaN, NaN) = false →
      // unbounded slot growth) AND the renderer would read NaN
      // from the slot at draw time. Skip non-finite constants —
      // the renderer falls back to its default for the property.
      if (Number.isFinite(shape.value)) b.addScalar(shape.value)
      return
    case 'zoom-interpolated':
      b.addScalarGradient(shape.stops, shape.base)
      return
    case 'time-interpolated':
    case 'zoom-time':
    case 'data-driven':
      // Same rationale as ingestColor: anything beyond zoom-only
      // stays on the CPU-resolve path. Constants embedded in the
      // shape (e.g. zoom-time's zoomStops) are NOT pulled in — the
      // future zoom-time-as-3D-LUT pass (deferred) handles that.
      return
  }
}

function ingestRenderNode(b: PaletteBuilder, node: RenderNode): void {
  ingestColor(b, node.fill)
  ingestColor(b, node.stroke.color)
  ingestNumberShape(b, node.opacity)
  // Stroke width is PropertyShape<number> via the
  // StrokeWidthValue alias — ingest the same way.
  ingestNumberShape(b, node.stroke.width)
  // Size: SizeValue union ('none' | 'constant' | 'data-driven' |
  // 'zoom-interpolated' | 'time-interpolated') — only pull constant
  // + zoom-interpolated, leave the rest for runtime resolve.
  switch (node.size.kind) {
    case 'constant':
      // Number.isFinite gate — mirror of ingestNumberShape.
      if (Number.isFinite(node.size.value)) b.addScalar(node.size.value)
      break
    case 'zoom-interpolated':
      b.addScalarGradient(node.size.stops, node.size.base)
      break
    case 'none':
    case 'data-driven':
    case 'time-interpolated':
      break
  }
  // Label paints — preserve future-readiness by ingesting the size
  // halves that are constant. label is undefined on most polygon
  // / line layers, so the guard pays off on real styles.
  const label = node.label
  if (label) {
    // Label.size on LabelDef is a number (resolved at lower time);
    // shape variants live in the parallel paintShapes/labelShapes
    // tree (not on the legacy RenderNode field). For P3.1 we only
    // touch the legacy fields — the labelShapes migration ingests
    // through the existing PropertyShape<T> visitor when wired in
    // P3.2.
    // Number.isFinite rejects NaN — addScalar dedups via numbersEqual
    // (epsilon compare), but `Math.abs(NaN - NaN) < eps` is false so
    // every NaN size would get its own palette slot AND the renderer
    // would read a NaN size from the slot at draw time. Skip non-
    // finite sizes — the label falls to the renderer's default.
    if (typeof label.size === 'number' && Number.isFinite(label.size)) b.addScalar(label.size)
    if (label.color) b.addColor(label.color)
  }
}

// ─── Public API ────────────────────────────────────────────────────

/** Walk the Scene's renderNodes, pull every ZOOM-only / constant
 *  paint property into a deduplicated pool. Side-effect-free; safe
 *  to call multiple times (returns equivalent Palettes for the same
 *  Scene). Empty Scene returns an empty Palette — callers that need
 *  to know "is anything in the pool" check `palette.colors.length`
 *  etc. directly. */
export function collectPalette(scene: Scene): Palette {
  const b = new PaletteBuilder()
  for (const node of scene.renderNodes) ingestRenderNode(b, node)
  return b.build()
}

/** Test/diagnostic helper — return an empty palette without walking
 *  any input. Used by codegen sites that want a stable "no palette
 *  collected" sentinel. */
export function emptyPalette(): Palette {
  return new PaletteBuilder().build()
}
