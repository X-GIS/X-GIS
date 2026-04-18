// ═══ WebGPU timestamp-query GPU timing ═══
//
// Wraps `timestampWrites` on a single render pass. Each frame:
//   1. write begin/end timestamps into a 2-slot QuerySet
//   2. resolve the QuerySet into a u64 GPU buffer
//   3. copy that into a MAP_READ buffer
//   4. mapAsync the readback buffer (async — completes 1+ frames later)
//   5. push (end - begin) ns into a rolling ring exposed via getTimings()
//
// State machine per readback slot:
//   IDLE  → COPY    (resolveOnEncoder encoded the copy this frame)
//   COPY  → MAP     (pollReadbacks called mapAsync, awaiting .then)
//   MAP   → MAPPED  (mapAsync .then resolved)
//   MAPPED → IDLE   (pollReadbacks read+unmap, slot is reusable)
//
// The states are kept STRICTLY DISJOINT so we never call mapAsync twice
// on the same buffer or encode a copy into a buffer that's currently
// mapped (which trips a "Buffer used in submit while mapped" validation
// error). Earlier impl conflated COPY+MAP into a single `pending` flag
// and triggered exactly that.

import type { GPUContext } from './gpu'

const RING_SIZE = 3 // hide ~2 frame map latency at 60Hz
const TIMESTAMP_BYTES = 8 // u64 per query

type SlotState = 'idle' | 'copy' | 'map' | 'mapped'

interface Slot {
  buf: GPUBuffer
  state: SlotState
}

export class GPUTimer {
  readonly enabled: boolean
  private device: GPUDevice
  private querySet: GPUQuerySet | null = null
  private resolveBuf: GPUBuffer | null = null
  private slots: Slot[] = []
  private writeIdx = 0
  private samples: number[] = []
  private static readonly MAX_SAMPLES = 600 // ~10 s at 60 Hz

  constructor(ctx: GPUContext) {
    this.device = ctx.device
    this.enabled = ctx.timestampQuerySupported
    if (!this.enabled) return
    this.querySet = ctx.device.createQuerySet({ type: 'timestamp', count: 2 })
    this.resolveBuf = ctx.device.createBuffer({
      size: 2 * TIMESTAMP_BYTES,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    })
    for (let i = 0; i < RING_SIZE; i++) {
      this.slots.push({
        buf: ctx.device.createBuffer({
          size: 2 * TIMESTAMP_BYTES,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
        state: 'idle',
      })
    }
  }

  /** Pass descriptor `timestampWrites` for the timed pass. Returns null
   *  when disabled — call sites should spread it conditionally. */
  passWrites(): GPURenderPassTimestampWrites | null {
    if (!this.enabled || !this.querySet) return null
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    }
  }

  /** Encode resolveQuerySet + copyBufferToBuffer into the frame's
   *  command encoder. MUST be called AFTER pass.end() and BEFORE
   *  encoder.finish(). Picks the next IDLE slot; skips this frame
   *  if all slots are still in flight (better to drop a sample than
   *  to clobber a buffer the GPU is still using). */
  resolveOnEncoder(encoder: GPUCommandEncoder): void {
    if (!this.enabled || !this.querySet || !this.resolveBuf) return
    // Find an IDLE slot starting at writeIdx; advance writeIdx so
    // subsequent frames probe the next slot first.
    let chosen = -1
    for (let i = 0; i < RING_SIZE; i++) {
      const idx = (this.writeIdx + i) % RING_SIZE
      if (this.slots[idx].state === 'idle') { chosen = idx; break }
    }
    if (chosen < 0) return // ring full, drop sample
    const slot = this.slots[chosen]
    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuf, 0)
    encoder.copyBufferToBuffer(this.resolveBuf, 0, slot.buf, 0, 2 * TIMESTAMP_BYTES)
    slot.state = 'copy'
    this.writeIdx = (chosen + 1) % RING_SIZE
  }

  /** Drain mapped slots, kick mapAsync on freshly-copied slots. Call
   *  once per frame AFTER queue.submit(). */
  pollReadbacks(): void {
    if (!this.enabled) return
    for (const slot of this.slots) {
      // 1) Drain anything that finished mapping last frame.
      if (slot.state === 'mapped') {
        const range = slot.buf.getMappedRange()
        const big = new BigUint64Array(range, 0, 2)
        const begin = big[0], end = big[1]
        if (end > begin) {
          const ns = Number(end - begin)
          this.samples.push(ns)
          if (this.samples.length > GPUTimer.MAX_SAMPLES) this.samples.shift()
        }
        slot.buf.unmap()
        slot.state = 'idle'
      }
      // 2) Promote freshly-copied slots into the mapping queue. The .then
      //    flips state to 'mapped' on completion; until then the slot is
      //    `state === 'map'` and won't be re-mapAsync'd or reused for copy.
      if (slot.state === 'copy') {
        slot.state = 'map'
        // Capture the slot reference for the closure — TS narrows correctly.
        const s = slot
        s.buf.mapAsync(GPUMapMode.READ).then(() => {
          // If the slot was reset by something else in between (shouldn't
          // happen in normal flow), don't override its state.
          if (s.state === 'map') s.state = 'mapped'
        }).catch(() => {
          // Device lost or buffer destroyed mid-flight: park in idle so
          // the slot stays out of the way; future writes will retry.
          s.state = 'idle'
        })
      }
    }
  }

  /** Snapshot of pass times in nanoseconds (in arrival order). */
  getTimings(): number[] {
    return this.samples.slice()
  }

  /** Drop all collected samples. */
  resetTimings(): void {
    this.samples.length = 0
  }
}
