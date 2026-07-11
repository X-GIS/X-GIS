// ═══ Vector drape baked-texture cache policy (#599 I3) ═══
//
// The pure eviction policy for VectorDrapeRenderer's baked-fill cache, split out
// (zero GPU/render imports) so the LRU-cap behaviour is unit-testable without
// standing up the RasterDraper / WebGPU stack. VectorDrapeRenderer owns the Map
// and the destroyTexture side effects; this module only DECIDES which keys go.

/** Plan baked-texture cache evictions: the least-recently-draped entries (lowest
 *  lastCall) that are NOT currently visible, dropped until the cache is back
 *  within `cap`. Mirrors raster-renderer.evictTiles — skip the visible set, drop
 *  the LRU tail past the cap. Returns the cache keys to destroyTexture + delete
 *  (empty when at/under the cap, or when every over-cap entry is still visible —
 *  an on-screen bake is never evicted, which keeps a static globe rebake-free). */
export function planBakeEvictions(
  baked: ReadonlyMap<string, { readonly lastCall: number }>,
  visibleKeys: ReadonlySet<string>,
  cap: number,
): string[] {
  if (baked.size <= cap) return []
  const evictable: Array<[string, number]> = []
  for (const [k, e] of baked) if (!visibleKeys.has(k)) evictable.push([k, e.lastCall])
  evictable.sort((a, b) => a[1] - b[1])
  const n = Math.min(baked.size - cap, evictable.length)
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(evictable[i]![0])
  return out
}
