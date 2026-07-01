// Sprite atlas — fetches the JSON metadata + PNG raster declared by
// a Mapbox/MapLibre style's top-level `sprite` field, then exposes
// per-icon UV/size lookups to the rendering pipeline.
//
// The Mapbox sprite protocol:
//   GET  ${spriteUrl}.json   →  { [iconName]: { x, y, width, height,
//                                                pixelRatio?, sdf? } }
//   GET  ${spriteUrl}.png    →  raster atlas, indexed by JSON x/y
//
// We follow the same load-once-then-sync-lookup pattern as
// GlyphPbfCache: kick off a single fetch on construction, expose
// `whenReady()` for orchestrators that need to await, and serve
// `get()` synchronously after that. Failures (offline / 404 / CORS)
// resolve to a "loaded but empty" state — the rasterizer pipeline
// can decide to skip icons silently rather than crash.

import { assertSafeRemoteUrl, readBodyCapped, safeFetch } from '@xgis/shared'

/** DoS ceilings for sprite assets — an atlas PNG is a few MB at most; the
 *  JSON metadata far less. Generous, but bound a size-bomb. */
const MAX_SPRITE_PNG_BYTES = 32 * 1024 * 1024
const MAX_SPRITE_JSON_BYTES = 16 * 1024 * 1024

export interface SpriteInfo {
  name: string
  /** Top-left of icon in the atlas PNG, in atlas pixels. */
  x: number
  y: number
  /** Width / height in atlas pixels. For pixelRatio > 1 sprites the
   *  raster is 2× the design size — the renderer divides by
   *  pixelRatio when computing display size. */
  width: number
  height: number
  pixelRatio: number
  /** SDF sprites can be tinted via `icon-color`; raster sprites
   *  render as-is. */
  sdf: boolean
}

export type SpriteAtlasState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; metadata: Map<string, SpriteInfo>; image: ImageBitmap | HTMLImageElement }
  | { status: 'failed' }

export interface SpriteAtlasHostOptions {
  spriteUrl: string
  /** Optional fetch override — primarily for tests. */
  fetch?: typeof globalThis.fetch
  /** When the device DPR is ≥ 1.5, the host tries `${spriteUrl}@2x.{json,png}`
   *  first and falls back to the 1× variant on 404. Defaults to 1. */
  dpr?: number
  /** Fires once the atlas reaches a terminal state (loaded or failed) — the
   *  render-loop re-arm hook so an idle map repaints the just-landed icons /
   *  fill-patterns (mirrors the glyph onResourceLanded; without it a sprite
   *  that lands after the loop idles waits for the next interaction to paint). */
  onLanded?: () => void
}

const HIGH_DPR_SUFFIX = '@2x'

export class SpriteAtlasHost {
  private readonly spriteUrl: string
  private readonly fetchFn: typeof globalThis.fetch
  private readonly dpr: number
  private state: SpriteAtlasState = { status: 'idle' }
  private readonly readyPromise: Promise<void>
  private resolveReady: (() => void) | null = null
  private readonly onLanded?: () => void

