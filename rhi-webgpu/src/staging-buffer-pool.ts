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
  4 * 1024, // 4 KB   — small index buffers, z attributes
  16 * 1024, // 16 KB
  64 * 1024, // 64 KB
  256 * 1024, // 256 KB
  1024 * 1024, // 1 MB   — typical polygon vertex buffer
  4 * 1024 * 1024, // 4 MB
  16 * 1024 * 1024, // 16 MB  — extreme tile (very dense roads)
]

/** Per-tier free-list caps (#1153 P2 R2). Without a cap the free-list
 *  high-water mark persists for the whole session: one fast LOD jump warms
 *  every tier and those bytes never come back (GPU bytes exert no JS GC
 *  pressure). `release` pools a returned slot only while its tier is under
 *  cap and destroys the excess — the GpuTileStore._bufferPool cap precedent
 *  (gpu-tile-store.ts).
 *
 *  Sizing (aligned index-for-index with TIER_SIZES): a desktop upload burst
 *  runs up to the map's per-frame upload budget (`MAX_UPLOADS_PER_FRAME` /
 *  `uploadBudgetFor` in vector-tile-renderer-helpers.ts; historically the
 *  "maxJobs (4-8)" range) tile uploads concurrently, each borrowing several
 *  same-tier staging slots, so 8 (a generous multiple of that budget) retains
 *  the small tiers' steady-state working set BYTE-IDENTICALLY — under-cap traffic
 *  never destroys-then-reallocates — while bounding growth. The budget's exact
 *  value is map-layer policy and is deliberately NOT copied here (that number has
 *  drifted before); this cap is a self-contained conservative constant.
 *  The two largest tiers (4 MB / 16 MB "extreme tile") are capped tighter
 *  (2 / 1): they dominate retained bytes and a dense-roads spike is rare, so a
 *  permanent 8× high-water there is not worth holding. Worst-case retained per
 *  pool ≈ 34.7 MB. Caps are PER-POOL and pools are per-VectorTileRenderer (per
 *  source), so a multi-source map multiplies the retained bytes by source
 *  count — acceptable, but the coupling to the upload budget lives here so a
 *  future budget retune stays discoverable. */
