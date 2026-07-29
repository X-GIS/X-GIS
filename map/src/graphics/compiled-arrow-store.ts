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
import type { RetainedArrowAdvectedDraper } from '../render/material/arrow-retained-advected-material'
import {
  arrowViewBlock,
  arrowViewUniformBytes,
  writeArrowViewUniform,
  type ArrowViewCamera,
  type ArrowViewGrid,
} from '../render/arrow-view-uniform'
import { S111_ARROW_BASE_PX, S111_OUTLINE_FRAC } from '../render/s111-portrayal'
import type {
  RhiDevice,
  RhiBuffer,
  RhiBindGroup,
  RhiRenderPass,
  RhiTextureView,
} from '@xgis/engine'

/** What an ADVECTED batch needs beyond the static one — supplied by the coverage arm, which is
 *  the only side that knows the grid.
 *
 *  BOTH FIELDS ARE BATCH SCALARS (#1520 step 2). This used to carry six typed arrays parallel to
 *  the lon/lat ones — per-instance origins and two basis anchors each — because the field was
 *  generated per grid cell. It is generated on the SCREEN now, so there is nothing per instance to
 *  hand over: the grid box is four numbers and the shader recovers everything else per frame. */
export interface AdvectedArrowInput {
  /** The affine lon/lat → grid-uv box (`coverageArrowGrid`). */
  grid: ArrowViewGrid
  /** The catalogue table in the shader's units (`s111BandTableNormalized`). */
  bandTable: Float32Array
}

/** The camera half of an advected draw, computed ONCE per frame by the manager and shared by
 *  every advected batch — the camera is batch-independent; only the grid box is not. */
export type AdvectedArrowView = ArrowViewCamera

/** The frame-side half of an advected draw: where the arrows are, where they belong, and the
 *  velocity pair they are moving through — all four from `FlowRenderer`, which owns the step.
 *  Passed in per frame rather than held, because the state side alternates every step. */
export interface AdvectedArrowSource {
  /** THAT region's velocity textures. Per region, not per map: a mosaic's domains each carry
   *  their own current, and one pair for all of them reports another domain's water as this
   *  one's (#1458).
   *
   *  There is no shared arrow STATE to hand out a texel range from any more (#1520) — an arrow's
   *  position is a function of its origin and the frame clock, so nothing is reserved, nothing is
   *  released, and two regions cannot collide over a range. */
  arrowBindingFor(region: string): {
    flowU: RhiTextureView
    flowV: RhiTextureView
  } | null
}

/** A DECLARATIVE `| arrow` layer (#1302) — compiler-fed twin of a host arrow batch, same
 *  ARROW_RETAINED feat/tint layout; raw arrays (incl. strokeUnits, #1333) kept for DPR re-pack. */
interface CompiledArrowBatch {
  /** Null for an ADVECTED batch: its instances are lattice nodes of the current viewport, so
   *  there is no per-instance record to pack and the advected module binds no feat buffer. */
  featBuf: RhiBuffer | null
  /** Null for an ADVECTED batch: its colour is the band the arrow is standing in, so there is no
   *  launch colour to keep and the advected module binds no tint at all. */
  tintBuf: RhiBuffer | null
  /** Null for an ADVECTED batch — that path's group also binds the region's velocity pair, so it
   *  is built (and invalidated) separately in `advectedGroup`. */
  bindGroup: RhiBindGroup | null
  advected: AdvectedArrowInput | null
  /** The band table, uploaded once per advected batch. */
  bandBuf: RhiBuffer | null
  /** The ArrowView block — allocated once per advected batch, REWRITTEN every frame. Its contents
   *  are the camera (which moves) plus this batch's grid box (which does not); the bind group
   *  holding it is still cached, since only the bytes change. */
  viewBuf: RhiBuffer | null
  /** The advected bind group, rebuilt only when the region's velocity pair changes. */
  advectedGroup: RhiBindGroup | null
  /** The velocity views those groups were built against. A re-armed or evicted coverage hands
   *  over different ones, and the groups holding the old pair must go with them. */
  boundFlowU: RhiTextureView | null
  boundFlowV: RhiTextureView | null
  count: number
  lons: Float64Array
  lats: Float64Array
  bearings: Float32Array
  sizes: Float32Array
  strokeUnits: number
  /** Opaque owner tag, so one owner's layers can be replaced without touching another's
   *  (#1272 E-④). The coverage arm passes its region key here; every other caller leaves it
   *  at `''` and keeps the old clear-everything lifecycle. */
  region: string
}

export class CompiledArrowStore {
  private rhi: RhiDevice | null = null
  private draper: RetainedArrowDraper | null = null
  private advectedDraper: RetainedArrowAdvectedDraper | null = null
  private arrowSource: AdvectedArrowSource | null = null
  private readonly batches: CompiledArrowBatch[] = []

  /** GPU-upload counters, mirroring the manager's — incremented ONLY at the feat/tint
   *  writeBuffer sites (add / DPR re-pack), NEVER in `draw`. The manager folds these into
   *  its `getWriteCounts()` so the counter semantics are unchanged from before the split. */
  private _featWrites = 0
  private _tintWrites = 0

