// ═══ Link class — the single "how expensive is this connection?" authority ═══
//
// Sibling of `viewport-class.ts`, and deliberately separate from it. That one
// answers "what device is this?"; this one answers "what does a byte cost
// here?". Every bandwidth-shaping decision in the library used to key off
// viewport width ALONE, which conflates the two: a tethered or metered desktop
// received the full 32-concurrent budget plus speculative prefetch, while a
// phone on fast Wi-Fi was throttled to 8 because its screen is small (#1356).
// Width is a proxy for device class and says nothing about link cost.
//
// Lives here rather than beside its callers because the caps it scales are
// spread across @xgis/data (catalog concurrency, per-archive in-flight cap,
// skeleton prewarm) and @xgis/map (prefetch) — the same divergence shape that
// put `isMobileClassViewport` here.

/** The subset of the Network Information API this reads. Declared locally
 *  because `navigator.connection` is not in TypeScript's DOM lib — it is a
 *  Chromium/Android extension, absent on Safari and Firefox. */
interface NetworkInformationLike {
  /** User's declared data-saver preference. */
  readonly saveData?: boolean
  /** Round-trip/downlink bucket, NOT the radio technology: a throttled or
   *  congested 4G link reports '2g'. That is what makes it useful here. */
  readonly effectiveType?: string
}

/** How aggressively to shape traffic.
 *
 *  - `'saver'` — the user asked for less data, or the link is 2g-grade. Drop
 *    everything speculative and take the tightest caps.
 *  - `'reduced'` — 3g-grade. Tighten concurrency; speculation still pays for
 *    itself because the link is usable.
 *  - `'full'` — everything else, INCLUDING every browser without the API. The
 *    library's pre-#1356 behaviour is exactly this branch, so a browser that
 *    exposes no signal is byte-identical to before. */
export type LinkBudgetClass = 'saver' | 'reduced' | 'full'

/** Current link class, feature-detected. Progressive enhancement: absent API
 *  ⇒ `'full'` ⇒ unchanged behaviour.
 *
 *  Reads live on every call. That is right for the CLASSIFIER — its semantics
 *  are what the matrix below tests, and a memo here would make the answer a
 *  function of when you asked. The per-call COST is handled one level up, in
 *  `linkBudgetClassMemoised`, which is what the two shaping helpers call. */
export function linkBudgetClass(): LinkBudgetClass {
  if (typeof navigator === 'undefined') return 'full'
  const c = (navigator as Navigator & { connection?: NetworkInformationLike }).connection
  if (!c) return 'full'
  // saveData is an explicit user request, so it outranks any measurement.
  if (c.saveData === true) return 'saver'
  if (c.effectiveType === 'slow-2g' || c.effectiveType === '2g') return 'saver'
  if (c.effectiveType === '3g') return 'reduced'
  return 'full'
}

/** `linkBudgetClass()` memoised for the lifespan of one microtask.
 *
 *  The docblock above used to argue the opposite — that these are "plain
 *  property reads on a Web IDL object with no layout cost" and so need no
 *  memo, calling the asymmetry with `readInnerWidthMemoised` deliberate. An
 *  owner CPU profile of the deployed build refuted the premise: 96.2 ms of
 *  main-thread self time, 1.4 % of a 6.7 s vector session, inside this
 *  function. `effectiveType` and `saveData` are not field loads — they consult
 *  Blink's NetworkStateNotifier on every get.
 *
 *  The asymmetry was not deliberate, it was an oversight, and
 *  `tile-types.ts:274` is where it shows: `maxConcurrentLoads` reads
 *  `readInnerWidthMemoised()` and `linkScaledConcurrency()` in ONE expression,
 *  memoising the first and not the second — while its own comment records that
 *  this site runs ~50 times in a single frame.
 *
 *  Same mechanism as that memo, for the same reason and with the same window:
 *  valid for this call stack and any sync continuation, dropped on the next
 *  microtask. So the `change` event still lands — a link that degrades
 *  mid-session is picked up on the next frame's first read, which is the
 *  liveness the original docblock actually wanted. */
let _cachedClass: LinkBudgetClass | null = null
function linkBudgetClassMemoised(): LinkBudgetClass {
  if (_cachedClass !== null) return _cachedClass
  const c = linkBudgetClass()
  _cachedClass = c
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(() => {
      _cachedClass = null
    })
  } else {
    // Fire-and-forget by design: the microtask only drops the memo, and the body
    // cannot throw. `void` is the repo's explicit-discard idiom (#1565).
    void Promise.resolve().then(() => {
      _cachedClass = null
    })
  }
  return c
}

/** Whether SPECULATIVE work — fetching tiles the camera may never reach — is
 *  worth its bytes on this link.
 *
 *  Named rather than open-coded because two independent call sites act on it
 *  (the skeleton prewarm budget in @xgis/data, the pan-ahead prefetch pump in
 *  @xgis/map), and `linkBudgetClass() === 'saver'` written out at each is two
 *  authorities for one policy: widening it to also cover `'reduced'` would
 *  otherwise mean finding every site that spelled the comparison itself. */
export function speculativeFetchAllowed(): boolean {
  return linkBudgetClassMemoised() !== 'saver'
}

/** Scale a device-class concurrency cap by link cost.
 *
 *  A divisor rather than a per-class table: the device-class caps already encode
 *  how much parallelism the DEVICE can drain (fetch pressure, decode queue
 *  depth, GPU upload), and link cost is an independent axis that should compose
 *  with it rather than replace it. A table would have to restate every device
 *  cap and would drift the moment one is retuned.
 *
 *  Floors at 2 so a saver-class phone still overlaps one fetch with one decode.
 *  Dropping to 1 serialises the pipeline and makes the map appear hung on
 *  exactly the links where it is already slowest — saving data must not mean
 *  making no progress. */
export function linkScaledConcurrency(deviceCap: number): number {
  switch (linkBudgetClassMemoised()) {
    case 'saver':
      return Math.max(2, deviceCap >> 3)
    case 'reduced':
      return Math.max(2, deviceCap >> 2)
    case 'full':
      return deviceCap
  }
}
