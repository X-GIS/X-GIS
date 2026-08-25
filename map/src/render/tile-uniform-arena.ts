// ═══ TileUniformArena — persistent per-(tile × worldCopy) TileBlock slots
//     (#2042 INC-2) ═══
//
// Owns the map-side lifecycle of the TILE class of the uniform-block split
// (docs/plans/2026-08-24-uniform-block-split.md): a UniformSlotArena of
// `tileBlockU` slots, keyed (source-layer slice, numeric tile key, world
// copy). A slot is allocated and PACKED ONCE, the first frame a (tile, copy)
// draws; it is freed when the tile leaves the GPU cache — piggybacked on the
// SAME injected release hook (`${tileKey}:${sourceLayer}`) every
// GpuTileStore eviction/drop/supersede path already fires, so no store
// change and no new seam.
//
// INC-2 scope decisions (recorded in the plan doc):
//   • UNCLIPPED draws only. A fallback-clip draw's clip_bounds depends on
//     WHICH visible descendant is clipping (`visibleKey`) — an unbounded,
//     draw-time key space (the Korea fill-drop pair-aliasing precedent, one
//     level further). Those draws keep the per-frame ring slot; this arena's
//     clip_bounds lane is always the −1e30 "no clip" sentinel.
//   • WebGPU main path only (the WebGL2 twin has no retained-command
//     consumer; INC-4 decides whether its write volume is worth the wiring).
//   • Nothing BINDS these slots yet — INC-4 does. What INC-2 buys: the
//     allocator + lifecycle are proven (leak gate: live slots ⊆ live tiles,
//     exact equality on the covered path), and the staged bytes are proven
//     byte-equal to the polygonU lanes the shader reads today
//     (tile-uniform-arena parity suite), so INC-4 is a pure rebind.
//
// World copies: worldOff arrives in DEGREES (multiples of 360). Lanes cover
// −2..+2 copies (the visible-copy router's practical range); an exotic copy
// outside it is simply not arena-resident (INC-4 falls back to the ring for
// such draws — correctness never depends on residency).

import {
  UniformSlotArena,
  uniformBlock,
  type UniformBlockOf,
  type RhiBuffer,
  type RhiDevice,
} from '@xgis/engine'
import { tileBlockU } from '../shaders/dsl/tile-block'
import type { TileCameraAnchor } from './tile-camera-anchor'

const COPY_BIAS = 2
const COPY_LANES = 5 // worldOff −2..+2 × 360°

export class TileUniformArena {
  private arena: UniformSlotArena | null = null
  private block: UniformBlockOf<typeof tileBlockU> | null = null
  /** #2042 INC-4b — fired after the arena buffer is (re)created. The split
   *  bind path re-binds its group and invalidates recorded bundles here
   *  (a bundle baked against the retired buffer must never replay). */
  private _onGrow: (() => void) | null = null
  /** slice → tileKey → per-copy slot indices (lane = worldOff/360 + 2).
   *  Mirrors GpuTileStore.gpuCache's nested-map shape so the per-tile hot
   *  path stays free of composite-string allocation. */
  private readonly slots = new Map<string, Map<number, (number | undefined)[]>>()

  constructor(
    /** Lazy device provider — VTR's `rhi` is assigned in its ctor body,
     *  after field initializers run, so the arena resolves it on first use. */
    private readonly rhi: () => RhiDevice,
  ) {}

  /** The typed CPU packer over tileBlockU — the SINGLE layout authority the
   *  INC-4 shader struct will share. Module-free (wgslLayout on the decl), so
   *  constructing it never triggers the projection emit; memoised lazily for
   *  the same reason polygonUniformBytes() is. */
  private ensureBlock(): UniformBlockOf<typeof tileBlockU> {
    return (this.block ??= uniformBlock(tileBlockU))
  }

  private ensureArena(): UniformSlotArena {
    if (!this.arena) {
      this.arena = new UniformSlotArena(
        this.rhi(),
        this.ensureBlock().std140Stride(),
        256,
        'tile-uniform-arena',
        () => this._onGrow?.(),
      )
      // Create the GPU buffer now — without this, flush() no-ops forever
      // and every staged slot silently never reaches the GPU (caught by
      // the parity suite's flush-then-read).
      this.arena.ensure()
    }
    return this.arena
  }

