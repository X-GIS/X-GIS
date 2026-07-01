// ═══════════════════════════════════════════════════════════════════
// Bind-group layout drift invariant — iter-204A
// ═══════════════════════════════════════════════════════════════════
//
// Catches the iter-197 bug class: a BindGroup entry references a
// binding number that the matching BindGroupLayout doesn't declare,
// so WebGPU validation errors flood the console and rendering halts.
//
// Concrete iter-197 trace:
//
//   In entries[4], binding index 5 not present in the bind group layout.
//   Expected layout: [ binding 0, 1, 2, 4, 16 ]  ← `FEATURE_LAYOUT_ENTRIES`
//                                                  was missing bindings 5/6
//   Bind group entries: [ 0, 1, 2, 4, 5, 6, 16 ] ← VTR per-tile-feature-bg
//                                                  binds them unconditionally
//
// Root cause was drift between `MapRenderer.FEATURE_LAYOUT_ENTRIES`
// (the static used by `getOrBuildVariantLayout` for compute-extended
// layouts) and the function-scope `paletteLayoutEntries` (the
// per-method local used by the non-compute path's
// `bindGroupLayout` + `featureBindGroupLayout`). iter-181/182 added
// bindings 5/6 to paletteLayoutEntries WITHOUT updating
// FEATURE_LAYOUT_ENTRIES — the non-compute path silently picked up
// the new sprite atlas slots while the compute path stayed on the
// old layout.
//
// Invariant pinned here:
//
//   The set of binding numbers that PALETTE_LAYOUT_ENTRIES declares
//   MUST be a subset of FEATURE_LAYOUT_ENTRIES (excluding bindings
//   that are exclusive to the feature path — binding 0 uniform +
//   binding 1 feature-data storage). Equivalently: every binding the
//   non-compute per-tile BindGroup writes for the palette/sprite
//   slots MUST appear in the compute layout's base entry list too.
//
// When does this test fire?
//
//   Any future commit that:
//     - Adds a binding to PALETTE_LAYOUT_ENTRIES without adding it to
//       FEATURE_LAYOUT_ENTRIES.
//     - Adds a binding to FEATURE_LAYOUT_ENTRIES via a different
//       visibility mask than its PALETTE_LAYOUT_ENTRIES entry would
//       declare. WebGPU validates layout entries by visibility too.
//
// Why not just dedup the two arrays in production code?
//
//   Future iterations may want differing entries in the two layouts
//   (e.g. a feature-only debug binding). The invariant locks the
//   palette+sprite OVERLAP, not the entire layout. If a binding
//   intentionally diverges, this test guides the author to update
//   the invariant deliberately instead of letting drift slip in.

import { describe, it, expect } from 'vitest'
import { FrameRenderer } from '@xgis/map'

interface MinimalEntry {
  binding: number
  visibility: number | GPUFlagsConstant
}

function asMinimal(e: GPUBindGroupLayoutEntry): MinimalEntry {
  return { binding: e.binding, visibility: e.visibility as number }
}

describe('bind-group layout drift invariant (iter-204A)', () => {
  it('every PALETTE_LAYOUT_ENTRIES binding is present in FEATURE_LAYOUT_ENTRIES', () => {
    const feature = FrameRenderer.getFeatureLayoutEntries().map(asMinimal)
    const palette = FrameRenderer.PALETTE_LAYOUT_ENTRIES.map(asMinimal)
    const featureBindings = new Set(feature.map(e => e.binding))
    const missingFromFeature = palette
      .map(e => e.binding)
      .filter(b => !featureBindings.has(b))
    expect(
      missingFromFeature,
      `These palette bindings are missing from FEATURE_LAYOUT_ENTRIES: [${missingFromFeature.join(', ')}]. ` +
      `Bind groups writing these slots will fail WebGPU validation on the compute path. ` +
      `Re-add the missing binding(s) to FEATURE_LAYOUT_ENTRIES (renderer.ts) — see iter-197.`,
    ).toEqual([])
  })

  it('matching bindings declare matching visibility masks', () => {
    const feature = FrameRenderer.getFeatureLayoutEntries().map(asMinimal)
    const palette = FrameRenderer.PALETTE_LAYOUT_ENTRIES.map(asMinimal)
    const byBinding = new Map(feature.map(e => [e.binding, e.visibility]))
    const mismatches: { binding: number; feature: number; palette: number }[] = []
    for (const p of palette) {
      const f = byBinding.get(p.binding)
      if (f === undefined) continue  // covered by the subset test
      if (f !== p.visibility) {
        mismatches.push({ binding: p.binding, feature: f as number, palette: p.visibility as number })
      }
    }
    expect(
      mismatches,
      'PALETTE_LAYOUT_ENTRIES and FEATURE_LAYOUT_ENTRIES disagree on visibility for the same binding. ' +
      'WebGPU validates visibility per entry; a mismatch fails layout construction.',
    ).toEqual([])
  })

  it('canonical binding set covers 2 / 4 / 5 / 6 (palette + sprite atlas slots)', () => {
    // Sanity pin. If a future refactor renames or renumbers the palette
    // slot, this test points at the original intent. Bindings 2 (palette
    // atlas) + 4 (palette sampler) are P3-era; bindings 5 (sprite atlas)
    // + 6 (sprite sampler) are iter-181/182.
    const bindings = FrameRenderer.PALETTE_LAYOUT_ENTRIES.map(e => e.binding).sort((a, b) => a - b)
    expect(bindings).toEqual([2, 4, 5, 6])
  })

  it('FEATURE_LAYOUT_ENTRIES additionally includes 0 (uniform) + 1 (feature-data storage)', () => {
    // Mirror sanity for the feature-path-specific bindings. These are
    // NOT in PALETTE_LAYOUT_ENTRIES — feature buffer is the layer that
    // distinguishes the feature path from the base path.
    const bindings = FrameRenderer.getFeatureLayoutEntries()
      .map(e => e.binding).sort((a, b) => a - b)
    expect(bindings).toEqual([0, 1, 2, 4, 5, 6])
  })
})
