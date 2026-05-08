// ═══ WebGPU timestamp-query GPU timing ═══
//
// Two modes:
//
//   1. timestamp-query (standard) — ONE measurement per pass: end - begin.
//      `getTimings()` returns ns per frame, no breakdown.
//
//   2. timestamp-query-inside-passes (Chromium experimental) — adds
//      `pass.writeTimestamp(querySet, idx)` so we can mark mid-pass
//      checkpoints. With four segment markers we split the first
//      opaque pass into:
//
//        bg     — backgroundRenderer (earth-fill quad)
//        raster — rasterRenderer (basemap PNG/JPEG tiles)
//        vector — vectorRenderer.renderToPass (poly fill + stroke +
//                 extruded — currently the heavy bucket)
//        post   — anything in the pass after the vector renderer
//                 (typically near-zero)
//
//      `getBreakdown()` returns one ring per segment so you can see
//      WHICH bucket dominates the GPU pass — the original "total" ring
//      lumped them together.
//
// Lifecycle is identical for both modes:
//   1. Pass.timestampWrites = { begin: 0, end: nMarkers-1 }
//   2. (insidePasses only) call mark(pass, label) at strategic points
//   3. resolveQuerySet(0..nMarkers) into a u64 GPU buffer
//   4. copyBufferToBuffer into a MAP_READ readback ring slot
//   5. mapAsync that slot, parse N timestamps, compute N-1 deltas
//   6. push each delta into its segment's rolling sample ring
//
// State machine per readback slot is the same as before:
//   IDLE  → COPY    (resolveOnEncoder encoded the copy this frame)
//   COPY  → MAP     (pollReadbacks called mapAsync, awaiting .then)
//   MAP   → MAPPED  (mapAsync .then resolved)
//   MAPPED → IDLE   (pollReadbacks read+unmap, slot is reusable)
//
// The states are kept STRICTLY DISJOINT so we never call mapAsync twice
// on the same buffer or encode a copy into a buffer that's currently
// mapped (which trips a "Buffer used in submit while mapped" validation
// error).

import type { GPUContext } from './gpu'

const RING_SIZE = 3 // hide ~2 frame map latency at 60Hz
const TIMESTAMP_BYTES = 8 // u64 per query

type SlotState = 'idle' | 'copy' | 'map' | 'mapped'

interface Slot {
  buf: GPUBuffer
  state: SlotState
}

// Segment labels for inside-passes mode. Index in this array is the
// SEGMENT index, NOT the marker index. Marker index = segmentIdx + 1
// because marker 0 is the implicit "begin" (set via beginningOfPass-
// WriteIndex) and the LAST marker is the implicit "end".
//
// Mapped to map.ts's render order in the first opaque sub-pass:
//   bg     = t[1] - t[0]   begin → after_bg
//                          backgroundRenderer.render() — earth-fill quad
//   raster = t[2] - t[1]   after_bg → after_raster
//                          rasterRenderer.render() — image basemap tiles
//   legacy = t[3] - t[2]   after_raster → after_legacy
//                          this.renderer.renderToPass() — legacy direct
//                          MapRenderer (GeoJSON shows attached at the
//                          source level; usually a no-op for PMTiles-
//                          only demos like osm_style)
//   vt     = t[4] - t[3]   after_legacy → end
//                          group.shows[…].vtEntry.renderer.render()
//                          — the per-(tile×layer) vector-tile loop.
//                          THIS is the bucket every cartography demo
//                          actually pays.
const SEGMENT_LABELS_INSIDE = ['bg', 'raster', 'legacy', 'vt'] as const
const MARKER_LABELS_INSIDE = ['after_bg', 'after_raster', 'after_legacy'] as const
type MarkerLabel = typeof MARKER_LABELS_INSIDE[number]
const N_MARKERS_INSIDE = SEGMENT_LABELS_INSIDE.length + 1 // 5: begin + 3 mid + end

export class GPUTimer {
  readonly enabled: boolean
  readonly insidePasses: boolean
  private querySet: GPUQuerySet | null = null
  private resolveBuf: GPUBuffer | null = null
  private slots: Slot[] = []
  private writeIdx = 0
  private nMarkers: number
  // Parallel rings — one entry per segment, all kept the same length.
  // Inside-passes: 4 rings (bg, raster, vector, post).
  // Begin/end-only: 1 ring ('total').
  private segmentSamples: number[][]
  private segmentNames: readonly string[]
  private static readonly MAX_SAMPLES = 600 // ~10 s at 60 Hz

