// ═══════════════════════════════════════════════════════════════════
// canonicalJsonStringify — order-stable JSON serialiser
// ═══════════════════════════════════════════════════════════════════
//
// Phase 2.5 US-010 (preview) — replaces `JSON.stringify(value)` at the
// shader-gen-helpers.ts:matchArmsKey site so the variant cache key is
// stable across Node.js versions / engines / serialisation implementations.
//
// `JSON.stringify` traverses object keys in the order the runtime
// stores them. ECMA-262 specifies the order for "integer index" keys
// (numeric ascending) but lets the engine choose for "string" keys
// (typically insertion order, but not guaranteed across versions /
// platforms — V8 and JSC have historically differed). For a content-
// addressed cache key derived from the matchExpr Node's structural
// JSON, that nondeterminism would silently cache-miss across
// engines and bloat the variant pool.
//
// `canonicalJsonStringify` walks the value tree and emits each object's
// keys in lexicographic order. Numbers, strings, booleans, null, and
// arrays pass through unchanged; functions / symbols / undefined are
// dropped per JSON.stringify convention. Plain-object cycles are
// detected and throw (the matchExpr IR is acyclic by construction;
// a cycle indicates a malformed Node tree).

export function canonicalJsonStringify(value: unknown): string {
  // Reset the cycle-detection set per top-level call — the WeakSet is
  // function-local but reused; clear before each call so successive
  // serialisations don't trip on cross-call object identity.
  return walk(value, new WeakSet<object>())
}

function walk(v: unknown, seen: WeakSet<object>): string {
  if (v === null) return 'null'
  switch (typeof v) {
    case 'number':
      // JSON.stringify emits NaN / Infinity as null; mirror that.
      return Number.isFinite(v) ? String(v) : 'null'
    case 'boolean':
      return v ? 'true' : 'false'
    case 'string':
      return JSON.stringify(v) // delegate string escaping to the builtin
    case 'bigint':
      throw new Error('canonicalJsonStringify: bigint not supported')
    case 'function':
    case 'symbol':
    case 'undefined':
      // JSON.stringify drops these at the top level → emit empty.
      // Inside arrays / objects, the caller filters them out before calling walk.
      return 'null'
    case 'object': {
      if (seen.has(v as object)) {
        throw new Error('canonicalJsonStringify: cycle detected')
      }
      seen.add(v as object)
      try {
        if (Array.isArray(v)) {
          const items = v.map((x) => {
            if (x === undefined || typeof x === 'function' || typeof x === 'symbol') return 'null'
            return walk(x, seen)
          })
          return `[${items.join(',')}]`
        }
        // Plain object — sort keys lexicographically.
        const o = v as Record<string, unknown>
        const keys = Object.keys(o).sort()
        const pairs: string[] = []
        for (const k of keys) {
          const child = o[k]
          if (child === undefined || typeof child === 'function' || typeof child === 'symbol')
            continue
          pairs.push(`${JSON.stringify(k)}:${walk(child, seen)}`)
        }
        return `{${pairs.join(',')}}`
      } finally {
        seen.delete(v as object)
      }
    }
  }
  return 'null'
}
