import { useEffect, useRef, useState, useCallback } from 'react'

// Playground — the "type-and-see" island. A .xgis source editor (left)
// wired to a live XGISMap canvas (right): edit the source, the compiler
// + runtime re-render in your browser on a short debounce.
//
// ── The live-recompile API path (verified against runtime/src/engine/map.ts) ──
//   `map.run(source, baseUrl)` (map.ts:1843) is RE-CALLABLE on a live
//   instance. Its first lines (map.ts:1849-1850):
//
//       if (this._destroyed) return
//       if (this._loaded || this.running) this._teardownForReinit()
//
//   `_teardownForReinit()` (map.ts:3390) frees every GPU resource of the
//   prior run — renderers, stages, palettes, device — MINUS the canvas /
//   pointer-controller / keyboard hooks, which the re-run reuses. The
//   class doc literally calls re-running "a legitimate scene swap"
//   (map.ts:1847). So we DON'T destroy()+recreate per keystroke: we hold
//   ONE XGISMap for the page lifetime and call run() again on each edit.
//   This keeps the camera controller bound and is the cleanest supported
//   path. (`setStyle` / `addLayer` are explicit no-op parity stubs —
//   map.ts:1090 — confirming there is no runtime style-swap; recompile is
//   the only route.)
//
//   Overlap guard: run() is async + re-entrant. We serialize — await any
//   in-flight run, then run the LATEST pending source — and stamp each
//   run with a monotonic id so a stale completion can't clobber a newer
//   edit (the `runSeq` / `latestSource` refs below).
//
// Asset URLs are depth-independent absolute (`${base}/data/land.geojson`)
// like GlobeDemo, so the source resolves regardless of where /play sits.

type XGISMapType = import('@xgis/runtime').XGISMap

interface Props {
  /** Site base URL (import.meta.env.BASE_URL, trailing slash stripped) so
   *  the land source resolves from any page depth. */
  base: string
  /** The SSR'd default source (also rendered into the no-JS <textarea>),
   *  so the editor's first paint matches the server exactly. */
  initialSource: string
}

interface Preset {
  id: string
  label: string
  blurb: string
  projection: string
  source: string
}

// ── Presets ────────────────────────────────────────────────────────────
// Every preset draws the ONE source the site ships — `data/land.geojson`
// (Natural Earth land polygons, properties: featurecla / scalerank /
// min_zoom). All are small + known-good against that file and the
// confirmed grammar (source / background / layer | fill-… stroke-…).
// `{B}` is replaced with the absolute base at runtime.
const PRESETS: Preset[] = [
  {
    id: 'land',
    label: 'Land',
    blurb: 'The minimal map — one source, one fill.',
    projection: 'globe',
    source: `source land {
  type: geojson
  url: "{B}/data/land.geojson"
}

background { fill: #0a0a0a }

layer continents {
  source: land
  | fill-zinc-200
}`,
  },
  {
    id: 'outline',
    label: 'Coastline',
    blurb: 'Stroke instead of fill — the world as a wire drawing.',
    projection: 'natural_earth',
    source: `source land {
  type: geojson
  url: "{B}/data/land.geojson"
}

background { fill: #0a0a0a }

layer coast {
  source: land
  | fill-zinc-900 stroke-zinc-300 stroke-1
}`,
  },
  {
    id: 'data',
    label: 'Data-driven',
    blurb: 'match() on a feature property — colour comes from the data.',
    projection: 'natural_earth',
    source: `source land {
  type: geojson
  url: "{B}/data/land.geojson"
}

background { fill: #0a0a0a }

// Fill colour is chosen per-feature from its scalerank
// (a real property on every land polygon). The map is a
// function of the data, not a fixed paint.
layer continents {
  source: land
  | fill match(.scalerank) {
      1 -> emerald-400,
      _ -> emerald-700
    }
    stroke-emerald-200 stroke-0.5 opacity-95
}`,
  },
  {
    id: 'merc',
    label: 'Mercator',
    blurb: 'Same source, flat — switching projection is a uniform write.',
    projection: 'mercator',
    source: `source land {
  type: geojson
  url: "{B}/data/land.geojson"
}

background { fill: #0a0a0a }

layer continents {
  source: land
  | fill-stone-300 stroke-stone-500 stroke-0.5
}`,
  },
]

