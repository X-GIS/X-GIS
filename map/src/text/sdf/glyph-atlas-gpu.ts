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
// SINGLE PAGE, by contract (#1580): AtlasState.allocatePage() is reachable
// only while both its free-slot stack AND its entry map are empty, which by
// construction (freeSlots + entries == pageCount * slotsPerPage, and nothing
// ever clears `entries`) is true exactly once, before the first page — every
// miss past that point evicts instead of growing. `host.state.pageCount` can
// therefore never exceed 1; `ensurePage()` below asserts that invariant
// rather than silently looping/defending against a page count this class can
// never actually see.

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
  /** At most one entry — see the SINGLE PAGE contract above. */
  private page?: RhiTexture
  private view?: RhiTextureView
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

  /** GPUTexture for the given page, or undefined if not allocated yet.
   *  `index` must be 0 — see the SINGLE PAGE contract above. */
  getPage(index: number): RhiTexture | undefined {
    if (index !== 0)
      throw new Error(`GlyphAtlasGPU: page ${index} requested — atlas is single-page`)
    return this.page
  }

  /** Cached RHI view for the page — one createView call, not per frame. */
  pageView(index: number): RhiTextureView | undefined {
    if (index !== 0)
      throw new Error(`GlyphAtlasGPU: page ${index} requested — atlas is single-page`)
    if (!this.page) return undefined
    return (this.view ??= this.rhi.createView(this.page))
  }
  get pageCount(): number {
    return this.page ? 1 : 0
  }
  /** Page side length in pixels. */
  get pageSizePx(): number {
    return this.pageSize
  }

  /** Allocate the page texture. Lazy — called once, from `flush()`'s first
   *  dirty glyph. Asserts the single-page contract rather than looping over
   *  `host.state.pageCount`: that count can never exceed 1 (see above), so a
   *  second call — or any `host.state.pageCount` above 1 — is a broken
   *  invariant, not a growth case to handle silently. */
  private ensurePage(): RhiTexture {
    if (this.host.state.pageCount > 1) {
      throw new Error(
        `GlyphAtlasGPU: host reports pageCount=${this.host.state.pageCount} — ` +
          'AtlasState is contracted to never grow past one page (#1580)',
      )
    }
    if (!this.page) {
      this.page = this.rhi.createTexture({
        width: this.pageSize,
        height: this.pageSize,
        format: 'r8unorm',
        usage: ['sample', 'copy-dst'],
        label: `${this.label}-page-0`,
      })
    }
    return this.page
  }

  /** Drain the host's dirty queue and upload each new SDF to the
   *  texture at its slot position. Call once per frame BEFORE the
   *  text-renderer's draw — guarantees every referenced glyph is
   *  resident on the GPU.
   *
   *  Returns the count of glyphs uploaded so the caller can log
   *  perf in dev / surface a "fonts still loading" indicator. */
  flush(): number {
    const dirty = this.host.consumeDirty()
    if (dirty.length === 0) return 0

    const tex = this.ensurePage()
    for (const d of dirty) {
      if (d.slot.page !== 0) {
        throw new Error(
          `GlyphAtlasGPU: glyph slot targets page ${d.slot.page} — atlas is single-page`,
        )
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
    if (this.page) this.rhi.destroyTexture(this.page)
    this.page = undefined
    this.view = undefined
  }
}
