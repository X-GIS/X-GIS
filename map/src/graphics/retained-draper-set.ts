// ═══ The five `map.graphics.*` retained drapers, built on first use (#1888) ═══
//
// Extracted from `GraphicsManager`, which had grown past the 800-line ceiling holding both
// the batch lifecycle and this. Draper OWNERSHIP is its own responsibility: which drapers
// exist, when they come into being, and what a device swap does to them.
//
// WHY FIRST USE, not device attach. Each draper's constructor emits (or looks up) its shader
// immediately, so constructing all five at attach put all five shader families in the BOOT
// baked group — for an API a session opts into. `shaders/baked/ids.ts` derives the boot/lazy
// split from where these constructors sit, and `shaders/baked/install.test.ts`'s census reads
// THIS FILE to check the two agree, in both directions. That census matches on the literal
// `new <Name>Draper(` spelling, which is why the five stay written out rather than collapsing
// into a table of constructor references: a `new Ctor(...)` would be invisible to it, and the
// gate would go quietly vacuous instead of loudly wrong.
//
// `null` means BOTH "no device yet" and "nothing has asked for this yet". The two are
// indistinguishable to a caller and neither is drawable, so callers keep the single
// null-check they always had.
//
// `format` is typed `string` — what every draper constructor here declares. This module sits
// behind the RHI seam, so naming the WebGPU DOM type instead would buy a raw-WebGPU token
// (the #991 ratchet, which counts the spelling anywhere in the file, comments included) for
// no type safety the drapers themselves ask for.

import type { RhiDevice, RhiBuffer, RhiBindGroup, RhiTextureView, RhiSampler } from '@xgis/rhi'
import { RetainedIconDraper } from '../render/material/icon-retained-material'
import { RetainedArrowDraper } from '../render/material/arrow-retained-material'
import { RetainedArrowAdvectedDraper } from '../render/material/arrow-retained-advected-material'
import { RetainedCircleDraper } from '../render/material/circle-retained-material'
import { RetainedParticleDraper } from '../render/material/particle-retained-material'

/** Every retained spec kind, `text` included — it has no draper, and saying so here is what
 *  lets the manager pass `spec.type` straight through instead of pre-filtering. */
export type RetainedKind = 'arrow' | 'circle' | 'particle-flow' | 'icon' | 'text'

/** Any of the five. Callers only ever need `draw`, which every member has with the same
 *  signature; the shapes that DIFFER (the icon's atlas-bound bind group) are discriminated
 *  inside this module, where the concrete classes are known. */
export type AnyRetainedDraper =
  | RetainedIconDraper
  | RetainedArrowDraper
  | RetainedArrowAdvectedDraper
  | RetainedCircleDraper
  | RetainedParticleDraper

export class RetainedDraperSet {
  private rhi: RhiDevice | null = null
  private format: string | null = null
  private uniformBytes = 0
  private icon: RetainedIconDraper | null = null
  private arrow: RetainedArrowDraper | null = null
  private advected: RetainedArrowAdvectedDraper | null = null
  private circle: RetainedCircleDraper | null = null
  private particle: RetainedParticleDraper | null = null

  /** Bind the per-run device. Constructs NOTHING — a device attach is not evidence that
   *  anything will be drawn through these. Clears every slot so the next run rebuilds against
   *  the new device rather than handing back one bound to the old. */
  attach(rhi: RhiDevice, format: string, uniformBytes: number): void {
    this.rhi = rhi
    this.format = format
    this.uniformBytes = uniformBytes
    this.releaseSlots()
  }

  /** Drop the device and every built draper — `GraphicsManager.destroyGpu`'s half of the
   *  contract. Without it a slot keeps a draper bound to the device just destroyed, and the
   *  accessors below, which read a non-null slot as "already built", hand it straight back. */
  detach(): void {
    this.rhi = null
    this.format = null
    this.releaseSlots()
  }

  private releaseSlots(): void {
    this.icon = null
    this.arrow = null
    this.advected = null
    this.circle = null
    this.particle = null
  }

  /** True once a device is attached — the precondition every accessor shares. */
  private get ready(): boolean {
    return this.rhi !== null && this.format !== null
  }

  iconDraper(): RetainedIconDraper | null {
    if (this.icon === null && this.ready)
      this.icon = new RetainedIconDraper(this.rhi!, this.format!, 1, this.uniformBytes)
    return this.icon
  }

  arrowDraper(): RetainedArrowDraper | null {
    if (this.arrow === null && this.ready)
      this.arrow = new RetainedArrowDraper(this.rhi!, this.format!, 1, this.uniformBytes)
    return this.arrow
  }

  advectedArrowDraper(): RetainedArrowAdvectedDraper | null {
    if (this.advected === null && this.ready)
      this.advected = new RetainedArrowAdvectedDraper(this.rhi!, this.format!, 1, this.uniformBytes)
    return this.advected
  }

  circleDraper(): RetainedCircleDraper | null {
    if (this.circle === null && this.ready)
      this.circle = new RetainedCircleDraper(this.rhi!, this.format!, 1, this.uniformBytes)
    return this.circle
  }

  particleDraper(): RetainedParticleDraper | null {
    if (this.particle === null && this.ready)
      this.particle = new RetainedParticleDraper(this.rhi!, this.format!, 1, this.uniformBytes)
    return this.particle
  }

  /** The draper for one batch kind — the single call `materialise` makes, so packing a circle
   *  builds the circle draper and leaves the other four unbuilt. */
  forKind(type: RetainedKind): AnyRetainedDraper | null {
    switch (type) {
      case 'arrow':
        return this.arrowDraper()
      case 'circle':
        return this.circleDraper()
      case 'particle-flow':
        return this.particleDraper()
      case 'icon':
        return this.iconDraper()
      default:
        return null
    }
  }

  /** Build one batch's group-1 bind group. The discrimination lives HERE because only this
   *  module knows the concrete classes: the five drapers share method names, so `instanceof`
   *  narrowing over the union is inert at a call site — the negative branch keeps the icon
   *  member and its 4-argument signature, which tsc then rejects. `text` has no draper and no
   *  bind group by design (it packs and uploads but never draws), so it answers null.
   *
   *  The icon draper is the only one that binds the atlas; the other three read feat + tint. */
  makeBatchBindGroup(
    type: RetainedKind,
    feat: RhiBuffer,
    tint: RhiBuffer,
    atlasView: () => RhiTextureView,
    atlasSampler: () => RhiSampler,
  ): RhiBindGroup | null {
    switch (type) {
      case 'arrow':
        return this.arrowDraper()?.makeBatchBindGroup(feat, tint) ?? null
      case 'circle':
        return this.circleDraper()?.makeBatchBindGroup(feat, tint) ?? null
      case 'particle-flow':
        return this.particleDraper()?.makeBatchBindGroup(feat, tint) ?? null
      case 'icon':
        return (
          this.iconDraper()?.makeBatchBindGroup(feat, tint, atlasView(), atlasSampler()) ?? null
        )
      default:
        return null
    }
  }

  /** Already-built drapers only — the draw path's lookup. A drawable batch was materialised,
   *  which is what built its draper, so this never has to construct one mid-frame. */
  builtForKind(type: RetainedKind): AnyRetainedDraper | null {
    switch (type) {
      case 'arrow':
        return this.arrow
      case 'circle':
        return this.circle
      case 'particle-flow':
        return this.particle
      case 'icon':
        return this.icon
      default:
        return null
    }
  }
}
