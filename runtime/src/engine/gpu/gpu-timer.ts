// ═══ WebGPU timestamp-query GPU timing ═══
//
// Two timing dimensions:
//
//   • Within sub-pass 0 (the FIRST opaque sub-pass) we use Chromium's
//     `timestamp-query-inside-passes` to plant mid-pass markers and
//     split the pass into named segments — bg, raster, legacy, vt.
//     The `vt` segment captures the (tile × layer) loop for the
//     first sub-pass.
//
//   • Across additional opaque sub-passes (1, 2, …) we attach a
//     standard begin/end timestamp pair to each. Their durations
//     accumulate into the same `vt` ring. PMTiles demos like
//     osm_style typically split their opaque rendering across
//     multiple sub-passes (one per source group); without this
//     extension the `vt` ring would only count sub-pass 0.
//
// Resulting per-frame samples (when inside-passes is on):
//   bg       sub-pass 0 only           backgroundRenderer
//   raster   sub-pass 0 only           rasterRenderer
//   legacy   sub-pass 0 only           legacy MapRenderer
//   vt       sub-pass 0 vt segment +
//            sum(begin..end of sub-pass 1, 2, …)
//                                      vector-tile loop, total
//                                      across all opaque groups
//
// When inside-passes is OFF (only `timestamp-query`):
//   total    sub-pass 0 begin..end +
//            sum(begin..end of sub-pass 1, 2, …)
//
// QuerySet layout — pre-allocated up to MAX_SUBPASSES:
//   inside-passes ON:
//     [0..4]  sub-pass 0 — 5 markers (begin, after_bg, after_raster,
//                                     after_legacy, end)
//     [5..6]  sub-pass 1 — 2 markers (begin, end)
//     [7..8]  sub-pass 2 — 2 markers
//     ...
//   inside-passes OFF:
//     [0..1]  sub-pass 0 — 2 markers
//     [2..3]  sub-pass 1
//     ...
//
// State machine per readback ring slot is unchanged:
//   IDLE  → COPY  → MAP  → MAPPED  → IDLE
// Strictly disjoint so we never mapAsync twice on the same buffer
// or encode a copy into a buffer that's currently mapped.

import type { GPUContext } from './gpu'

const RING_SIZE = 3 // hide ~2 frame map latency at 60Hz
const TIMESTAMP_BYTES = 8 // u64 per query
const MAX_SUBPASSES = 8 // pre-allocated cap; X-GIS demos run ≤ ~5

type SlotState = 'idle' | 'copy' | 'map' | 'mapped'

interface Slot {
  buf: GPUBuffer
  state: SlotState
  // Per-sub-pass active flag at the time the copy was encoded — only
  // sub-passes that actually wrote their timestamp pair contribute
  // to the frame's deltas. Inactive sub-passes' query slots stay at
  // their prior value (or 0); reading them would push noise into vt.
  activeSubpasses: number
  /** True when the compute pass ran this frame (so the begin/end query
   *  slots carry a real measurement). False frames are skipped to keep
   *  the 'compute' ring noise-free. */
  computeActive: boolean
}

const SEGMENT_LABELS_INSIDE = ['bg', 'raster', 'legacy', 'vt'] as const
const MARKER_LABELS_INSIDE = ['after_bg', 'after_raster', 'after_legacy'] as const
type MarkerLabel = typeof MARKER_LABELS_INSIDE[number]

// Sub-pass 0 marker count. With inside-passes: 5 (begin + 3 mid + end).
// Without: 2 (begin + end).
function firstPassMarkerCount(insidePasses: boolean): number {
  return insidePasses ? SEGMENT_LABELS_INSIDE.length + 1 : 2
}
const SUBPASS_N_MARKERS = 2 // additional sub-passes: just begin + end
const COMPUTE_PASS_MARKERS = 2 // begin + end of the P4 compute pass

