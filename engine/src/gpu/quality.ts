// ═══ Quality / performance trade-off settings ═══
//
// Per-deployment knobs that trade visual fidelity for frame budget.
// Shaped as URL flags + named presets so e2e tests, demo URLs, and
// embedding apps all use one mechanism (mirrors the existing
// `?safe=1` / `?gpuprof=1` pattern in `gpu.ts`).
//
// **Defaults preserve current behavior** — opt-in only. Existing
// deployments don't change unless they pass a flag. Settings ARE
// allowed here despite the project's general "don't expose quality
// trade-offs" stance because for a GPU-bound scene like `multi_layer`
// (12ms first-pass on desktop) hitting >100fps is a **physical
// impossibility** without trading off MSAA / DPR. The rest of the
// codebase shouldn't sprout new settings; this is the one knob.
//
// ## URL flags
//   `?quality=performance|balanced|battery|default`
//        Apply a named preset. Lower presets trade fidelity for
//        budget. `default` = current behavior, full quality.
//   `?msaa=1|2|4`            override MSAA sample count
//   `?dpr=N`                 override max devicePixelRatio cap
//   `?adaptiveDpr=N`         drop DPR to N during pointer/wheel
//                            interaction, restore on idle (null = off)
//   `?safe=1`                back-compat alias for `?quality=battery`
//                            (existing flag, kept working)
//
// Individual key flags override preset values, so
// `?quality=performance&msaa=2` keeps performance preset's other knobs
// but bumps MSAA back to 2× for slightly cleaner edges.

export interface QualityConfig {
  /** MSAA sample count: 1, 2, or 4. Init-time only — pipelines bake
   *  sampleCount, runtime change requires page reload. Higher = smoother
   *  polygon edges, more fragment work. SDF line strokes carry their own
   *  1-px shader AA so 1× is acceptable for stroke-heavy scenes.
   *
   *  Auto-forced to 1 when `picking` is enabled — uint pick RTs can't
   *  share a multisample pass with a color target without a custom
   *  resolve shader. */
  msaa: 1 | 2 | 4
  /** Max devicePixelRatio cap. Lower = fewer pixels processed but blurrier
   *  on hi-DPI displays. 1.0 effectively disables retina scaling. */
  maxDpr: number
  /** During pointer/wheel interaction, drop DPR to this value; restore to
   *  `maxDpr` on idle. null = always `maxDpr`. Pan motion blur naturally
   *  hides lower DPR aliasing, so this trades nothing visible during
   *  the moments the user is actively dragging. */
  interactionDpr: number | null
  /** GPU picking (`map.pickAt(x, y)` returns feature/instance IDs under
   *  the pointer). Adds a second RG32Uint color attachment to every main
   *  pass. Off by default — 8 bytes/pixel of VRAM + minor fragment cost.
   *  Requires `msaa = 1` (silently forced). */
  picking: boolean
}

