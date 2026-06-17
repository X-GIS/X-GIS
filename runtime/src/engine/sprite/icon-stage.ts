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
  /** Re-arm hook fired when the sprite atlas reaches a terminal state, so an
   *  idle map repaints the just-landed icons / fill-patterns. */
  onLanded?: () => void
}

interface PendingIcon {
  anchorX: number
  anchorY: number
  iconName: string
  sizeScale: number
  rotateRad: number
  anchor: IconAnchor
  opacity: number
  /** Mapbox `icon-color` SDF tint, sRGB 0..1. Undefined = white
   *  (identity); only applied to SDF sprites by the renderer. */
  tint?: [number, number, number]
  /** Iter 112 paired-symbol collision: identifier shared with the
   *  matching text label dispatched at the SAME line-walk anchor.
   *  Before prepare() emits the draw, IconStage checks against
   *  TextStage.getDroppedPairKeys() and drops icons whose paired
   *  text was collision-rejected. */
  pairKey?: string
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
  /** iter-343 — per-frame icon placement dump (debug-labels page).
   *  Captures the resolved draw box (anchor + drawW/drawH) of every
   *  prepared icon so the on-device analyzer can compare a paired
   *  shield's box centre against its text label centre (the "라벨이랑
   *  흰색 박스가 안맞아요" class). Refreshed each prepare(); null when
   *  capture is disabled (default off — zero overhead). */
  private _iconDump: { name: string; anchorX: number; anchorY: number; drawW: number; drawH: number; centerY: number }[] | null = null
  setIconDumpEnabled(on: boolean): void { this._iconDump = on ? [] : null }
  getDumpedIcons(): { name: string; anchorX: number; anchorY: number; drawW: number; drawH: number; centerY: number }[] | null { return this._iconDump }
  /** iter-301 — per-icon dispatch debug hook. Symmetric to
   *  TextStage's `setLabelDebugHook` so a test harness can collect
   *  paired-symbol (icon + text) anchor coordinates and assert
   *  alignment per pairKey. Hook fires once per addIcon submission
   *  BEFORE the prepare() pass + sprite resolution; null = no hook. */
  private _iconDebugHook: ((iconName: string, anchorX: number, anchorY: number, pairKey: string | undefined) => void) | null = null
  setIconDebugHook(hook: ((iconName: string, anchorX: number, anchorY: number, pairKey: string | undefined) => void) | null): void {
    this._iconDebugHook = hook
  }

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
      onLanded: options.onLanded,
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
    opts: { sizeScale?: number; rotateRad?: number; anchor?: IconAnchor; opacity?: number; tint?: [number, number, number]; pairKey?: string } = {},
  ): void {
    if (this._iconDebugHook) {
      this._iconDebugHook(iconName, anchorX, anchorY, opts.pairKey)
    }
    this.pending.push({
      anchorX, anchorY, iconName,
      sizeScale: opts.sizeScale ?? 1,
      rotateRad: opts.rotateRad ?? 0,
      anchor: opts.anchor ?? 'center',
      opacity: opts.opacity ?? 1,
      tint: opts.tint,
      pairKey: opts.pairKey,
    })
  }

  /** Iter 112 paired-symbol collision: source of REJECTED text-label
   *  pair-keys. Set by `setDroppedPairKeys()` from the map every
   *  frame after TextStage.prepare and BEFORE IconStage.prepare. */
  private droppedPairKeys: ReadonlySet<string> = new Set()
  setDroppedPairKeys(keys: ReadonlySet<string>): void {
    this.droppedPairKeys = keys
  }

  /** Resolve sprite metadata for every pending icon and build the
   *  vertex buffer. Silently drops icons whose sprite isn't in the
   *  atlas (typo or atlas still loading); the user sees nothing
   *  rather than a console flood. Call once per frame BEFORE
   *  render(). */
  prepare(): void {
    if (this._iconDump) this._iconDump = []
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
      // Iter 112: drop icon when its paired text label was collision-
      // rejected. Mirrors MapLibre's "text+icon as one symbol" rule.
      if (p.pairKey !== undefined && this.droppedPairKeys.has(p.pairKey)) {
        continue
      }
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
        tint: p.tint,
      })
      if (this._iconDump) {
        const drawW = (sprite.width / sprite.pixelRatio) * sizeScale
        const drawH = (sprite.height / sprite.pixelRatio) * sizeScale
        const a = p.anchor ?? 'center'
        // vertical centre of the rendered box relative to nothing — the
        // SAME geometry icon-renderer uses (anchorOffset). center/left/
        // right centre on anchorY; top* below; bottom* above.
        const cy = a === 'top' || a === 'top-left' || a === 'top-right' ? p.anchorY + drawH / 2
          : a === 'bottom' || a === 'bottom-left' || a === 'bottom-right' ? p.anchorY - drawH / 2
          : p.anchorY
        this._iconDump.push({ name: p.iconName, anchorX: p.anchorX, anchorY: p.anchorY, drawW, drawH, centerY: cy })
      }
    }
    this.renderer.setDraws(draws)
    this.pending = []
  }

  /** Encode draw commands. No-op when nothing was prepared or the
   *  atlas hasn't loaded. */
  render(pass: GPURenderPassEncoder, viewport: { width: number; height: number }): void {
    this.renderer.draw(pass, viewport)
  }

  /** Drop the pending icon queue without preparing. `prepare()` normally
   *  clears `pending` at its tail; the label pass calls this every frame so a
   *  frame that SKIPS `prepare()` (S16 collision skip) cannot leak dispatched
   *  icons into the next prepared set. The renderer's draws are untouched, so
   *  a skipped frame replays the previous prepare's icons. */
  reset(): void {
    this.pending = []
  }

  /** True once the sprite atlas fetch has reached a TERMINAL state (loaded or
   *  failed) — i.e. no further icon-resolution change can arrive. The label
   *  pass reads this to decide the S16 prepare-skip is safe: while the atlas is
   *  still 'loading'/'idle', a skip would freeze the frame before icons resolve,
   *  so the caller must keep preparing until this returns true. */
  isAtlasTerminal(): boolean {
    const s = this.host.getState().status
    return s === 'loaded' || s === 'failed'
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

  /** Iter 533 sibling — last frame's actual GPU-submitted icon count.
   *  `getDispatchedIconNames()` is cumulative across all frames and
   *  proves nothing about the CURRENT screen state. This returns the
   *  vertex-buffer-derived draw count from the most recent
   *  `prepare()`. Zero here despite a non-empty dispatched set means
   *  "shields rendered earlier; the screenshot frame had no pending
   *  addIcons" — likely a tile-cache / feature-iteration race. */
  getLastDrawIconCount(): number { return this.renderer.vertexCount / 6 }

  /** Iter 534 — first vertex of the most recent setDraws (pos_px_xy,
   *  uv, opacity) + last-known atlas dimensions. Lets the diagnostic
   *  verify that vertex positions land on-screen AND UVs sit inside
   *  the atlas. Returns null when no draw has been recorded. */
  getLastDrawSample(): {
    firstVertex: [number, number, number, number, number] | null
    atlasSize: { width: number; height: number } | null
    vertexBBox: { minX: number; minY: number; maxX: number; maxY: number } | null
    drawViewport: { width: number; height: number } | null
  } {
    return {
      firstVertex: this.renderer.firstVertexSample,
      atlasSize: this.renderer.lastAtlasSize,
      vertexBBox: this.renderer.lastVertexBBox,
      drawViewport: this.renderer.lastDrawViewport,
    }
  }

  destroy(): void {
    this.renderer.destroy()
    this.gpu.destroy()
  }
}
