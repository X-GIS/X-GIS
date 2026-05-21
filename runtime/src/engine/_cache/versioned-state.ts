// ═══════════════════════════════════════════════════════════════════
// VersionedState — monotonic version counter on mutable cells
// ═══════════════════════════════════════════════════════════════════
//
// iter-282. The Lamport-clock half of the iter-281 structural-key
// pattern. Each mutable state cell that participates in a cache key
// becomes a VersionedState; cache keys read `.version()` instead of
// the cell's raw value. When the cell mutates through .set() the
// version monotonically advances, every cache derived from it
// invalidates on the next key lookup.
//
// Why version instead of value?
//
//   - Object identity comparison breaks structural-hash equality
//     (two Maps with the same entries hash differently if you walk
//     entries; recursing the value is expensive every frame).
//   - Float matrices (cameraMVP) change every frame at micro-noise
//     levels; raw-value hashing produces all-misses. Version bump
//     only on semantic state change (camera.setZoom(x), tile.upload,
//     pipeline.rebuild) gives stable cache hits between meaningful
//     changes.
//   - Integers compose: cache key over N versioned cells is N
//     integers concatenated. O(1) hash. Integer-only key beats
//     value-walk every time.
//
// What this is NOT:
//
//   - A reactive signal. There's no automatic propagation. Cache
//     consumers must explicitly read `.version()` when building keys.
//     The Lamport pattern catches all *observed* dependencies — a
//     dependency you forgot to list still leaks, same as before. The
//     win is INVARIANT: once you list it, version-bump semantics
//     mean you'll never miss an invalidation. The iter-281 pattern
//     (structural-key over a typed state literal) is what guards the
//     "did you list it" question; this versioning layer makes the
//     listing efficient + value-noise-stable.
//
//   - A general-purpose state container. No subscriptions, no
//     notifications. Just a value + a counter.

/** A mutable cell that bumps a monotonic version every time the
 *  value changes through `.set()` or `.bump()`. Cache keys derive
 *  from `.version()` so equal-but-different-reference values still
 *  invalidate downstream caches when explicitly bumped. */
export class VersionedState<T> {
  private _value: T
  private _version = 0

  constructor(initial: T) {
    this._value = initial
  }

  /** Current value (no version bump). */
  get value(): T {
    return this._value
  }

  /** Replace the value AND bump the version. */
  set(next: T): void {
    this._value = next
    this._version = (this._version + 1) | 0
  }

  /** Bump the version without changing the value reference. Use when
   *  you mutated the value in place (e.g. pushed into an array, set
   *  a Map entry) and need to signal downstream caches. */
  bump(): void {
    this._version = (this._version + 1) | 0
  }

  /** Current version. Caches read this when building keys; an
   *  integer compare suffices to know "did the cell change since
   *  the last cached output". */
  version(): number {
    return this._version
  }
}

/** A monotonic integer counter — for state with no underlying value,
 *  just a "changed N times" signal. Examples: `bindGroupRebuildEpoch`
 *  (incremented when the shared bind groups are rebuilt; no value
 *  needed, only "are we on the same generation"). Lighter than
 *  VersionedState because no `_value` slot. */
export class Epoch {
  private _v = 0

  /** Advance the epoch. Cache keys built before this call no longer
   *  match keys built after. */
  bump(): void {
    this._v = (this._v + 1) | 0
  }

  /** Current epoch. */
  value(): number {
    return this._v
  }
}
