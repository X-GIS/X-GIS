import { describe, expect, it } from 'vitest'
import { PriorityQueue, PriorityQueueItemRemovedError } from '../loader/priority-queue'

// Sync scheduler runs `tryRunJobs` inline. Useful when tests want to
// observe a SPECIFIC enqueue → dispatch sequence (e.g. remove before
// dispatch). Most tests use the default microtask scheduler so all
// `add` calls in one synchronous burst batch into a single sort+drain.
function makeSyncQueue<T, R = unknown>(): PriorityQueue<T, R> {
  return new PriorityQueue<T, R>({ schedulingCallback: (fn) => fn() })
}

/** Wait until `q.running` is false. Used after the last awaited job
 *  promise — the `completedCallback` that decrements `currJobs` lives
 *  on the .finally chain, which settles AFTER the awaited promise. */
async function waitIdle(q: { readonly running: boolean }): Promise<void> {
  for (let i = 0; i < 10 && q.running; i++) {
    await Promise.resolve()
  }
}

describe('PriorityQueue', () => {
  it('FIFO order when no priorityCallback is set', async () => {
    const q = makeSyncQueue<string>()
    q.maxJobs = 1
    const log: string[] = []
    const a = q.add('a', () => { log.push('a') })
    const b = q.add('b', () => { log.push('b') })
    const c = q.add('c', () => { log.push('c') })
    await Promise.all([a, b, c])
    expect(log).toEqual(['a', 'b', 'c'])
  })

  it('priorityCallback puts highest-priority item first (sorts LAST → pops first)', async () => {
    // Default microtask scheduler so the three `add` calls batch into
    // ONE sort+drain instead of dispatching the first one immediately.
    const q = new PriorityQueue<{ id: string; pri: number }>()
    q.maxJobs = 1
    // Higher `pri` = higher priority. Comparator returns positive when
    // a is higher priority (sorts a last → popped first).
    q.priorityCallback = (a, b) => a.pri - b.pri
    const log: string[] = []
    const cb = (item: { id: string }): void => { log.push(item.id) }
    const p1 = q.add({ id: 'low',    pri: 1 }, cb)
    const p2 = q.add({ id: 'high',   pri: 10 }, cb)
    const p3 = q.add({ id: 'medium', pri: 5 }, cb)
    await Promise.all([p1, p2, p3])
    expect(log).toEqual(['high', 'medium', 'low'])
  })

  it('honours maxJobs concurrency cap', async () => {
    const q = makeSyncQueue<number, void>()
    q.maxJobs = 3
    let active = 0
    let peak = 0
    const settle: Array<() => void> = []
    const dispatched: Array<Promise<void>> = []
    for (let i = 0; i < 10; i++) {
      dispatched.push(
        q.add(i, async () => {
          active++
          if (active > peak) peak = active
          await new Promise<void>((res) => settle.push(res))
          active--
        }),
      )
    }
    // Drain settle queue one at a time; after each completion the
    // next pending job should dispatch.
    while (settle.length > 0 || active > 0) {
      const next = settle.shift()
      if (next) next()
      // Yield so the microtask scheduling completes.
      await Promise.resolve()
      await Promise.resolve()
    }
    await Promise.all(dispatched)
    expect(peak).toBe(3)
  })

  it('remove() rejects the queued item with PriorityQueueItemRemovedError', async () => {
    const q = makeSyncQueue<string>()
    q.maxJobs = 1
    q.autoUpdate = false // hold off dispatch so we can remove first
    const a = q.add('a', () => 1)
    let caught: unknown = null
    const rejection = a.catch((err) => { caught = err })
    q.remove('a')
    await rejection
    expect(caught).toBeInstanceOf(PriorityQueueItemRemovedError)
    expect(q.has('a')).toBe(false)
  })

  it('removeByFilter rejects every matching queued item', async () => {
    const q = makeSyncQueue<number>()
    q.maxJobs = 1
    q.autoUpdate = false
    const ps = [1, 2, 3, 4, 5].map((i) => q.add(i, () => i).catch(() => 'rejected' as const))
    q.removeByFilter((n) => n % 2 === 0) // drop 2 and 4
    // Re-enable dispatch.
    q.autoUpdate = true
    q.tryRunJobs()
    const results = await Promise.all(ps)
    expect(results).toEqual([1, 'rejected', 3, 'rejected', 5])
  })

  it('running flag reflects queued + active state', async () => {
    const q = makeSyncQueue<number>()
    q.maxJobs = 1
    expect(q.running).toBe(false)
    let release!: () => void
    const job = q.add(1, () => new Promise<void>((res) => { release = res }))
    expect(q.running).toBe(true)
    release()
    await job
    await waitIdle(q)
    expect(q.running).toBe(false)
  })

  it('callback throwing synchronously rejects without leaking the slot', async () => {
    const q = makeSyncQueue<string>()
    q.maxJobs = 1
    const failed = q.add('boom', () => {
      throw new Error('intentional')
    }).catch((e) => (e as Error).message)
    const ok = q.add('ok', () => 'done')
    const [errMsg, okVal] = await Promise.all([failed, ok])
    expect(errMsg).toBe('intentional')
    expect(okVal).toBe('done')
  })
})
