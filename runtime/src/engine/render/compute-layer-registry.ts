// ═══════════════════════════════════════════════════════════════════
// Compute layer registry — renderer-side glue aggregator
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 4-5l. The final runtime composition piece before the
// actual renderer integration. Owns the set of `ComputeLayerHandle`
// instances attached to a renderer and exposes a tiny surface area
// the renderer (`renderer.ts` GeoJSON path / `vector-tile-renderer.ts`
// MVT path) can wire in:
//
//   attach(key, variant, scenePlan, renderNodeIndex)
//     → instantiates a handle, or no-ops when the variant has no
//       compute bindings. Idempotent on same key — repeated calls
//       return the existing handle.
//
//   getHandle(key) → ComputeLayerHandle | null
//     → caller uses this to call uploadFromProps + bind-group
//       entry building.
//
//   dispatchAll(encoder)
//     → fires every kernel before any render pass. Called once
//       per frame from the orchestrator (map.ts:render).
//
//   detach(key) → destroys + removes
//     → called from the layer-removal path.
//
//   destroyAll() → renderer disposal.
//
// Goal: renderer integration shrinks to four call sites:
//   1. `attach(...)` inside addLayer when variant.computeBindings is set
//   2. `getHandle(key)?.uploadFromProps(...)` after feature data ready
//   3. `dispatchAll(encoder)` once per frame before any render pass
//   4. `detach(key)` inside removeLayer / clear
//
// What this module does NOT do:
//
//   - Touch the renderer. The renderer holds a `ComputeLayerRegistry`
//     instance and calls into it; the registry is itself dumb data.
//   - Decide layer identity. The renderer picks the key (typically
//     `show.targetName` or an internal layer index); the registry
//     just keys a Map.
//   - Build bind groups. The handle exposes that via
//     `getBindGroupEntries()`; renderer appends those to its layout
//     entries when creating bind groups.
//   - Handle WebGPU validation errors. Mismatches between the
//     scene plan and the variant.computeBindings surface as thrown
//     errors out of `ComputeLayerHandle`; the registry lets those
//     propagate.

import type { ComputePlanEntry, ShaderVariant } from '@xgis/compiler'
import { ComputeDispatcher } from '../gpu/compute'
import { ComputeLayerHandle } from './compute-layer-handle'

export class ComputeLayerRegistry {
  private dispatcher: ComputeDispatcher
  private handles = new Map<string, ComputeLayerHandle>()

  constructor(dispatcher: ComputeDispatcher) {
    this.dispatcher = dispatcher
  }

  /** Number of attached compute layers — diagnostic only. */
  get size(): number {
    return this.handles.size
  }

  /** Attach a compute handle for the given layer key. Returns the
   *  handle (existing or new), or null when the variant has no
   *  compute bindings (the common case — caller can short-circuit
   *  the rest of the compute wire-up).
   *
   *  Idempotent: a second call with the same key returns the
   *  existing handle without re-constructing — this is what lets
   *  the renderer call `attach` unconditionally inside its
   *  `addLayer` path without worrying about double-add.
   *
   *  Throws when the scene plan + variant.computeBindings drift
   *  (propagated from `ComputeLayerHandle`'s drift detection). */
  attach(
    key: string,
    variant: ShaderVariant,
    scenePlan: readonly ComputePlanEntry[] | undefined,
    renderNodeIndex: number,
  ): ComputeLayerHandle | null {
    if (!variant.computeBindings || variant.computeBindings.length === 0) {
      return null
    }
    const existing = this.handles.get(key)
    if (existing) return existing
    const handle = new ComputeLayerHandle(
      this.dispatcher, variant, scenePlan, renderNodeIndex,
    )
    this.handles.set(key, handle)
    return handle
  }

  /** Look up the handle for a given key, or null if none attached. */
  getHandle(key: string): ComputeLayerHandle | null {
    return this.handles.get(key) ?? null
  }

  /** Dispatch every attached handle's kernels onto the encoder in
   *  insertion order. Call ONCE per frame from the orchestrator
   *  before any render pass begins. No-op when the registry is
   *  empty — the renderer can call this unconditionally. */
  dispatchAll(encoder: GPUCommandEncoder): void {
    for (const handle of this.handles.values()) {
      handle.dispatch(encoder)
    }
  }

  /** Release the handle's GPU buffers and remove it from the
   *  registry. Returns true if a handle existed for the key. */
  detach(key: string): boolean {
    const handle = this.handles.get(key)
    if (!handle) return false
    handle.destroy()
    this.handles.delete(key)
    return true
  }

  /** Release every handle's GPU buffers + clear the map. Called
   *  on renderer disposal. */
  destroyAll(): void {
    for (const handle of this.handles.values()) {
      handle.destroy()
    }
    this.handles.clear()
  }

  /** Diagnostic — returns the set of attached keys in insertion
   *  order. Useful for tests + introspection panels. */
  keys(): string[] {
    return [...this.handles.keys()]
  }
}
