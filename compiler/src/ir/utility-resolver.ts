// Resolves utility items into rendering properties
// Maps Tailwind-style utility names to ShowCommand fields

import { resolveColor } from '../tokens/colors'
import type { UtilityItem } from '../parser/ast'

export interface ResolvedProperties {
  fill: string | null
  stroke: string | null
  strokeWidth: number
  opacity: number
  projection: string
  visible: boolean
  /** CSS-style pointer interactivity. 'none' tells the runtime to skip
   *  writing this layer's pickId into the pick texture's G channel
   *  (writeMask:0 on a pipeline variant), so picks fall through to
   *  whatever drew underneath. 'auto' is the default and makes the
   *  layer pickable. */
  pointerEvents: 'auto' | 'none'
}

const DEFAULTS: ResolvedProperties = {
  fill: null,
  stroke: null,
  strokeWidth: 1,
  opacity: 1.0,
  projection: 'mercator',
  visible: true,
  pointerEvents: 'auto',
}

/**
 * Resolve an array of utility items into rendering properties.
 * Later items override earlier ones (cascade).
 */
export function resolveUtilities(items: UtilityItem[]): ResolvedProperties {
  const result = { ...DEFAULTS }

  for (const item of items) {
    // Skip items with modifiers for now (Phase 1B)
    if (item.modifier) continue

    applyUtility(result, item.name)
  }

  return result
}

function applyUtility(props: ResolvedProperties, name: string): void {
  // fill-{color} — e.g., fill-red-500, fill-white
  if (name.startsWith('fill-')) {
    const colorName = name.slice(5)
    const hex = resolveColor(colorName)
    if (hex) {
      props.fill = hex
      return
    }
  }

  // stroke-{color} — e.g., stroke-white, stroke-black, stroke-blue-500
  // stroke-{N} — e.g., stroke-1, stroke-2
  if (name.startsWith('stroke-')) {
    const rest = name.slice(7)
    // Try as number (stroke width)
    const num = parseFloat(rest)
    if (!isNaN(num) && rest === String(num)) {
      props.strokeWidth = num
      return
    }
    // Try as color
    const hex = resolveColor(rest)
    if (hex) {
      props.stroke = hex
      return
    }
  }

  // opacity-{N} — e.g., opacity-80 → 0.8
  if (name.startsWith('opacity-')) {
    const num = parseFloat(name.slice(8))
    if (!isNaN(num)) {
      props.opacity = num <= 1 ? num : num / 100
      return
    }
  }

  // projection-{name} — e.g., projection-mercator
  if (name.startsWith('projection-')) {
    props.projection = name.slice(11)
    return
  }

  // visible / hidden
  if (name === 'visible') { props.visible = true; return }
  if (name === 'hidden') { props.visible = false; return }

  // pointer-events-{none,auto} — CSS-equivalent. 'none' makes the layer
  // non-pickable (skips pick texture write via writeMask:0 variant);
  // 'auto' is the default. Used by the DOM-inspired layer API so
  // authors can mark decorative layers as non-interactive in the DSL.
  if (name === 'pointer-events-none') { props.pointerEvents = 'none'; return }
  if (name === 'pointer-events-auto') { props.pointerEvents = 'auto'; return }
}