  constructor(ctx: GPUContext) {
    this.enabled = ctx.timestampQuerySupported
    this.insidePasses = ctx.timestampInsidePassesSupported
    this.nMarkers = this.insidePasses ? N_MARKERS_INSIDE : 2
    this.segmentNames = this.insidePasses ? SEGMENT_LABELS_INSIDE : ['total']
    this.segmentSamples = this.segmentNames.map(() => [])
    if (!this.enabled) return
    const queryByteSize = this.nMarkers * TIMESTAMP_BYTES
    this.querySet = ctx.device.createQuerySet({ type: 'timestamp', count: this.nMarkers })
    this.resolveBuf = ctx.device.createBuffer({
      size: queryByteSize,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    })
    for (let i = 0; i < RING_SIZE; i++) {
      this.slots.push({
        buf: ctx.device.createBuffer({
          size: queryByteSize,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
        state: 'idle',
      })
    }
  }

  /** Pass descriptor `timestampWrites` for the timed pass. The first
   *  query (index 0) gets the begin timestamp, the LAST query
   *  (`nMarkers - 1`) gets the end timestamp. In inside-passes mode the
   *  three middle queries (1,2,3) are written via `mark()` calls
   *  during the pass. Returns null when disabled — call sites should
   *  spread it conditionally. */
  passWrites(): GPURenderPassTimestampWrites | null {
    if (!this.enabled || !this.querySet) return null
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: this.nMarkers - 1,
    }
  }

  /** Write a mid-pass timestamp at the given segment boundary. No-op
   *  when inside-passes is unavailable (so call sites can sprinkle
   *  `mark()` calls unconditionally — they cost nothing on devices
   *  without the feature). */
  mark(pass: GPURenderPassEncoder, label: MarkerLabel): void {
    if (!this.insidePasses || !this.querySet) return
    const markerIdx = MARKER_LABELS_INSIDE.indexOf(label) + 1 // +1 for "begin"
    // `writeTimestamp` is gated by the chromium-experimental feature
    // and isn't on the standard `GPURenderPassEncoder` type — cast.
    ;(pass as unknown as {
      writeTimestamp: (qs: GPUQuerySet, idx: number) => void
    }).writeTimestamp(this.querySet, markerIdx)
  }

  /** Encode resolveQuerySet + copyBufferToBuffer into the frame's
   *  command encoder. MUST be called AFTER pass.end() and BEFORE
   *  encoder.finish(). Picks the next IDLE slot; skips this frame
   *  if all slots are still in flight (better to drop a sample than
   *  to clobber a buffer the GPU is still using). */
  resolveOnEncoder(encoder: GPUCommandEncoder): void {
    if (!this.enabled || !this.querySet || !this.resolveBuf) return
    let chosen = -1
    for (let i = 0; i < RING_SIZE; i++) {
      const idx = (this.writeIdx + i) % RING_SIZE
      if (this.slots[idx].state === 'idle') { chosen = idx; break }
    }
    if (chosen < 0) return // ring full, drop sample
    const slot = this.slots[chosen]
    const nBytes = this.nMarkers * TIMESTAMP_BYTES
    encoder.resolveQuerySet(this.querySet, 0, this.nMarkers, this.resolveBuf, 0)
    encoder.copyBufferToBuffer(this.resolveBuf, 0, slot.buf, 0, nBytes)
    slot.state = 'copy'
    this.writeIdx = (chosen + 1) % RING_SIZE
  }

  /** Drain mapped slots, kick mapAsync on freshly-copied slots. Call
   *  once per frame AFTER queue.submit(). */
  pollReadbacks(): void {
    if (!this.enabled) return
    for (const slot of this.slots) {
      if (slot.state === 'mapped') {
        const range = slot.buf.getMappedRange()
        const big = new BigUint64Array(range, 0, this.nMarkers)
        // For each segment, push (t[i+1] - t[i]) ns into its ring.
        // Skip frames where the GPU returned non-monotonic timestamps
        // (rare but possible during device reset / power transitions
        // — would manifest as huge bogus samples otherwise).
        let ok = true
        for (let s = 0; s < this.segmentSamples.length; s++) {
          if (big[s + 1] < big[s]) { ok = false; break }
        }
        if (ok) {
          for (let s = 0; s < this.segmentSamples.length; s++) {
            const ns = Number(big[s + 1] - big[s])
            const ring = this.segmentSamples[s]
            ring.push(ns)
            if (ring.length > GPUTimer.MAX_SAMPLES) ring.shift()
          }
        }
        slot.buf.unmap()
        slot.state = 'idle'
      }
      if (slot.state === 'copy') {
        slot.state = 'map'
        const s = slot
        s.buf.mapAsync(GPUMapMode.READ).then(() => {
          if (s.state === 'map') s.state = 'mapped'
        }).catch(() => {
          s.state = 'idle'
        })
      }
    }
  }

  /** Snapshot of pass times in nanoseconds (in arrival order). When
   *  inside-passes is active, returns the SUM across segments per
   *  frame so existing single-number consumers see the whole-pass
   *  cost. Use `getBreakdown()` for the per-segment split. */
  getTimings(): number[] {
    if (this.segmentSamples.length === 1) return this.segmentSamples[0].slice()
    const len = this.segmentSamples[0].length
    const out = new Array(len).fill(0)
    for (const ring of this.segmentSamples) {
      for (let i = 0; i < len; i++) out[i] += ring[i] ?? 0
    }
    return out
  }

  /** Per-segment ns rings. Only meaningful when `insidePasses` is true;
   *  otherwise a single 'total' entry mirrors `getTimings()`. */
  getBreakdown(): Record<string, number[]> {
    const out: Record<string, number[]> = {}
    for (let s = 0; s < this.segmentNames.length; s++) {
      out[this.segmentNames[s]] = this.segmentSamples[s].slice()
    }
    return out
  }

  /** Drop all collected samples. */
  resetTimings(): void {
    for (const ring of this.segmentSamples) ring.length = 0
  }
}
