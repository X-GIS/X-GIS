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
import type { RhiDevice , RhiSampler, RhiTextureView , RhiRenderPass } from '@xgis/engine'

/** Minimal sprite-metadata read surface IconStage resolves icons through.
 *  Satisfied structurally by SpriteAtlasHost (URL sprite atlas) and by
 *  HostSpriteAtlasGPU (the host DRAWING API atlas, #797). Extracting it lets
 *  IconStage be built from an injected atlas instead of only a spriteUrl. */
export interface SpriteMetadataSource {
  get(name: string): SpriteInfo | undefined
  getState(): { status: 'idle' | 'loading' | 'loaded' | 'failed' }
  whenReady(): Promise<void>
  /** Fill-/line-pattern Stage-1 centre-pixel readback — only the URL
   *  SpriteAtlasHost implements it; the host DRAWING API atlas (#797) does
   *  not (host fill-pattern coexistence is Phase 1), so callers use `?.`. */
  getSpriteCenterColor?(name: string): [number, number, number, number] | null
}

/** Minimal GPU-atlas surface the icon + fill-pattern renderers consume
 *  (size/ensure/getView/sampler + teardown). Satisfied structurally by
 *  SpriteAtlasGPU (URL sprite atlas) and by HostSpriteAtlasGPU (#797). */
export interface IconAtlasGpu {
  size(): { width: number; height: number }
  ensure(): GPUTexture | null
  getView(): GPUTextureView | null
  readonly sampler: GPUSampler
  destroy(): void
  /** RHI twins (#834 M5 slice 4) — the WebGL2 icon path binds these; the
   *  host atlas twins (M0) and SpriteAtlasGPU implement them. Optional so a
   *  bespoke WebGPU-only atlas keeps compiling; the webgl2 draw fail-closes
   *  (skips) when absent. */
  rhiView?(): RhiTextureView | null
  rhiSampler?(): RhiSampler | null
}

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
  /** #417 — line-placement icon collision. When true, prepare() drops
   *  this icon if its box overlaps an already-placed collide-icon (icon-
   *  padding AABB). Used for symbol-placement:line icons (e.g. OFM
   *  road_oneway arrows) so two PARALLEL road features' overlapping
   *  arrows collapse to one chain like MapLibre, instead of drawing
   *  side-by-side. POINT-placement icons (the allow-overlap city dots)
   *  leave this false → never collision-dropped (preserves #419). */
  collide?: boolean
}

export class IconStage {
  readonly host: SpriteMetadataSource
  readonly gpu: IconAtlasGpu
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
  private _iconDump:
    | {
        name: string
        anchorX: number
        anchorY: number
        drawW: number
        drawH: number
        centerY: number
      }[]
    | null = null
  setIconDumpEnabled(on: boolean): void {
    this._iconDump = on ? [] : null
  }
  getDumpedIcons():
    | {
        name: string
        anchorX: number
        anchorY: number
        drawW: number
        drawH: number
        centerY: number
      }[]
    | null {
    return this._iconDump
  }
  /** iter-301 — per-icon dispatch debug hook. Symmetric to
   *  TextStage's `setLabelDebugHook` so a test harness can collect
   *  paired-symbol (icon + text) anchor coordinates and assert
   *  alignment per pairKey. Hook fires once per addIcon submission
   *  BEFORE the prepare() pass + sprite resolution; null = no hook. */
  private _iconDebugHook:
    | ((iconName: string, anchorX: number, anchorY: number, pairKey: string | undefined) => void)
    | null = null
  setIconDebugHook(
    hook:
      | ((iconName: string, anchorX: number, anchorY: number, pairKey: string | undefined) => void)
      | null,
  ): void {
    this._iconDebugHook = hook
  }

  constructor(
    device: GPUDevice,
    rhi: RhiDevice,
    presentationFormat: GPUTextureFormat,
    options: IconStageOptions | { hostAtlas: IconAtlasGpu & SpriteMetadataSource },
    sampleCount: number = 1,
  ) {
    if ('hostAtlas' in options) {
      // Host DRAWING API path (#797) — the injected atlas plays BOTH the
      // metadata-source and GPU roles. No SpriteAtlasHost fetch, no
      // SpriteAtlasGPU allocation.
      this.host = options.hostAtlas
      this.gpu = options.hostAtlas
    } else {
      // URL sprite path — byte-identical to the pre-#797 construction.
      const host = new SpriteAtlasHost({
        spriteUrl: options.spriteUrl,
        fetch: options.fetch,
        dpr: options.dpr ?? 1,
        onLanded: options.onLanded,
      })
      this.host = host
      this.gpu = new SpriteAtlasGPU(device, host, rhi)
    }
    this.renderer = new IconRenderer(device, rhi, this.gpu, presentationFormat, sampleCount)
  }