  constructor(opts: SpriteAtlasHostOptions) {
    this.spriteUrl = opts.spriteUrl
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis)
    this.dpr = opts.dpr ?? 1
    this.onLanded = opts.onLanded
    // Promise resolves on terminal state (loaded OR failed). Callers
    // who need the atlas before first draw await this once; callers
    // happy with "render-when-ready" can just probe `get()`.
    this.readyPromise = new Promise<void>(resolve => { this.resolveReady = resolve })
    this.kickOffLoad()
  }

  /** Resolves once the atlas reaches a terminal state (loaded or
   *  failed). Never rejects — caller checks `state()` if they care
   *  about the difference. */
  whenReady(): Promise<void> { return this.readyPromise }

  getState(): SpriteAtlasState { return this.state }

  /** Sync lookup. Returns the icon's metadata once the atlas is
   *  loaded; undefined for both "still loading" and "failed". */
  get(name: string): SpriteInfo | undefined {
    if (this.state.status !== 'loaded') return undefined
    return this.state.metadata.get(name)
  }

  /** The decoded raster — available iff state is 'loaded'. Used by
   *  SpriteAtlasGPU to upload to a WebGPU texture once. */
  getImage(): ImageBitmap | HTMLImageElement | undefined {
    return this.state.status === 'loaded' ? this.state.image : undefined
  }

  /** iter-177 fill-pattern Stage 1 — sample the sprite's centre pixel
   *  as an sRGB 0..255 RGBA tuple. Cached per sprite name; populated
   *  lazily through an OffscreenCanvas (browser) on first ask. Stage 1
   *  uses this as a flat fill colour for layers whose only paint
   *  declaration was `fill-pattern: X` (no `fill-color` fallback) so
   *  the layer at least renders in its intended hue band instead of
   *  staying invisible. Returns null when the atlas isn't loaded yet,
   *  the sprite is missing, or the canvas readback failed (e.g.,
   *  tainted SVG sprite). */
  getSpriteCenterColor(name: string): [number, number, number, number] | null {
    if (this.state.status !== 'loaded') return null
    const cached = this._centerColorCache.get(name)
    if (cached) return cached
    const sprite = this.state.metadata.get(name)
    if (!sprite) return null
    const cx = Math.floor(sprite.x + sprite.width / 2)
    const cy = Math.floor(sprite.y + sprite.height / 2)
    try {
      if (!this._readbackCtx) {
        const img = this.state.image
        const w = (img as ImageBitmap).width
        const h = (img as ImageBitmap).height
        // OffscreenCanvas (workers + most modern browsers); fall
        // through to HTMLCanvas in legacy environments.
        const C: typeof OffscreenCanvas | undefined =
          typeof OffscreenCanvas !== 'undefined' ? OffscreenCanvas : undefined
        const canvas = C ? new C(w, h) : (() => {
          const el = document.createElement('canvas')
          el.width = w; el.height = h
          return el as unknown as OffscreenCanvas
        })()
        const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null
        if (!ctx) return null
        ctx.drawImage(img as CanvasImageSource, 0, 0)
        this._readbackCtx = ctx
      }
      const px = this._readbackCtx.getImageData(cx, cy, 1, 1).data
      const rgba: [number, number, number, number] = [px[0], px[1], px[2], px[3]]
      this._centerColorCache.set(name, rgba)
      return rgba
    } catch {
      return null
    }
  }
  private _centerColorCache: Map<string, [number, number, number, number]> = new Map()
  private _readbackCtx: OffscreenCanvasRenderingContext2D | null = null

  private kickOffLoad(): void {
    // SSRF guard: refuse a private/loopback or non-http(s) sprite URL.
    // Degrade to 'failed' (no fetch issued) — same graceful path as an
    // offline/404 miss, so a hostile style only loses its icons, never
    // crashes the map or probes an internal host.
    try {
      assertSafeRemoteUrl(this.spriteUrl, 'sprite URL')
    } catch {
      this.state = { status: 'failed' }
      this.resolveReady?.()
      this.resolveReady = null
      this.onLanded?.()
      return
    }
    this.state = { status: 'loading' }
    const tryLoad = async (suffix: string): Promise<void> => {
      const jsonUrl = `${this.spriteUrl}${suffix}.json`
      const pngUrl = `${this.spriteUrl}${suffix}.png`
      // safeFetch re-validates every redirect hop (following manually) so an
      // allowlisted sprite host can't 302 to a private/loopback address; the
      // host's injected fetch is threaded through for test parity.
      const [jsonRes, pngRes] = await Promise.all([
        safeFetch(jsonUrl, undefined, 'sprite json URL', this.fetchFn),
        safeFetch(pngUrl, undefined, 'sprite png URL', this.fetchFn),
      ])
      if (!jsonRes.ok || !pngRes.ok) {
        throw new Error(`sprite ${suffix || '1x'} fetch failed`)
      }
      const [jsonBytes, pngBytes] = await Promise.all([
        readBodyCapped(jsonRes, MAX_SPRITE_JSON_BYTES, 'sprite json'),
        readBodyCapped(pngRes, MAX_SPRITE_PNG_BYTES, 'sprite png'),
      ])
      const rawJson = JSON.parse(new TextDecoder().decode(jsonBytes)) as Record<string, RawSpriteEntry>
      // readBodyCapped yields a Uint8Array whose generic buffer param is
      // `ArrayBufferLike` (it may be a stream-chunk passthrough); the Blob
      // ctor's BlobPart wants a definite-buffer view. The bytes are plain
      // (never SharedArrayBuffer) here, so narrow at this boundary.
      const image = await decodeBlob(new Blob([pngBytes as BlobPart]))
      const metadata = parseMetadata(rawJson)
      this.state = { status: 'loaded', metadata, image }
    }

    const fallbackLoad = (err: unknown): Promise<void> => {
      // @2x miss → try 1x. Don't double-fall on second failure.
      if (this.dpr >= 1.5) return tryLoad('').catch(handleFailure)
      return handleFailure(err)
    }
    const handleFailure = (_err: unknown): Promise<void> => {
      this.state = { status: 'failed' }
      return Promise.resolve()
    }

    const start = this.dpr >= 1.5 ? tryLoad(HIGH_DPR_SUFFIX).catch(fallbackLoad) : tryLoad('').catch(handleFailure)
    start.finally(() => { this.resolveReady?.(); this.resolveReady = null; this.onLanded?.() })
  }
}

interface RawSpriteEntry {
  x: number; y: number; width: number; height: number
  pixelRatio?: number; sdf?: boolean
}

function parseMetadata(raw: Record<string, RawSpriteEntry>): Map<string, SpriteInfo> {
  const out = new Map<string, SpriteInfo>()
  for (const [name, e] of Object.entries(raw)) {
    if (typeof e.x !== 'number' || typeof e.y !== 'number'
      || typeof e.width !== 'number' || typeof e.height !== 'number') continue
    out.set(name, {
      name, x: e.x, y: e.y, width: e.width, height: e.height,
      pixelRatio: e.pixelRatio ?? 1, sdf: e.sdf === true,
    })
  }
  return out
}

async function decodeBlob(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  // Prefer createImageBitmap — zero-copy on most browsers, works in
  // workers. Fall back to <img> on environments where createImageBitmap
  // isn't available (very old Safari).
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob)
  }
  if (typeof Image !== 'undefined') {
    const url = URL.createObjectURL(blob)
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
      img.onerror = e => { URL.revokeObjectURL(url); reject(e) }
      img.src = url
    })
  }
  throw new Error('SpriteAtlasHost: no image decoder available')
}
