// ═══ Pass-order authority — ONE frozen sequence, consumed by both orchestrations ═══
//
// The full-frame pass sequence is executed by TWO paths (#1004): the native
// pass-chain (pass-chain.ts buildRenderNodes — the WebGPU authority) and the
// forced-WebGL2 linear twin (render-loop.ts renderFrameViaRhi). Before this
// module each hand-maintained its own copy of the order, and the comments in
// render-loop.ts enumerate the real divergence bugs that caused (vanishing
// point labels, missing strokes, double-paint). This constant is the single
// authority: pass-chain BUILDS from it (constructive — it cannot diverge), and
// pass-order-parity.test.ts pins the twin's source order against it plus the
// documented not-yet-ported set below.
//
// Entries are the passes' real `label` strings ('labels', not 'label' — the
// singleton's label, label-pass.ts). Pure data, zero imports — safe for both
// runtime consumption and fs-scanning tests.

/** The byte-frozen full-frame pass order (see pass-chain.ts for per-pass
 *  semantics; oit is registered but runtime-dead — shouldRun immutably false). */
export const PASS_CHAIN_ORDER = [
  'background',
  // #1333 — the IBFV advection step. PRODUCER, so it must precede its consumer: the coverage
  // drape samples the advected field and draws inside `opaque`. Touches no swapchain
  // attachment (it renders only into its own grid-space pair), so it takes no part in the
  // clear/resolve ownership the surrounding buckets negotiate.
  'flow',
  'opaque',
  'oit',
  'translucent',
  'hillshade',
  'points',
  'labels',
  'heatmap',
  'overdraw-compose',
  'graphics',
] as const

export type PassLabel = (typeof PASS_CHAIN_ORDER)[number]

/** Which render target a pass rasterises into — the OVERLAY half of the frame.
 *
 *  Overlay passes draw screen-anchored symbology whose legibility IS the deliverable: a
 *  sounding numeral is not decoration that degrades gracefully, it is the only information its
 *  layer carries. They therefore read `ctx.screen`, the target the adaptive-DPR ladder may not
 *  shrink, while the world rasterises into `ctx.scene`, which it may
 *  (docs/architecture/design/overlay-native-resolution.md).
 *
 *  Membership is declared HERE and nowhere else, next to the order it partitions, so the two
 *  cannot be edited apart. */
export const OVERLAY_PASSES: readonly PassLabel[] = ['labels', 'graphics']

/** The world-rasterising half — DERIVED, never listed. A pass added to PASS_CHAIN_ORDER is a
 *  scene pass unless it declares itself overlay above, so the sets cannot both forget it; the
 *  partition gate (target-role-partition.test.ts) proves they cover the order exactly and that
 *  each pass's SOURCE reads the geometry its role names. */
export const SCENE_PASSES: readonly PassLabel[] = PASS_CHAIN_ORDER.filter(
  (label) => !OVERLAY_PASSES.includes(label),
)

/** Passes the renderFrameViaRhi twin does NOT yet port (#1004 shrink-only
 *  baseline): porting one to the twin must REMOVE it here in the same commit
 *  (pass-order-parity.test.ts fails otherwise — locks the win). oit is dead in
 *  both paths but stays listed for order fidelity. Close-out = [] when the
 *  #991 P4/P5 unification runs the RenderNode chain over RHI passes. */
export const RHI_TWIN_MISSING: readonly PassLabel[] = [
  'oit',
  // hillshade IS ported to the twin (render-loop.ts renderFrameViaRhi) so the
  // relief renders under ?forcegl2=1 for the _hillshade-gl2-gate (#777 Phase II).
  // 'points' ported in #1057 (direct-layer + the VT tile-points inline path);
  // 'heatmap' ported in #1060 (renderFrameViaRhi -> heatmapRenderer.renderRhi).
  'overdraw-compose',
]