const QUALITY_PRESETS = {
  /** Default — render at the device's native pixel density (capped at
   *  3 to bound fragment work on hypothetical 4×+ monitors). Anchored
   *  here AFTER the DPR-invariance fixes (tile budget / mobile
   *  classification / MVP altitude all CSS-pixel-based, ee1f394 +
   *  d608358 + 9d40ddb): tile fetch / decode / cache pressure is
   *  identical at any DPR for the same logical viewport. The only
   *  remaining DPR-dependent cost is fragment work — legitimate, since
   *  more device pixels REQUIRE more fragment shader invocations.
   *
   *  Heavy scenes (Manhattan z=11.5 pitch=43° osm-style) measure ~18 ms
   *  GPU pass at DPR=3 — a hair over the 16.7 ms 60 fps target, so
   *  weak devices may see 40-50 fps on the worst case. Users on low-
   *  power hardware can opt down with `?quality=performance` (msaa=1,
   *  maxDpr=1.0). The previous "silently downscale to 1× for retina
   *  phones" auto-promotion was removed because it lied about pixel
   *  intent — `stroke-1` rendered as a fuzzy 3-device-pixel band after
   *  the OS upscale instead of a sharp 1 CSS pixel. */
  default: {
    msaa: 4,
    maxDpr: 3,
    interactionDpr: null,
    picking: false,
  },
  /** 144fps target. MSAA off, DPR 1.0, no adaptive (since DPR is already
   *  minimum). Required for GPU-bound scenes on low-end devices. */
  performance: {
    msaa: 1,
    maxDpr: 1.0,
    interactionDpr: null,
    picking: false,
  },
  /** Desktop sweet spot: full quality at rest, drop DPR during pan to
   *  preserve smoothness without sacrificing static fidelity. */
  balanced: {
    msaa: 2,
    maxDpr: 2,
    interactionDpr: 1.5,
    picking: false,
  },
  /** Mobile / low-power. Aliased from the existing `?safe=1` flag for
   *  back-compat. Roughly matches the prior mobile defaults. */
  battery: {
    msaa: 1,
    maxDpr: 1.5,
    interactionDpr: 1.0,
    picking: false,
  },
} as const satisfies Record<string, QualityConfig>

type QualityPreset = keyof typeof QUALITY_PRESETS

function readURL(): URLSearchParams | null {
  if (typeof window === 'undefined') return null
  try {
    return new URL(window.location.href).searchParams
  } catch {
    return null
  }
}

function clampMsaa(n: number): 1 | 2 | 4 {
  // WebGPU currently supports only sampleCount 1 or 4 in practice (Chrome
  // rejects 2 as "Multisample count (2) is not supported"). The type
  // allows 2 for future-proofing but we clamp to 1/4 here. Anything else
  // → default 4×.
  if (n === 1) return 1
  if (n === 2) return 1 // round down to 1× rather than error on the pass
  return 4
}

/** The raw `?safe=1` boot flag — distinct from the battery-preset ALIAS it also
 *  triggers in `resolveQuality`. Renderers read it to disable the most invasive
 *  recent code path (the translucent-line offscreen composite) for bisection.
 *  Engine owns the parse so `@xgis/map` reads it from here (the single quality
 *  authority) rather than reaching into a concrete backend package. */
export function isSafeMode(): boolean {
  return readURL()?.get('safe') === '1'
}

