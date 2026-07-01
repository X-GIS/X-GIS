// Priority queue for scheduling async work with a concurrency limit.
//
// TypeScript port of NASA-AMMOS/3DTilesRendererJS
// `src/core/renderer/utilities/PriorityQueue.js` (MIT, used here as the
// algorithmic reference for tile-fetch scheduling). Behaviour-equivalent
// to the source apart from:
//   - Scheduler dependency dropped — default scheduling uses
//     `queueMicrotask`. Tile fetches are network IO, so we don't need
//     rAF gating like the three.js use case.
//   - The deprecated `schedulingCallback` setter / log is omitted.
//
// Items are dispatched via a sort + pop pattern: highest priority sorts
// LAST and pops first. With no `priorityCallback`, the queue degrades to
// FIFO (insertion order) because items are unshifted to the front and
// popped from the back.

export class PriorityQueueItemRemovedError extends Error {
  constructor() {
    super('PriorityQueue: Item removed')
    this.name = 'PriorityQueueItemRemovedError'
  }
}

interface ItemData<T, R> {
  callback: (item: T) => Promise<R> | R
  resolve: (value: R) => void
  reject: (reason: unknown) => void
  promise: Promise<R>
}

export class PriorityQueue<T, R = unknown> {
  /** Maximum number of jobs that can run concurrently. */
  maxJobs = 6

  /** Auto-schedule a `tryRunJobs` after `add` and after each job
   *  completes. */
  autoUpdate = true

  /** Comparator used to sort queued items. Higher-priority items must
   *  sort LAST (return positive when `a` should run before `b`). When
   *  null, queue is FIFO. */
  priorityCallback: ((a: T, b: T) => number) | null = null

  private items: T[] = []
  private callbacks = new Map<T, ItemData<T, R>>()
  private currJobs = 0
  private scheduled = false
  private readonly schedulingCallback: (fn: () => void) => void
  /** Sort idempotency flag. `sort()` no-ops when this is false —
   *  the items haven't changed nor has the comparator's behaviour
   *  signalled an update. `add()` / `remove()` / explicit
   *  `markDirty()` set this to true. VTR clears its distance-memo
   *  on camera move and calls `markDirty()` so the next `sort()`
   *  reorders against the new camera position. */
  private dirty = true

  constructor(opts: { schedulingCallback?: (fn: () => void) => void } = {}) {
    this.schedulingCallback = opts.schedulingCallback ?? ((fn) => queueMicrotask(fn))
  }

  /** Whether tasks are queued or actively running. */
  get running(): boolean {
    return this.items.length !== 0 || this.currJobs !== 0
  }

  has(item: T): boolean {
    return this.callbacks.has(item)
  }

  size(): number {
    return this.items.length
  }

  activeCount(): number {
    return this.currJobs
  }

  /** Force the next `sort()` to actually run. Call when the
   *  comparator's BEHAVIOUR changes for an unchanged item set —
   *  e.g. when VTR clears its distance-memo on camera move, the
   *  same items now compare in a different order. `add()` /
   *  `remove()` mark dirty automatically. */
  markDirty(): void {
    this.dirty = true
  }

  sort(): void {
    if (this.priorityCallback === null) return
    // Idempotency skip — no add/remove and the camera (or other
    // comparator input) hasn't signalled dirty since the last
    // sort. On Bright the same render frame calls sort() once per
    // ShowCommand (~80×); the previous frame already sorted the
    // queue against the current camera, so all but the FIRST call
    // would just re-do the same comparator work.
    if (!this.dirty) return
    // Skip sort when every queued item will dispatch in the next
    // tryRunJobs round — priority order is moot at that point.
    // tryRunJobs caps dispatch at `maxJobs - currJobs`, so when
    // `items.length <= slots` the next loop pops the whole queue
    // regardless of order. The sort skip saves N×log(N) comparator
    // calls multiplied by however many times tryRunJobs fires this
    // frame — and on Bright VTR.render calls drainPendingUploads
    // once per ShowCommand (~80 / frame), so even a 4-item queue's
    // sort showed as ~16 ms in the S1 hitch-frame attribution
    // (`uploadQueue.priorityCallback` × 3 entries).
    const slots = this.maxJobs - this.currJobs
    if (this.items.length <= slots) return
    this.items.sort(this.priorityCallback)
    this.dirty = false
  }

