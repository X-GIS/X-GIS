// ═══ Per-layer-type converter registry ═══
// A4 (Tier-A, parallel-axis registry). `convertLayer` was the single
// layer-type dispatch authority — a chain of `if (layer.type === …)`
// branches plus an inline generic emit body whose only per-type
// variation was the `line` layout-utility block. This registry turns
// that god-function into an assembler: each layer type self-registers
// its converter in its own module, so two future changes in different
// layer types (e.g. a new fill paint prop vs a new line layout util)
// touch different files (append-only, parallel-safe).
//
// FAITHFUL RELOCATION: the per-type converter bodies are the same code
// that lived in convertLayer / its helpers — byte-identical output and
// identical warnings[] push order. The dispatcher (layers.ts) preserves
// the exact branch order: a registry HIT short-circuits exactly the
// types that emitted before the skip-reason/validation path today
// (symbol, circle, fill, line, fill-extrusion, raster); a MISS falls
// through to the same SKIP_REASONS + type-validation path as before.

import type { MapboxLayer } from '../types'

export type LayerConvertFn = (layer: MapboxLayer, warnings: string[]) => string | null

export const LAYER_CONVERTERS: Map<string, LayerConvertFn> = new Map()

export function registerLayerConverter(layerType: string, fn: LayerConvertFn): void {
  LAYER_CONVERTERS.set(layerType, fn)
}
