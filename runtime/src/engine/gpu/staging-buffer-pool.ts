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
  /** Implementation-defined: some software adapters (Mesa/SwiftShader-
   *  WebGPU, seen on Linux GH Actions runners with no GPU) reject
   *  `createBuffer({ mappedAtCreation: true })` even at 4 KB with
   *  `RangeError: size N is too large for the implementation when
   *  mappedAtCreation == true`. When that happens the entire staging
   *  pipeline collapses — every tile upload throws and nothing
   *  renders. The fallback path uses `device.queue.writeBuffer`
   *  directly: slower (the driver does its own staging copy), but
   *  works on the software adapter. Set lazily on first failure;
   *  exposed for tests. */
  private mappedAtCreationFails = false

  /** Read-only view of the SwiftShader-style fallback flag. */
  get hasMappedAtCreationFallback(): boolean { return this.mappedAtCreationFails }
  /** Test seam — flip without provoking the GPU. */
  _forceDirectWriteFallback(): void { this.mappedAtCreationFails = true }

  /** Expose the device so `asyncWriteBuffer` can route around this
   *  pool when the fallback is engaged. */
  get gpuDevice(): GPUDevice { return this.device }

  constructor(device: GPUDevice) {
    this.device = device
  }

  /** Borrow a staging buffer ≥ `byteLength` bytes. Returned buffer is
   *  mapped for write — call `getMappedRange()` to fill it. Throws
   *  RangeError on the SwiftShader-WebGPU fallback path; callers use
   *  `asyncWriteBuffer` which catches and routes around via
   *  `device.queue.writeBuffer`. */
  async borrow(byteLength: number): Promise<StagingSlot> {
    if (byteLength <= 0) throw new Error(`StagingBufferPool.borrow: byteLength must be positive (got ${byteLength})`)

    // Pick smallest tier that fits.
    let tier = 0
    while (tier < TIER_SIZES.length && TIER_SIZES[tier] < byteLength) tier++

    if (tier === TIER_SIZES.length) {
      // Bigger than the largest tier — one-off buffer, destroy on release.
      const buffer = this._createMappedBuffer(byteLength, `staging-oversize-${byteLength}`)
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
    const buffer = this._createMappedBuffer(TIER_SIZES[tier]!, `staging-tier-${tier}-${TIER_SIZES[tier]}`)
    this.created++
    return { buffer, tier, byteCapacity: TIER_SIZES[tier]! }
  }

  /** mappedAtCreation createBuffer with the SwiftShader-fallback flag
   *  flip. The flag is read by `asyncWriteBuffer` which takes the
   *  direct `queue.writeBuffer` path once tripped. */
  private _createMappedBuffer(size: number, label: string): GPUBuffer {
    try {
      return this.device.createBuffer({
        size,
        usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
        mappedAtCreation: true,
        label,
      })
    } catch (e) {
      // SwiftShader-WebGPU rejects mappedAtCreation buffers even at 4 KB.
      // Mark the flag and re-throw — asyncWriteBuffer's catch routes
      // this call and every subsequent one through queue.writeBuffer.
      if (e instanceof RangeError && /mappedAtCreation/.test(e.message)) {
        this.mappedAtCreationFails = true
      }
      throw e
    }
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
 *  via the callback that the resolved promise schedules.
 *
 *  Empty-data case (`byteLength === 0`) resolves with a no-op release
 *  closure — matches WebGPU's `queue.writeBuffer` semantics where a
 *  zero-length write is legal and does nothing. Real-world hit:
 *  tile slices that ship a zero-length `lineVertices` array because
 *  the source layer carried only polygons. */
export async function asyncWriteBuffer(
  pool: StagingBufferPool,
  encoder: GPUCommandEncoder,
  dst: GPUBuffer,
  dstOffset: number,
  data: ArrayBuffer | ArrayBufferView,
): Promise<{ release: () => void }> {
  const byteLength = ('byteLength' in data) ? data.byteLength : (data as ArrayBuffer).byteLength
  if (byteLength === 0) {
    return { release: () => {} }
  }

  // Fast direct-write path when the staging pool can't allocate
  // mappedAtCreation buffers (SwiftShader-WebGPU on headless Linux CI).
  // `queue.writeBuffer` is the canonical fallback — the driver does an
  // internal staging copy, which is slower but always works.
  if (pool.hasMappedAtCreationFallback) {
    pool.gpuDevice.queue.writeBuffer(dst, dstOffset, data as BufferSource)
    return { release: () => {} }
  }

  let slot
  try {
    slot = await pool.borrow(byteLength)
  } catch (e) {
    if (pool.hasMappedAtCreationFallback) {
      // First-fail: flag was just flipped by borrow's catch. Retry
      // through the direct path so this very write doesn't drop.
      pool.gpuDevice.queue.writeBuffer(dst, dstOffset, data as BufferSource)
      return { release: () => {} }
    }
    throw e
  }
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
    release: () => pool.release(slot!),
  }
}
