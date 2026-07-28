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
import {
  S111_BAND_PARAMS_ROW,
  S111_BAND_STRIDE,
  S111_PARAM_STATE_BASE,
} from '../shaders/dsl/s111-band-table-layout'
import type { RetainedArrowDraper } from '../render/material/arrow-retained-material'
import type { RetainedArrowAdvectedDraper } from '../render/material/arrow-retained-advected-material'
import type {
  RhiDevice,
  RhiBuffer,
  RhiBindGroup,
  RhiRenderPass,
  RhiTextureView,
} from '@xgis/engine'

/** What an ADVECTED batch needs beyond the static one (#1419) — supplied by the coverage arm,
 *  which is the only side that knows the grid. The anchors and the origins are parallel to the
 *  lon/lat arrays: entry `i` belongs to instance `i`, and to state texel `i`. */
export interface AdvectedArrowInput {
  /** Instance origins in grid-uv (`coverageArrowOrigins`). */
  originU: Float32Array
  originV: Float32Array
  /** The two basis anchors, one leash length along grid-u and grid-v. */
  uStepLon: Float64Array
  uStepLat: Float64Array
  vStepLon: Float64Array
  vStepLat: Float64Array
  /** The catalogue table in the shader's units (`s111BandTableNormalized`). */
  bandTable: Float32Array
  /** Identifies the INSTANCE LAYOUT (region + grid + count). An equal key means texel `i` is
   *  still the same arrow, so the state keeps drifting across a forecast step instead of
   *  snapping home; see `ArrowAdvectState.writeOrigins`. */
  key: string
}

/** The frame-side half of an advected draw: where the arrows are, where they belong, and the
 *  velocity pair they are moving through — all four from `FlowRenderer`, which owns the step.
 *  Passed in per frame rather than held, because the state side alternates every step. */
export interface AdvectedArrowSource {
  /** Returns the batch's BASE TEXEL in the shared state (#1458). */
  writeArrowOrigins(key: string, u: ArrayLike<number>, v: ArrayLike<number>): number
  /** Give this batch's texel range back — its region was dropped. */
  releaseArrowOrigins(key: string): void
  readonly arrowBinding: {
    state: RhiTextureView
    origin: RhiTextureView
    flowU: RhiTextureView
    flowV: RhiTextureView
  } | null
}

/** A DECLARATIVE `| arrow` layer (#1302) — compiler-fed twin of a host arrow batch, same
 *  ARROW_RETAINED feat/tint layout; raw arrays (incl. strokeUnits, #1333) kept for DPR re-pack. */
interface CompiledArrowBatch {
  featBuf: RhiBuffer
  /** Null for an ADVECTED batch: its colour is the band the arrow is standing in, so there is no
   *  launch colour to keep and the advected module binds no tint at all. */
  tintBuf: RhiBuffer | null
  /** Null for an ADVECTED batch — that path's group also binds the ping-pong's READ side, which
   *  alternates every step, so its groups are memoized per state view in `advectedGroups`. */
  bindGroup: RhiBindGroup | null
  advected: AdvectedArrowInput | null
  /** The band table, uploaded once per advected batch. */
  bandBuf: RhiBuffer | null
  /** Advected bind groups, keyed by the ping-pong side they read (two entries at rest). */
  advectedGroups: Map<RhiTextureView, RhiBindGroup>
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
    if (count === 0 || !this.rhi || !this.draper) return
    // Both halves or nothing: an advected batch drawn through the static draper would be a
    // field that animates nothing and reports its launch instant forever.
    if (advected && (!this.advectedDraper || !this.arrowSource)) return
    const feat = packCompiledArrowFeat(
      lons,
      lats,
      bearingsDeg,
      sizesPx,
      dpr,
      strokeUnits,
      advected ?? undefined,
    )
    const featBuf = this.rhi.createBuffer({
      size: Math.max(feat.byteLength, 16),
      usage: 'storage',
      writable: true,
      label: 'compiled-arrow-feat',
    })
    this.rhi.writeBuffer(featBuf, 0, feat)
    this._featWrites++