export class GPUTimer {
  readonly enabled: boolean
  readonly insidePasses: boolean
  private querySet: GPUQuerySet | null = null
  private resolveBuf: GPUBuffer | null = null
  private slots: Slot[] = []
  private writeIdx = 0
  private firstPassMarkers: number
  private totalMarkers: number
  // Per-frame accounting — reset at frame start by the caller via
  // resolveOnEncoder, populated by passWrites() each time a sub-pass
  // wires its timestamps.
  private nextSubpassToAssign = 0
  private subpassFirstMarkerIdx: number[] = []
  /** Latched by `computeWrites()` on its first non-null return each
   *  frame so the readback knows the compute query slots carry a real
   *  sample. Reset at `beginFrame()`. */
  private computeRanThisFrame = false
  // Parallel rings — one entry per segment, all kept the same length.
  // Inside-passes: 4 rings (bg, raster, legacy, vt).
  // Begin/end-only: 1 ring ('total').
  private segmentSamples: number[][]
  private segmentNames: readonly string[]
  private static readonly MAX_SAMPLES = 600 // ~10 s at 60 Hz

  /** Index of the FIRST compute-pass query slot (begin); end is +1.
   *  Compute pass writes are reserved at the end of the query set so
   *  the sub-pass indexing math above stays untouched. */
  private computeFirstMarker: number