const TIER_CAPS = [8, 8, 8, 8, 8, 2, 1]

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
  /** Terminal once `dispose()` runs (#1153 P2 R1). A pool is disposed on
   *  VectorTileRenderer.destroy(); an async upload suspended on the staging
   *  `mapAsync` round-trip can still resume AFTER that and hand its slot back
   *  via `release`. When disposed, `release` DESTROYS the returned buffer
   *  instead of pooling it into a dead free-list (which would never be
   *  drained — a real GPU leak). `borrow` after dispose stays legal: it
   *  allocates a fresh buffer that its own `release` then destroys. */
  private disposed = false

  /** Read-only view of the SwiftShader-style fallback flag. */
  get hasMappedAtCreationFallback(): boolean {
    return this.mappedAtCreationFails
  }
  /** Test seam — flip without provoking the GPU. */
  _forceDirectWriteFallback(): void {
    this.mappedAtCreationFails = true
  }

  /** Expose the device so `asyncWriteBuffer` can route around this
   *  pool when the fallback is engaged. */
  get gpuDevice(): GPUDevice {
    return this.device
  }

  constructor(device: GPUDevice) {
    this.device = device
  }

  /** Borrow a staging buffer ≥ `byteLength` bytes. Returned buffer is
   *  mapped for write — call `getMappedRange()` to fill it. Throws
   *  RangeError on the SwiftShader-WebGPU fallback path; callers use
   *  `asyncWriteBuffer` which catches and routes around via
   *  `device.queue.writeBuffer`. */
  async borrow(byteLength: number): Promise<StagingSlot> {
    if (byteLength <= 0)
      throw new Error(`StagingBufferPool.borrow: byteLength must be positive (got ${byteLength})`)

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
      try {
        await slot.buffer.mapAsync(GPUMapMode.WRITE)
      } catch (e) {
        // mapAsync rejected (e.g. device loss). Route the slot back through
        // release() before rethrowing so it is not stranded off-list (#782).
        // release() DESTROYS it if the pool was disposed mid-borrow — an async
        // upload suspended here while VectorTileRenderer.destroy() ran dispose()
        // (#1153 P2 R1: never pool into a dead free-list nothing will drain) — or
        // if the tier is at cap (R2); otherwise it returns to the free-list.
        // A raw `list.push` here bypassed both guards (the pre-fix dispose-terminal
        // hole, symmetric with the guard release() already carries). Since borrow
        // just popped this slot, the tier is under cap on the normal path, so the
        // re-pool stays byte-identical to the old push.
        this.release(slot)
        throw e
      }
      return slot
    }

    // No free buffer in this tier — create a fresh one, mapped at birth.
    const buffer = this._createMappedBuffer(
      TIER_SIZES[tier]!,
      `staging-tier-${tier}-${TIER_SIZES[tier]}`,
    )
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
    // Oversize one-offs always destroy; a disposed pool destroys everything
    // returned to it (#1153 P2 R1 — never pool into a dead free-list).
    if (slot.tier === -1 || this.disposed) {
      slot.buffer.destroy()
      return
    }
    // Per-tier cap (#1153 P2 R2): pool while under cap, else destroy the
    // excess so the free-list high-water mark can't persist for the session.
    // Mirrors GpuTileStore.releaseBuffer (gpu-tile-store.ts). Under-cap
    // traffic is byte-identical to the pre-cap push.
    const list = this.free[slot.tier]
    if (list.length < TIER_CAPS[slot.tier]!) list.push(slot)
    else slot.buffer.destroy()
  }

  /** Diagnostic — how many buffers we've allocated total since boot. */
  getCreatedCount(): number {
    return this.created
  }

  /** Diagnostic — current free count per tier. */
  getFreeCounts(): readonly number[] {
    return this.free.map((list) => list.length)
  }

  /** Destroy every pooled buffer + mark the pool terminal. Call on context
   *  loss / VectorTileRenderer.destroy(). After this, any slot still out on
   *  loan (an in-flight async upload that resumes post-destroy) is destroyed
   *  on `release` rather than pooled (#1153 P2 R1). Idempotent; touches
   *  `device` NOWHERE, so it is safe on the forced-WebGL2 fail-loud proxy. */
  dispose(): void {
    this.disposed = true
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
 *  encoder when ready).
 *
 *  Resolves with the borrowed `StagingSlot`, which the caller hands back
 *  via `pool.release(slot)` AFTER submitting its encoder — returning the
 *  slot itself instead of a per-upload `{release}` closure keeps the
 *  150-210 uploads of an LOD jump allocation-free (#784) while still
 *  letting a multi-write tile batch into ONE submit and bulk-release.
 *
 *  Resolves `null` when there is nothing to release: a zero-length write
 *  (legal no-op, matching `queue.writeBuffer` semantics — real-world hit:
 *  tile slices whose source layer carried only polygons) or the
 *  direct-write fallback below. */
export async function asyncWriteBuffer(
  pool: StagingBufferPool,
  encoder: GPUCommandEncoder,
  dst: GPUBuffer,
  dstOffset: number,
  data: ArrayBuffer | ArrayBufferView,
): Promise<StagingSlot | null> {
  const byteLength = 'byteLength' in data ? data.byteLength : (data as ArrayBuffer).byteLength
  if (byteLength === 0) {
    return null
  }

  // Fast direct-write path when the staging pool can't allocate
  // mappedAtCreation buffers (SwiftShader-WebGPU on headless Linux CI).
  // `queue.writeBuffer` is the canonical fallback — the driver does an
  // internal staging copy, which is slower but always works.
  if (pool.hasMappedAtCreationFallback) {
    pool.gpuDevice.queue.writeBuffer(dst, dstOffset, data as BufferSource)
    return null
  }

  let slot
  try {
    slot = await pool.borrow(byteLength)
  } catch (e) {
    if (pool.hasMappedAtCreationFallback) {
      // First-fail: flag was just flipped by borrow's catch. Retry
      // through the direct path so this very write doesn't drop.
      pool.gpuDevice.queue.writeBuffer(dst, dstOffset, data as BufferSource)
      return null
    }
    throw e
  }
  const mapped = slot.buffer.getMappedRange(0, byteLength)
  // Copy data into the mapped range. Both ArrayBuffer and typed-array
  // inputs map to a Uint8Array view for the byte-level memcpy.
  const srcBytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  new Uint8Array(mapped).set(srcBytes)
  slot.buffer.unmap()
  encoder.copyBufferToBuffer(slot.buffer, 0, dst, dstOffset, byteLength)
  return slot
}
