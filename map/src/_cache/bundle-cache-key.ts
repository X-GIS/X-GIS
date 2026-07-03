// ═══════════════════════════════════════════════════════════════════
// BundleCacheKey — compile-time enforced cache key shape
// ═══════════════════════════════════════════════════════════════════
//
// iter-283. iter-281 (structuralHashKey) hashes any object literal;
// iter-282 (VersionedState/Epoch) versions the cells. This file adds
// the third leg of the pattern: an EXPLICIT TYPE for the bundle
// cache key shape, so adding a new dependency = type-check error
// at every call site until the literal is updated.
//
// Why a separate file:
//
//   - Vector-tile-renderer.ts (5000+ LOC) is not the right home for
//     cross-cutting cache-shape contracts. The type lives here so any
//     future bundle producer (compute-pipeline bundles, OIT bundles,
//     stroke-phase bundles) can share the same key shape and validate
//     against the same type.
//
//   - The type is the canonical "list of dependencies the bundle
//     replay output depends on". Reviewing this file = reviewing the
//     invariant.
//
// What this enables:
//
//   - Add a new dimension (e.g. `cameraMVPBucket`) to BundleKeyState
//     once. Every consumer that builds a BundleKeyState now type-
//     errors until they fill the field. No silent drift.
//
//   - `as const satisfies BundleKeyState` at the call site asserts
//     the literal matches the contract — same idiom Vue / SolidJS
//     use for typed config objects.

/** Bundle cache key state. Every cell that affects the recorded GPU
 *  commands a RenderBundle holds MUST appear here. Adding a new
 *  dependency = new property on this type → call sites fail typecheck
 *  until they're updated.
 *
 *  Conventions:
 *
 *    - String identifiers (sliceLayer, phase, pipeline labels) =
 *      categorical state; stable across frames within one config.
 *
 *    - Number arrays (neededKeys, epochs, fallbackKeys, etc) = per-
 *      tile state; bundle records one set of draws per array
 *      position. Order significant.
 *
 *    - Single integers (bindGroupEpoch, samples, etc) = global state
 *      counters; iter-282 Epoch / VersionedState.version().
 *
 *    - Pipeline labels = the only string field that can be `null`
 *      when a layer has no line stroke / no fallback pipeline; the
 *      structural hash treats null distinctly from any other value. */
export interface BundleKeyState {
  /** Source-layer name (e.g. 'water', 'roads_*'). */
  readonly sliceLayer: string

  /** Phase tag (`opaque`, `oit-fill`, `strokes`, etc). */
  readonly phase: string

  /** Tile keys this bundle records draws for, in iteration order
   *  matching the bundle's recordTileFill loop. */
  readonly neededKeys: readonly number[]

  /** Per-tile uploadEpoch values, parallel-array indexed to
   *  neededKeys. */
  readonly epochs: readonly number[]

  /** Optional fallback-side tile keys (used by the fallback bundle
   *  path). Null on the primary path. */
  readonly fallbackKeys?: readonly number[] | null

  /** Optional fallback-side visible-key array (used to derive stencil
   *  clip rects per fallback tile). Null on the primary path. */
  readonly fallbackVisibleKeys?: readonly number[] | null

  /** World-copy offsets (millidegrees, integer-quantised). Null when
   *  no world-copy enumeration applies. */
  readonly worldOffsets: readonly number[] | null

  /** Epoch.value() of the shared bind-group rebuild counter. Bumped
   *  when tileBgDefault / tileBgFeature are re-created. */
  readonly bindGroupEpoch: number

  /** Whether pick output target is enabled (changes the second color
   *  attachment binding). */
  readonly pickOn: boolean

  /** MSAA sample count. */
  readonly samples: number

  /** Identifying label of the main fill pipeline (variant cache key
   *  proxy). Null if no fill pipeline (line-only show). */
  readonly mainPipelineLabel: string | null

  /** Identifying label of the line pipeline (variant cache key
   *  proxy). Null if no line pipeline (fill-only show). */
  readonly linePipelineLabel: string | null
}

/** Type guard — pinned for tests + future runtime assertions. */
export function isBundleKeyState(v: unknown): v is BundleKeyState {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.sliceLayer === 'string' &&
    typeof o.phase === 'string' &&
    Array.isArray(o.neededKeys) &&
    Array.isArray(o.epochs) &&
    typeof o.bindGroupEpoch === 'number' &&
    typeof o.pickOn === 'boolean' &&
    typeof o.samples === 'number'
  )
}
