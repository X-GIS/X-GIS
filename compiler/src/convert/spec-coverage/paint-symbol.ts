import type { CoverageEntry } from './types'

export const PAINT_SYMBOL: readonly CoverageEntry[] = [
  {
    name: 'text-color',
    status: 'supported',
    note: 'Constant + interpolate-by-zoom + per-feature colorExpr.',
    source: 'layers.ts:199',
  },
  {
    name: 'text-opacity',
    status: 'supported',
    note: 'Constant folded into label-color alpha (applyAlphaMultiplier). Zoom-interp + data-driven emit `label-opacity-[…]` → LabelShapes.opacity PropertyShape; runtime resolveNumberShape multiplies into resolvedColor.a + resolvedHalo.color.a per frame. Iter 113.',
    source: 'layers.ts:480',
  },
  {
    name: 'text-halo-color',
    status: 'supported',
    note: 'Constant + interpolate-by-zoom.',
    source: 'layers.ts:269',
  },
  {
    name: 'text-halo-width',
    status: 'supported',
    note: 'Constant + interpolate-by-zoom; PR #76 fixed scaling into SDF units.',
    source: 'layers.ts:259',
  },
  {
    name: 'text-halo-blur',
    status: 'supported',
    note: 'Constant only at conversion; IR exposes a PropertyShape so future zoom-interp / data-driven emit lands without IR changes.',
    source: 'layers.ts:283',
  },
  {
    name: 'text-translate',
    status: 'supported',
    note: 'Pixel-space offset added on top of em-unit text-offset.',
    source: 'layers.ts:340',
  },
  {
    name: 'text-translate-anchor',
    status: 'supported',
    note: 'viewport (default) = screen-space (byte-identical historical path); map = world-space: the converter emits `label-translate-anchor-map` (layers-symbol.ts text-translate-anchor) → LabelDef.translateAnchorMap → TextStage.prepare rotates the [dx,dy] text-translate by the map bearing (rotateLabelTranslate, mirror of the fill/line clip-space bake — Phase S Batch 2) before the per-anchor pixel add; the rotated value also re-keys the layout cache so a bearing change never serves a stale offset. Pitch foreshortening of the offset not reproduced.',
    source: 'layers-symbol.ts text-translate-anchor / text-stage.ts rotateLabelTranslate',
  },
  {
    name: 'icon-color',
    status: 'supported',
    note: 'SDF sprite tint. iter 138 (Plan §4): IconRenderer carries a per-vertex tint + fwidth SDF fragment path; one batch mixes raster + SDF quads (per-vertex sdf flag, no pipeline split). Constant + zoom-interp + data-driven all route through LabelShapes.iconColor PropertyShape<RGBA> (same contract as text-color); runtime resolveColorShape at dispatchIcon → IconStage tint. Raster sprites ignore the tint per Mapbox spec.',
    source: 'layers.ts icon-color emit / icon-renderer.ts fs sdf branch',
  },
  {
    name: 'icon-opacity',
    status: 'supported',
    note: 'Constant + zoom-interp + data-driven all route through LabelShapes.iconOpacity PropertyShape. Runtime resolveNumberShape at dispatchIcon → IconStage.addIcon per-vertex alpha. Iter 113.',
    source: 'layers.ts:1260',
  },
  {
    name: 'icon-halo-color',
    status: 'na',
    // na — SDF-sprite-only; no SDF sprite in scope; revisit if an SDF sprite source lands.
    note: 'na — SDF-sprite-only; no SDF sprite in scope. icon-halo applies ONLY to SDF sprites (Mapbox spec); the sprite loader DOES read the flag (sprite-atlas-host.ts parseMetadata, `sdf: e.sdf === true`) but no in-scope sprite sets it: the iter-162 probe (playground/scripts/sprite-sdf-buffer-probe.ts) fetched the live OFM bright sprite — 264 entries, ZERO SDF — and the committed fixture-sprite.json declares none either, so this property is a guaranteed NO-OP on every target style. Reclassified unsupported → na (#777 I-H): a real gap only appears once an SDF sprite source becomes a target. Revisit then — the iter-138 SDF icon foundation (icon.ts fragment branch + per-vertex tint) already serves SDF icons; the implementation recipe is a second smoothstep at edge-haloWidth mirroring fs_text, per-vertex halo attrs extending the 9-float format (icon-renderer.ts / icon-vertex-format.ts), and a converter paint emit — the spritezero buffer constant stays UNRESOLVED until the probe pins it against a real SDF sprite.',
  },
  {
    name: 'icon-halo-width',
    status: 'na',
    // na — SDF-sprite-only; no SDF sprite in scope; revisit if an SDF sprite source lands.
    note: 'na — SDF-sprite-only; no SDF sprite in scope. Same disposition as icon-halo-color (iter-162 probe: OFM bright 0 SDF icons, fixture-sprite.json 0 SDF → guaranteed no-op). Reclassified unsupported → na (#777 I-H); revisit if an SDF sprite source lands.',
  },
  {
    name: 'icon-halo-blur',
    status: 'na',
    // na — SDF-sprite-only; no SDF sprite in scope; revisit if an SDF sprite source lands.
    note: 'na — SDF-sprite-only; no SDF sprite in scope. Same disposition as icon-halo-color (iter-162 probe: OFM bright 0 SDF icons, fixture-sprite.json 0 SDF → guaranteed no-op). Reclassified unsupported → na (#777 I-H); revisit if an SDF sprite source lands.',
  },
  {
    name: 'icon-translate',
    status: 'partial',
    impact: 'low',
    note: 'CSS-px viewport offset for icons (independent of text-translate). Constant [dx, dy] form wired end-to-end: converter emits `label-icon-translate-{x,y}-N` (layers-symbol.ts) → LabelDef.iconTranslateX/Y → dispatchIcon adds it (× dpr) to the icon anchor before IconStage.addIcon (label-pass.ts), alongside icon-offset. Default [0,0] = no-op. #777 I-F: the per-feature EXPRESSION form (case/match/get → [dx,dy]) now lowers to `label-icon-translate-[<expr>]` → LabelDef.iconTranslateExpr → applyFeatureExprs evaluates it per feature into iconTranslateX/Y. Still PARTIAL for one residual sub-form: zoom-`interpolate` of the [dx,dy] tuple snaps to the nearest stop (the runtime evaluate does NOT component-interpolate array-valued stops), so a smoothly zoom-animated translate is approximate.',
    source: 'layers-symbol.ts icon-translate emit / label-pass.ts dispatchIcon',
  },
  {
    name: 'icon-translate-anchor',
    status: 'supported',
    note: 'viewport (default) = screen-space (byte-identical); map = world-space: the converter emits `label-icon-translate-anchor-map` (layers-symbol.ts icon-translate-anchor) → LabelDef.iconTranslateAnchorMap → dispatchIcon rotates ONLY the icon-translate portion of the icon anchor offset by the map bearing (icon-offset, a layout nudge, stays screen-space) before IconStage.addIcon — mirror of text-translate-anchor / fill/line Phase S Batch 2. Pitch foreshortening of the offset not reproduced.',
    source: 'layers-symbol.ts icon-translate-anchor / label-pass.ts dispatchIcon',
  },
]