  constructor(ctx: GPUContext) {
    this.enabled = ctx.timestampQuerySupported
    this.insidePasses = ctx.timestampInsidePassesSupported
    this.firstPassMarkers = firstPassMarkerCount(this.insidePasses)
    const renderMarkers = this.firstPassMarkers + (MAX_SUBPASSES - 1) * SUBPASS_N_MARKERS
    this.computeFirstMarker = renderMarkers
    this.totalMarkers = renderMarkers + COMPUTE_PASS_MARKERS
    // 'compute' ring trails the render-pass segments. Available whether
    // or not inside-passes is supported — `beginComputePass` accepts
    // `timestampWrites` independently of the inside-passes flag.
    const renderSegments = this.insidePasses ? SEGMENT_LABELS_INSIDE : (['total'] as const)
    this.segmentNames = [...renderSegments, 'compute']
    this.segmentSamples = this.segmentNames.map(() => [])
    if (!this.enabled) return
    const queryByteSize = this.totalMarkers * TIMESTAMP_BYTES
    this.querySet = ctx.device.createQuerySet({ type: 'timestamp', count: this.totalMarkers })
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
        activeSubpasses: 0,
        computeActive: false,
      })
    }
  }

  /** MUST be called once per frame, before any passWrites(), to reset
   *  the per-frame sub-pass assignment counter. */
  beginFrame(): void {
    this.nextSubpassToAssign = 0
    this.subpassFirstMarkerIdx.length = 0
    this.computeRanThisFrame = false
  }

  /** Pass descriptor `timestampWrites` for the next opaque sub-pass.
   *  Returns null when:
   *    • timer is disabled
   *    • we've already issued passWrites for MAX_SUBPASSES sub-passes
   *      this frame (caller can keep rendering — those passes just
   *      won't be measured).
   *
   *  Sub-pass 0 receives the inside-passes breakdown range (5 slots)
   *  and is also the only pass where mark() calls take effect.
   *  Sub-passes 1..N-1 receive 2-slot begin/end pairs that aggregate
   *  into the `vt` ring. */
  passWrites(): GPURenderPassTimestampWrites | null {
    if (!this.enabled || !this.querySet) return null
    const passIdx = this.nextSubpassToAssign
    if (passIdx >= MAX_SUBPASSES) return null
    const firstMarker = passIdx === 0
      ? 0
      : this.firstPassMarkers + (passIdx - 1) * SUBPASS_N_MARKERS
    const lastMarker = firstMarker + (passIdx === 0 ? this.firstPassMarkers : SUBPASS_N_MARKERS) - 1
    this.subpassFirstMarkerIdx.push(firstMarker)
    this.nextSubpassToAssign = passIdx + 1
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: firstMarker,
      endOfPassWriteIndex: lastMarker,
    }
  }

  /** Descriptor `timestampWrites` for the first compute pass of the
   *  frame. Returns null when the timer is disabled OR when this
   *  method has already returned a non-null this frame — every kernel
   *  begins its own `beginComputePass`, but timestamp markers are
   *  per-pass and we only have one slot pair, so the FIRST dispatch
   *  alone is timed. continent-match-style scenes have exactly one
   *  compute pass per frame, so single-pass timing equals total compute
   *  time there. Multi-kernel scenes get the first kernel's time as a
   *  representative sample.
   *
   *  Caller (the dispatcher) feeds the result straight into
   *  `encoder.beginComputePass({timestampWrites})`; a frame's begin..end
   *  delta lands in the 'compute' segment of `getBreakdown()`. */
  computeWrites(): GPUComputePassTimestampWrites | null {
    if (!this.enabled || !this.querySet) return null
    if (this.computeRanThisFrame) return null
    this.computeRanThisFrame = true
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: this.computeFirstMarker,
      endOfPassWriteIndex: this.computeFirstMarker + 1,
    }
  }

  /** Write a mid-pass timestamp at the given segment boundary. ONLY
   *  valid in sub-pass 0 (the first opaque sub-pass) and only when
   *  inside-passes is enabled — otherwise a no-op. Call sites can
   *  sprinkle mark() calls unconditionally; they cost nothing on
   *  devices/passes without support. */
  mark(pass: GPURenderPassEncoder, label: MarkerLabel): void {
    if (!this.insidePasses || !this.querySet) return
    // Only the FIRST sub-pass (subpass 0) carries the mid-markers.
    // Mid-markers for sub-passes 1+ would be writing into adjacent
    // sub-passes' begin/end slots, which corrupts those readings.
    if (this.subpassFirstMarkerIdx.length === 0) return
    if (this.subpassFirstMarkerIdx[0] !== 0) return // defensive
    if (this.subpassFirstMarkerIdx.length !== 1) return // already in sub-pass 1+
    const markerIdx = MARKER_LABELS_INSIDE.indexOf(label) + 1 // +1 for "begin"
    // `writeTimestamp` is gated by the chromium-experimental feature
    // and isn't on the standard `GPURenderPassEncoder` type — cast.
    ;(pass as unknown as {
      writeTimestamp: (qs: GPUQuerySet, idx: number) => void
    }).writeTimestamp(this.querySet, markerIdx)
  }

  /** Encode resolveQuerySet + copyBufferToBuffer into the frame's
   *  command encoder. MUST be called AFTER all sub-pass.end() calls
   *  and BEFORE encoder.finish(). Picks the next IDLE slot; skips
   *  this frame if all slots are still in flight (better to drop a
   *  sample than to clobber a buffer the GPU is still using). */
  resolveOnEncoder(encoder: GPUCommandEncoder): void {
    if (!this.enabled || !this.querySet || !this.resolveBuf) return
    let chosen = -1
    for (let i = 0; i < RING_SIZE; i++) {
      const idx = (this.writeIdx + i) % RING_SIZE
      if (this.slots[idx].state === 'idle') { chosen = idx; break }
    }
    if (chosen < 0) return // ring full, drop sample
    const slot = this.slots[chosen]
    const nBytes = this.totalMarkers * TIMESTAMP_BYTES
    encoder.resolveQuerySet(this.querySet, 0, this.totalMarkers, this.resolveBuf, 0)
    encoder.copyBufferToBuffer(this.resolveBuf, 0, slot.buf, 0, nBytes)
    slot.state = 'copy'
    slot.activeSubpasses = this.nextSubpassToAssign
    slot.computeActive = this.computeRanThisFrame
    this.writeIdx = (chosen + 1) % RING_SIZE
  }

  /** Drain mapped slots, kick mapAsync on freshly-copied slots. Call
   *  once per frame AFTER queue.submit(). */
  pollReadbacks(): void {
    if (!this.enabled) return
    for (const slot of this.slots) {
      if (slot.state === 'mapped') {
        const range = slot.buf.getMappedRange()
        const big = new BigUint64Array(range, 0, this.totalMarkers)
        const nSubpasses = slot.activeSubpasses
        if (nSubpasses > 0) this.parseFrame(big, nSubpasses)
        if (slot.computeActive) this.parseComputeFrame(big)
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

  // Decodes one frame's worth of timestamps into per-segment ns deltas
  // and pushes them into the rolling rings. Sub-pass 0 contributes the
  // inside-passes breakdown (or a single 'total' segment); sub-passes
  // 1..N-1 each contribute one (end - begin) value that ALSO feeds the
  // 'vt' ring (or 'total' when inside-passes is off). All segment
  // rings end the call at the same length so getBreakdown() returns
  // aligned arrays.
  private parseFrame(big: BigUint64Array, nSubpasses: number): void {
    if (this.insidePasses) {
      const t0 = big[0]
      const t1 = big[1]
      const t2 = big[2]
      const t3 = big[3]
      const t4 = big[4]
      // Reject any sub-pass-0 frame where mid markers weren't written
      // (uninitialized → t1..t3 may be 0 or stale).
      if (t1 < t0 || t2 < t1 || t3 < t2 || t4 < t3) return
      let vtTotal = Number(t4 - t3)
      for (let i = 1; i < nSubpasses; i++) {
        const base = this.firstPassMarkers + (i - 1) * SUBPASS_N_MARKERS
        const a = big[base], b = big[base + 1]
        if (b < a) continue // skip non-monotonic sub-pass — likely a stale
                            // readback before the GPU finished writing
        vtTotal += Number(b - a)
      }
      this.push(0, Number(t1 - t0)) // bg
      this.push(1, Number(t2 - t1)) // raster
      this.push(2, Number(t3 - t2)) // legacy
      this.push(3, vtTotal)         // vt (sub-pass 0 vt segment + all sub-passes 1..N)
    } else {
      // Single 'total' ring. Sum begin..end of every sub-pass.
      let total = 0
      for (let i = 0; i < nSubpasses; i++) {
        const base = i === 0 ? 0 : this.firstPassMarkers + (i - 1) * SUBPASS_N_MARKERS
        const a = big[base], b = big[base + 1]
        if (b < a) continue
        total += Number(b - a)
      }
      this.push(0, total)
    }
  }

  // Extract the (begin..end) delta from the compute query slot pair
  // and push into the 'compute' ring. Last segment in segmentNames so
  // index = segmentNames.length - 1.
  private parseComputeFrame(big: BigUint64Array): void {
    const a = big[this.computeFirstMarker]
    const b = big[this.computeFirstMarker + 1]
    if (b < a) return
    const computeIdx = this.segmentNames.length - 1
    this.push(computeIdx, Number(b - a))
  }

  private push(segmentIdx: number, ns: number): void {
    const ring = this.segmentSamples[segmentIdx]
    ring.push(ns)
    if (ring.length > GPUTimer.MAX_SAMPLES) ring.shift()
  }

  /** Snapshot of RENDER pass times in nanoseconds (in arrival order).
   *  Sums across the render segments (bg + raster + legacy + vt when
   *  inside-passes is active, or a single 'total' otherwise). Excludes
   *  the 'compute' segment so the legacy frame-time inspector keeps
   *  the same number it had before compute timing was wired in — use
   *  `getBreakdown()` to read per-segment values including 'compute'. */
  getTimings(): number[] {
    // segmentNames = [...renderSegments, 'compute']. Render segments
    // are everything except the last entry.
    const renderSegCount = this.segmentNames.length - 1
    if (renderSegCount === 1) return this.segmentSamples[0].slice()
    const len = this.segmentSamples[0].length
    const out = new Array(len).fill(0)
    for (let s = 0; s < renderSegCount; s++) {
      const ring = this.segmentSamples[s]
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