  /** Bind the per-run device + arrow drapers (called from GraphicsManager.attachDevice).
   *
   *  The advected DRAPER arrives here; its frame-side SOURCE arrives later, through
   *  `setAdvectedSource` — the two genuinely become available in that order, and requiring them
   *  together is what left the store with no advected draper at all: at attach time the
   *  FlowRenderer does not exist yet, so the paired form dropped every advected batch and the
   *  portrayal rendered NOTHING. Both are still required to ADD one; they just arrive apart. */
  attach(
    rhi: RhiDevice,
    draper: RetainedArrowDraper,
    advectedDraper?: RetainedArrowAdvectedDraper,
  ): void {
    this.rhi = rhi
    this.draper = draper
    this.advectedDraper = advectedDraper ?? null
  }

  /** Point the advected path at its frame-side state (#1419). Separate from `attach` because
   *  the two become available in that order: the device (and this store's drapers) exist before
   *  `buildSceneRenderers` has constructed the FlowRenderer that owns the arrow ping-pong. */
  setAdvectedSource(source: AdvectedArrowSource | null): void {
    this.arrowSource = source
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
    region = '',
    advected: AdvectedArrowInput | null = null,
  ): void {
    const count = lons.length
    if (!this.rhi || !this.draper) return
    // An ADVECTED batch carries NO instances (#1520 step 2) — its count is a per-frame decision
    // taken from the viewport, so an empty lon/lat array is the normal case there and only the
    // static path is empty-guarded.
    if (!advected && count === 0) return
    // Both halves or nothing: an advected batch drawn through the static draper would be a
    // field that animates nothing and reports its launch instant forever.
    if (advected && (!this.advectedDraper || !this.arrowSource)) return

    let featBuf: RhiBuffer | null = null
    if (!advected) {
      const feat = packCompiledArrowFeat(lons, lats, bearingsDeg, sizesPx, dpr, strokeUnits)
      featBuf = this.rhi.createBuffer({
        size: Math.max(feat.byteLength, 16),
        usage: 'storage',
        writable: true,
        label: 'compiled-arrow-feat',
      })
      this.rhi.writeBuffer(featBuf, 0, feat)
      this._featWrites++
    }

    let tintBuf: RhiBuffer | null = null
    let bandBuf: RhiBuffer | null = null
    let viewBuf: RhiBuffer | null = null
    if (advected) {
      // The catalogue rule, uploaded once. No tint buffer: the colour is re-decided every frame
      // from the band the arrow is standing in, so a launch colour would only be a wrong answer
      // waiting to be read.
      bandBuf = this.rhi.createBuffer({
        size: Math.max(advected.bandTable.byteLength, 16),
        usage: 'storage',
        writable: true,
        label: 'compiled-arrow-band',
      })
      this.rhi.writeBuffer(bandBuf, 0, advected.bandTable)
      viewBuf = this.rhi.createBuffer({
        size: arrowViewUniformBytes(),
        usage: 'uniform',
        writable: true,
        label: 'compiled-arrow-view',
      })
    } else {
      const tint = packCompiledArrowTint(colors)
      tintBuf = this.rhi.createBuffer({
        size: Math.max(tint.byteLength, 16),
        usage: 'storage',
        writable: true,
        label: 'compiled-arrow-tint',
      })
      this.rhi.writeBuffer(tintBuf, 0, tint)
      this._tintWrites++
    }

    this.batches.push({
      featBuf,
      tintBuf,
      bindGroup: featBuf && tintBuf ? this.draper.makeBatchBindGroup(featBuf, tintBuf) : null,
      advected,
      bandBuf,
      viewBuf,
      advectedGroup: null,
      boundFlowU: null,
      boundFlowV: null,
      count,
      lons,
      lats,
      bearings: bearingsDeg,
      sizes: sizesPx,
      strokeUnits,
      region,
    })
  }

  /** Drop compiled-arrow layers — every one, or (given `region`) just that owner's. Called
   *  at the top of each rebuildLayers before the isArrow fork re-adds, and per-region when a
   *  mosaic domain re-arms or leaves the viewport. Buffers go through the manager's `retired`
   *  sink (drained next renderRetained) so an in-flight submit that bound them completes
   *  first.
   *
   *  The region-scoped form is what lets a mosaic hold several domains: the unscoped clear
   *  ran on every single-region re-arm, so a neighbour's forecast step wiped every other
   *  domain's glyphs and re-added only its own. */
  clear(retired: RhiBuffer[], region?: string): void {
    const kept: CompiledArrowBatch[] = []
    for (const ca of this.batches) {
      if (region === undefined || ca.region === region) {
        if (ca.featBuf) retired.push(ca.featBuf)
        if (ca.tintBuf) retired.push(ca.tintBuf)
        if (ca.bandBuf) retired.push(ca.bandBuf)
        if (ca.viewBuf) retired.push(ca.viewBuf)
      } else kept.push(ca)
    }
    this.batches.length = 0
    this.batches.push(...kept)
  }