function resolveQuality(): QualityConfig {
  const params = readURL()
  if (!params) return { ...QUALITY_PRESETS.default }

  // 1. Pick base preset. `?safe=1` is back-compat alias for battery.
  let base: QualityConfig
  const presetParam = params.get('quality')
  const safeFlag = params.get('safe') === '1'
  if (presetParam && presetParam in QUALITY_PRESETS) {
    base = { ...QUALITY_PRESETS[presetParam as QualityPreset] }
  } else if (safeFlag) {
    base = { ...QUALITY_PRESETS.battery }
  } else {
    base = { ...QUALITY_PRESETS.default }
  }

  // Mobile auto-promotion to `performance` was removed once the
  // DPR-invariance fixes landed (ee1f394 / d608358 / 9d40ddb). The
  // earlier rationale — "GPU pass 27 ms on iPhone" — was driven by
  // tile-budget / MVP altitude inflation that scaled with DPR², not
  // by raw fragment cost. With those sinks closed, DPR=3 produces
  // the same tile / decode / cache load as DPR=1; only legitimate
  // fragment work scales. Users on weak hardware can still opt down
  // explicitly with `?quality=performance` (msaa=1, maxDpr=1.0).

  // 3. Per-key URL overrides (apply on top of preset).
  const msaaParam = params.get('msaa')
  if (msaaParam !== null) {
    const n = Number(msaaParam)
    if (Number.isFinite(n)) base.msaa = clampMsaa(n)
  }
  const dprParam = params.get('dpr')
  if (dprParam !== null) {
    const n = Number(dprParam)
    if (Number.isFinite(n) && n > 0) base.maxDpr = n
  }
  const adpParam = params.get('adaptiveDpr')
  if (adpParam !== null) {
    if (adpParam === '0' || adpParam === 'off' || adpParam === 'null') {
      base.interactionDpr = null
    } else {
      const n = Number(adpParam)
      if (Number.isFinite(n) && n > 0) base.interactionDpr = n
    }
  }

  // ?picking=1 enables GPU picking. Uint pick RTs need sampleCount=1,
  // so enabling picking silently drops MSAA.
  const pickParam = params.get('picking')
  if (pickParam === '1' || pickParam === 'true') {
    base.picking = true
    base.msaa = 1
  }

  // ?debug=overdraw — fragment-count heatmap mode. Forces msaa=1
  // (debug pipelines mirror only the single-sample path; adding 4×
  // variants for a debug mode isn't worth the pipeline-state matrix
  // blow-up) and picking=false (the uint pick attachment confuses
  // the additive r16float accumulator routing). debug-flags.ts is
  // the source of truth for the flag itself; we re-read the URL
  // here to avoid an import cycle (debug-flags depends on nothing,
  // quality.ts depends on nothing — they meet here at the resolver).
  const debugParam = params.get('debug')
  if (debugParam === 'overdraw') {
    base.msaa = 1
    base.picking = false
  }

  // Adaptive MSAA: at DPR ≥ 2 the device-pixel density already
  // super-samples polygon edges (a single CSS pixel becomes 4 — at
  // DPR=2 — or 9 — at DPR=3 — device sub-pixels). Stacking MSAA=4
  // on top multiplies fragment work without a visible-quality
  // payoff. Real-device measurement on iPhone DPR=3 z=8 osm-style
  // hit 270 ms GPU pass with msaa=4 (4-6 fps); dropping to msaa=1
  // brings it back into 60 fps territory. Mapbox / MapLibre apply
  // the same heuristic. Users on a hypothetical DPR=1 retina-cap-
  // override (e.g. `?dpr=1`) keep msaa=4 for proper edge AA.
  const effectiveDpr =
    typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, base.maxDpr) : 1
  if (effectiveDpr >= 2 && msaaParam === null) {
    base.msaa = 1
  }

  return base
}

/** Live, mutable quality configuration. Fields can be patched at runtime
 *  via `updateQuality(patch)` — every caller that reads `QUALITY.x`
 *  (renderers at pipeline-rebuild time, resizeCanvas, etc.) sees the
 *  new value.
 *
 *  - DPR / interactionDpr changes apply on the next canvas resize (~0 ms).
 *  - MSAA / picking changes require the map to call each renderer's
 *    `rebuildForQuality()` to recompile pipelines and reallocate render
 *    targets (~100–300 ms spike). `map.setQuality()` dispatches this.
 *
 *  Initial value comes from URL flags (`?quality`, `?msaa`, `?dpr`,
 *  `?adaptiveDpr`, `?picking`) so the boot-time behavior is unchanged. */
export const QUALITY: QualityConfig = resolveQuality()

/** Change listeners — `map.setQuality()` registers so it can orchestrate
 *  the heavy renderer rebuilds that MSAA / picking flips require. */
type QualityChangeListener = (prev: QualityConfig, next: QualityConfig) => void
const listeners = new Set<QualityChangeListener>()

