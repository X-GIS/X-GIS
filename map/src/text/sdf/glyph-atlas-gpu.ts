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
import type { RhiDevice, RhiSampler, RhiTexture, RhiTextureView } from '@xgis/engine'

export interface GlyphAtlasGPUOptions {
  /** Side length in pixels of each atlas page. Must match the
   *  `pageSize` configured on the GlyphAtlasHost. */
  pageSize: number
  /** Optional debug label prefix on each created texture. */
  label?: string
}

export class GlyphAtlasGPU {
  private readonly rhi: RhiDevice
  private readonly host: GlyphAtlasHost
  private readonly pageSize: number
  private readonly label: string
  private readonly pages: RhiTexture[] = []
  private readonly views: RhiTextureView[] = []
  /** Sampler shared by all atlas reads. Linear magnify so SDF upscales
   *  smoothly; clamp-to-edge (both backends' RHI sampler convention) so a
   *  near-edge sample never bleeds into a neighbouring slot. Backend-blind
   *  since #834 M5 slice 3 — on WebGPU rhi.createSampler IS
   *  device.createSampler with the same (default) clamp addressing. */
  readonly sampler: RhiSampler

  constructor(rhi: RhiDevice, host: GlyphAtlasHost, opts: GlyphAtlasGPUOptions) {
    this.rhi = rhi
    this.host = host
    this.pageSize = opts.pageSize
    this.label = opts.label ?? 'glyph-atlas'
    this.sampler = rhi.createSampler({
      mag: 'linear',
      min: 'linear',
      label: `${this.label}-sampler`,
    })
  }

  /** GPUTexture for the given page, or undefined if not allocated.
   *  The renderer uses page 0 for now (multi-page extends naturally
   *  once the host needs it). */
  getPage(index: number): RhiTexture | undefined {
    return this.pages[index]
  }

  /** Cached RHI view for a page — one createView per page, not per frame. */
  pageView(index: number): RhiTextureView | undefined {
    const tex = this.pages[index]
    if (!tex) return undefined
    return (this.views[index] ??= this.rhi.createView(tex))
  }
  get pageCount(): number {
    return this.pages.length
  }
  /** Page side length in pixels (all pages are square and same-sized). */
  get pageSizePx(): number {
    return this.pageSize
  }

  /** Allocate a new page texture. Lazy — the host calls this when
   *  its own pageCount grows. */
  addPage(): void {
    const tex = this.rhi.createTexture({
      width: this.pageSize,
      height: this.pageSize,
      format: 'r8unorm',
      usage: ['sample', 'copy-dst'],
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
      this.rhi.writeTexture(
        tex,
        d.sdf,
        d.slot.size,
        d.slot.size,
        d.slot.size,
        d.slot.pxX,
        d.slot.pxY,
      )
    }
    return dirty.length
  }

  destroy(): void {
    for (const tex of this.pages) this.rhi.destroyTexture(tex)
    this.pages.length = 0
    this.views.length = 0
  }
}