    let tintBuf: RhiBuffer | null = null
    let bandBuf: RhiBuffer | null = null
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
      // The origins go up HERE, not at first draw: the advect step runs EARLIER in the frame
      // than the graphics pass, so a batch whose origins arrived at draw time would spend its
      // first step leashed to grid-uv (0, 0) — every arrow yanked toward the grid's corner.
      //
      // It answers with this batch's BASE TEXEL in the shared state (#1458) — one texture
      // serves every mosaic region — which is why the band table is patched and uploaded
      // AFTER the call rather than before it.
      const base =
        this.arrowSource?.writeArrowOrigins(advected.key, advected.originU, advected.originV) ?? 0
      advected.bandTable[S111_BAND_PARAMS_ROW * S111_BAND_STRIDE + S111_PARAM_STATE_BASE] = base
      this.rhi.writeBuffer(bandBuf, 0, advected.bandTable)
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
      bindGroup: tintBuf ? this.draper.makeBatchBindGroup(featBuf, tintBuf) : null,
      advected,
      bandBuf,
      advectedGroups: new Map(),
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
        retired.push(ca.featBuf)
        if (ca.tintBuf) retired.push(ca.tintBuf)
        if (ca.bandBuf) retired.push(ca.bandBuf)
        // …and give the shared state's texels back (#1458). Without this the ranges only ever
        // grow: a mosaic that pans across a coast re-arms constantly, and each re-arm would
        // append a fresh range until the allocation hit its ceiling and later regions silently
        // got no texels at all.
        if (ca.advected) this.arrowSource?.releaseArrowOrigins(ca.advected.key)
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
  draw(pass: RhiRenderPass, perCopy: Float32Array[]): number {
    if (!this.draper) return 0
    let calls = 0
    for (const ca of this.batches) {
      if (ca.advected) calls += this.drawAdvected(pass, ca, perCopy)
      else if (ca.bindGroup) calls += this.draper.draw(pass, ca.bindGroup, perCopy, ca.count)
    }
    return calls
  }

  /** One advected batch. Skipped — not drawn statically — until the step has produced a state:
   *  before then there is nothing to say where any arrow is, and drawing the origins would be a
   *  frame of the catalogue field masquerading as the animation. */
  private drawAdvected(
    pass: RhiRenderPass,
    ca: CompiledArrowBatch,
    perCopy: Float32Array[],
  ): number {
    const draper = this.advectedDraper
    const bind = this.arrowSource?.arrowBinding
    if (!draper || !bind || !ca.bandBuf) return 0
    // Keyed by the STATE side, but invalidated on the FIELD views — because the ping-pong
    // alternates between exactly two state views and nothing else ever appears as a key. The
    // first version of this cleared "when a third key shows up", which cannot happen: a
    // re-armed coverage hands over new velocity views under the SAME two state sides, so the
    // cached groups kept binding the old ones. After a region eviction those old ones are
    // DESTROYED, and the next submit fails —
    //   "destroyed texture coverage-flow-v used in a submit"
    // reported from S-111 Live by zooming out and panning to another domain.
    if (ca.boundFlowU !== bind.flowU || ca.boundFlowV !== bind.flowV) {
      ca.advectedGroups.clear()
      ca.boundFlowU = bind.flowU
      ca.boundFlowV = bind.flowV
    }
    let bg = ca.advectedGroups.get(bind.state)
    if (!bg) {
      bg = draper.makeBatchBindGroup(
        ca.featBuf,
        ca.bandBuf,
        bind.state,
        bind.origin,
        bind.flowU,
        bind.flowV,
      )
      ca.advectedGroups.set(bind.state, bg)
    }
    return draper.draw(pass, bg, perCopy, ca.count)
  }

  /** Compiled layers bake size in px too — re-pack feat from the retained raw arrays on a
   *  DPR change, mirroring the host arrow path. */
  repackForDpr(dpr: number): void {
    if (!this.rhi) return
    for (const ca of this.batches) {
      this.rhi.writeBuffer(
        ca.featBuf,
        0,
        packCompiledArrowFeat(
          ca.lons,
          ca.lats,
          ca.bearings,
          ca.sizes,
          dpr,
          ca.strokeUnits,
          ca.advected ?? undefined,
        ),
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
      if (ca.tintBuf) this.rhi?.destroyBuffer(ca.tintBuf)
      if (ca.bandBuf) this.rhi?.destroyBuffer(ca.bandBuf)
    }
    this.batches.length = 0
    this.rhi = null
    this.draper = null
    this.advectedDraper = null
  }
}
