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

/** Iterative depth-first hash. iter-300 replaces the prior recursive
 *  walk that risked a JS engine stack overflow on a state object
 *  containing deeply-nested data (per the iter-298/299 path on
 *  filter-eval's computeSliceKey, same class of risk).
 *
 *  Stack growth is O(frontier-of-tree-at-each-pop) not
 *  O(tree-depth), so a state literal with a 10 K-element array runs
 *  fine — the prior recursive version would tail-recurse through
 *  the array via the for-loop but a nested object chain blew up at
 *  ~5 K depth.
 *
 *  Cycles (defensive — POJOs shouldn't normally cycle): tracked via
 *  WeakSet, emit a fixed marker on re-entry instead of looping. */
function hashValue(h: number, root: unknown): number {
  let acc = h
  const stack: unknown[] = [root]
  const visited = new WeakSet<object>()
  // Phantom marker pushed AFTER object/array open so the
  // children-then-close hash order matches the prior recursive
  // shape (avoids destabilising the hash space vs iter-281).
  const _END = { __end: true } as const
  while (stack.length > 0) {
    const v = stack.pop()
    if (v === _END) {
      // No-op: the prior recursive version had no explicit close
      // marker. Kept here for future shape changes that need one.
      continue
    }
    if (v === null || v === undefined) {
      acc = fnv(acc, 0)
      continue
    }
    const t = typeof v
    if (t === 'number') {
      acc = fnv(acc, (v as number) | 0)
      continue
    }
    if (t === 'boolean') {
      acc = fnv(acc, (v as boolean) ? 1 : 0)
      continue
    }
    if (t === 'string') {
      acc = hashString(acc, v as string)
      continue
    }
    if (t === 'object') {
      const obj = v as object
      if (visited.has(obj)) {
        // Cycle — emit a fixed marker (distinct from null) and
        // skip the children.
        acc = fnv(acc, 0xfade)
        continue
      }
      visited.add(obj)
      if (Array.isArray(v)) {
        // Array length is mixed in first (matches iter-281 shape).
        acc = fnv(acc, (v as unknown[]).length)
        // Push children in REVERSE so they pop in original order.
        const arr = v as unknown[]
        for (let i = arr.length - 1; i >= 0; i--) stack.push(arr[i])
        continue
      }
      // Plain object — visit sorted keys for insertion-order
      // independence. Push (value) then (key-as-string) so the
      // pop order interleaves key/value just like the recursive
      // version's `hashString(hh, k); hashValue(hh, o[k])`.
      const o = v as Record<string, unknown>
      const keys = Object.keys(o).sort()
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i]!
        stack.push(o[k])
        stack.push(k) // string — gets hashed via hashString branch
      }
      continue
    }
    // function / symbol / bigint — unreachable for normal state
    // literals but defensive.
  }
  return acc
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
