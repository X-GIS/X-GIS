// ═══════════════════════════════════════════════════════════════════
// Glyph Atlas GPU Wrapper (Batch 1c-6e)
// ═══════════════════════════════════════════════════════════════════
//
// Holds the GPU texture(s) backing the atlas pages and drains
// GlyphAtlasHost.consumeDirty() into writeTexture calls. Tiny —
// the orchestration lives in GlyphAtlasHost; this wrapper is just
// the GPU edge.
//
// Format: R8Unorm — 1 byte per pixel matching the SDF byte. The
// shader samples the single-channel value and thresholds at 192/255
// for the glyph fill, with optional smoothstep for halo.
//
// Multi-page is plumbed but bounded: currently each call to
// `flush()` handles whatever pages already exist; growing past the
// initial page count requires `addPage()` (the renderer can
// pre-allocate based on expected glyph count, or wait for the
// host's pageCount to grow and call addPage on demand).

import type { GlyphAtlasHost } from './glyph-atlas-host'

export interface GlyphAtlasGPUOptions {
  /** Side length in pixels of each atlas page. Must match the
   *  `pageSize` configured on the GlyphAtlasHost. */
  pageSize: number
  /** Optional debug label prefix on each created texture. */
  label?: string
}

export class GlyphAtlasGPU {
  private readonly device: GPUDevice
  private readonly host: GlyphAtlasHost
  private readonly pageSize: number
  private readonly label: string
  private readonly pages: GPUTexture[] = []
  /** Sampler shared by all atlas reads. Linear magnify so SDF
   *  upscales smoothly; clamp-to-edge so a near-edge sample never
   *  bleeds into a neighbouring slot. */
  readonly sampler: GPUSampler

  constructor(device: GPUDevice, host: GlyphAtlasHost, opts: GlyphAtlasGPUOptions) {
    this.device = device
    this.host = host
    this.pageSize = opts.pageSize
    this.label = opts.label ?? 'glyph-atlas'
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      label: `${this.label}-sampler`,
    })
  }

  /** GPUTexture for the given page, or undefined if not allocated.
   *  The renderer uses page 0 for now (multi-page extends naturally
   *  once the host needs it). */
  getPage(index: number): GPUTexture | undefined { return this.pages[index] }
  get pageCount(): number { return this.pages.length }

  /** Allocate a new page texture. Lazy — the host calls this when
   *  its own pageCount grows. */
  addPage(): void {
    const tex = this.device.createTexture({
      size: { width: this.pageSize, height: this.pageSize },
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: `${this.label}-page-${this.pages.length}`,
    })
    this.pages.push(tex)
  }

  /** Drain the host's dirty queue and upload each new SDF to the
   *  texture at its slot position. Call once per frame BEFORE the
   *  text-renderer's draw — guarantees every referenced glyph is
   *  resident on the GPU.
   *
   *  Returns the count of glyphs uploaded so the caller can log
   *  perf in dev / surface a "fonts still loading" indicator. */
  flush(): number {
    // Make sure we have enough pages allocated for whatever the host
    // grew into (e.g. via prewarm before the GPU wrapper saw it).
    while (this.pages.length < this.host.state.pageCount) this.addPage()

    const dirty = this.host.consumeDirty()
    if (dirty.length === 0) return 0

    for (const d of dirty) {
      const tex = this.pages[d.slot.page]
      if (!tex) {
        // Host outpaced us — defensive page alloc, then continue.
        // Shouldn't happen in normal flow because we synced above.
        this.addPage()
        continue
      }
      this.device.queue.writeTexture(
        { texture: tex, origin: { x: d.slot.pxX, y: d.slot.pxY } },
        d.sdf,
        { bytesPerRow: d.slot.size },
        { width: d.slot.size, height: d.slot.size },
      )
    }
    return dirty.length
  }

  destroy(): void {
    for (const tex of this.pages) tex.destroy()
    this.pages.length = 0
  }
}
