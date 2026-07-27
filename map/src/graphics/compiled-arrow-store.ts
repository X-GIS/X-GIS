// Compiled `| arrow` layer store (#1302) — the DECLARATIVE twin of the host arrow batches.
//
// Extracted from GraphicsManager (#1333): the compiled-arrow concern is a cohesive unit
// (its own batch record, its own lifecycle, its own DPR re-pack and draw fragment) that
// happens to share the arrow draper with the host path. Owning it here keeps the
// manager's remaining surface — the host retained-batch lifecycle — one concern, and
// gives the compiled path room to grow (pitch-alignment) without pushing
// graphics-manager.ts past its LOC ceiling.
//
// The store is DEVICE-COUPLED: it holds the same `rhi` + `arrowDraper` the manager
// builds at attachDevice and drops at destroyGpu, so a compiled layer added before a
// device exists is silently dropped — unchanged from the pre-extraction behaviour
// (addCompiledArrowLayer returned early on a null device; the compiler re-adds every
// layer on the post-device rebuildLayers anyway).
//
// Retirement is NOT owned here: cleared buffers are pushed onto the manager's shared
// `_retired` list so the drain (at the top of renderRetained, after the in-flight submit
// returns) stays a single authority.

import { packCompiledArrowFeat, packCompiledArrowTint } from './retained-arrow-packer'
import type { RetainedArrowDraper } from '../render/material/arrow-retained-material'
import type { RhiDevice, RhiBuffer, RhiBindGroup, RhiRenderPass } from '@xgis/engine'

/** A DECLARATIVE `| arrow` layer (#1302) — compiler-fed twin of a host arrow batch, same
 *  ARROW_RETAINED feat/tint layout; raw arrays (incl. strokeUnits, #1333) kept for DPR re-pack. */
interface CompiledArrowBatch {
  featBuf: RhiBuffer
  tintBuf: RhiBuffer
  bindGroup: RhiBindGroup
  count: number
  lons: Float64Array
  lats: Float64Array
  bearings: Float32Array
  sizes: Float32Array
  strokeUnits: number
}

export class CompiledArrowStore {
  private rhi: RhiDevice | null = null
  private draper: RetainedArrowDraper | null = null
  private readonly batches: CompiledArrowBatch[] = []

  /** GPU-upload counters, mirroring the manager's — incremented ONLY at the feat/tint
   *  writeBuffer sites (add / DPR re-pack), NEVER in `draw`. The manager folds these into
   *  its `getWriteCounts()` so the counter semantics are unchanged from before the split. */
  private _featWrites = 0
  private _tintWrites = 0

  /** Bind the per-run device + arrow draper (called from GraphicsManager.attachDevice). */
  attach(rhi: RhiDevice, draper: RetainedArrowDraper): void {
    this.rhi = rhi
    this.draper = draper
  }

  /** Registers a DECLARATIVE `| arrow` layer via the compiled packers (same draper/shader
   *  as host). `strokeUnits` (#1333, 0 = none) requests the outline stroke. */
  add(
    lons: Float64Array,
    lats: Float64Array,
    bearingsDeg: Float32Array,
    sizesPx: Float32Array,
    colors: ReadonlyArray<readonly [number, number, number, number]>,
    strokeUnits: number,
    dpr: number,
  ): void {
    const count = lons.length
    if (count === 0 || !this.rhi || !this.draper) return
    const feat = packCompiledArrowFeat(lons, lats, bearingsDeg, sizesPx, dpr, strokeUnits)
    const tint = packCompiledArrowTint(colors)
    const featBuf = this.rhi.createBuffer({
      size: Math.max(feat.byteLength, 16),
      usage: 'storage',
      writable: true,
      label: 'compiled-arrow-feat',
    })
    this.rhi.writeBuffer(featBuf, 0, feat)
    this._featWrites++
    const tintBuf = this.rhi.createBuffer({
      size: Math.max(tint.byteLength, 16),
      usage: 'storage',
      writable: true,
      label: 'compiled-arrow-tint',
    })
    this.rhi.writeBuffer(tintBuf, 0, tint)
    this._tintWrites++
    const bindGroup = this.draper.makeBatchBindGroup(featBuf, tintBuf)
    this.batches.push({
      featBuf,
      tintBuf,
      bindGroup,
      count,
      lons,
      lats,
      bearings: bearingsDeg,
      sizes: sizesPx,
      strokeUnits,
    })
  }

  /** Drop every compiled-arrow layer — called at the top of each rebuildLayers before the
   *  isArrow fork re-adds. Buffers go through the manager's `retired` sink (drained next
   *  renderRetained) so an in-flight submit that bound them completes first. */
  clear(retired: RhiBuffer[]): void {
    for (const ca of this.batches) retired.push(ca.featBuf, ca.tintBuf)
    this.batches.length = 0
  }

  /** True when at least one compiled arrow layer is resident — part of the manager's
   *  `hasRetainedBatches` pass gate. */
  get isEmpty(): boolean {
    return this.batches.length === 0
  }

  /** GPU-upload counters — folded into GraphicsManager.getWriteCounts(). */
  get writeCounts(): { featWrites: number; tintWrites: number } {
    return { featWrites: this._featWrites, tintWrites: this._tintWrites }
  }

  /** Draw every compiled layer through the SAME draper + per-copy uniform as the host
   *  arrows, so compiler-fed and `map.graphics` arrows are one draw authority. Returns the
   *  real draw-call count (one instanced draw per world copy per layer). */
  draw(pass: RhiRenderPass, perCopy: Float32Array[]): number {
    if (!this.draper) return 0
    let calls = 0
    for (const ca of this.batches) {
      calls += this.draper.draw(pass, ca.bindGroup, perCopy, ca.count)
    }
    return calls
  }

  /** Compiled layers bake size in px too — re-pack feat from the retained raw arrays on a
   *  DPR change, mirroring the host arrow path. */
  repackForDpr(dpr: number): void {
    if (!this.rhi) return
    for (const ca of this.batches) {
      this.rhi.writeBuffer(
        ca.featBuf,
        0,
        packCompiledArrowFeat(ca.lons, ca.lats, ca.bearings, ca.sizes, dpr, ca.strokeUnits),
      )
      this._featWrites++
    }
  }

  /** Drop the per-run GPU buffers on a scene swap / destroy. Unlike the host batches (whose
   *  SPECS survive for re-materialisation), compiled layers are re-added wholesale by the
   *  next rebuildLayers, so the records go too. */
  destroyGpu(): void {
    for (const ca of this.batches) {
      this.rhi?.destroyBuffer(ca.featBuf)
      this.rhi?.destroyBuffer(ca.tintBuf)
    }
    this.batches.length = 0
    this.rhi = null
    this.draper = null
  }
}
