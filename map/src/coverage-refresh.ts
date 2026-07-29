// ═══ Coverage refresh — conditional revalidation + the auto-refetch timer (#1158) ═══
//
// A `coverage` source fetched once at attach. A cell at a ROLLING url (a rolling
// NOAA S-111 cycle, a re-issued S-102 cell) changes underneath that read, so
// tracking it live meant the host running its own timer and pushing bytes back through
// `setCoverageData`. This owns the part that is actually library-worthy: deciding
// whether a re-read is needed at all, and not tearing the display when one is in flight.
//
// REVALIDATION IS A PROBE, NOT A CONDITIONAL GET. The read path is HTTP Range
// (`fetchCoverageHandle`), and hanging `If-None-Match` on a ranged read invites a 304
// the reader cannot consume. So a refresh HEADs the url, compares ETag / Last-Modified
// against what the last read saw, and skips the read entirely when they match — one
// cheap request in the common "nothing changed" case.
//
// DEGRADE GRACEFULLY, DO NOT FAIL LOUDLY. The reader's loud-failure contract is about
// PARSING (a mis-parse of navigation data is unacceptable); this is network policy. A
// proxy that blocks HEAD, or a CORS response that does not expose ETag, must fall back
// to "re-read unconditionally" — a throw here would kill the polling loop instead of
// costing it some bandwidth.

/** The cache validators a probe recovered; null when the server exposed neither. */
export interface CoverageValidator {
  etag: string | null
  lastModified: string | null
}

/** Why a refresh did (or did not) re-read. `unchanged` is the only one that skips.
 *  A blocked/failed probe is reported as `no-validator` — from the decision's point of
 *  view "the server told us nothing" and "we could not ask" are the same state. */
export type RefreshReason =
  'unchanged' | 'validator-changed' | 'first-probe' | 'no-validator' | 'forced'

export interface RefreshDecision {
  read: boolean
  reason: RefreshReason
}

/** Pull the cache validators out of a probe response's headers. */
export function readValidator(headers: Headers): CoverageValidator | null {
  const etag = headers.get('etag')
  const lastModified = headers.get('last-modified')
  return etag || lastModified ? { etag, lastModified } : null
}

/** True when two validators identify the SAME representation. ETag wins when both
 *  carry one (it is the stronger validator); Last-Modified is the 1-second-granularity
 *  fallback. Two nulls are NOT a match — "we know nothing" must never read as "unchanged". */
export function validatorsMatch(
  a: CoverageValidator | null | undefined,
  b: CoverageValidator | null | undefined,
): boolean {
  if (!a || !b) return false
  if (a.etag && b.etag) return a.etag === b.etag
  if (a.lastModified && b.lastModified) return a.lastModified === b.lastModified
  return false
}

/** Decide whether a refresh must re-read. Every uncertain case reads: the cost of a
 *  needless read is bandwidth, the cost of a wrongly-skipped one is a stale chart. */
export function decideRefresh(
  stored: CoverageValidator | null | undefined,
  probed: CoverageValidator | null,
  force = false,
): RefreshDecision {
  if (force) return { read: true, reason: 'forced' }
  if (!probed) return { read: true, reason: 'no-validator' }
  if (!stored) return { read: true, reason: 'first-probe' }
  return validatorsMatch(stored, probed)
    ? { read: false, reason: 'unchanged' }
    : { read: true, reason: 'validator-changed' }
}

/** Probe a coverage url for its cache validators without downloading it. Returns null
 *  when the server exposes none, blocks HEAD, or the request fails — all of which mean
 *  "cannot tell", which `decideRefresh` turns into a read. */
export async function probeValidator(
  url: string,
  fetchFn: typeof fetch,
): Promise<CoverageValidator | null> {
  try {
    const response = await fetchFn(url, { method: 'HEAD' })
    return response.ok ? readValidator(response.headers) : null
  } catch {
    return null
  }
}

/** Per-source refresh state: the last-seen validator, a supersession epoch, and the
 *  polling timer.
 *
 *  The epoch is the same discipline `CoverageTimePlayer` uses for forecast stepping — a
 *  slow re-read that a newer refresh has superseded must never arm its stale handle.
 *  The timer re-arms only AFTER a tick settles, so a tick slower than the interval
 *  cannot stack up overlapping reads.
 *
 *  Deliberate divergence from `CoverageTimePlayer`: a failed tick does NOT stop the
 *  loop. That player steps within an already-loaded cell, where a failure means a real
 *  bug; this one polls a network that is allowed to blip, and a loop that dies on the
 *  first flaky response is not a refresh policy. Failures surface through `onError`. */
export class CoverageRefreshScheduler {
  private readonly validators = new Map<string, CoverageValidator>()
  private readonly epochs = new Map<string, number>()
  /** `gen` distinguishes successive `start()` calls for one source, so a tick that was
   *  in flight when the loop restarted cannot re-arm on top of the new loop. */
  private readonly timers = new Map<string, { timer: ReturnType<typeof setTimeout>; gen: number }>()
  private generation = 0

  /** Claim the next epoch for `sourceId`; `isCurrent(id, token)` is false once a later
   *  refresh has claimed one. */
  nextEpoch(sourceId: string): number {
    const next = (this.epochs.get(sourceId) ?? 0) + 1
    this.epochs.set(sourceId, next)
    return next
  }

  isCurrent(sourceId: string, token: number): boolean {
    return this.epochs.get(sourceId) === token
  }

  validator(sourceId: string): CoverageValidator | undefined {
    return this.validators.get(sourceId)
  }

  /** Record what the last successful read saw. A null probe FORGETS the stored
   *  validator: keeping a stale one would let a later probe failure be compared against
   *  a validator no longer known to describe the resident data. */
  rememberValidator(sourceId: string, validator: CoverageValidator | null): void {
    if (validator) this.validators.set(sourceId, validator)
    else this.validators.delete(sourceId)
  }

  /** Poll `tick` every `intervalMs`, re-arming only after each tick settles. Restarts
   *  cleanly if already running for this source. `intervalMs` is clamped to ≥ 1000 —
   *  a sub-second poll of a remote cell is never the right answer. */
  start(
    sourceId: string,
    intervalMs: number,
    tick: () => Promise<void>,
    onError?: (err: unknown) => void,
  ): void {
    this.stop(sourceId)
    const delay = Math.max(1000, Math.floor(intervalMs))
    const gen = ++this.generation
    const run = async (): Promise<void> => {
      try {
        await tick()
      } catch (err) {
        onError?.(err)
      }
      // Re-arm only if THIS loop still owns the source — a stop() during the tick drops
      // the entry, and a restart replaces `gen`, so neither can be re-armed over.
      if (this.timers.get(sourceId)?.gen === gen)
        this.timers.set(sourceId, { timer: setTimeout(() => void run(), delay), gen })
    }
    this.timers.set(sourceId, { timer: setTimeout(() => void run(), delay), gen })
  }

  stop(sourceId: string): void {
    const entry = this.timers.get(sourceId)
    if (entry !== undefined) {
      clearTimeout(entry.timer)
      this.timers.delete(sourceId)
    }
  }

  stopAll(): void {
    for (const entry of this.timers.values()) clearTimeout(entry.timer)
    this.timers.clear()
  }

  isRunning(sourceId: string): boolean {
    return this.timers.has(sourceId)
  }
}
