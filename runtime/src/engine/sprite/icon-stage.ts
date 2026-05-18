// Icon Stage — orchestration layer over SpriteAtlasHost + GPU upload
// + IconRenderer. Mirrors TextStage's role for SDF text.
//
// Per-frame contract:
//   1. addIcon(anchorX, anchorY, iconName, options)   — N times
//   2. prepare()                                       — builds draws
//   3. render(pass, viewport)                          — encodes draw

import { SpriteAtlasHost, type SpriteInfo } from './sprite-atlas-host'
import { SpriteAtlasGPU } from './sprite-atlas-gpu'
import { IconRenderer, type IconDraw, type IconAnchor } from './icon-renderer'

export interface IconStageOptions {
  spriteUrl: string
  /** Device pixel ratio — affects whether to try `@2x` sprite first. */
  dpr?: number
  /** Optional fetch override (tests). */
  fetch?: typeof globalThis.fetch
}

interface PendingIcon {
  anchorX: number
  anchorY: number
  iconName: string
  sizeScale: number
  rotateRad: number
  anchor: IconAnchor
  opacity: number
}

export class IconStage {
  readonly host: SpriteAtlasHost
  readonly gpu: SpriteAtlasGPU
  readonly renderer: IconRenderer
  private pending: PendingIcon[] = []
  private dpr: number = 1
  /** Diagnostic tracker — icon names the style references that
   *  weren't found in the atlas AFTER it loaded. Helps surface
   *  sprite-atlas mismatches (the OFM `school` marker case from
   *  the iter 510 pixel-match baseline). The Set survives across
   *  frames; clear via `clearMissingIconNames()` between tests. */
  private missingIconNames: Set<string> = new Set()
  /** Diagnostic counterpart — icon names the style ACTUALLY
   *  dispatched (atlas resolved). Set rather than counter so the
   *  test can answer "which names rendered" rather than "how
   *  many". Iter 532 added to distinguish "shield filter rejected
   *  all features" from "shield resolved but render path broken"
   *  in the OFM bright-texas-shields view. */
  private dispatchedIconNames: Set<string> = new Set()

  constructor(
    device: GPUDevice,
    presentationFormat: GPUTextureFormat,
    options: IconStageOptions,
    sampleCount: number = 1,
  ) {
    this.host = new SpriteAtlasHost({
      spriteUrl: options.spriteUrl,
      fetch: options.fetch,
      dpr: options.dpr ?? 1,
    })
    this.gpu = new SpriteAtlasGPU(device, this.host)
    this.renderer = new IconRenderer(device, this.gpu, presentationFormat, sampleCount)
  }

  setDpr(dpr: number): void { this.dpr = dpr > 0 ? dpr : 1 }

  /** Submit one icon for the current frame. `anchorX/Y` are in
   *  physical px (engine-side projected). `iconName` keys into the
   *  sprite atlas — unknown names are dropped silently in prepare(). */
  addIcon(
    anchorX: number, anchorY: number, iconName: string,
    opts: { sizeScale?: number; rotateRad?: number; anchor?: IconAnchor; opacity?: number } = {},
  ): void {
    this.pending.push({
      anchorX, anchorY, iconName,
      sizeScale: opts.sizeScale ?? 1,
      rotateRad: opts.rotateRad ?? 0,
      anchor: opts.anchor ?? 'center',
      opacity: opts.opacity ?? 1,
    })
  }

  /** Resolve sprite metadata for every pending icon and build the
   *  vertex buffer. Silently drops icons whose sprite isn't in the
   *  atlas (typo or atlas still loading); the user sees nothing
   *  rather than a console flood. Call once per frame BEFORE
   *  render(). */
  prepare(): void {
    if (this.pending.length === 0) {
      this.renderer.setDraws([])
      return
    }
    // The host may still be loading; ensure() returns null and the
    // renderer's draw() will no-op. We still build draws so as soon
    // as the atlas lands the next frame picks them up — but if
    // metadata isn't there yet, EVERY icon misses and we just skip.
    const draws: IconDraw[] = []
    // Track missing names ONLY when the atlas is in the terminal
    // 'loaded' state — during 'loading' / 'idle' / 'failed' every
    // lookup misses for orthogonal reasons (no atlas in memory).
    // Treating those as missing would flood the diagnostic with
    // false positives during cold-start.
    const atlasLoaded = this.host.getState().status === 'loaded'
    for (const p of this.pending) {
      const sprite = this.host.get(p.iconName)
      if (!sprite) {
        if (atlasLoaded) this.missingIconNames.add(p.iconName)
        continue
      }
      if (atlasLoaded) this.dispatchedIconNames.add(p.iconName)
      // Mapbox icon-size scaling already applies; DPR scaling layered
      // on top so a "1.0" icon-size looks the same physical size on
      // hidpi displays as the design intent.
      const sizeScale = p.sizeScale * this.dpr
      draws.push({
        anchorX: p.anchorX, anchorY: p.anchorY,
        sprite, sizeScale,
        rotateRad: p.rotateRad,
        anchor: p.anchor,
        opacity: p.opacity,
      })
    }
    this.renderer.setDraws(draws)
    this.pending = []
  }

  /** Encode draw commands. No-op when nothing was prepared or the
   *  atlas hasn't loaded. */
  render(pass: GPURenderPassEncoder, viewport: { width: number; height: number }): void {
    this.renderer.draw(pass, viewport)
  }

  /** Async-ready hook — resolves once the atlas reaches a terminal
   *  state (loaded OR failed). Useful for callers who want to suppress
   *  the first frame until icons are available. Failure does NOT
   *  reject — caller probes `host.getState()` if it wants to know. */
  whenReady(): Promise<void> { return this.host.whenReady() }

  /** Look up sprite metadata directly — exposed for collision /
   *  text-icon-fit code paths that need an icon's design size before
   *  the draw is queued. */
  getSprite(name: string): SpriteInfo | undefined { return this.host.get(name) }

  /** Diagnostic: every icon name the style referenced that the atlas
   *  didn't have AFTER it loaded. Useful for pinpointing sprite-
   *  atlas mismatches (style says `school`; atlas has `school_11`).
   *  Returns a fresh array so the caller can hold onto it across
   *  frame boundaries. */
  getMissingIconNames(): string[] { return [...this.missingIconNames].sort() }

  /** Reset the missing-icon diagnostic (tests that drive the stage
   *  through multiple atlas-load cycles). */
  clearMissingIconNames(): void { this.missingIconNames.clear() }

  /** Iter 532 sibling — icon names successfully dispatched. */
  getDispatchedIconNames(): string[] { return [...this.dispatchedIconNames].sort() }
  clearDispatchedIconNames(): void { this.dispatchedIconNames.clear() }

  destroy(): void {
    this.renderer.destroy()
    this.gpu.destroy()
  }
}
