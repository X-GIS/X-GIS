// DirtyDomains — explicit invalidation bitset (roadmap S3). At S3 this is a
// WRITE-ONLY back-compat wrapper over XGISMap._needsRender: edits tag domains,
// but no per-frame consumer reads it to skip yet, so behavior is unchanged.
// Granular tagging + consumer skips land at S14+. Eight domains:
export const DirtyDomain = {
  CAMERA: 1 << 0,
  VIEWPORT: 1 << 1,
  PROJECTION: 1 << 2,
  STYLE: 1 << 3,
  SOURCE: 1 << 4,
  GEOMETRY: 1 << 5,
  LABEL: 1 << 6,
  CLOCK: 1 << 7,
} as const
/** All domains set — the conservative "rebuild everything" mask (== current
 *  always-render behavior when every invalidate() tags ALL). */
export const DIRTY_ALL = 0xff

/** A bitset of dirty domains. `tag` from the edit side (operators); `consume`
 *  from the eval side (per-frame consumers) reads-and-clears so the next frame
 *  starts clean unless re-tagged. */
export class DirtyTracker {
  // Start fully dirty so the first frame renders everything (matches a fresh
  // map's _needsRender = true).
  private bits = DIRTY_ALL
  /** Edit side: mark domain(s) dirty. Accepts a single flag or an OR of flags. */
  tag(domains: number): void {
    this.bits |= domains
  }
  /** Eval side: returns whether ANY of `domains` was dirty, and clears them. */
  consume(domains: number): boolean {
    const had = (this.bits & domains) !== 0
    this.bits &= ~domains
    return had
  }
  /** Non-destructive read — is any of `domains` currently dirty? */
  peek(domains: number): boolean {
    return (this.bits & domains) !== 0
  }
  /** Any domain dirty at all (mirrors the _needsRender boolean). */
  any(): boolean {
    return this.bits !== 0
  }
  /** Clear everything (mirrors _needsRender = false after a rendered frame). */
  clear(): void {
    this.bits = 0
  }
}