export function onQualityChange(fn: QualityChangeListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Merge `patch` into `QUALITY` in place and notify listeners. Callers
 *  that just want to bump DPR (cheap) can call this directly; full
 *  runtime toggles (MSAA, picking) should go through `map.setQuality()`
 *  which also rebuilds renderer state. */
export function updateQuality(patch: Partial<QualityConfig>): void {
  const prev: QualityConfig = { ...QUALITY }
  if (patch.msaa !== undefined) QUALITY.msaa = clampMsaa(patch.msaa)
  if (patch.maxDpr !== undefined && patch.maxDpr > 0) QUALITY.maxDpr = patch.maxDpr
  if (patch.interactionDpr !== undefined) QUALITY.interactionDpr = patch.interactionDpr
  if (patch.picking !== undefined) {
    QUALITY.picking = patch.picking
    // Picking requires MSAA=1 (uint RTs can't coexist with multisample
    // color without a custom resolve). Mirror the URL-flag behavior.
    if (patch.picking) QUALITY.msaa = 1
  }
  for (const fn of listeners) fn(prev, QUALITY)
}

if (typeof window !== 'undefined') {
  // Safe-mode announce lives HERE with the flag's single authority (#929 B —
  // formerly a module-load warn in rhi-webgpu's boot, which made the adapter
  // reach into engine policy just to print it).
  if (isSafeMode()) {
    console.warn(
      '[X-GIS] safe mode active (?safe=1) — translucent offscreen disabled (quality preset = battery)',
    )
  }
  // Surface non-default quality once so users see the trade-off they
  // opted into. Quiet for default to avoid console noise.
  const isDefault =
    QUALITY.msaa === 4 &&
    QUALITY.maxDpr === 2 &&
    QUALITY.interactionDpr === null &&
    !QUALITY.picking
  if (!isDefault) {
    console.info(
      `[X-GIS] quality: msaa=${QUALITY.msaa}× dpr=${QUALITY.maxDpr} adaptiveDpr=${QUALITY.interactionDpr ?? 'off'} picking=${QUALITY.picking ? 'on' : 'off'}`,
    )
  }
}

// ── Live accessors (#832 M1 — backend-NEUTRAL, moved from gpu.ts) ──────────────
// Function-accessor form so runtime `map.setQuality(patch)` mutations propagate
// to every read site (a `const X = QUALITY.msaa` would snapshot at module load).
// They live HERE (the neutral core) so camera/projection code can read the
// quality knobs without importing the WebGPU-zone boot module; gpu.ts
// re-exports all four, so every existing import site is unchanged.

export const getSampleCount = (): number => QUALITY.msaa
export const getMaxDpr = (): number => QUALITY.maxDpr
export const isPickEnabled = (): boolean => QUALITY.picking

/** The devicePixelRatio the swapchain is (re)sized to. During an interaction
 *  it drops to `QUALITY.interactionDpr` (when set), otherwise the full
 *  `getMaxDpr()` cap. The render loop MUST derive its per-frame `dpr` from
 *  this SAME value — a divergent cap makes `canvasHeight/dpr` disagree with
 *  the actual buffer size and the zoom-scale jumps on every gesture under
 *  presets that set `interactionDpr`. Single source of truth. SSR/no-GPU → 1. */
export function effectiveDpr(interacting = false): number {
  const cap = interacting && QUALITY.interactionDpr !== null ? QUALITY.interactionDpr : getMaxDpr()
  if (typeof window === 'undefined') return 1
  return Math.min(window.devicePixelRatio || 1, cap)
}

/** The device-pixel-ratio a canvas is CURRENTLY sized at, read back FROM the
 *  canvas — the single geometric authority for every device-px↔CSS-px conversion
 *  that happens OUTSIDE the render loop (project/unproject/getBounds/fitBounds/the
 *  post-compile bounds-fit). `resizeCanvas` sets `canvas.width = floor(clientWidth ·
 *  effDpr)` and may reduce `effDpr` below `effectiveDpr()` to fit the backend's
 *  `maxTextureDimension2D` (#1153 M3); dividing the device width back by the CSS
 *  width recovers EXACTLY that effDpr. So these consumers never re-derive a
 *  `min(devicePixelRatio, maxDpr)` that disagrees with the swapchain the instant the
 *  clamp engages — the swapchain's own size is the one authority (#929 B). Falls back
 *  to the quality-policy dpr only when the canvas has no CSS layout yet (clientWidth
 *  0/absent — pre-first-frame / detached / SSR / a bare test mock). */
export function canvasEffectiveDpr(canvas: { width: number; clientWidth: number }): number {
  const cssW = canvas.clientWidth
  if (cssW > 0 && canvas.width > 0) return canvas.width / cssW
  return effectiveDpr()
}