  /** True when at least one compiled arrow layer is resident — part of the manager's
   *  `hasRetainedBatches` pass gate. */
  get isEmpty(): boolean {
    return this.batches.length === 0
  }

  /** True when an ADVECTED layer is resident (#1419) — what tells the frame to run the arrow
   *  step at all, so a map with only static `| arrow` batches allocates no ping-pong. */
  get hasAdvected(): boolean {
    return this.batches.some((b) => b.advected !== null)
  }

  /** GPU-upload counters — folded into GraphicsManager.getWriteCounts(). */
  get writeCounts(): { featWrites: number; tintWrites: number } {
    return { featWrites: this._featWrites, tintWrites: this._tintWrites }
  }

  /** Draw every compiled layer through the SAME draper + per-copy uniform as the host
   *  arrows, so compiler-fed and `map.graphics` arrows are one draw authority. Returns the
   *  real draw-call count (one instanced draw per world copy per layer). */
  draw(pass: RhiRenderPass, perCopy: Float32Array[], view: AdvectedArrowView | null): number {
    if (!this.draper) return 0
    let calls = 0
    for (const ca of this.batches) {
      if (ca.advected) calls += this.drawAdvected(pass, ca, perCopy, view)
      else if (ca.bindGroup) calls += this.draper.draw(pass, ca.bindGroup, perCopy, ca.count)
    }
    return calls
  }

  /** One advected batch: rewrite its view block from this frame's camera, then draw the lattice
   *  that block describes.
   *
   *  THE INSTANCE COUNT COMES FROM THE WRITE, not from the batch. That is the inversion #1520 is
   *  about — `ca.count` is the number of cells the coverage happened to have, which is exactly the
   *  quantity that made the field expire at z17. What is drawn instead is `nx·ny·G` lattice nodes
   *  of the CURRENT viewport, so density is constant per screen area at every zoom by construction.
   *
   *  `null` from the write is a camera with no usable inverse (an orthographic or degenerate
   *  matrix): nothing is drawn, rather than a lattice built from a divide by zero. */
  private drawAdvected(
    pass: RhiRenderPass,
    ca: CompiledArrowBatch,
    perCopy: Float32Array[],
    view: AdvectedArrowView | null,
  ): number {
    const draper = this.advectedDraper
    // THIS batch's region, not the map's one field (#1458): a mosaic's domains each carry their
    // own current, and the glyph's colour, heading and scale are re-decided every frame from the
    // velocity under it — bound from the wrong domain that is another sea reported as this one.
    // Null when the region has left the coverage: its textures are destroyed, so a batch
    // outliving its region by a frame draws nothing rather than binding freed memory (#1419).
    const bind = this.arrowSource?.arrowBindingFor(ca.region)
    if (!draper || !bind || !ca.bandBuf || !ca.viewBuf || !ca.advected || !view || !this.rhi)
      return 0
    const block = arrowViewBlock()
    const count = writeArrowViewUniform(block, view, ca.advected.grid, {
      basePx: S111_ARROW_BASE_PX * view.dpr,
      strokeUnits: S111_OUTLINE_FRAC,
    })
    if (count === null || count === 0) return 0
    this.rhi.writeBuffer(ca.viewBuf, 0, block.buffer)
    // Rebuilt only when the region hands over a DIFFERENT velocity pair. It used to be keyed by
    // the ping-pong state side as well; there is no state to alternate any more (#1520), so the
    // group is stable for the batch's life — the view BUFFER is rewritten in place, not swapped.
    // The invalidation still matters and for the original reason: after a region eviction the old
    // views are DESTROYED, and a cached group holding them fails the next submit —
    //   "destroyed texture coverage-flow-v used in a submit"
    // reported from S-111 Live by zooming out and panning to another domain.
    if (ca.boundFlowU !== bind.flowU || ca.boundFlowV !== bind.flowV) {
      ca.advectedGroup = null
      ca.boundFlowU = bind.flowU
      ca.boundFlowV = bind.flowV
    }
    let bg = ca.advectedGroup
    if (!bg) {
      bg = draper.makeBatchBindGroup(ca.bandBuf, bind.flowU, bind.flowV, ca.viewBuf)
      ca.advectedGroup = bg
    }
    return draper.draw(pass, bg, perCopy, count)
  }

  /** Compiled layers bake size in px too — re-pack feat from the retained raw arrays on a
   *  DPR change, mirroring the host arrow path. */
  repackForDpr(dpr: number): void {
    if (!this.rhi) return
    for (const ca of this.batches) {
      // An advected batch bakes no size into a buffer — its glyph size rides the per-frame
      // ArrowView block, which is written from the CURRENT dpr every frame anyway.
      if (!ca.featBuf) continue
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
      if (ca.featBuf) this.rhi?.destroyBuffer(ca.featBuf)
      if (ca.tintBuf) this.rhi?.destroyBuffer(ca.tintBuf)
      if (ca.bandBuf) this.rhi?.destroyBuffer(ca.bandBuf)
      if (ca.viewBuf) this.rhi?.destroyBuffer(ca.viewBuf)
    }
    this.batches.length = 0
    this.rhi = null
    this.draper = null
    this.advectedDraper = null
  }
}
