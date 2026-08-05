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
  // #1429 INC-2 — the scene→screen seam. When the adaptive ladder scales the scene
  // target below native, this pass samples the resolved scene colour up into the
  // screen attachment; every pass BEFORE it writes scene-sized attachments, every
  // pass AFTER it writes the native screen attachment. At scale 1 it does not run
  // (shouldRun false) and the frame is byte-identical to the pre-split frame.
  'scene-upscale',
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

/** The scene→screen SEAM (#1429 INC-2) — the third role. The upscale READS the scene
 *  target and WRITES the screen attachment, so filing it into either half would falsify
 *  the rules that half asserts (a scene pass must not read `ctx.screen`; an overlay pass
 *  must not read `ctx.scene`). The seam must read BOTH — the partition gate asserts that
 *  positively. NOTE the read-role partition and the WRITE-target split are different
 *  axes: `heatmap`/`overdraw-compose` sit AFTER the seam in the order (they composite
 *  onto the native screen attachment) while keeping the scene READ-role — their grids
 *  rasterise at scene/own resolution and their composes are full-screen draws. */
export const SEAM_PASSES: readonly PassLabel[] = ['scene-upscale']

/** The world-rasterising half — DERIVED, never listed. A pass added to PASS_CHAIN_ORDER is a
 *  scene pass unless it declares itself overlay or seam above, so the sets cannot all forget
 *  it; the partition gate (target-role-partition.test.ts) proves the three roles cover the
 *  order exactly and that each pass's SOURCE reads the geometry its role names. */
export const SCENE_PASSES: readonly PassLabel[] = PASS_CHAIN_ORDER.filter(
  (label) => !OVERLAY_PASSES.includes(label) && !SEAM_PASSES.includes(label),
)
