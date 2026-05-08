// Tiered pool of MAP_WRITE | COPY_SRC staging buffers for async tile
// upload. Each `borrow(byteLength)` returns a buffer at least that
// large, already mapped for write. Caller fills the mapped range,
// unmaps, encodes a `copyBufferToBuffer(staging, 0, dst, 0, n)` into
// its command encoder, and submits. After submit, `release(slot)`
// returns the buffer to the pool — next `borrow` re-maps it via
// `mapAsync`, which natively waits for the GPU copy to finish.
//
// Why: `device.queue.writeBuffer` is sync from JS but pays a
// staging-copy on every call inside the driver. For 30 tiles × 5-7
// buffers per LOD jump, that's 150-210 driver staging copies that
// block JS. Routing through `mapAsync` lets multiple uploads overlap
// with CPU work on subsequent tiles AND avoids the driver's hidden
// staging step (we own the staging buffer and reuse it).
//
// Reference: MDN/WebGPU spec — staging-buffer-then-copyBufferToBuffer
// is the canonical async upload pattern.

const TIER_SIZES = [
  4 * 1024,         // 4 KB   — small index buffers, z attributes
  16 * 1024,        // 16 KB
  64 * 1024,        // 64 KB
  256 * 1024,       // 256 KB
  1024 * 1024,      // 1 MB   — typical polygon vertex buffer
  4 * 1024 * 1024,  // 4 MB
  16 * 1024 * 1024, // 16 MB  — extreme tile (very dense roads)
]

export interface StagingSlot {
  /** GPU buffer with MAP_WRITE | COPY_SRC usage. */
  readonly buffer: GPUBuffer
  /** Tier index used to route this slot back on release; -1 for a
   *  one-off buffer larger than any tier (destroyed on release). */
  readonly tier: number
  /** Size of THIS buffer (the tier capacity, not the request). */
  readonly byteCapacity: number
}

export class StagingBufferPool {
  private device: GPUDevice
  private free: StagingSlot[][] = TIER_SIZES.map(() => [])
  /** Total buffers ever created — diagnostic for tuning tier sizes. */
  private created = 0

  constructor(device: GPUDevice) {
    this.device = device
  }

  /** Borrow a staging buffer ≥ `byteLength` bytes. Returned buffer is
   *  mapped for write — call `getMappedRange()` to fill it. */
  async borrow(byteLength: number): Promise<StagingSlot> {
    if (byteLength <= 0) throw new Error(`StagingBufferPool.borrow: byteLength must be positive (got ${byteLength})`)

    // Pick smallest tier that fits.
    let tier = 0
    while (tier < TIER_SIZES.length && TIER_SIZES[tier] < byteLength) tier++

    if (tier === TIER_SIZES.length) {
      // Bigger than the largest tier — one-off buffer, destroy on release.
      const buffer = this.device.createBuffer({
        size: byteLength,
        usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
        mappedAtCreation: true,
        label: `staging-oversize-${byteLength}`,
      })
      this.created++
      return { buffer, tier: -1, byteCapacity: byteLength }
    }

    const list = this.free[tier]
    if (list.length > 0) {
      const slot = list.pop()!
      // Re-map the buffer for write. mapAsync waits for any prior GPU
      // copy from this buffer to finish — natural serialisation.
      await slot.buffer.mapAsync(GPUMapMode.WRITE)
      return slot
    }

    // No free buffer in this tier — create a fresh one, mapped at birth.
    const buffer = this.device.createBuffer({
      size: TIER_SIZES[tier],
      usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
      label: `staging-tier-${tier}-${TIER_SIZES[tier]}`,
    })
    this.created++
    return { buffer, tier, byteCapacity: TIER_SIZES[tier] }
  }

  /** Return a slot to the pool. Caller must have already unmapped the
   *  buffer AND submitted any commandEncoder that reads from it.
   *  One-off (tier === -1) slots are destroyed; pooled slots wait for
   *  the next borrow to re-map. */
  release(slot: StagingSlot): void {
    if (slot.tier === -1) {
      slot.buffer.destroy()
      return
    }
    this.free[slot.tier].push(slot)
  }

  /** Diagnostic — how many buffers we've allocated total since boot. */
  getCreatedCount(): number {
    return this.created
  }

  /** Diagnostic — current free count per tier. */
  getFreeCounts(): readonly number[] {
    return this.free.map(list => list.length)
  }

  /** Destroy every pooled buffer. Call on context loss / dispose. */
  dispose(): void {
    for (const list of this.free) {
      for (const slot of list) slot.buffer.destroy()
      list.length = 0
    }
  }
}

/** Async equivalent of `device.queue.writeBuffer(dst, dstOffset, data)`.
 *  Borrows a staging slot, copies `data` into its mapped range, unmaps,
 *  encodes `copyBufferToBuffer` into `encoder`, and resolves once the
 *  copy is queued (NOT once the GPU completes — caller submits the
 *  encoder when ready). The slot is returned to the pool after submit
 *  via the callback that the resolved promise schedules. */
export async function asyncWriteBuffer(
  pool: StagingBufferPool,
  encoder: GPUCommandEncoder,
  dst: GPUBuffer,
  dstOffset: number,
  data: ArrayBuffer | ArrayBufferView,
): Promise<{ release: () => void }> {
  const byteLength = ('byteLength' in data) ? data.byteLength : (data as ArrayBuffer).byteLength
  const slot = await pool.borrow(byteLength)
  const mapped = slot.buffer.getMappedRange(0, byteLength)
  // Copy data into the mapped range. Both ArrayBuffer and typed-array
  // inputs map to a Uint8Array view for the byte-level memcpy.
  const srcBytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  new Uint8Array(mapped).set(srcBytes)
  slot.buffer.unmap()
  encoder.copyBufferToBuffer(slot.buffer, 0, dst, dstOffset, byteLength)
  // Caller submits encoder, then invokes release(). We hand back a
  // closure rather than auto-releasing so a multi-write tile can batch
  // its uploads into ONE submit, then bulk-release all slots after.
  return {
    release: () => pool.release(slot),
  }
}
