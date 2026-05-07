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

export const QUALITY_PRESETS = {
  /** Default — render at the device's native pixel density (capped at 3
   *  to bound fragment work on high-DPR displays). The `maxDpr=2` cap
   *  used to silently downscale iPhone DPR=3 to 2× canvas, breaking the
   *  "1 px in style = 1 device px" contract for retina users. Cap at 3
   *  covers every iPhone / common Android device; rare 4× monitors will
   *  still see 3×, which is visually indistinguishable. */
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

export type QualityPreset = keyof typeof QUALITY_PRESETS

function readURL(): URLSearchParams | null {
  if (typeof window === 'undefined') return null
  try { return new URL(window.location.href).searchParams }
  catch { return null }
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

function resolveQuality(): QualityConfig {
  const params = readURL()
  if (!params) return { ...QUALITY_PRESETS.default }

  // 1. Pick base preset. `?safe=1` is back-compat alias for battery.
  let base: QualityConfig
  const presetParam = params.get('quality')
  const safeFlag = params.get('safe') === '1'
  if (presetParam && (presetParam in QUALITY_PRESETS)) {
    base = { ...QUALITY_PRESETS[presetParam as QualityPreset] }
  } else if (safeFlag) {
    base = { ...QUALITY_PRESETS.battery }
  } else {
    base = { ...QUALITY_PRESETS.default }
  }

  // Mobile auto-promotion to `performance` was REMOVED — it lied about
  // the pixel grid. With maxDpr=1.0, a `stroke-1` line was rendered at
  // 1 canvas pixel (= 1 CSS pixel = 3 device pixels after OS upscale on
  // a DPR=3 phone), which contradicts "1 px means 1 device px". Users
  // who need the previous performance behavior can still opt in via
  // `?quality=performance`. The thermal trade-off is now an explicit
  // choice, not silently applied.

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
  // Surface non-default quality once so users see the trade-off they
  // opted into. Quiet for default to avoid console noise.
  const isDefault = QUALITY.msaa === 4 && QUALITY.maxDpr === 2 && QUALITY.interactionDpr === null && !QUALITY.picking
  if (!isDefault) {
    console.info(`[X-GIS] quality: msaa=${QUALITY.msaa}× dpr=${QUALITY.maxDpr} adaptiveDpr=${QUALITY.interactionDpr ?? 'off'} picking=${QUALITY.picking ? 'on' : 'off'}`)
  }
}
