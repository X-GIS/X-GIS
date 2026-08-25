// ═══ UniformSplitBind — the Frame/Show/Tile split-bind write path
//     (#2042 INC-4b) ═══
//
// The runtime half of the uniform-block split
// (docs/plans/2026-08-24-uniform-block-split.md): owns everything a split
// draw binds that the TileUniformArena does not — the per-show ShowBlock
// arena, the single per-frame FrameBlock buffer, and the native bind group
// over all three ranges (bindings 7 tile / 10 show / 11 frame).
//
// THE WRITE PATH IS A SPAN-COPY, NOT A RE-PACK. The legacy per-(show × tile)
// walk keeps packing the full polygonU block into `frameBlock` (INC-5
// deletes that walk, not INC-4b). At the first qualifying draw of a frame
// this class COPIES the frame-class lanes out of those live legacy bytes;
// at the first qualifying draw of each show it copies the show-class lanes
// into that show's persistent slot — both stamped by frameCount so each
// copies once per frame. Because the SAME packer wrote the source bytes,
// the split path reads byte-identical values with zero new pack logic to
// get wrong; the span tables are DERIVED from the block declarations'
// reflected field offsets (the exact mapping uniform-split-partition.test.ts
// pins exhaustive + byte-compatible), so a struct change reflows them.
//
// Show addressing: slot per show identity (pickId & 0xffff — the style
// declaration index), allocated on first use and NEVER freed — a style
// change reassigns indices from 0, so stale slots are simply overwritten on
// their next use (bounded by the max simultaneous layer count, ≤ 0xffff).
//
// Bind-group lifecycle: any of the three buffers being (re)created retires
// the cached bind group (a bundle baked against a retired buffer must never
// replay) — the tile arena's grow reaches us through VTR's single
// `_onSplitRebind` wire, the show arena's through its own onGrow, and both
// also invalidate the bundle cache via the injected `onRebind`.

import {
  UniformSlotArena,
  uniformBlock,
  type UniformBlockOf,
  type RhiBuffer,
  type RhiDevice,
} from '@xgis/engine'
import { polygonU } from '../shaders/dsl/polygon'
import { tileBlockU } from '../shaders/dsl/tile-block'
import { showBlockU } from '../shaders/dsl/show-block'
import { frameBlockU } from '../shaders/dsl/frame-block'
import type { TileUniformArena } from './tile-uniform-arena'

interface Span {
  src: number
  dst: number
  size: number
}

/** The two ShowBlock lanes with no same-named polygonU source: the Mapbox
 *  opt-out flags that legacy-ride the spare .w lanes (byte 12) of the two
 *  retiring cam_ecef_off vec4s (uniform-split-partition's RELOCATED set). */
const SHOW_RELOCATED: ReadonlyArray<
  readonly [dstField: string, srcField: string, srcByte: number]
> = [
  ['fill_antialias', 'cam_ecef_off_h', 12],
  ['fill_vertical_gradient', 'cam_ecef_off_l', 12],
]

/** Build the src→dst copy spans for one destination block: every non-pad
 *  destination field copies from the SAME-NAMED polygonU lane (plus the
 *  explicit relocations). A destination field with no polygonU source is a
 *  partition break — throw rather than stage zeros (#600 class). */
function buildSpans(
  poly: UniformBlockOf<typeof polygonU>,
  dest: UniformBlockOf<typeof showBlockU> | UniformBlockOf<typeof frameBlockU>,
  destDecl: typeof showBlockU | typeof frameBlockU,
  relocated: typeof SHOW_RELOCATED,
): Span[] {
  const sizeOf = (t: { kind?: string; n?: number }): number =>
    t.kind === 'mat' ? 64 : t.kind === 'vec' ? (t.n === 2 ? 8 : 16) : 4
  const spans: Span[] = []
  for (const f of destDecl.struct.fields) {
    if (f.name.startsWith('_pad')) continue
    const rel = relocated.find(([d]) => d === f.name)
    if (rel) {
      spans.push({
        src: poly.fieldOffset(rel[1] as never) + rel[2],
        dst: dest.fieldOffset(f.name as never),
        size: 4,
      })
      continue
    }
    spans.push({
      src: poly.fieldOffset(f.name as never),
      dst: dest.fieldOffset(f.name as never),
      size: sizeOf(f.type as { kind?: string; n?: number }),
    })
  }
  return spans
}

export class UniformSplitBind {
  private showArena: UniformSlotArena | null = null
  private frameBuf: RhiBuffer | null = null
  private frameScratch: Uint8Array | null = null
  private showScratch: Uint8Array | null = null
  private frameSpans: Span[] | null = null
  private showSpans: Span[] | null = null
  private showBindSize = 0
  private showFillColorOff = 0
  private frameStamp = -1
  private readonly showStamp = new Map<number, number>()
  private readonly showSlot = new Map<number, number>()
  /** Native bind-group half — WebGPU main path only, mirroring the arena's
   *  INC-2 scope. `layout` arrives via setFillRhi (the factory's split
   *  layout); null keeps every accessor inert. */
  private layout: GPUBindGroupLayout | null = null
  private bg: GPUBindGroup | null = null

  constructor(
    /** Lazy device provider — same VTR ctor-ordering rationale as the
     *  TileUniformArena's. */
    private readonly rhi: () => RhiDevice,
    /** The TileBlock arena (binding 7's buffer + stride). */
    private readonly tiles: TileUniformArena,
    /** Native device for bind-group creation (null on WebGL2 — the split
     *  path never engages there: the factory builds no split Materials). */
    private readonly device: GPUDevice | null,
    /** RhiBuffer → native GPUBuffer (WebGpuDevice.unwrapBuffer). */
    private readonly unwrap: (b: RhiBuffer) => GPUBuffer,
    /** Fired when any split buffer is (re)created: VTR invalidates the
     *  bundle cache (a bundle holding the old bind group must re-encode). */
    private readonly onRebind: () => void,
  ) {}

