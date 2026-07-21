// ═══ Label fade ledger — symbol fade-in/out state across prepares ═══
//
// MapLibre-equivalent symbol fading (fadeDuration, default 300 ms) for the
// label + paired-icon path. The collision pass stays BINARY (placed / not
// placed); this ledger turns those binary transitions into per-symbol opacity
// ramps WITHOUT touching placement:
//
//   - prepare() (rare — S16 miss frames) decides per-symbol TARGETS:
//     newly placed keys start at opacity 0 → ramp to 1; keys that vanish
//     ramp to 0 (their last draw is HELD OVER by the stage while visible).
//   - advance() (cheap — every rendered frame, hit AND miss) steps every
//     record toward its target by dt/duration. The renderers then patch the
//     current `FadeRef.a` into their per-draw alpha at draw()-encode time,
//     so a fade never forces a re-prepare and the S16 skip keeps hitting
//     (re-preparing per fade frame would reintroduce the #1177 zoom jank).
//
// Identity: records are keyed by the #728 stable `collisionId`, qualified by
// a per-prepare DISPATCH-ORDER occurrence index (`fadeInstanceKey`) so
// multi-instance ids (same route's repeated shields, world copies of one
// feature) fade independently. Dispatch order is tile-set-stable, so the
// same physical symbol resolves to the same key across prepares; symbols
// without a collisionId (imperative overlays, raw-dataset labels) get no
// ref and render fully opaque exactly as before.
//
// Reversal is smooth by construction: a target flip mid-ramp continues from
// the CURRENT opacity (no restart-from-0 pop when placement flickers).
//
// durationMs = 0 disables the whole feature: place()/refOf() return
// undefined, finishPrepare() returns [], advance() reports inactive — every
// consumer then takes its historical byte-identical path.

/** Mutable per-symbol opacity box. The stage attaches it to a draw at
 *  prepare time; the renderer READS `.a` when encoding that draw (uniform
 *  alpha patch for text, vertex-opacity patch for icons) every frame.
 *  Advance mutates `.a` in place, so replayed (S16-skip) draws fade too. */
export interface FadeRef {
  a: number
}

interface FadeRec {
  ref: FadeRef
  target: 0 | 1
  /** Prepare generation that last placed this key (mark for the
   *  finishPrepare sweep). */
  seenGen: number
}

/** Per-prepare instance key: `collisionId` for the first occurrence,
 *  `collisionId\u0001n` for the n-th repeat (same route's spaced shields,
 *  world copies). U+0001 cannot appear in a collisionId (`<invLayer>\u0000<featureIdentity>`
 *  composition, label-pass.ts labelCollisionId). Both stages derive keys with
 *  THIS function over their own dispatch-order occurrence counters, so a
 *  text symbol and its paired icon land on the same record. */
export function fadeInstanceKey(collisionId: string, occurrence: number): string {
  return occurrence === 0 ? collisionId : `${collisionId}\u0001${occurrence}`
}

/** Clamp a fade-duration input to a non-negative finite number; anything
 *  else (NaN, ∞, negative) becomes 0 = disabled. Shared by the ctor and the
 *  live `setDurationMs` setter so both normalise identically. */
function normFadeDuration(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
}

export class LabelFadeLedger {
  private _durationMs: number
  private readonly records = new Map<string, FadeRec>()
  private gen = 0
  private lastAdvanceMs: number | null = null

  constructor(durationMs: number) {
    this._durationMs = normFadeDuration(durationMs)
  }

  /** Effective fade duration (ms); 0 disables fading. Live-updatable via
   *  `setDurationMs` (reduced-motion / option change, #1260). */
  get durationMs(): number {
    return this._durationMs
  }

  /** #1260 — live fade-duration update (a reduced-motion flip or an option
   *  change, applied without reconstructing the stage). Setting 0 disables
   *  fading and CLEARS in-flight records, so their held-over draws stop and
   *  the symbols render at full opacity on the next prepare instead of
   *  freezing mid-ramp (a disabled ledger's advance() no longer steps them).
   *  A positive value re-enables fading for subsequent placement changes. */
  setDurationMs(durationMs: number): void {
    const d = normFadeDuration(durationMs)
    if (d === this._durationMs) return
    this._durationMs = d
    if (d === 0) this.records.clear()
  }

  /** False when durationMs = 0 — every consumer then takes its historical
   *  (fade-free, byte-identical) path. */
  get enabled(): boolean {
    return this._durationMs > 0
  }

  /** Start a prepare generation. Call once at the top of TextStage.prepare's
   *  emit phase, BEFORE any place() of that prepare. */
  beginPrepare(): void {
    this.gen++
  }

  /** A symbol with stable key `key` was PLACED this prepare. Ensures a
   *  record (new keys start at opacity 0 → fade-in), marks it seen, and
   *  returns the ref whose `.a` the renderer reads. Undefined when fading
   *  is disabled. Idempotent within a prepare. */
  place(key: string): FadeRef | undefined {
    if (!this.enabled) return undefined
    let r = this.records.get(key)
    if (r === undefined) {
      r = { ref: { a: 0 }, target: 1, seenGen: this.gen }
      this.records.set(key, r)
    } else {
      r.target = 1
      r.seenGen = this.gen
    }
    return r.ref
  }

