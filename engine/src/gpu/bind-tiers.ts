// ═══════════════════════════════════════════════════════════════════
// Bind-group 4-tier descriptor planner
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 2 (wild-finding-starlight WebGPU-native plan). The
// current renderer collapses every binding onto a single bind group
// (`mr-baseBindGroupLayout` / `mr-featureBindGroupLayout`) — the
// uniform buffer (per-tile data), feat_data storage buffer, palette
// texture, and sampler all live on `@group(0)`. That over-couples
// change frequencies: re-binding the uniform ring every tile forces
// the GPU driver to re-validate the texture + sampler bindings too,
// even though those are device-lifetime constants.
//
// The 4-tier hierarchy separates bindings by INVALIDATION FREQUENCY:
//
//   Tier 0 (Constants) — device lifetime
//     palette atlases, font atlas, sprite atlas, large match() LUTs
//     (P3 / P5). Bound once at scene compile, never re-bound.
//
//   Tier 1 (Camera) — frame
//     mvp matrix, zoom, time, resolution, DPR. One writeBuffer per
//     frame; setBindGroup once per pass.
//
//   Tier 2 (Tile) — per-tile / per-source
//     tile_origin_merc, cam_h / cam_l, tile_extent_m, clip_bounds,
//     extrude_height_m, layer_depth_offset, pick_id. One dynamic-
//     offset per draw via the existing uniform ring.
//
//   Tier 3 (Feature) — per-feature / per-segment
//     feat_data storage buffer (data-driven match), segment slot 17 /
//     18 baked widths + colors. Per-tile bind group rebuild.
//
// This module is the PURE descriptor planner — it accepts a list of
// tier slot specs and returns the per-tier `GPUBindGroupLayoutEntry`
// arrays. A separate (device-aware) registry will consume the plan
// to call `device.createBindGroupLayout` and cache the handles.
// Splitting pure-planning from impure-allocation keeps the unit
// tests free of a GPUDevice fixture.
//
// What this module does NOT do:
//
//   - Allocate GPU resources. The pure planner returns descriptors;
//     a future `BindTierRegistry` will own the device side.
//   - Migrate existing renderer.ts / VTR call sites. Step B (next
//     commit) flips those over.

/** Bind-group invalidation tier. Constants stay attached to the
 *  pipeline for the device's lifetime; Feature rebinds per tile.
 *  Lower index = stickier = cheaper rebind. */
export const BindTier = {
  Constants: 0,
  Camera: 1,
  Tile: 2,
  Feature: 3,
} as const

export type BindTierValue = typeof BindTier[keyof typeof BindTier]

/** Lightweight descriptor for one binding slot. The visibility +
 *  resourceType fields map onto WebGPU's `GPUBindGroupLayoutEntry`
 *  but using high-level names (no per-callsite GPUTextureSampleType
 *  / GPUBufferBindingType strings) so the call sites stay readable
 *  and don't have to import GPU type modules at module load time. */
export interface TierSlot {
  tier: BindTierValue
  /** `@binding(N)` index inside its tier's group. Two slots in the
   *  SAME tier must have distinct bindings; bindings across DIFFERENT
   *  tiers may collide (different group). */
  binding: number
  /** Bitset of `GPUShaderStage`. Use the WebGPU constants
   *  (VERTEX = 1, FRAGMENT = 2) at the call site; this module is
   *  resource-type-agnostic. */
  visibility: number
  /** High-level resource kind. Translates to the right buffer{} /
   *  texture{} / sampler{} field on the WebGPU layout entry. */
  resourceType:
    | 'uniform'
    | 'uniform-dynamic'         // hasDynamicOffset = true
    | 'storage-readonly'
    | 'texture-float-2d'
    | 'texture-uint-2d'
    | 'sampler-filtering'
    | 'sampler-nonfiltering'
  /** Human-readable identifier; used in layout labels so WebGPU's
   *  validation messages name the offending slot. */
  label?: string
}

/** Map each tier (0..3) to its `GPUBindGroupLayoutEntry` array,
 *  ready to feed `device.createBindGroupLayout`. Tiers with no
 *  slots get an empty entry array (still useful for pipeline
 *  layouts that need to declare ALL tiers even if some are unused).
 */
export interface PlannedTiers {
  entries: Map<BindTierValue, GPUBindGroupLayoutEntry[]>
  /** True when at least one slot referenced this tier. Lets the
   *  pipeline-layout builder skip empty tier slots cleanly. */
  hasTier: Map<BindTierValue, boolean>
}

function resourceFieldFor(
  type: TierSlot['resourceType'],
): Partial<GPUBindGroupLayoutEntry> {
  switch (type) {
    case 'uniform':
      return { buffer: { type: 'uniform' } }
    case 'uniform-dynamic':
      return { buffer: { type: 'uniform', hasDynamicOffset: true } }
    case 'storage-readonly':
      return { buffer: { type: 'read-only-storage' } }
    case 'texture-float-2d':
      return { texture: { sampleType: 'float', viewDimension: '2d' } }
    case 'texture-uint-2d':
      return { texture: { sampleType: 'uint', viewDimension: '2d' } }
    case 'sampler-filtering':
      return { sampler: { type: 'filtering' } }
    case 'sampler-nonfiltering':
      return { sampler: { type: 'non-filtering' } }
  }
}