  /** Host DRAWING API construction form (#797 Phase 0). Builds an IconStage
   *  whose metadata + GPU atlas are the injected host atlas instead of a
   *  fetched URL sprite. The URL constructor path stays untouched. */
  static forHostAtlas(
    device: GPUDevice,
    rhi: RhiDevice,
    presentationFormat: GPUTextureFormat,
    hostAtlas: IconAtlasGpu & SpriteMetadataSource,
    sampleCount: number = 1,
  ): IconStage {
    return new IconStage(device, rhi, presentationFormat, { hostAtlas }, sampleCount)
  }

  setDpr(dpr: number): void {
    this.dpr = dpr > 0 ? dpr : 1
  }

  /** Submit one icon for the current frame. `anchorX/Y` are in
   *  physical px (engine-side projected). `iconName` keys into the
   *  sprite atlas — unknown names are dropped silently in prepare(). */
  addIcon(
    anchorX: number,
    anchorY: number,
    iconName: string,
    opts: {
      sizeScale?: number
      rotateRad?: number
      anchor?: IconAnchor
      opacity?: number
      tint?: [number, number, number]
      pairKey?: string
      collide?: boolean
      /** #1081 — MapLibre perspective distance attenuation for this anchor.
       *  Folded into the stored `sizeScale` so a far icon's draw quad AND its
       *  collision obstacle (both read `sizeScale`) shrink together — the icon
       *  sibling of the text label attenuation. Undefined → 1 (no attenuation). */
      perspScale?: number
    } = {},
  ): void {
    if (this._iconDebugHook) {
      this._iconDebugHook(iconName, anchorX, anchorY, opts.pairKey)
    }
    this.pending.push({
      anchorX,
      anchorY,
      iconName,
      sizeScale: (opts.sizeScale ?? 1) * (opts.perspScale ?? 1),
      rotateRad: opts.rotateRad ?? 0,
      anchor: opts.anchor ?? 'center',
      opacity: opts.opacity ?? 1,
      tint: opts.tint,
      pairKey: opts.pairKey,
      collide: opts.collide ?? false,
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
    // #417 — boxes of already-placed collide-icons (symbol-placement:line,
    // e.g. road_oneway arrows) for the per-frame overlap collision below.
    const placedBoxes: { minX: number; minY: number; maxX: number; maxY: number }[] = []
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
      // #417 — line-icon overlap collision. A symbol-placement:line icon
      // (collide=true) is dropped when its padded box overlaps an
      // already-placed collide-icon, so two parallel road features'
      // overlapping arrows collapse to one chain (MapLibre parity).
      // Zoom-invariant (tests actual icon boxes, not a fixed distance).
      // Only collide-icons are tested + recorded → point dots untouched (#419).
      if (p.collide) {
        const cdW = (sprite.width / sprite.pixelRatio) * sizeScale
        const cdH = (sprite.height / sprite.pixelRatio) * sizeScale
        const pad = 2 * this.dpr // Mapbox icon-padding default
        const minX = p.anchorX - cdW / 2 - pad,
          maxX = p.anchorX + cdW / 2 + pad
        const minY = p.anchorY - cdH / 2 - pad,
          maxY = p.anchorY + cdH / 2 + pad
        let overlaps = false
        for (const b of placedBoxes) {
          if (minX < b.maxX && maxX > b.minX && minY < b.maxY && maxY > b.minY) {
            overlaps = true
            break
          }
        }
        if (overlaps) continue
        placedBoxes.push({ minX, minY, maxX, maxY })
      }
      draws.push({
        anchorX: p.anchorX,
        anchorY: p.anchorY,
        sprite,
        sizeScale,
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
        const cy =
          a === 'top' || a === 'top-left' || a === 'top-right'
            ? p.anchorY + drawH / 2
            : a === 'bottom' || a === 'bottom-left' || a === 'bottom-right'
              ? p.anchorY - drawH / 2
              : p.anchorY
        this._iconDump.push({
          name: p.iconName,
          anchorX: p.anchorX,
          anchorY: p.anchorY,
          drawW,
          drawH,
          centerY: cy,
        })
      }
    }
    this.renderer.setDraws(draws)
    this.pending = []
  }

  /** Encode draw commands. No-op when nothing was prepared or the
   *  atlas hasn't loaded. */
  render(
    pass: GPURenderPassEncoder | RhiRenderPass,
    viewport: { width: number; height: number },
  ): void {
    this.renderer.draw(pass, viewport)
  }

  /** Screen bboxes of the pending icons, for the text-collision pass (#609).
   *  MapLibre inserts every placed icon box into the shared collision grid
   *  (placement.ts placeCollisionBox) so later labels avoid it; X-GIS runs
   *  text + icon stages separately, so the label pass calls this BEFORE
   *  TextStage.prepare and seeds the boxes as collision obstacles.
   *  Mirrors prepare()'s sprite + drawW/drawH/anchor math.
   *  groupKey = pairKey so a paired icon never blocks its OWN text.
   *  Icons whose sprite isn't resolved yet are omitted (they don't draw,
   *  so they don't block). Only icons with collide=true act as obstacles
   *  (matching the icons that participate in the collision grid).
   *
   *  #609 over-drop fix — `activeTextPairKeys` is the set of pairKeys whose
   *  text label has a LIVE bbox in this frame's text-collision pass
   *  (TextStage.getActiveTextPairKeys). A collide icon whose pairKey is in
   *  that set is SKIPPED here: its paired text already represents the symbol
   *  in the grid (and groupKey exempts the pair from each other). If the text
   *  wins, its own bbox blocks other labels; if it loses, the icon is dropped
   *  via droppedPairKeys. Seeding the icon's box too would let a to-be-dropped
   *  paired icon block a different-group label — a valid label dropped to
   *  avoid an icon that never renders. An icon-only / empty-text paired symbol
   *  is ABSENT from the set (TextStage skips empty text), so it still seeds its
   *  obstacle — preserving #609's separate-feature blocking. */
  computeObstacles(
    activeTextPairKeys: ReadonlySet<string> = new Set(),
  ): { bbox: { minX: number; minY: number; maxX: number; maxY: number }; groupKey?: string }[] {
    const out: {
      bbox: { minX: number; minY: number; maxX: number; maxY: number }
      groupKey?: string
    }[] = []
    for (const p of this.pending) {
      if (!p.collide) continue
      // Skip icons whose paired text is live in the collision pass — that
      // text bbox already blocks; the icon box would phantom-over-drop.
      if (p.pairKey !== undefined && activeTextPairKeys.has(p.pairKey)) continue
      const sprite = this.host.get(p.iconName)
      if (!sprite) continue
      const sizeScale = p.sizeScale * this.dpr
      const drawW = (sprite.width / sprite.pixelRatio) * sizeScale
      const drawH = (sprite.height / sprite.pixelRatio) * sizeScale
      const a = p.anchor ?? 'center'
      const cx =
        a === 'left' || a === 'top-left' || a === 'bottom-left'
          ? p.anchorX + drawW / 2
          : a === 'right' || a === 'top-right' || a === 'bottom-right'
            ? p.anchorX - drawW / 2
            : p.anchorX
      const cy =
        a === 'top' || a === 'top-left' || a === 'top-right'
          ? p.anchorY + drawH / 2
          : a === 'bottom' || a === 'bottom-left' || a === 'bottom-right'
            ? p.anchorY - drawH / 2
            : p.anchorY
      out.push({
        bbox: {
          minX: cx - drawW / 2,
          minY: cy - drawH / 2,
          maxX: cx + drawW / 2,
          maxY: cy + drawH / 2,
        },
        groupKey: p.pairKey,
      })
    }
    return out
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
  whenReady(): Promise<void> {
    return this.host.whenReady()
  }

  /** Look up sprite metadata directly — exposed for collision /
   *  text-icon-fit code paths that need an icon's design size before
   *  the draw is queued. */
  getSprite(name: string): SpriteInfo | undefined {
    return this.host.get(name)
  }

  /** Diagnostic: every icon name the style referenced that the atlas
   *  didn't have AFTER it loaded. Useful for pinpointing sprite-
   *  atlas mismatches (style says `school`; atlas has `school_11`).
   *  Returns a fresh array so the caller can hold onto it across
   *  frame boundaries. */
  getMissingIconNames(): string[] {
    return [...this.missingIconNames].sort()
  }

  /** Reset the missing-icon diagnostic (tests that drive the stage
   *  through multiple atlas-load cycles). */
  clearMissingIconNames(): void {
    this.missingIconNames.clear()
  }

  /** Iter 532 sibling — icon names successfully dispatched. */
  getDispatchedIconNames(): string[] {
    return [...this.dispatchedIconNames].sort()
  }
  clearDispatchedIconNames(): void {
    this.dispatchedIconNames.clear()
  }

  /** Iter 533 sibling — last frame's actual GPU-submitted icon count.
   *  `getDispatchedIconNames()` is cumulative across all frames and
   *  proves nothing about the CURRENT screen state. This returns the
   *  vertex-buffer-derived draw count from the most recent
   *  `prepare()`. Zero here despite a non-empty dispatched set means
   *  "shields rendered earlier; the screenshot frame had no pending
   *  addIcons" — likely a tile-cache / feature-iteration race. */
  getLastDrawIconCount(): number {
    return this.renderer.vertexCount / 6
  }

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
