// ═══ Canvas cursor feedback (#1263) — grab / grabbing / pointer ═══
//
// The canvas cursor is a user's primary "can I interact with this?" signal.
// MapLibre/Mapbox set `grab`/`grabbing` on the canvas out of the box and let
// each app hand-roll `pointer`-over-feature; X-GIS ships the whole policy
// built-in because it already tracks pointer-press state (the controller) and
// which layer/feature is under the cursor (the event dispatcher).
//
// SINGLE AUTHORITY — the reason this is a class, not two inline writes. Two
// inputs drive the cursor: an active pointer press (⇒ grabbing) and a hovered
// interactive feature (⇒ pointer). They can be true AT ONCE — a drag begun
// over a clickable feature. If the controller and the dispatcher each wrote
// `canvas.style.cursor` directly they would fight: a hover flush mid-drag
// (pointermove fires every frame, drag or not) would stamp `pointer` over the
// drag's `grabbing`. So both feed booleans into this ONE resolver, which is
// the sole writer of the DOM property and settles the priority once.
//
// HOST-RESPECTING (mirrors map.ts `_setupTouchAction`): when the host has
// already expressed cursor intent — an inline value OR a non-default computed
// one — this controller never manages the cursor at all; `cursor: false` opts
// out entirely. On destroy the applied value is restored, but only if the host
// has not since taken the cursor over (no-clobber).

/** Effective managed cursor. `grab` at rest, `grabbing` during an active
 *  pointer press (drag/rotate), `pointer` while hovering an interactive
 *  feature. */
export type ManagedCursor = 'grab' | 'grabbing' | 'pointer'

/** Pure priority resolver: an active press (grabbing) outranks a feature
 *  hover (pointer), which outranks the rest state (grab). Matches MapLibre —
 *  a drag that begins over a clickable feature reads as `grabbing`, not
 *  `pointer`. Extracted so the priority is unit-testable without a DOM. */
export function resolveCursor(interacting: boolean, hovering: boolean): ManagedCursor {
  if (interacting) return 'grabbing'
  if (hovering) return 'pointer'
  return 'grab'
}

export class CanvasCursorController {
  private interacting = false
  private hovering = false
  /** The cursor value this controller last wrote, or null if it never wrote
   *  (opted out / host intent / disabled). Drives the no-clobber restore. */
  private applied: ManagedCursor | null = null
  private managing = false
  /** Inline cursor present before we claimed it — restored on destroy. */
  private priorInlineCursor = ''

  constructor(
    private readonly canvas: HTMLCanvasElement,
    enabled: boolean,
  ) {
    this.managing = enabled && this.claim()
    // Seed the rest cursor so the canvas reads as draggable before the first
    // interaction (MapLibre sets `grab` via CSS on the container at load).
    if (this.managing) this.apply()
  }

  /** Claim the cursor iff the host has NOT expressed intent — an inline value,
   *  or a non-default computed one. Records the prior inline value for the
   *  restore. Returns false (⇒ never manage) when intent is present or the
   *  canvas has no usable `.style` (a bare unit-test mock). */
  private claim(): boolean {
    const style = (this.canvas as Partial<HTMLCanvasElement>)?.style
    if (!style) return false
    if (style.cursor !== '') return false // inline host intent
    if (typeof getComputedStyle === 'function') {
      const c = getComputedStyle(this.canvas).cursor
      // 'auto'/'default' are the canvas defaults, not authorial intent.
      if (c !== '' && c !== 'auto' && c !== 'default') return false
    }
    this.priorInlineCursor = style.cursor // === ''
    return true
  }

  /** Pointer pressed (drag/rotate active) ⇒ `grabbing`. Idempotent. */
  setInteracting(v: boolean): void {
    if (v === this.interacting) return
    this.interacting = v
    this.apply()
  }

  /** Pointer over an interactive feature ⇒ `pointer` (unless a press is
   *  active, which outranks it). Idempotent. */
  setHovering(v: boolean): void {
    if (v === this.hovering) return
    this.hovering = v
    this.apply()
  }

  private apply(): void {
    if (!this.managing) return
    const next = resolveCursor(this.interacting, this.hovering)
    if (next === this.applied) return
    ;(this.canvas as HTMLCanvasElement).style.cursor = next
    this.applied = next
  }

  /** Restore the pre-claim inline cursor, but only if our value is still the
   *  live one (no-clobber: a host that took the cursor over mid-session keeps
   *  it). Idempotent — safe to call once, from map.destroy(). */
  destroy(): void {
    if (!this.managing) return
    this.managing = false
    const style = (this.canvas as Partial<HTMLCanvasElement>)?.style
    if (style && this.applied !== null && style.cursor === this.applied) {
      style.cursor = this.priorInlineCursor
    }
    this.applied = null
  }
}
