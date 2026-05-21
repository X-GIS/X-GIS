// ═══════════════════════════════════════════════════════════════════
// Structural Key — auto-derived hash from a typed state object
// ═══════════════════════════════════════════════════════════════════
//
// iter-281. Replaces manual cache-key concatenation (the iter-226
// `${kh}:${woh}:${ueXor}:${rebuildEpoch}:${pickOn}:${samples}…`
// pattern) with a single `structuralHash(stateObject)` call. Adding a
// new dependency to a cached computation is now ONE line at the call
// site (new property on the state literal) instead of THREE (read the
// new value, splice it into the manual string, remember to also bump
// any consumer that read the old key shape).
//
// The bundle path regression in iter-275/276 (re-enabled bundle path
// based on a static-screenshot gate that missed per-tile uniform writes
// the bundle replay depends on) is the canonical example of why
// manual keys break: every refactor adds another invisible dimension,
// the key catches some, misses others, and a sample-based gate cannot
// reliably distinguish "GPU non-determinism noise" from "missed
// invariant". The structural pattern below makes the dependency set
// explicit, type-checked, and exhaustively visible at the call site.
//
// Hashing strategy: depth-first FNV-1a 32-bit over a stable key order
// for objects, insertion order for arrays. Single 32-bit number, fits
// existing cache-key infrastructure (BundleCache keys strings, but
// `.toString(36)` keeps the encoded form short). Collision domain at
// 32-bit = ~4 G distinct states; bundle cache map size is bounded at
// ~hundreds of entries so birthday-paradox collision risk is
// negligible (~1 in 50M for 100 keys).
//
// What this does NOT do:
//
//   - Track which fields were actually READ during the cached
//     computation. That requires a reactive system (signals / Solid
//     / MobX / React Forget) which is invasive to retrofit. The
//     structural-key approach is a deliberate point on the
//     "explicit ↔ automatic" trade-off curve: explicit listing at the
//     call site, automatic hashing of the listed inputs.
//
//   - Provide structural equality. Only hash. Hash collision means
//     two different states might produce the same cache key; if your
//     cache value is sensitive to that distinction, key the cache by
//     the full state object reference, not by this hash.

/** FNV-1a 32-bit mixing step. */
function fnv(h: number, v: number): number {
  return Math.imul(h ^ (v | 0), 0x01000193) | 0
}

/** Hash a 32-bit string char-by-char. */
function hashString(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = fnv(h, s.charCodeAt(i))
  return h
}

/** Recursively hash any JSON-like value. Object keys are visited in
 *  sorted order so structurally-equal objects with different
 *  insertion order produce the same hash. */
function hashValue(h: number, v: unknown): number {
  if (v === null || v === undefined) return fnv(h, 0)
  switch (typeof v) {
    case 'number':
      // Floor-bias to mix the integer half into the hash. Floats with
      // identical integer parts but different fractions hit the same
      // bucket — acceptable for the cache-key use case (zoom 11.231
      // and 11.234 don't need distinct bundles), and the caller can
      // pre-bucket (e.g., Math.round(zoom * 100)) for finer-grain
      // when it matters.
      return fnv(h, v | 0)
    case 'boolean':
      return fnv(h, v ? 1 : 0)
    case 'string':
      return hashString(h, v)
    case 'object':
      if (Array.isArray(v)) {
        // Array order is significant (sorted-set semantics need the
        // caller to sort before passing in).
        let hh = fnv(h, v.length)
        for (let i = 0; i < v.length; i++) hh = hashValue(hh, v[i])
        return hh
      }
      // Plain object — visit sorted keys so structurally-equal objects
      // built in different orders produce the same hash.
      let hh = h
      const keys = Object.keys(v as object).sort()
      for (const k of keys) {
        hh = hashString(hh, k)
        hh = hashValue(hh, (v as Record<string, unknown>)[k])
      }
      return hh
    default:
      return h
  }
}

/** Type-checked structural hash over a state object.
 *
 *  Usage:
 *
 *      const state = {
 *        tiles: neededKeys.slice().sort(),
 *        epochs: neededKeys.map(k => layerCache.get(k)?.uploadEpoch ?? 0),
 *        cameraBucket: Math.round(camera.zoom * 100),
 *      } as const
 *      const cacheKey = `vt:${structuralHash(state).toString(36)}`
 *
 *  Adding a new dependency = one new property on the literal. The hash
 *  changes automatically the moment the new property's value changes,
 *  so the cache invalidates without any string-concat update or any
 *  test that has to be revised in sync. */
export function structuralHash<T extends object>(state: Readonly<T>): number {
  // FNV-1a 32-bit start constant.
  return hashValue(0x811c9dc5 | 0, state) >>> 0
}

/** Convenience: hash + base36 encode in one call. Produces the same
 *  short string the iter-226 manual cache keys used. */
export function structuralHashKey<T extends object>(state: Readonly<T>): string {
  return structuralHash(state).toString(36)
}
