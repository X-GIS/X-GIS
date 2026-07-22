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
import type { RhiDevice, RhiSampler, RhiTextureView, RhiRenderPass } from '@xgis/engine'
import { fadeInstanceKey, fadeStableIdentity, type LabelFadeLedger } from '../text/label-fade'
import {
  holdoverDrawToEmit,
  makeBakeFrame,
  reprojectIconHoldover,
  type HoldoverBakeFrame,
  type MotionHoldoverCtx,
} from '../text/holdover-reproject'

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
 *  (size + teardown, plus one of two backend halves). Satisfied structurally by
 *  SpriteAtlasGPU (URL sprite atlas, both halves), HostSpriteAtlasGPU (#797, the
 *  WebGPU half) and HostSpriteAtlasRhi (#823, the WebGL2 half). */
export interface IconAtlasGpu {
  size(): { width: number; height: number }
  destroy(): void
  /** WebGPU half — the WebGPU icon path binds these. Optional (#1261) so the
   *  WebGL2-only host atlas twin (HostSpriteAtlasRhi, which carries the RHI half
   *  below instead) satisfies the type; the WebGPU draw fail-closes (skips) when
   *  absent, mirroring the RHI twins' own optionality. */
  ensure?(): GPUTexture | null
  getView?(): GPUTextureView | null
  readonly sampler?: GPUSampler
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
  /** Mapbox `icon-padding` (px) — collision-box padding around the icon AABB,
   *  scaled by dpr at the collision site. Defaulted to the spec value 2 in
   *  addIcon, so an absent property stays byte-identical to the old constant. */
  padding: number
  /** Mapbox `icon-text-fit` (#777 I-A) — stretch this icon's quad to the paired
   *  text bbox. `mode` selects the fitted axis; `pad` is [t,r,b,l] px added per
   *  side. Resolved to a physical-px quad override in prepare() once the paired
   *  bbox is known (pairKey → TextStage.getPairFitBoxes). Undefined = native
   *  sprite size. */
  fit?: { mode: 'width' | 'height' | 'both'; pad: [number, number, number, number] }
  /** Symbol fade — the paired TEXT's stable collisionId (label-fade.ts).
   *  pairKey cannot serve here (`pt${seq}` is per-frame); this id is
   *  pan-invariant, so the icon finds its text's fade record across
   *  prepares. Undefined (icon-only symbols, raw datasets, overlays) →
   *  no fade, byte-identical.
   *
   *  DOUBLES as the #417 collide-icon near-first Y-tie break (icon twin of
   *  text #728): being a tile-stable per-feature id, it makes the survivor of
   *  two same-screen-Y collide icons (a flat road's arrow chain) deterministic
   *  instead of dispatch-order (I/O) dependent. Same value serves both — the
   *  label's collisionId is what fade keys on AND what the collision pass needs. */
  fadeId?: string
}

/** #777 I-G — one inline label image to draw this frame. TextStage computed
 *  the absolute top-left `(x, y)` (physical px) from the shaped glyph run;
 *  IconStage resolves the sprite by `name` and draws it at natural CSS size
 *  (`sizeScale = dpr`) via the existing icon quad path. `wPx/hPx` are the
 *  intended draw size (informational — the renderer recomputes from the
 *  sprite + sizeScale, which equals wPx/hPx for the same sprite + dpr). */
export interface InlineImageDraw {
  name: string
  x: number
  y: number
  wPx: number
  hPx: number
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
      /** Mapbox `icon-padding` (px) — per-icon collision-box padding; absent
       *  keeps the spec default 2 (byte-identical to the old fixed constant). */
      padding?: number
      /** #1081 — MapLibre perspective distance attenuation for this anchor.
       *  Folded into the stored `sizeScale` so a far icon's draw quad AND its
       *  collision obstacle (both read `sizeScale`) shrink together — the icon
       *  sibling of the text label attenuation. Undefined → 1 (no attenuation). */
      perspScale?: number
      /** Mapbox `icon-text-fit` (#777 I-A) — stretch the quad to the paired text
       *  bbox; resolved in prepare() via the pairKey → getPairFitBoxes coupling. */
      fit?: { mode: 'width' | 'height' | 'both'; pad: [number, number, number, number] }
      /** Symbol fade — the paired text's stable collisionId (see PendingIcon). */
      fadeId?: string
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
      padding: opts.padding ?? 2,
      fit: opts.fit,
      fadeId: opts.fadeId,
    })
  }

  /** Iter 112 paired-symbol collision: source of REJECTED text-label
   *  pair-keys. Set by `setDroppedPairKeys()` from the map every
   *  frame after TextStage.prepare and BEFORE IconStage.prepare. */
  private droppedPairKeys: ReadonlySet<string> = new Set()
  setDroppedPairKeys(keys: ReadonlySet<string>): void {
    this.droppedPairKeys = keys
  }

  /** Symbol fade — TextStage's ledger, handed over by the label pass
   *  (mirror of the droppedPairKeys handoff). Icons only READ records
   *  (text placement is the single authority): a paired icon fades with
   *  its text, keyed by fadeId + the same dispatch-order occurrence
   *  scheme as the text side (fadeInstanceKey). Null / disabled →
   *  byte-identical legacy behaviour. */
  private fadeLedger: LabelFadeLedger | null = null
  setFadeLedger(ledger: LabelFadeLedger): void {
    this.fadeLedger = ledger
  }
  /** Last emitted draw per fade key — re-pushed while the record fades out
   *  after its source vanished from `pending` (tile unload). IconDraw is
   *  heap-owned (sprite/tint/fit refs are stable), so plain retention
   *  suffices — no clone needed (unlike the text side's arena payloads). */
  private readonly _fadeHoldover = new Map<string, IconDraw>()
  /** Bake frame per holdover key, for fade-out reprojection (holdover-reproject.ts). */
  private readonly _fadeHoldoverBake = new Map<string, HoldoverBakeFrame>()
  /** Per-prepare scratch: fadeId → occurrence count, and the fade keys this
   *  prepare actually emitted (so holdover skips live keys). */
  private readonly _fadeOcc = new Map<string, number>()
  private readonly _fadeEmitted = new Set<string>()

  /** #777 I-A — paired text bboxes (physical px) that TextStage laid out this
   *  frame, keyed by pairKey. Set by `setPairFitBoxes()` from the map every frame
   *  after TextStage.prepare and BEFORE IconStage.prepare (mirror of the
   *  droppedPairKeys handoff). prepare() reads it to stretch icon-text-fit quads.
   *  Because it is rebuilt from THIS frame's text layout (whose bbox re-keys on
   *  the zoom-dependent sizePx), a fitted icon never wraps a stale bbox. */
  private pairFitBox: ReadonlyMap<string, { w: number; h: number }> = new Map()
  setPairFitBoxes(boxes: ReadonlyMap<string, { w: number; h: number }>): void {
    this.pairFitBox = boxes
  }

  /** #777 I-G — inline images (Mapbox `["image",…]` in label text) that
   *  TextStage placed this frame, absolute physical px. Set by the map every
   *  frame after TextStage.prepare and BEFORE IconStage.prepare (mirror of
   *  setPairFitBoxes). prepare() draws each via the existing icon quad path
   *  and clears the list, so a stale placement can never redraw. */
  private inlineImages: readonly InlineImageDraw[] = []
  setInlineImagePlacements(images: readonly InlineImageDraw[]): void {
    this.inlineImages = images
  }

  /** Resolve sprite metadata for every pending icon and build the
   *  vertex buffer. Silently drops icons whose sprite isn't in the
   *  atlas (typo or atlas still loading); the user sees nothing
   *  rather than a console flood. Call once per frame BEFORE
   *  render(). */
  prepare(
    // Symbol fade: mirror of TextStage.prepare's holdoverOk — false when the
    // camera/canvas moved since the previous prepare (a held-over quad's
    // baked screen px would lie). Direct-stage callers default to true.
    holdoverOk: boolean = true,
    // Symbol fade: mirror of TextStage.prepare — reprojects a fade-out badge on
    // a similarity-safe prepare so it fades in place (holdover-reproject.ts).
    motionHoldover?: MotionHoldoverCtx,
  ): void {
    if (this._iconDump) this._iconDump = []
    // Symbol fade — per-prepare scratch reset. `ledger` is non-null only
    // when the handoff happened AND fading is enabled; every fade branch
    // below is gated on it, so the disabled path stays byte-identical.
    // `!= null` (not `!== null`): GPU-free harnesses drive prepare() on an
    // Object.create(IconStage.prototype) stub whose field initializers never
    // ran, so the field can be undefined there.
    const ledger = this.fadeLedger != null && this.fadeLedger.enabled ? this.fadeLedger : null
    if (ledger !== null) {
      this._fadeOcc.clear()
      this._fadeEmitted.clear()
    }
    // Symbol fade — this prepare's bake frame, stamped onto each holdover below
    // for a later fade-out reprojection (one refs copy per prepare).
    const bakeThisPrepare = makeBakeFrame(motionHoldover)
    // #777 I-G — inline label images draw even when NO icon-image was
    // dispatched (a label that is only text + an inline sprite), so the
    // fast-out must consider them too.
    if (this.pending.length === 0 && this.inlineImages.length === 0) {
      // Wholesale clear — no holdover emission (mirror of TextStage's
      // empty-prepare arm); dead records' clones drop on the next sweep.
      if (ledger !== null) {
        this._fadeHoldover.clear()
        this._fadeHoldoverBake.clear()
      }
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
    // #417 near-first (icon sibling of #1249) — decide which collide-icons
    // (symbol-placement:line arrows) survive their mutual overlap BEFORE the
    // emit loop, iterating NEAREST-first. The overlap pass is greedy first-
    // wins, so on a pitched view the label nearer the camera (larger anchorY)
    // must claim its box first or the far arrow occludes the near one — the
    // same wrong direction #1249 fixed for text. Equal-Y ties keep dispatch
    // order, so a flat/same-latitude row of arrows collides byte-identically
    // to the pre-fix pass. The verdict is keyed by pending index; the emit
    // loop reads `collideDropped` and keeps DRAW (painter) order in dispatch
    // order (survivors don't overlap, so their relative draw order is moot).
    // The two pre-collision skips (paired-text-dropped, sprite-missing) are
    // mirrored here so a dropped/absent icon never seeds a phantom blocker.
    const collideDropped = new Set<number>()
    {
      const collideOrder: number[] = []
      for (let i = 0; i < this.pending.length; i++)
        if (this.pending[i]!.collide) collideOrder.push(i)
      collideOrder.sort((a, b) => {
        const pa = this.pending[a]!
        const pb = this.pending[b]!
        if (pa.anchorY !== pb.anchorY) return pb.anchorY - pa.anchorY // near (larger Y) first
        // Y-tie (a flat road's arrow chain): a STABLE per-feature id decides,
        // so the survivor doesn't flip with tile-dispatch (I/O) order on pan —
        // the icon twin of text #728. `fadeId` (the paired text's collisionId,
        // threaded for symbol fade) doubles as that id — it's the same tile-
        // stable value the collision pass needs. Falls back to dispatch index
        // only when it is absent on either side (byte-identical to the pre-
        // determinism pass).
        const ca = pa.fadeId
        const cb = pb.fadeId
        if (ca !== undefined && cb !== undefined && ca !== cb) return ca < cb ? -1 : 1
        return a - b // stable: dispatch order
      })
      const placedBoxes: { minX: number; minY: number; maxX: number; maxY: number }[] = []
      for (const i of collideOrder) {
        const p = this.pending[i]!
        if (p.pairKey !== undefined && this.droppedPairKeys.has(p.pairKey)) continue
        const sprite = this.host.get(p.iconName)
        if (!sprite) continue
        const sizeScale = p.sizeScale * this.dpr
        const cdW = (sprite.width / sprite.pixelRatio) * sizeScale
        const cdH = (sprite.height / sprite.pixelRatio) * sizeScale
        const pad = p.padding * this.dpr // Mapbox icon-padding (default 2)
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
        if (overlaps) {
          collideDropped.add(i)
          continue
        }
        placedBoxes.push({ minX, minY, maxX, maxY })
      }
    }
    for (let idx = 0; idx < this.pending.length; idx++) {
      const p = this.pending[idx]!
      // Symbol fade: resolve this icon's instance key FIRST — occurrence
      // counting must see every dispatched icon (drops included) so the
      // indices stay aligned with the text side's per-shaped counter. The
      // near-first collide pre-pass above does NOT reorder emission (this
      // loop still walks dispatch order), so occurrences pair with the text
      // side exactly as before #1278.
      let fadeKey: string | undefined
      if (ledger !== null && p.fadeId !== undefined) {
        // #1254 fix: strip the zoom-varying invLayer prefix identically to the
        // text side (text-stage) so a paired text+icon still share one fade
        // record and neither blinks on a zoom-level tile swap.
        const fid = fadeStableIdentity(p.fadeId)
        const occ = this._fadeOcc.get(fid) ?? 0
        this._fadeOcc.set(fid, occ + 1)
        fadeKey = fadeInstanceKey(fid, occ)
      }
      // Iter 112: drop icon when its paired text label was collision-
      // rejected. Mirrors MapLibre's "text+icon as one symbol" rule.
      // Symbol fade: when that text is fading out, emit the badge once more with
      // the shared record so they fade as one. It is projected FRESH here
      // (p.anchorX/Y), so a similarity-safe motion is admissible with no
      // reprojection — fixes "badge pops on zoom while its text fades".
      if (p.pairKey !== undefined && this.droppedPairKeys.has(p.pairKey)) {
        if (!(
          fadeKey !== undefined &&
          ledger !== null &&
          (holdoverOk || motionHoldover !== undefined) &&
          ledger.isFadingOut(fadeKey)
        )) {
          continue
        }
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
      // #417 — line-icon overlap verdict decided near-first above; a
      // collide-icon dropped there is skipped here (point dots have
      // collide=false → never in the set → untouched, #419).
      if (p.collide && collideDropped.has(idx)) continue
      // #777 I-A — icon-text-fit: resolve the quad override from the paired text
      // bbox (physical px, laid out THIS frame by TextStage) + per-side padding
      // (CSS px → dpr). `width`/`height` fit only that axis (undefined leaves the
      // renderer's native drawW/drawH); `both` fits both. Asymmetric padding
      // shifts the fit-box centre by (right−left)/2, (bottom−top)/2. A fit icon
      // whose paired text was not laid out (dropped / absent) keeps native dims.
      let fit: IconDraw['fit']
      if (p.fit && p.pairKey !== undefined) {
        const box = this.pairFitBox.get(p.pairKey)
        if (box) {
          const [pt, pr, pb, pl] = p.fit.pad
          const fitW =
            p.fit.mode === 'width' || p.fit.mode === 'both'
              ? box.w + (pl + pr) * this.dpr
              : undefined
          const fitH =
            p.fit.mode === 'height' || p.fit.mode === 'both'
              ? box.h + (pt + pb) * this.dpr
              : undefined
          fit = {
            w: fitW,
            h: fitH,
            dx: fitW !== undefined ? ((pr - pl) * this.dpr) / 2 : 0,
            dy: fitH !== undefined ? ((pb - pt) * this.dpr) / 2 : 0,
          }
        }
      }
      // Symbol fade: attach the paired text's record (read-only — refOf
      // never creates). A never-placed text has no record ⇒ no fadeRef ⇒
      // the icon renders exactly as before.
      const fadeRef = fadeKey !== undefined && ledger !== null ? ledger.refOf(fadeKey) : undefined
      const draw: IconDraw = {
        anchorX: p.anchorX,
        anchorY: p.anchorY,
        sprite,
        sizeScale,
        rotateRad: p.rotateRad,
        anchor: p.anchor,
        opacity: p.opacity,
        tint: p.tint,
        ...(fit ? { fit } : {}),
        ...(fadeRef !== undefined ? { fadeRef } : {}),
      }
      draws.push(draw)
      if (fadeKey !== undefined) {
        this._fadeEmitted.add(fadeKey)
        if (fadeRef !== undefined) {
          this._fadeHoldover.set(fadeKey, draw)
          // Stamp the bake frame (clear it off the similarity-safe path).
          if (bakeThisPrepare !== null) this._fadeHoldoverBake.set(fadeKey, bakeThisPrepare)
          else this._fadeHoldoverBake.delete(fadeKey)
        }
      }
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
    // #777 I-G — inline label images. TextStage already positioned each quad
    // (absolute top-left, physical px), so no collision / anchor math here:
    // resolve the sprite from the SAME atlas the icons use and draw it at
    // natural CSS size (sizeScale = dpr ⟹ drawW = design px / pixelRatio ·
    // dpr = the advance TextStage reserved). anchor:'top-left' lands the quad
    // corner exactly at (x, y). A sprite missing here (present when TextStage
    // shaped, evicted since) is skipped — the text already drew.
    for (const im of this.inlineImages) {
      const sprite = this.host.get(im.name)
      if (!sprite) {
        if (atlasLoaded) this.missingIconNames.add(im.name)
        continue
      }
      if (atlasLoaded) this.dispatchedIconNames.add(im.name)
      draws.push({
        anchorX: im.x,
        anchorY: im.y,
        sprite,
        sizeScale: this.dpr,
        rotateRad: 0,
        anchor: 'top-left',
        opacity: 1,
      })
    }
    // Symbol fade: holdover — an icon whose source left `pending` keeps drawing
    // while the paired text fades. holdoverDrawToEmit draws as-is when idle,
    // reprojects on a similarity-safe zoom/pan, or drops it; then sweep prunes.
    if (ledger !== null) {
      for (const [k, held] of this._fadeHoldover) {
        if (this._fadeEmitted.has(k)) continue
        if (!ledger.isFadingOut(k)) continue
        const emit = holdoverDrawToEmit(
          held,
          this._fadeHoldoverBake.get(k),
          holdoverOk,
          motionHoldover,
          reprojectIconHoldover,
        )
        if (emit !== null) draws.push(emit)
      }
      for (const k of this._fadeHoldover.keys()) {
        if (ledger.refOf(k) === undefined) {
          this._fadeHoldover.delete(k)
          this._fadeHoldoverBake.delete(k)
        }
      }
    }
    this.renderer.setDraws(draws)
    this.pending = []
    this.inlineImages = []
  }

  /** Encode draw commands. No-op when nothing was prepared or the
   *  atlas hasn't loaded. `replay` (#1177) is the S16 skip-replay
   *  screen-space correction; omit on prepared frames. */
  render(
    pass: GPURenderPassEncoder | RhiRenderPass,
    viewport: { width: number; height: number },
    replay?: { scale: number; dx: number; dy: number },
  ): void {
    this.renderer.draw(pass, viewport, replay)
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
    this.inlineImages = []
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
