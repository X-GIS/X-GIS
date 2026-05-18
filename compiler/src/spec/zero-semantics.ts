// Mapbox Style Spec — zero-value semantics.
//
// For each property, this module pins what value=0 MEANS per spec
// (vs how the runtime currently treats it). Pre-fix several properties
// drifted from spec at zero:
//   - line-blur=0 still applied 1.5px smoothstep fade (runtime)
//   - line-gap-width=0 / line-offset=0 correctly skip emit (no-op)
//   - text-opacity=0 / icon-opacity=0 are visually invisible but still
//     occupy collision space (matches Mapbox — intentional)
//
// The kind tag drives test gates and runtime branches:
//   * 'identity'      — 0 produces a no-op equivalent to the spec
//                       default; converter usually skips emit.
//   * 'strict-zero'   — 0 must produce a hard / sharp result;
//                       any soft edge / fallback is a spec violation.
//   * 'invisible-but-present' — 0 is invisible BUT the feature still
//                               participates in collision, occlusion,
//                               or layout (matches Mapbox).

export type ZeroKind =
  | 'identity'
  | 'strict-zero'
  | 'invisible-but-present'

export interface ZeroSemantic {
  property: string
  layerType: 'fill' | 'line' | 'symbol' | 'circle' | 'fill-extrusion' | 'raster' | 'background' | 'heatmap'
  kind: ZeroKind
  rationale: string
}

export const ZERO_SEMANTICS: readonly ZeroSemantic[] = [
  // ─── line ──────────────────────────────────────────────────
  {
    property: 'line-blur',
    layerType: 'line',
    kind: 'identity',
    rationale:
      'blur=0 means no ADDITIONAL blur on top of the implicit edge AA per Mapbox spec. X-GIS line shader splits aa_width_px as (0.5 + blur_px); blur=0 still keeps the 0.5px edge AA (which is required for any antialiased SDF line — making it strict-zero would produce jagged staircase edges). Identity at zero.',
  },
  {
    property: 'line-gap-width',
    layerType: 'line',
    kind: 'identity',
    rationale:
      'gap-width=0 means a single line (no inner gap). Converter correctly skips emit (utility absent = single line).',
  },
  {
    property: 'line-offset',
    layerType: 'line',
    kind: 'identity',
    rationale:
      'offset=0 means line centered on its geometry. Converter correctly skips emit.',
  },
  {
    property: 'line-width',
    layerType: 'line',
    kind: 'strict-zero',
    rationale:
      'width=0 means a zero-thickness line — should NOT render (Mapbox spec). Pre-AA padding could leak a pixel; verify with pixel-diff.',
  },

  // ─── fill ──────────────────────────────────────────────────
  {
    property: 'fill-opacity',
    layerType: 'fill',
    kind: 'invisible-but-present',
    rationale:
      'opacity=0 → transparent fill. Per Mapbox the geometry is still drawn (occludes nothing because alpha=0). X-GIS matches.',
  },
  {
    property: 'fill-antialias',
    layerType: 'fill',
    kind: 'strict-zero',
    rationale:
      'antialias=false (treated as zero-AA) means hard edges. Runtime currently always smoothsteps — known gap.',
  },

  // ─── symbol (text) ─────────────────────────────────────────
  {
    property: 'text-opacity',
    layerType: 'symbol',
    kind: 'invisible-but-present',
    rationale:
      'opacity=0 invisible but the label still participates in collision (Mapbox semantics). X-GIS matches.',
  },
  {
    property: 'text-halo-width',
    layerType: 'symbol',
    kind: 'identity',
    rationale: 'halo-width=0 → no halo emitted. Mapbox + X-GIS agree.',
  },
  {
    property: 'text-halo-blur',
    layerType: 'symbol',
    kind: 'identity',
    rationale: 'halo-blur=0 → hard halo edge. Identity at zero.',
  },

  // ─── symbol (icon) ─────────────────────────────────────────
  {
    property: 'icon-opacity',
    layerType: 'symbol',
    kind: 'invisible-but-present',
    rationale:
      'opacity=0 invisible but icon still claims collision space. Matches Mapbox.',
  },
  {
    property: 'icon-halo-width',
    layerType: 'symbol',
    kind: 'identity',
    rationale: 'halo-width=0 → no halo. Identity at zero.',
  },

  // ─── circle ────────────────────────────────────────────────
  {
    property: 'circle-radius',
    layerType: 'circle',
    kind: 'identity',
    rationale: 'radius=0 → no visible circle. Drawn as a degenerate point (no fragments).',
  },
  {
    property: 'circle-opacity',
    layerType: 'circle',
    kind: 'invisible-but-present',
    rationale: 'opacity=0 invisible but still claims pick / occlusion.',
  },
  {
    property: 'circle-stroke-width',
    layerType: 'circle',
    kind: 'identity',
    rationale: 'stroke-width=0 → no stroke drawn.',
  },

  // ─── fill-extrusion ────────────────────────────────────────
  {
    property: 'fill-extrusion-height',
    layerType: 'fill-extrusion',
    kind: 'identity',
    rationale: 'height=0 → flat polygon at ground level (no walls, only top face).',
  },
  {
    property: 'fill-extrusion-base',
    layerType: 'fill-extrusion',
    kind: 'identity',
    rationale: 'base=0 (default) → wall starts at ground level.',
  },
  {
    property: 'fill-extrusion-opacity',
    layerType: 'fill-extrusion',
    kind: 'invisible-but-present',
    rationale: 'opacity=0 transparent walls — Mapbox draws them anyway (depth buffer participation preserved).',
  },

  // ─── raster ────────────────────────────────────────────────
  {
    property: 'raster-opacity',
    layerType: 'raster',
    kind: 'invisible-but-present',
    rationale: 'opacity=0 raster transparent but tile fetch / GPU upload still happens — Mapbox semantics.',
  },
] as const

/** Lookup zero-semantics for a property. Returns undefined if not
 *  catalogued — caller should treat as unknown / spec-default. */
export function zeroSemantic(
  layerType: ZeroSemantic['layerType'],
  property: string,
): ZeroSemantic | undefined {
  return ZERO_SEMANTICS.find(
    s => s.layerType === layerType && s.property === property,
  )
}
