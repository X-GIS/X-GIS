import { useEffect, useRef, useState } from 'react'

// GlobeDemo — the live X-GIS globe, embedded as the hero visual of the
// "Globe & 3D" concept page. Adapted from the home Hero island, trimmed
// to ONE job: render the real 3D globe and let the reader drag/zoom it.
//
// Differences from Hero (deliberate):
//   • NO projection cycling — this page is about the globe specifically.
//   • Depth-independent asset path — the source URL is an absolute
//     `${base}/data/land.geojson`, passed in via the `base` prop. Hero
//     lives at site root so its relative `data/…` resolves; a concept
//     page lives at /docs/concepts/ so a relative path would 404. An
//     absolute URL (starts with "/") bypasses run()'s baseUrl join.
//   • Lazy / idle mount, reduced-motion aware, destroy-clean — same as
//     Hero so the page stays light and well-behaved.
//
// XGISMap binds its own pointer handlers to the canvas (the orbit
// drag), so "draggable" needs no extra wiring — we only add a scoped
// wheel-to-zoom handler and the lifecycle guards.

type XGISMapType = import('@xgis/runtime').XGISMap

interface Props {
  /** Site base URL (import.meta.env.BASE_URL, trailing slash stripped) so
   *  the land source resolves from any page depth. */
  base: string
}

// A single neutral land source, taken straight to the globe. White-ish
// continents on the near-black canvas — the brand's "render is the hero,
// chrome stays monochrome" rule. The fill utility matches the home hero.
const source = (base: string) => `source land {
  type: geojson
  url: "${base}/data/land.geojson"
}

background { fill: #0a0a0a }

layer continents {
  source: land
  | fill-zinc-200
}`

export default function GlobeDemo({ base }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [mapReady, setMapReady] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let map: XGISMapType | null = null
    let mountStarted = false
    let destroyed = false
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // Scoped wheel-zoom — capture + non-passive so the page doesn't
    // scroll while the pointer is over the globe; mirrors Hero.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
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
      if (mountStarted || destroyed) return
      mountStarted = true
      try {
        const { XGISMap } = await import('@xgis/runtime')
        if (destroyed) return

        canvas.addEventListener('wheel', onWheel, { capture: true, passive: false })

        map = new XGISMap(canvas)
        // Absolute source URL inside `source(base)` → baseUrl arg unused.
        await map.run(source(base), '')
        if (destroyed) {
          map.destroy?.()
          return
        }

        map.setProjection('globe')
        // Frame the planet, centred — the same full-disc framing the home
        // hero uses for its globe beat (known-good value).
        const c = map.getCamera()
        c.zoom = 1
        c.centerX = 0
        c.centerY = 0
        map.markCameraPositioned()
        map.invalidate()

        canvas.style.opacity = '1'
        setMapReady(true)
      } catch (err) {
        console.warn('[globe-demo]', err)
        if (!destroyed) setFailed(true)
      }
    }

    // Idle/lazy kickoff — don't compete with first paint. Falls back to a
    // short timeout where requestIdleCallback is unavailable (Safari).
    const requestIdle =
      (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
        .requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 0))
    const kickoff = window.setTimeout(() => requestIdle(() => startMount(), { timeout: 1500 }), 600)

    // If the reader reaches for the globe before idle fires, mount now.
    const onInteract = () => startMount()
    canvas.addEventListener('pointerdown', onInteract, { once: true, passive: true })

    return () => {
      destroyed = true
      window.clearTimeout(kickoff)
      canvas.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions)
      canvas.removeEventListener('pointerdown', onInteract)
      map?.destroy?.()
    }
    // base is stable for the page lifetime; mount once.
  }, [])

  return (
    <div className="globe-demo">
      <div className="relative overflow-hidden rounded-[8px] border border-line bg-bg-card">
        <canvas
          ref={canvasRef}
          id="globe-demo-canvas"
          className="block w-full opacity-0 transition-opacity duration-500"
          style={{ height: '440px', touchAction: 'none' }}
          aria-label="Interactive 3D globe rendered live by X-GIS. Drag to orbit, scroll to zoom."
          role="img"
        />

        {!mapReady && !failed && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[11px] uppercase tracking-[0.18em] text-fg-mute">
            Compiling globe…
          </div>
        )}

        {failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-mute">
              Live globe unavailable
            </p>
            <p className="max-w-[320px] text-[13px] leading-[1.55] text-fg-dim">
              This browser could not start WebGPU. The same globe runs on the home page hero.
            </p>
            <a
              href={base + '/'}
              className="text-[13px] text-accent transition-colors hover:text-accent-hover"
            >
              Open the live globe →
            </a>
          </div>
        )}

        {/* Caption rail — mono caps, matches the home hero's render footer. */}
        <div className="flex items-center justify-between gap-4 border-t border-line px-5 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-fg-mute">
          <span>Source · land.geojson</span>
          <span className="inline-flex items-center gap-2">
            Projection
            <span className="inline-block size-1.5 rounded-full bg-accent" />
            <span className="text-fg-dim">Globe · 3D</span>
          </span>
        </div>
      </div>

      <p className="mt-3 text-center text-[12px] text-fg-mute">
        Drag to orbit · scroll to zoom · two-finger drag tilts. Rendered live, in your browser.
      </p>
    </div>
  )
}