/** Group slots by tier + materialise the WebGPU descriptor entries.
 *  Validates that bindings within the same tier are unique — a
 *  duplicate `@binding(N)` in one tier is a compile-time bug, not a
 *  silent draw failure. Throws on collision with a message naming
 *  both offending slots' labels. */
export function planTierLayout(slots: readonly TierSlot[]): PlannedTiers {
  const entries = new Map<BindTierValue, GPUBindGroupLayoutEntry[]>()
  const hasTier = new Map<BindTierValue, boolean>()
  const seen = new Map<string, string>()  // "tier:binding" → label
  for (const t of Object.values(BindTier)) {
    entries.set(t as BindTierValue, [])
    hasTier.set(t as BindTierValue, false)
  }
  for (const slot of slots) {
    const key = `${slot.tier}:${slot.binding}`
    const prior = seen.get(key)
    if (prior !== undefined) {
      throw new Error(
        `[bind-tiers] tier ${slot.tier} @binding(${slot.binding}) collision: `
        + `"${prior}" vs "${slot.label ?? '<unlabeled>'}". `
        + `Each tier owns a distinct binding space; if these slots are `
        + `meant to coexist, move one to a different tier.`,
      )
    }
    seen.set(key, slot.label ?? '<unlabeled>')
    const entry: GPUBindGroupLayoutEntry = {
      binding: slot.binding,
      visibility: slot.visibility,
      ...resourceFieldFor(slot.resourceType),
    }
    entries.get(slot.tier)!.push(entry)
    hasTier.set(slot.tier, true)
  }
  // Sort within each tier by binding for deterministic descriptor
  // order — keeps the WebGPU validation messages predictable and
  // lets equality checks in tests compare structurally.
  for (const arr of entries.values()) arr.sort((a, b) => a.binding - b.binding)
  return { entries, hasTier }
}

/** Convenience: build a `GPUPipelineLayout`-ready array of bind-group
 *  layouts in tier order (0..3), filtering out tiers that have no
 *  slots. Caller pairs this with `device.createPipelineLayout`. */
export function tierLayoutOrder(
  planned: PlannedTiers,
  resolve: (tier: BindTierValue) => GPUBindGroupLayout,
): GPUBindGroupLayout[] {
  const out: GPUBindGroupLayout[] = []
  for (const t of [BindTier.Constants, BindTier.Camera, BindTier.Tile, BindTier.Feature]) {
    if (planned.hasTier.get(t)) out.push(resolve(t))
  }
  return out
}

// ─── Device-aware registry ─────────────────────────────────────────

/** Owns the GPU side of the 4-tier hierarchy: materialises one
 *  `GPUBindGroupLayout` per non-empty tier and caches it. One
 *  registry per renderer instance — caller hands it to every
 *  pipeline/bind-group construction site instead of inline
 *  `createBindGroupLayout` calls.
 *
 *  Lifetime: registry is held for as long as the device is alive.
 *  Layouts created here aren't disposable individually — WebGPU
 *  reference-counts them and GC drops them when the last
 *  pipeline+bindGroup referencing them goes away.
 *
 *  Why a class (vs a free function): caching. Each `getLayout` call
 *  must return the SAME GPUBindGroupLayout handle so two pipelines
 *  built against tier 0 share validation state. A free function
 *  would either create N copies or require the caller to memoise. */
export class BindTierRegistry {
  private readonly layouts = new Map<BindTierValue, GPUBindGroupLayout>()
  private readonly planned: PlannedTiers
  private readonly device: GPUDevice
  private readonly labelPrefix: string

  constructor(device: GPUDevice, planned: PlannedTiers, labelPrefix = 'bind-tier') {
    this.device = device
    this.planned = planned
    this.labelPrefix = labelPrefix
  }

  /** Return the `GPUBindGroupLayout` for this tier, creating it on
   *  first request. Returns `null` if the tier has no slots — caller
   *  should skip the corresponding `setBindGroup` call entirely. */
  getLayout(tier: BindTierValue): GPUBindGroupLayout | null {
    if (!this.planned.hasTier.get(tier)) return null
    const cached = this.layouts.get(tier)
    if (cached) return cached
    const entries = this.planned.entries.get(tier)!
    const layout = this.device.createBindGroupLayout({
      label: `${this.labelPrefix}-tier${tier}`,
      entries,
    })
    this.layouts.set(tier, layout)
    return layout
  }

  /** Pipeline-layout-ready list of layouts in tier order (skips
   *  empty tiers). Wraps `tierLayoutOrder` with the registry's own
   *  `getLayout` so callers don't have to thread a resolver. */
  pipelineLayoutOrder(): GPUBindGroupLayout[] {
    return tierLayoutOrder(this.planned, t => this.getLayout(t)!)
  }

  /** Read-only access to the underlying plan — useful for tests +
   *  diagnostic logs that want to inspect the slot shape without
   *  triggering GPU allocation. */
  get plan(): PlannedTiers {
    return this.planned
  }
}
