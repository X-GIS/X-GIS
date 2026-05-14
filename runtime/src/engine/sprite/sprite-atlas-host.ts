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
}

const HIGH_DPR_SUFFIX = '@2x'

export class SpriteAtlasHost {
  private readonly spriteUrl: string
  private readonly fetchFn: typeof globalThis.fetch
  private readonly dpr: number
  private state: SpriteAtlasState = { status: 'idle' }
  private readonly readyPromise: Promise<void>
  private resolveReady: (() => void) | null = null

  constructor(opts: SpriteAtlasHostOptions) {
    this.spriteUrl = opts.spriteUrl
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis)
    this.dpr = opts.dpr ?? 1
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

  private kickOffLoad(): void {
    this.state = { status: 'loading' }
    const tryLoad = async (suffix: string): Promise<void> => {
      const jsonUrl = `${this.spriteUrl}${suffix}.json`
      const pngUrl = `${this.spriteUrl}${suffix}.png`
      const [jsonRes, pngRes] = await Promise.all([
        this.fetchFn(jsonUrl), this.fetchFn(pngUrl),
      ])
      if (!jsonRes.ok || !pngRes.ok) {
        throw new Error(`sprite ${suffix || '1x'} fetch failed`)
      }
      const [rawJson, pngBlob] = await Promise.all([
        jsonRes.json() as Promise<Record<string, RawSpriteEntry>>,
        pngRes.blob(),
      ])
      const image = await decodeBlob(pngBlob)
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
    start.finally(() => { this.resolveReady?.(); this.resolveReady = null })
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
