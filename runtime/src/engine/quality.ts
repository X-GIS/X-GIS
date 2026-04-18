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

// Inline isMobile rather than import from gpu.ts to avoid a circular
// dependency: gpu.ts now imports QUALITY from this module to derive
// SAMPLE_COUNT and MAX_DPR.
function isMobile(): boolean {
  if (typeof window === 'undefined') return false
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const narrow = (window.innerWidth || 0) <= 900
  return coarse && narrow
}

export interface QualityConfig {
  /** MSAA sample count: 1, 2, or 4. Init-time only — pipelines bake
   *  sampleCount, runtime change requires page reload. Higher = smoother
   *  polygon edges, more fragment work. SDF line strokes carry their own
   *  1-px shader AA so 1× is acceptable for stroke-heavy scenes. */
  msaa: 1 | 2 | 4
  /** Max devicePixelRatio cap. Lower = fewer pixels processed but blurrier
   *  on hi-DPI displays. 1.0 effectively disables retina scaling. */
  maxDpr: number
  /** During pointer/wheel interaction, drop DPR to this value; restore to
   *  `maxDpr` on idle. null = always `maxDpr`. Pan motion blur naturally
   *  hides lower DPR aliasing, so this trades nothing visible during
   *  the moments the user is actively dragging. */
  interactionDpr: number | null
}

export const QUALITY_PRESETS = {
  /** Current behavior — full quality, no perf opt-ins. Default to preserve
   *  back-compat with all existing deployments. */
  default: {
    msaa: 4,
    maxDpr: 2,
    interactionDpr: null,
  },
  /** 144fps target. MSAA off, DPR 1.0, no adaptive (since DPR is already
   *  minimum). Required for GPU-bound scenes on low-end devices. */
  performance: {
    msaa: 1,
    maxDpr: 1.0,
    interactionDpr: null,
  },
  /** Desktop sweet spot: full quality at rest, drop DPR during pan to
   *  preserve smoothness without sacrificing static fidelity. */
  balanced: {
    msaa: 2,
    maxDpr: 2,
    interactionDpr: 1.5,
  },
  /** Mobile / low-power. Aliased from the existing `?safe=1` flag for
   *  back-compat. Roughly matches the prior mobile defaults. */
  battery: {
    msaa: 1,
    maxDpr: 1.5,
    interactionDpr: 1.0,
  },
} as const satisfies Record<string, QualityConfig>

export type QualityPreset = keyof typeof QUALITY_PRESETS

function readURL(): URLSearchParams | null {
  if (typeof window === 'undefined') return null
  try { return new URL(window.location.href).searchParams }
  catch { return null }
}

function clampMsaa(n: number): 1 | 2 | 4 {
  if (n === 1 || n === 2 || n === 4) return n
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

  // 2. Mobile detection auto-promotes default → battery so phones don't
  //    have to opt in. Keeps prior mobile behavior identical even when
  //    the user typed no flag.
  if (!presetParam && !safeFlag && isMobile()) {
    base = { ...QUALITY_PRESETS.battery }
  }

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

  return base
}

/** Module-load constant — quality is fixed at app start. msaa changes
 *  require a page reload because pipelines bake `sampleCount`. */
export const QUALITY: QualityConfig = resolveQuality()

if (typeof window !== 'undefined') {
  // Surface non-default quality once so users see the trade-off they
  // opted into. Quiet for default to avoid console noise.
  const isDefault = QUALITY.msaa === 4 && QUALITY.maxDpr === 2 && QUALITY.interactionDpr === null
  if (!isDefault) {
    console.info(`[X-GIS] quality: msaa=${QUALITY.msaa}× dpr=${QUALITY.maxDpr} adaptiveDpr=${QUALITY.interactionDpr ?? 'off'}`)
  }
}
