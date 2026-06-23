import { useEffect, useRef, useState } from "react"
import { ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

type XGISMapType = import("@xgis/runtime").XGISMap

// [projection id, display label] — the same land source taken from sphere
// to plane and back, to show "one source, any view".
const CYCLE: [string, string][] = [
  ["globe", "Globe"],
  ["natural_earth", "Natural Earth"],
  ["mercator", "Mercator"],
  ["orthographic", "Orthographic"],
]

const SOURCE = `source land {
  type: geojson
  url: "data/land.geojson"
}

background { fill: #14110c }

layer continents {
  source: land
  | fill-zinc-200
}`

interface Props {
  docsUrl: string
  examplesUrl: string
  convertUrl: string
}

export default function Hero({ docsUrl, examplesUrl, convertUrl }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [projLabel, setProjLabel] = useState("Globe")
  const [mapReady, setMapReady] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let map: XGISMapType | null = null
    let mountStarted = false
    let destroyed = false
    let cycleTimer: ReturnType<typeof setTimeout> | null = null
    let cycleIdx = 0
    let userTookOver = false
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches

    const stopCycle = () => { if (cycleTimer) { clearTimeout(cycleTimer); cycleTimer = null } }

    const recenter = () => {
      if (!map) return
      const c = map.getCamera()
      c.zoom = 1; c.centerX = 0; c.centerY = 0
      map.markCameraPositioned(); map.invalidate()
    }

    const advance = () => {
      if (!map || userTookOver || destroyed || document.hidden) return
      cycleIdx = (cycleIdx + 1) % CYCLE.length
      const [id, label] = CYCLE[cycleIdx]
      canvas.style.opacity = "0"
      window.setTimeout(() => {
        if (!map || userTookOver || destroyed) return
        map.setProjection(id); recenter()
        setProjLabel(label)
        canvas.style.opacity = "1"
        cycleTimer = window.setTimeout(advance, 3600)
      }, 280)
    }

    const startMount = async () => {
      if (mountStarted || destroyed) return
      mountStarted = true
      try {
        const { XGISMap } = await import("@xgis/runtime")
        if (destroyed) return

        canvas.addEventListener("wheel", (e) => {
          e.preventDefault(); e.stopImmediatePropagation()
          if (!map) return
          userTookOver = true; stopCycle()
          const rect = canvas.getBoundingClientRect()
          const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.003)
          map.getCamera().zoomAt(
            Math.max(-1, Math.min(1, delta)),
            e.clientX - rect.left, e.clientY - rect.top,
            canvas.width, canvas.height,
          )
        }, { capture: true, passive: false })

        const baseUrl = window.location.pathname.endsWith("/")
          ? window.location.pathname
          : window.location.pathname.substring(0, window.location.pathname.lastIndexOf("/") + 1)

        map = new XGISMap(canvas)
        await map.run(SOURCE, baseUrl)
        if (destroyed) { map.destroy?.(); return }
        map.setProjection(CYCLE[0][0]); recenter()
        canvas.style.opacity = "1"
        setMapReady(true)
        if (!reduceMotion) cycleTimer = window.setTimeout(advance, 3600)
      } catch (err) {
        console.warn("[hero-map]", err)
      }
    }

    const requestIdle = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback
      ?? ((cb: () => void) => setTimeout(cb, 0))
    const kickoff = window.setTimeout(() => requestIdle(() => startMount(), { timeout: 1500 }), 2200)

    const onInteract = () => { userTookOver = true; stopCycle(); startMount() }
    canvas.addEventListener("pointerdown", onInteract, { once: true, passive: true })

    const onVis = () => {
      if (document.hidden) stopCycle()
      else if (!userTookOver && !reduceMotion && !cycleTimer && map) cycleTimer = window.setTimeout(advance, 1200)
    }
    document.addEventListener("visibilitychange", onVis)

    return () => {
      destroyed = true
      clearTimeout(kickoff); stopCycle()
      document.removeEventListener("visibilitychange", onVis)
      canvas.removeEventListener("pointerdown", onInteract)
      map?.destroy?.()
    }
  }, [])

  return (
    <section className="relative flex min-h-[100svh] items-center justify-center overflow-hidden pb-20 pt-24">
      <div className="relative mx-auto w-full max-w-[1080px] px-6 text-center">
        <p className="fade-up mb-7 inline-flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground" style={{ animationDelay: "80ms" }}>
          <span className="inline-block size-2 rotate-45 bg-primary" />
          Introducing X-GIS
        </p>

        <h1 className="fade-up font-display text-[44px] font-semibold uppercase leading-[0.88] tracking-[0.005em] text-foreground sm:text-[80px] md:text-[104px] lg:text-[132px] xl:text-[150px]" style={{ animationDelay: "200ms" }}>
          A language for<br />cartography
        </h1>

        <p className="fade-up mx-auto mt-8 max-w-[600px] text-[17px] leading-[1.5] text-muted-foreground sm:text-[20px]" style={{ animationDelay: "340ms" }}>
          Declare what your map should look like. The compiler emits the
          WGSL shaders, buffer layouts, and projection math.
        </p>

        <div className="fade-up mt-10 flex flex-wrap items-center justify-center gap-3.5" style={{ animationDelay: "480ms" }}>
          <Button asChild size="lg">
            <a href={docsUrl}>Read the docs <ChevronRight /></a>
          </Button>
          <Button asChild size="lg" variant="outline">
            <a href={examplesUrl}>View examples</a>
          </Button>
          <Button asChild size="lg" variant="ghost" className="text-muted-foreground">
            <a href={convertUrl}>Convert from Mapbox <ChevronRight className="opacity-70" /></a>
          </Button>
        </div>

        <div className="scale-fade mx-auto mt-16 max-w-[680px] text-left sm:mt-20" style={{ animationDelay: "640ms" }}>
          <Card className="overflow-hidden shadow-[0_28px_70px_-28px_rgba(0,0,0,0.75)]">
            <pre className="m-0 overflow-x-auto whitespace-pre px-7 py-6 font-mono text-[13.5px] leading-[1.8] text-foreground sm:text-[14.5px]">
              <code>
                <span className="kw">source</span> <span className="id">land</span> {"{"}{"\n"}
                {"  "}<span className="kw">type</span><span className="pun">:</span> <span className="lit">geojson</span>{"\n"}
                {"  "}<span className="kw">url</span><span className="pun">:</span> <span className="str">"data/land.geojson"</span>{"\n"}
                {"}"}{"\n\n"}
                <span className="kw">layer</span> <span className="id">continents</span> {"{"}{"\n"}
                {"  "}<span className="kw">source</span><span className="pun">:</span> <span className="id">land</span>{"\n"}
                {"  "}<span className="pun">|</span> <span className="util">fill-zinc-200</span>{"\n"}
                {"}"}
              </code>
            </pre>

            <div className="border-t border-border" />

            <div className="relative bg-background">
              <canvas ref={canvasRef} id="hero-map" className="block w-full opacity-0 transition-opacity duration-300" style={{ height: "300px", touchAction: "none" }} />
              {!mapReady && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[12px] uppercase tracking-[0.16em] text-muted-foreground">
                  Compiling…
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-4 border-t border-border px-5 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
              <span>Source · land.geojson</span>
              <span className="inline-flex items-center gap-2">
                Projection
                <span className="marker-pulse inline-block size-1.5 rounded-full bg-primary" />
                <span className="w-[92px] text-left text-foreground/80">{projLabel}</span>
              </span>
            </div>
          </Card>

          <p className="mt-5 text-center text-[12px] text-muted-foreground">
            Drag, zoom, explore. &nbsp;
            <a href={examplesUrl} className="inline-flex items-center gap-1 text-primary transition-colors hover:text-[var(--sienna-hover)]">
              See more examples <ChevronRight className="size-3" />
            </a>
          </p>
        </div>

        <p className="fade-up mt-10 font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--paper-4)]" style={{ animationDelay: "820ms" }}>
          WebGPU&nbsp; · &nbsp;Seven projections&nbsp; · &nbsp;MIT
        </p>
      </div>

      <style>{`
        #hero-map { }
        .kw { color: #d97f4d; }
        .id { color: var(--paper); font-weight: 600; }
        .util { color: #c79a63; }
        .lit, .str { color: #c9b489; }
        .pun { color: var(--paper-4); }
      `}</style>
    </section>
  )
}
