// ═══ Demo Definitions — SDF line renderer demos (styles, dashes, patterns, offset, translucent, stroke-align). ═══
// Faithful per-category fragment of the single DEMOS record (assembled in
// ../demos.ts, which preserves the original insertion order). Demo .xgis
// sources load via the shared loader; ids are unchanged (URL nav depends on
// them). Append-only: a new demo in this category is added HERE.

import { load, type Demo } from './loader'

export const DEMOS_LINES: Record<string, Demo> = {
  line_styles: {
    name: 'Line Styles',
    tag: 'line',
    description: 'Variable stroke width with round joins and caps — SDF line renderer',
    source: load('line-styles.xgis'),
  },

  dashed_lines: {
    name: 'Dashed Lines',
    tag: 'line',
    description: 'Simple dash array (20px on / 10px off) with cross-tile phase continuity',
    source: load('dashed-lines.xgis'),
  },

  pattern_lines: {
    name: 'Pattern Lines',
    tag: 'line',
    description: 'Imported symbol library — composite dash + railway-tie pattern + arrow cap',
    source: load('pattern-lines.xgis'),
  },

  multi_layer_line: {
    name: 'Multi-layer Line (regression)',
    tag: 'line',
    description: 'Two layers on one source — solid red + dashed blue. Regression guard for dynamic uniform offsets.',
    source: load('multi-layer-line.xgis'),
  },

  line_offset: {
    name: 'Line Offset',
    tag: 'line',
    description: 'Parallel offset rails — left-shifted red and right-shifted blue around a center coastline. Joins stay tight via offset-aware miter geometry.',
    source: load('line-offset.xgis'),
  },

  translucent_lines: {
    name: 'Translucent Lines',
    tag: 'line',
    description: 'Two transparent stroke layers stacked on coastline. Offscreen + MAX blend kills within-layer alpha accumulation so corners never darken.',
    source: load('translucent-lines.xgis'),
  },

  stroke_align: {
    name: 'Stroke Alignment',
    tag: 'line',
    description: 'GDI+-style center / inset / outset alignment. Three parallel coastlines shifted by half-width. Corners stay connected via offset-aware miter.',
    source: load('stroke-align.xgis'),
  },
}