  /** Lazy reflection — uniformBlock() is module-free (no projection emit),
   *  but stay lazy anyway (the polygonUniformBytes discipline). */
  private ensureSpans(): void {
    if (this.frameSpans) return
    const poly = uniformBlock(polygonU)
    const show = uniformBlock(showBlockU)
    const frame = uniformBlock(frameBlockU)
    this.showSpans = buildSpans(poly, show, showBlockU, SHOW_RELOCATED)
    this.frameSpans = buildSpans(poly, frame, frameBlockU, [])
    this.showScratch = new Uint8Array(show.byteLength)
    this.frameScratch = new Uint8Array(frame.std140Stride())
    this.showBindSize = show.byteLength
    this.showFillColorOff = show.fieldOffset('fill_color' as never)
  }

  private ensureShowArena(): UniformSlotArena {
    if (!this.showArena) {
      this.ensureSpans()
      this.showArena = new UniformSlotArena(
        this.rhi(),
        uniformBlock(showBlockU).std140Stride(),
        64,
        'show-uniform-arena',
        () => {
          this.bg = null
          this.onRebind()
        },
      )
      this.showArena.ensure()
    }
    return this.showArena
  }

  /** Copy the frame-class lanes from the live legacy block ONCE per frame
   *  and upload them (one 512-byte writeBuffer). */
  syncFrame(legacy: ArrayBuffer, frame: number): void {
    if (this.frameStamp === frame) return
    this.frameStamp = frame
    this.ensureSpans()
    if (!this.frameBuf) {
      this.frameBuf = this.rhi().createBuffer({
        size: this.frameScratch!.byteLength,
        usage: 'uniform',
        label: 'frame-uniform-block',
      })
      this.bg = null
      this.onRebind()
    }
    const src = new Uint8Array(legacy)
    for (const s of this.frameSpans!)
      this.frameScratch!.set(src.subarray(s.src, s.src + s.size), s.dst)
    this.rhi().writeBuffer(this.frameBuf, 0, this.frameScratch!)
  }

  /** Copy the show-class lanes into the show's persistent slot ONCE per
   *  frame; returns the slot's byte offset (binding 10's dynamic offset). */
  syncShow(legacy: ArrayBuffer, showIdx: number, frame: number): number {
    const arena = this.ensureShowArena()
    let slot = this.showSlot.get(showIdx)
    if (slot === undefined) {
      slot = arena.alloc()
      this.showSlot.set(showIdx, slot)
    }
    if (this.showStamp.get(showIdx) !== frame) {
      this.showStamp.set(showIdx, frame)
      const src = new Uint8Array(legacy)
      const dst = this.showScratch!
      for (const s of this.showSpans!) dst.set(src.subarray(s.src, s.src + s.size), s.dst)
      // §5 witness hook — skew the staged fill colour so a render gate can
      // prove the shader READS this block (cut-the-mechanism: skew moving
      // pixels = the split path is live; the unskewed A/B proves the bytes).
      if ((globalThis as { __XGIS_SPLIT_BIND_SKEW?: unknown }).__XGIS_SPLIT_BIND_SKEW === true) {
        const f32 = new Float32Array(dst.buffer, this.showFillColorOff, 4)
        f32[0] = 1 - f32[0]!
        f32[1] = 1 - f32[1]!
      }
      arena.stage(slot, dst.buffer as ArrayBuffer)
    }
    return arena.byteOffset(slot)
  }

  /** The factory's split bind-group layout (setFillRhi). A layout change
   *  retires the cached group. */
  setLayout(layout: GPUBindGroupLayout): void {
    if (this.layout !== layout) {
      this.layout = layout
      this.bg = null
    }
  }

  /** The native three-range bind group, rebuilt lazily after any buffer
   *  (re)creation. Null until layout + all three buffers exist. */
  bindGroup(): GPUBindGroup | null {
    if (this.bg) return this.bg
    const tileBuf = this.tiles.rhiBuffer()
    const showBuf = this.showArena?.rhiBuffer ?? null
    if (!this.layout || !this.device || !tileBuf || !showBuf || !this.frameBuf) return null
    this.ensureSpans()
    this.bg = this.device.createBindGroup({
      label: 'vtr-splitFillBg',
      layout: this.layout,
      entries: [
        {
          binding: 7,
          resource: {
            buffer: this.unwrap(tileBuf),
            offset: 0,
            size: uniformBlock(tileBlockU).byteLength,
          },
        },
        {
          binding: 10,
          resource: { buffer: this.unwrap(showBuf), offset: 0, size: this.showBindSize },
        },
        { binding: 11, resource: { buffer: this.unwrap(this.frameBuf) } },
      ],
    })
    return this.bg
  }

  /** VTR's single rebind wire (the TILE arena grew — our own arena wires
   *  itself). The bundle-cache invalidation lives with the caller. */
  invalidateBindGroup(): void {
    this.bg = null
  }

  /** Upload staged show slots — beside the ring/tile-arena flushes. */
  flush(): void {
    this.showArena?.flush()
  }

  /** Grow-retired show-arena buffers — drained beside the ring drain (drop
   *  refs, never destroy; same discipline + rationale). */
  takeRetired(): RhiBuffer[] {
    return this.showArena?.takeRetired() ?? []
  }

  destroy(): void {
    this.showArena?.destroy()
    this.showArena = null
    if (this.frameBuf) this.rhi().destroyBuffer(this.frameBuf)
    this.frameBuf = null
    this.showSlot.clear()
    this.showStamp.clear()
    this.frameStamp = -1
    this.bg = null
  }
}
