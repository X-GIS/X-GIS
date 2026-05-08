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

  sort(): void {
    if (this.priorityCallback !== null) {
      this.items.sort(this.priorityCallback)
    }
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
  }

  /** Drop every queued item for which `filter` returns true. */
  removeByFilter(filter: (item: T) => boolean): void {
    for (let i = 0; i < this.items.length; i++) {
      if (filter(this.items[i])) {
        this.remove(this.items[i])
        i--
      }
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