  /** Read-only ref lookup — the icon side follows its paired text's record
   *  and never creates one (text placement is the single authority). */
  refOf(key: string): FadeRef | undefined {
    if (!this.enabled) return undefined
    return this.records.get(key)?.ref
  }

  /** True while `key` is visibly fading OUT (target 0, alpha still > 0) —
   *  the gate for emitting a collision-dropped paired icon one more time
   *  so the badge fades with its text instead of popping. */
  isFadingOut(key: string): boolean {
    const r = this.records.get(key)
    return r !== undefined && r.target === 0 && r.ref.a > 0
  }

  /** End of a prepare: every record NOT placed this generation flips to
   *  fade-out. Returns the keys still visibly fading (the stage re-emits
   *  their held-over draws); fully-faded unseen records are pruned. Empty
   *  when disabled. */
  finishPrepare(): string[] {
    if (!this.enabled) return []
    const out: string[] = []
    for (const [k, r] of this.records) {
      if (r.seenGen === this.gen) continue
      r.target = 0
      if (r.ref.a > 0) out.push(k)
      else this.records.delete(k)
    }
    return out
  }

  /** Step every record toward its target by (now - lastAdvance)/duration.
   *  Call once per RENDERED frame (S16 hit and miss alike), before the
   *  stage renders. Returns:
   *   - anyActive: a ramp is still in flight → the map must keep
   *     scheduling frames (shouldRenderThisFrame hook).
   *   - anyFadeOutCompleted: some fade-out just reached 0 → the pass tags
   *     LABEL dirty once so the next prepare drops the now-invisible
   *     holdover draws (idle stays snap-correct, no alpha-0 quads linger).
   *  The first call after construction applies dt 0 (no clock yet); a large
   *  gap (idle tab) completes ramps in one step, matching wall-clock. */
  advance(nowMs: number): { anyActive: boolean; anyFadeOutCompleted: boolean } {
    const last = this.lastAdvanceMs
    this.lastAdvanceMs = nowMs
    if (!this.enabled || this.records.size === 0) {
      return { anyActive: false, anyFadeOutCompleted: false }
    }
    const step = last === null ? 0 : Math.max(0, nowMs - last) / this.durationMs
    let anyActive = false
    let anyFadeOutCompleted = false
    for (const r of this.records.values()) {
      const a = r.ref.a
      if (a === r.target) continue
      const next = r.target > a ? Math.min(r.target, a + step) : Math.max(r.target, a - step)
      r.ref.a = next
      if (next !== r.target) anyActive = true
      else if (r.target === 0) anyFadeOutCompleted = true
    }
    return { anyActive, anyFadeOutCompleted }
  }

  /** True while any ramp is in flight — the map-level render keep-alive
   *  (mirrors `_sceneHasAnimation` in shouldRenderThisFrame). */
  hasActive(): boolean {
    if (!this.enabled) return false
    for (const r of this.records.values()) {
      if (r.ref.a !== r.target) return true
    }
    return false
  }

  /** Test / diagnostic surface. */
  get size(): number {
    return this.records.size
  }
}

/** Reusable-slot clone of the last PLACED draw per fade key, kept so a
 *  fade-out can keep drawing after its source vanished from a prepare. The
 *  stage's draw payloads carry FrameArena-backed typed arrays (glyphOffsets /
 *  glyphRotations) that are invalidated by the next arena beginFrame, so a
 *  holdover MUST NOT retain the original object — store() shallow-copies the
 *  draw and deep-copies the typed-array fields into per-key reused buffers
 *  (no steady-state allocation while a symbol's glyph count is stable).
 *  Everything else on a draw is heap-owned (GlyphInfo[] comes from the
 *  across-frame string cache) and safe to carry by reference; the stage
 *  clears the store wholesale on atlas eviction, the one event that
 *  invalidates those references. */
export class FadeHoldoverStore<
  D extends { glyphOffsets?: Float32Array; glyphRotations?: Float32Array },
> {
  private readonly records = new Map<string, D>()

  store(key: string, draw: D): void {
    const prev = this.records.get(key)
    const clone: D = { ...draw }
    if (draw.glyphOffsets !== undefined) {
      clone.glyphOffsets = copyF32(draw.glyphOffsets, prev?.glyphOffsets)
    }
    if (draw.glyphRotations !== undefined) {
      clone.glyphRotations = copyF32(draw.glyphRotations, prev?.glyphRotations)
    }
    this.records.set(key, clone)
  }

  get(key: string): D | undefined {
    return this.records.get(key)
  }

  /** Drop clones whose ledger record was pruned. */
  sweep(isLive: (key: string) => boolean): void {
    for (const k of this.records.keys()) {
      if (!isLive(k)) this.records.delete(k)
    }
  }

  clear(): void {
    this.records.clear()
  }

  get size(): number {
    return this.records.size
  }
}

/** Copy `src` into `reuse` when the lengths match (the steady-state
 *  zero-alloc path), else into a fresh exact-length array. */
function copyF32(src: Float32Array, reuse: Float32Array | undefined): Float32Array {
  if (reuse !== undefined && reuse.length === src.length) {
    reuse.set(src)
    return reuse
  }
  return src.slice()
}
