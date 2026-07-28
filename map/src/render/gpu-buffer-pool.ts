// ═══ Pooled GPU buffer recycler (#1357) ═══
//
// Extracted from GpuTileStore, which owns tile residency, three arenas, the
// retire queues and this recycler — and sits on a shrink-only LOC ceiling. The
// pool is the one piece with no coupling to any of that: it takes sizes and
// usage flags and hands back GPUBuffers. Lifting it out is what paid for the
// byte cap below, and it makes the recycler assertable on its own.
//
// WHY IT EXISTS: doUploadTile and evictGPUTiles together create + destroy 5+
// GPUBuffers per tile, several times per frame on mobile during fast
// pinch/pan. Each createBuffer / destroy is a GPU driver call, so pooling hands
// a freed buffer straight back to the next acquire instead of round-tripping
// through the driver. Buckets are powers of two from 2 KB → 4 MB, so size-fit
// reuse works across tiles with similar feature density.

/** Per-bucket ENTRY cap. Bounds how many buffers of one size are parked;
 *  `POOL_MAX_BYTES` is what bounds the bytes, which is the guarantee that
 *  actually matters. */
const CAP_PER_BUCKET = 16

/** Byte ceiling for the whole recycler (#1357).
 *
 *  The per-bucket COUNT cap does not bound bytes, and the expensive buckets are
 *  exactly the large ones: buckets 2 KB → 4 MB sum to ~8.4 MB, so 16 per bucket
 *  is ~134 MB of idle VRAM — and the pool key includes `usage`, so every
 *  usage-flag combination gets that ceiling independently. Nothing trimmed it
 *  either: release destroyed only on per-bucket overflow and the sole drain was
 *  teardown, so buffers parked by one transient spike (a deep-zoom pitch pass, a
 *  dense-city tile wave) stayed resident for the rest of the session.
 *
 *  16 MB is a ceiling, not a target. The pool only has to absorb the
 *  release→acquire delta across a frame or two; a full 256-tile turnover of
 *  line/index/outline buffers parks single-digit MB because those cluster in the
 *  small buckets. So this sits far above any realistic burst and an order of
 *  magnitude below the arithmetic worst case, and deliberately well under the
 *  poly INDEX arena (64 MB) — a recycler must not rival storage. It is chosen,
 *  not measured; byte-level pool telemetry (#1355) would let it be tuned from
 *  data rather than from reasoning. */
const POOL_MAX_BYTES = 16 * 1024 * 1024

function bucketSize(size: number): number {
  let bucket = 2048
  while (bucket < size) bucket *= 2
  return bucket
}

/** Minimal device seam — only what the pool needs, so tests need no GPU. */
export interface BufferPoolDevice {
  createBuffer(desc: GPUBufferDescriptor): GPUBuffer
}

export class GpuBufferPool {
  /** Keyed by `{powerOfTwoBucketSize}:{usage}`. */
  private readonly pools = new Map<string, GPUBuffer[]>()
  /** Bytes currently parked. Maintained incrementally by acquire/release rather
   *  than recomputed, so the trim stays O(1) on the hot release path. */
  private _bytes = 0

  constructor(private readonly device: BufferPoolDevice) {}

  /** Parked bytes — the accumulator the byte cap is enforced against. */
  get bytes(): number {
    return this._bytes
  }

  acquire(size: number, usage: GPUBufferUsageFlags, label: string): GPUBuffer {
    const bucket = bucketSize(size)
    const pool = this.pools.get(`${bucket}:${usage}`)
    if (pool && pool.length > 0) {
      const hit = pool.pop()!
      this._bytes -= hit.size
      return hit
    }
    return this.device.createBuffer({ size: bucket, usage, label })
  }

  release(buf: GPUBuffer | null | undefined): void {
    if (!buf) return
    const key = `${buf.size}:${buf.usage}`
    let pool = this.pools.get(key)
    if (!pool) {
      pool = []
      this.pools.set(key, pool)
    }
    if (pool.length >= CAP_PER_BUCKET) {
      buf.destroy()
      return
    }
    pool.push(buf)
    this._bytes += buf.size
    this.trimToBudget()
  }

  /** Destroy pooled buffers, LARGEST bucket first, until back under the ceiling.
   *
   *  Largest-first frees the most bytes per driver call, and the small buckets
   *  are where the reuse actually pays: a 4 MB buffer is parked by a rare
   *  dense-tile spike, while 2-16 KB line/index buffers churn every frame.
   *  Evicting by insertion order instead would spend the whole budget keeping
   *  one spike's giants resident and destroy the hot small ones. */
  private trimToBudget(): void {
    if (this._bytes <= POOL_MAX_BYTES) return
    // Buckets are powers of two, so ordering by the key's numeric prefix is
    // ordering by size. Only non-empty pools can yield anything.
    const byBucketDesc = [...this.pools.entries()]
      .filter(([, pool]) => pool.length > 0)
      .sort((a, b) => Number(b[0].split(':')[0]) - Number(a[0].split(':')[0]))
    for (const [, pool] of byBucketDesc) {
      while (pool.length > 0 && this._bytes > POOL_MAX_BYTES) {
        const victim = pool.pop()!
        this._bytes -= victim.size
        victim.destroy()
      }
      if (this._bytes <= POOL_MAX_BYTES) return
    }
  }

  /** Drain on teardown (#298): pooled buffers are standalone GPUBuffers, NOT
   *  arena slices, so the arena destroys do not reclaim them. Without this they
   *  leak until device loss across SPA map create/destroy cycles. */
  destroy(): void {
    for (const pool of this.pools.values()) for (const b of pool) b.destroy()
    this.pools.clear()
    this._bytes = 0
  }
}
