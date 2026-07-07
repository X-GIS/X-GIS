// ═══ @xgis/shader-dsl examples — shared example descriptor ═══
//
// Each example is authored ONCE (real DSL, no runtime dep) and consumed by two surfaces
// from this single source: the CLI printer (examples/print.ts) and the interactive site
// page (/shader-dsl), which emits the module live and RENDERS it on a WebGL2 canvas.
//
// `controls` tells a host how to fill each uniform-struct FIELD per frame; the host
// recovers each field's std140 byte offset from `reflect(module)` — so the same
// reflection that documents the pipeline also drives the live uniform packing.

import type { ModuleDecl } from '../src/index.ts'

/** How a host fills one uniform-struct field each frame. */
export type Control =
  | { readonly kind: 'time' } // elapsed seconds → an f32 field
  | { readonly kind: 'resolution' } // canvas size in px → a vec2<f32> field
  // Pointer state → a vec4<f32> field: [x, y, down, used].
  //   x, y — last known pointer position in PIXELS (same units as `resolution`,
  //          bottom-left origin so it divides straight into uv space); updates on
  //          hover as well as drag, so a gallery visitor gets interactivity
  //          without clicking.
  //   down — 1 while a button/touch is held, else 0.
  //   used — 0 until the pointer first enters, 1 forever after: the shader's
  //          autopilot flag (`mix(autopilot, interactive, m.w)`), so a frame
  //          that has never been touched renders the canonical view (thumbnails,
  //          render gates, and reduced-motion all see used = 0).
  | { readonly kind: 'mouse' }
  | { readonly kind: 'const'; readonly value: readonly number[] } // fixed scalar / vec value
  | {
      readonly kind: 'slider'
      readonly label: string
      readonly min: number
      readonly max: number
      readonly step: number
      readonly value: number
      /** Also drive this slider from the mouse wheel over the canvas (zoom UX). */
      readonly wheel?: boolean
    }
  // On/off switch → an f32 field (1 / 0). `value` is the default state — it is
  // what thumbnails, render gates, and an untouched page all see.
  | { readonly kind: 'toggle'; readonly label: string; readonly value: boolean }
  // Drag-to-pan 2D camera → a vec2<f64> uniform field. `value` is the default
  // center as TWO full-precision JS doubles; the host accumulates drags in
  // double precision and packs the DF64Vec2 hi/lo planes with splitF64 each
  // frame (an untouched canvas renders the default center — thumbnails and
  // render gates see the canonical view). Drag scale: a full-canvas-width drag
  // moves the center by `unitsPerWidth × 10^(−v)` where v is the live value of
  // the `zoomExpField` control (the wheel-zoom slider).
  | {
      readonly kind: 'pan2d'
      readonly value: readonly [number, number]
      readonly zoomExpField: string
      readonly unitsPerWidth: number
    }

export interface ShaderExample {
  readonly id: string
  readonly title: string
  readonly blurb: string
  readonly category: 'cartographic' | 'generic' | 'compute'
  /** Source-file basename — lets the site pair this example with its `?raw` source for display. */
  readonly file: string
  readonly module: ModuleDecl
  /** WebGL2-renderable? Compute kernels are WGSL/WebGPU-only (GLSL ES 3.00 has no compute) → false. */
  readonly renderable: boolean
  /** Per-uniform-field fill strategy, keyed by the uniform struct's field name. */
  readonly controls?: Readonly<Record<string, Control>>
  /** For split-screen comparison examples: on-canvas badges naming the halves
   *  ([left, right]) — the host overlays them so the comparison reads at a glance. */
  readonly splitLabels?: readonly [string, string]
}