  /** Enqueue. Resolves with the callback's value once it runs; rejects
   *  with `PriorityQueueItemRemovedError` if `remove` is called before
   *  dispatch. */
  add(item: T, callback: (item: T) => Promise<R> | R): Promise<R> {
    let resolve!: (value: R) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<R>((res, rej) => { resolve = res; reject = rej })
    const data: ItemData<T, R> = { callback, resolve, reject, promise }
    this.items.unshift(item)
    this.callbacks.set(item, data)
    this.dirty = true
    if (this.autoUpdate) this.scheduleJobRun()
    return promise
  }

  /** Drop a queued (not-yet-dispatched) item. The item's promise
   *  rejects with `PriorityQueueItemRemovedError`. */
  remove(item: T): void {
    const index = this.items.indexOf(item)
    if (index === -1) return
    const info = this.callbacks.get(item)!
    // Pre-attach a catch so a removed-but-never-awaited item doesn't
    // surface as an unhandled rejection.
    info.promise.catch((err: unknown) => {
      if (!(err instanceof PriorityQueueItemRemovedError)) throw err
    })
    info.reject(new PriorityQueueItemRemovedError())
    this.items.splice(index, 1)
    this.callbacks.delete(item)
    // Removal can't unsettle remaining items' relative order, but
    // it can drop an item that was BLOCKING earlier ones from the
    // "top N slots" partition — re-sort is safest. (Net cost stays
    // zero in steady-state since we only re-sort when called.)
    this.dirty = true
  }

  /** Drop every queued item for which `filter` returns true. Compacts
   *  in-place: O(N) walk + reject + delete. The naive implementation
   *  called `remove(item)` per match — each remove does indexOf (O(N))
   *  and splice (O(N)) so the whole pass was O(N²) when many items
   *  matched. Per-frame `cancelStale` on PMTilesBackend hits this with
   *  the full fetch queue every render frame; in the pan-hitch CPU
   *  profile that bubbled up as `cancelStale` 5.4% of total time on
   *  OFM Bright. */
  removeByFilter(filter: (item: T) => boolean): void {
    const items = this.items
    let removed = 0
    let w = 0
    for (let r = 0; r < items.length; r++) {
      const it = items[r]
      if (filter(it)) {
        const info = this.callbacks.get(it)!
        info.promise.catch((err: unknown) => {
          if (!(err instanceof PriorityQueueItemRemovedError)) throw err
        })
        info.reject(new PriorityQueueItemRemovedError())
        this.callbacks.delete(it)
        removed++
      } else {
        items[w++] = it
      }
    }
    if (removed > 0) {
      items.length = w
      this.dirty = true
    }
  }

  /** Drain the queue up to `maxJobs` concurrent dispatches. */
  tryRunJobs(): void {
    this.sort()
    let iterated = 0
    const completedCallback = () => {
      this.currJobs--
      if (this.autoUpdate) this.scheduleJobRun()
    }
    while (
      this.maxJobs > this.currJobs
      && this.items.length > 0
      && iterated < this.maxJobs
    ) {
      this.currJobs++
      iterated++
      const item = this.items.pop()!
      const info = this.callbacks.get(item)!
      this.callbacks.delete(item)
      let result: Promise<R> | R
      try {
        result = info.callback(item)
      } catch (err) {
        info.reject(err)
        completedCallback()
        continue
      }
      if (result instanceof Promise) {
        result.then(info.resolve).catch(info.reject).finally(completedCallback)
      } else {
        info.resolve(result)
        completedCallback()
      }
    }
  }

  /** Schedule a deferred `tryRunJobs` via `schedulingCallback`. */
  scheduleJobRun(): void {
    if (this.scheduled) return
    this.scheduled = true
    this.schedulingCallback(() => {
      this.scheduled = false
      this.tryRunJobs()
    })
  }
}