  /** Get-or-allocate the persistent slot for (slice, tile, copy); pack the
   *  TileBlock ONCE on allocation. Returns the slot BYTE offset, or -1 for
   *  a copy outside the lane range (caller keeps the ring path). Hit path:
   *  two Map gets + an array index — no allocation, no writes. */
  ensureSlot(
    sourceLayer: string,
    tileKey: number,
    worldOffDeg: number,
    anchor: TileCameraAnchor,
    tileExtentM: number,
    dequantScale: number,
    dequantHalf: number,
  ): number {
    const lane = worldOffDeg / 360 + COPY_BIAS
    if (lane < 0 || lane >= COPY_LANES || !Number.isInteger(lane)) return -1
    let inner = this.slots.get(sourceLayer)
    if (!inner) {
      inner = new Map()
      this.slots.set(sourceLayer, inner)
    }
    let lanes = inner.get(tileKey)
    if (!lanes) {
      lanes = new Array<number | undefined>(COPY_LANES)
      inner.set(tileKey, lanes)
    }
    const existing = lanes[lane]
    const arena = this.ensureArena()
    if (existing !== undefined) return arena.byteOffset(existing)
    const slot = arena.alloc()
    lanes[lane] = slot
    const B = this.ensureBlock()
    // Full-struct write (compile-time completeness — the #600 net): every
    // TileBlock lane is established here, once, from tile-static inputs.
    B.write({
      tile_origin_merc_hl: [
        anchor.tileMercXH,
        anchor.tileMercYH,
        anchor.tileMercXL,
        anchor.tileMercYL,
      ],
      tile_extent_m: tileExtentM,
      tile_dequant_scale: dequantScale,
      tile_dequant_half: dequantHalf,
      _pad0: 0,
      clip_bounds: [-1e30, 0, 0, 0], // sentinel — unclipped draws only (header)
      tile_ecef_center_h: [anchor.tileEcefXH, anchor.tileEcefYH, anchor.tileEcefZH, 0],
      tile_ecef_center_l: [anchor.tileEcefXL, anchor.tileEcefYL, anchor.tileEcefZL, 0],
    })
    arena.stage(slot, B.buffer)
    return arena.byteOffset(slot)
  }

  /** Read-only residency lookup for the INC-4b draw path: the slot's byte
   *  offset, or -1 when this (slice, tile, copy) never established one
   *  (the caller keeps the legacy ring bind). Never allocates. */
  offsetOf(sourceLayer: string, tileKey: number, worldOffDeg: number): number {
    const lane = worldOffDeg / 360 + COPY_BIAS
    if (lane < 0 || lane >= COPY_LANES || !Number.isInteger(lane)) return -1
    const slot = this.slots.get(sourceLayer)?.get(tileKey)?.[lane]
    return slot === undefined ? -1 : this.arena!.byteOffset(slot)
  }

  /** Free every copy-lane slot of one tile. `hookKey` is the store's
   *  release-hook string, `${tileKey}:${sourceLayer}` — fired by every
   *  eviction / drop / supersede path. Unknown keys are a no-op (tiles
   *  that never drew unclipped, stroke-only slices, WebGL2). */
  releaseTile(hookKey: string): void {
    const sep = hookKey.indexOf(':')
    if (sep <= 0) return
    const tileKey = Number(hookKey.slice(0, sep))
    const sourceLayer = hookKey.slice(sep + 1)
    const inner = this.slots.get(sourceLayer)
    const lanes = inner?.get(tileKey)
    if (!inner || !lanes) return
    for (const slot of lanes) if (slot !== undefined) this.arena!.free(slot)
    inner.delete(tileKey)
  }

  /** Wholesale reset (the setLineRenderer resetForReupload path): every
   *  slot is dropped with its tile. Buffer + capacity survive for reuse. */
  resetAll(): void {
    if (this.arena) {
      for (const inner of this.slots.values())
        for (const lanes of inner.values())
          for (const slot of lanes) if (slot !== undefined) this.arena.free(slot)
    }
    this.slots.clear()
  }

  /** Upload staged slots (no-op when clean) — call once per frame beside the
   *  uniform-ring flush. */
  flush(): void {
    this.arena?.flush()
  }

  /** #2042 INC-4b — register the grow listener (bind-group rebuild + bundle
   *  invalidation). Fired for the initial buffer creation too if the arena
   *  does not exist yet when the consumer registers. */
  setOnGrow(cb: () => void): void {
    this._onGrow = cb
  }

  /** The live arena buffer (null until the first slot is established). */
  rhiBuffer(): RhiBuffer | null {
    return this.arena?.rhiBuffer ?? null
  }

  /** Buffers retired by grows since the last call — destroy them in the
   *  post-submit safe window (the ring/retired-pool discipline). */
  takeRetired(): RhiBuffer[] {
    return this.arena?.takeRetired() ?? []
  }

  /** Live slot count — the leak gate's left-hand side. */
  liveSlots(): number {
    return this.arena?.liveCount() ?? 0
  }

  /** Tiles currently holding at least one slot — the leak gate's tile side. */
  liveTiles(): number {
    let n = 0
    for (const inner of this.slots.values()) n += inner.size
    return n
  }

  destroy(): void {
    this.arena?.destroy()
    this.arena = null
    this.slots.clear()
  }
}