const DEBOUNCE_MS = 400

/** Inject the absolute base into a preset/source template. */
const withBase = (src: string, base: string) => src.split('{B}').join(base)

/** btoa over UTF-8 (handles non-ASCII), the convert page's exact idiom. */
const encodeSource = (src: string) => btoa(unescape(encodeURIComponent(src)))
const decodeSource = (b64: string) => decodeURIComponent(escape(atob(b64)))

/** Read `#src=<base64>` from the URL hash, or null when absent/invalid. */
function readHashSource(): string | null {
  if (typeof window === 'undefined') return null
  const m = window.location.hash.match(/[#&]src=([^&]+)/)
  if (!m) return null
  try {
    const decoded = decodeSource(decodeURIComponent(m[1]))
    return decoded.trim() ? decoded : null
  } catch {
    return null
  }
}

export default function Playground({ base, initialSource }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // The editor source is the single source of truth for the UI. It seeds
  // from the SSR default so the first client render === the server render
  // (no hydration flash); a hash payload, if present, replaces it inside
  // the mount effect (post-hydration, so SSR stays deterministic).
  const [source, setSource] = useState(initialSource)
  const [error, setError] = useState<string | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [activePreset, setActivePreset] = useState<string | null>('land')
  const [copied, setCopied] = useState(false)

  // ── Live-recompile machinery (refs — never trigger re-render) ──
  const mapRef = useRef<XGISMapType | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Monotonic run id + the latest source awaiting a run. `running` flags
  // an in-flight run() so we serialize rather than overlap.
  const runSeq = useRef(0)
  const latestSource = useRef(initialSource)
  const runningRef = useRef(false)
  const projectionRef = useRef('globe')
  const destroyedRef = useRef(false)

  /** Compile + render `src` on the live map, newest-wins. Serializes against
   *  any in-flight run; stamps a sequence id so a stale completion can't
   *  overwrite a newer edit's result. */
  const compileAndRender = useCallback(async (src: string) => {
    const map = mapRef.current
    if (!map || destroyedRef.current) return
    latestSource.current = src
    if (runningRef.current) return // a run is live; it'll pick up latestSource
    runningRef.current = true
    try {
      // Drain: keep running until the source stops changing under us.
      while (!destroyedRef.current) {
        const target = latestSource.current
        const seq = ++runSeq.current
        try {
          // Absolute url: inside the source → baseUrl arg unused (""),
          // exactly like GlobeDemo. run() tears down the prior scene
          // internally (map.ts:1850) — one instance, swapped in place.
          await map.run(target, '')
          if (destroyedRef.current) return
          // Ignore a stale completion (a newer run was kicked off while
          // this awaited). Only the most-recent seq applies its view.
          if (seq !== runSeq.current) continue
          map.setProjection(projectionRef.current)
          const c = map.getCamera()
          c.zoom = 1
          c.centerX = 0
          c.centerY = 0
          map.markCameraPositioned()
          map.invalidate()
          setError(null)
          setMapReady(true)
        } catch (err) {
          // A genuine syntax / compile error in the user's .xgis. The
          // compiler really throws here; surface the true message.
          if (destroyedRef.current) return
          if (seq === runSeq.current) {
            setError(err instanceof Error ? err.message : String(err))
          }
        }
        // If nothing new arrived while we were running, we're done.
        if (latestSource.current === target) break
      }
    } finally {
      runningRef.current = false
    }
  }, [])

  // ── Mount: build the single map, restore hash, first compile ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    destroyedRef.current = false
    let mountStarted = false
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // Restore a shared source from the URL hash (post-hydration so SSR is
    // deterministic). Falls back to the default preset when absent/invalid.
    const hashSource = readHashSource()
    if (hashSource) {
      setSource(hashSource)
      setActivePreset(null)
      latestSource.current = hashSource
    }
    const firstSource = hashSource ?? initialSource

    // Scoped wheel-zoom — capture + non-passive so the page doesn't scroll
    // while the pointer is over the map; mirrors Hero / GlobeDemo.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      const map = mapRef.current
      if (!map) return
      const rect = canvas.getBoundingClientRect()
      const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.003)
      map
        .getCamera()
        .zoomAt(
          Math.max(-1, Math.min(1, delta)),
          e.clientX - rect.left,
          e.clientY - rect.top,
          canvas.width,
          canvas.height,
        )
    }

    const startMount = async () => {
      if (mountStarted || destroyedRef.current) return
      mountStarted = true
      try {
        const { XGISMap } = await import('@xgis/runtime')
        if (destroyedRef.current) return

        canvas.addEventListener('wheel', onWheel, { capture: true, passive: false })

        const map = new XGISMap(canvas)
        mapRef.current = map
        // First compile goes through the same serialized path as edits.
        await compileAndRender(firstSource)
        if (destroyedRef.current) return
        canvas.style.opacity = '1'
      } catch (err) {
        console.warn('[playground]', err)
        if (!destroyedRef.current) setFailed(true)
      }
    }

    // Idle / lazy kickoff — don't compete with first paint. The reduced-
    // motion branch still mounts (the map isn't an animation; it's the
    // content), just without the cosmetic fade lead-in.
    const requestIdle =
      (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
        .requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 0))
    const kickoff = window.setTimeout(
      () => requestIdle(() => startMount(), { timeout: 1500 }),
      reduceMotion ? 0 : 500,
    )

    // If the user reaches for the canvas before idle fires, mount now.
    const onInteract = () => startMount()
    canvas.addEventListener('pointerdown', onInteract, { once: true, passive: true })

    return () => {
      destroyedRef.current = true
      window.clearTimeout(kickoff)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      canvas.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions)
      canvas.removeEventListener('pointerdown', onInteract)
      mapRef.current?.destroy?.()
      mapRef.current = null
    }
    // Mount once — base / initialSource / compileAndRender are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Editor edits → debounced recompile ──
  const onEdit = useCallback(
    (next: string) => {
      setSource(next)
      setActivePreset(null)
      setCopied(false)
      latestSource.current = next
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        void compileAndRender(next)
      }, DEBOUNCE_MS)
    },
    [compileAndRender],
  )

  // ── Preset load: fill the editor, set projection, recompile now ──
  const loadPreset = useCallback(
    (preset: Preset) => {
      const next = withBase(preset.source, base)
      projectionRef.current = preset.projection
      setSource(next)
      setActivePreset(preset.id)
      setCopied(false)
      setError(null)
      latestSource.current = next
      if (debounceRef.current) clearTimeout(debounceRef.current)
      // Presets are known-good → recompile immediately, no debounce.
      void compileAndRender(next)
    },
    [base, compileAndRender],
  )

  // ── Share: encode source into the hash, copy the link ──
  const copyLink = useCallback(async () => {
    if (typeof window === 'undefined') return
    const url = `${window.location.origin}${window.location.pathname}#src=${encodeURIComponent(
      encodeSource(source),
    )}`
    // Keep the address bar in sync without a history entry.
    try {
      window.history.replaceState(null, '', url)
    } catch {
      /* replaceState can throw in sandboxed embeds — copy still works */
    }
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard API unavailable (insecure context) — select the editor
      // as a usable fallback so the user can copy the source by hand.
      textareaRef.current?.select()
    }
  }, [source])

  // Tab inserts two spaces instead of moving focus — table stakes for a
  // code editor, and keeps keyboard users inside the box.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Tab') {
        e.preventDefault()
        const el = e.currentTarget
        const start = el.selectionStart
        const end = el.selectionEnd
        const next = source.slice(0, start) + '  ' + source.slice(end)
        onEdit(next)
        // Restore the caret just after the inserted spaces.
        requestAnimationFrame(() => {
          el.selectionStart = el.selectionEnd = start + 2
        })
      }
    },
    [source, onEdit],
  )

  return (
    <div className="flex min-h-[calc(100svh-3rem)] flex-col lg:flex-row">
      {/* ── Editor pane ── */}
      <div className="flex min-h-[42svh] flex-col border-b border-line lg:min-h-0 lg:w-[44%] lg:max-w-[620px] lg:border-b-0 lg:border-r">
        {/* Toolbar: presets + share */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="mr-1 font-mono text-[10.5px] uppercase tracking-[0.16em] text-fg-mute">
            Source
          </span>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => loadPreset(p)}
              title={p.blurb}
              aria-pressed={activePreset === p.id}
              className={
                'rounded-full border px-3 py-1 text-[12px] transition-colors ' +
                (activePreset === p.id
                  ? 'border-fg/40 bg-fg/10 text-fg'
                  : 'border-line bg-transparent text-fg-dim hover:border-line-strong hover:text-fg')
              }
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            onClick={copyLink}
            className="ml-auto rounded-full border border-line bg-transparent px-3 py-1 text-[12px] text-fg-dim transition-colors hover:border-line-strong hover:text-fg"
          >
            {copied ? 'Link copied' : 'Copy link'}
          </button>
        </div>

        {/* The editor itself — a plain textarea, mono, xAI-styled. Zero-dep. */}
        <textarea
          ref={textareaRef}
          value={source}
          onChange={(e) => onEdit(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="X-GIS source editor — edit the .xgis source to recompile the live map"
          className="min-h-[200px] flex-1 resize-none bg-bg px-5 py-4 font-mono text-[13px] leading-[1.7] text-fg caret-accent outline-none placeholder:text-fg-mute"
        />

        {/* Error strip — the compiler's real message, or a hairline idle bar. */}
        {error ? (
          <div
            role="alert"
            className="border-t border-rose-500/40 bg-rose-500/10 px-5 py-2.5 font-mono text-[12px] leading-[1.5] text-rose-300"
          >
            <span className="mr-2 uppercase tracking-[0.14em] text-rose-300/70">Error</span>
            {error}
          </div>
        ) : (
          <div className="border-t border-line px-5 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-fg-mute">
            Compiles in your browser · edits re-render live
          </div>
        )}
      </div>

      {/* ── Map pane (the hero) ── */}
      <div className="relative min-h-[42svh] flex-1 bg-bg">
        <canvas
          ref={canvasRef}
          id="playground-map"
          className="block size-full opacity-0 transition-opacity duration-500"
          style={{ touchAction: 'none' }}
          aria-label="Live map rendered by X-GIS from the source on the left. Drag to pan or orbit, scroll to zoom."
          role="img"
        />

        {!mapReady && !failed && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[11px] uppercase tracking-[0.18em] text-fg-mute">
            Compiling…
          </div>
        )}

        {failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-mute">
              Live map unavailable
            </p>
            <p className="max-w-[340px] text-[13px] leading-[1.55] text-fg-dim">
              This browser could not start WebGPU. The editor still works — copy your source and
              open it where WebGPU is available (recent Chrome, Edge, or Safari Technology Preview).
            </p>
          </div>
        )}

        {/* Caption rail — mono caps, matches the home hero's render footer. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-4 border-t border-line bg-bg/80 px-5 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-fg-mute backdrop-blur-sm">
          <span>Live · WebGPU</span>
          <span className="inline-flex items-center gap-2">
            <span className="inline-block size-1.5 rounded-full bg-accent" />
            Rendered in your browser
          </span>
        </div>
      </div>
    </div>
  )
}
