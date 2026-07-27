// ═══ Completion-driven animation loop for host data pushes (#1372) ═══
//
// The "Animate a line" / "Update a feature in realtime" demos push new geometry into a
// declared source and let the engine re-tile it. That round-trip is ASYNCHRONOUS and its cost
// depends on the machine, the data size, and the projection — so a demo that pushes on a fixed
// `setInterval` is guessing. Both demos guessed 3000 ms, with the guess written down as a
// finding: "sub-second re-seed churn starves the virtual-tiling pipeline's worker round-trip
// (tiles never finish before the next churn preempts them), so nothing paints".
//
// A fixed interval can only ever be wrong in one of two directions:
//   • too fast  → each push preempts the previous re-tile, nothing converges, nothing paints;
//   • too slow  → the animation is a step function (measured: the re-tile settles in
//                 1.0-2.7 s under a software rasterizer, so 3 s spends most of the cycle idle,
//                 which reads as a hang rather than an animation).
//
// This loop removes the guess: it pushes, waits for the map to actually SETTLE (the `idle`
// event — fired when the camera is at rest and no source work is pending), then pushes again.
// The cadence becomes whatever the pipeline can sustain: fast on a real GPU, self-throttling on
// a slow one, never preempting itself. Same shape as the S-111 playback fix (#1362): the next
// step is clocked by the previous step's COMPLETION, not by a timer racing it.

/** The slice of XGISMap the loop needs — so it is testable without a map or a GPU. */
export interface SettledLoopMap {
  once(type: 'idle', listener: () => void): void
  off(type: 'idle', listener: () => void): void
}

export interface SettledLoopOptions {
  /** Floor between a settle and the next push (ms, default 60). Keeps a step that settles
   *  instantly from spinning, and sets the animation's maximum frame rate. */
  minStepMs?: number
  /** Cap on how long one step may wait for `idle` (ms, default 1200). A map kept busy by
   *  something else (a sibling animated layer) would otherwise never settle and the loop would
   *  stall; past this the next step goes anyway. Still well under the 3 s blind interval it
   *  replaces, so the worst case is no worse than the old behaviour. */
  maxWaitMs?: number
}

/** Run `step()` repeatedly, each step starting only once the map has settled from the previous
 *  one. Returns the stop function (idempotent); the first step runs immediately. */
export function startSettledLoop(
  map: SettledLoopMap,
  step: () => void,
  opts: SettledLoopOptions = {},
): () => void {
  const minStepMs = Math.max(0, opts.minStepMs ?? 60)
  const maxWaitMs = Math.max(1, opts.maxWaitMs ?? 1200)
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  /** Resolve on the first `idle` after this call, or after `maxWaitMs`, whichever comes first.
   *  Both paths detach the listener, so a stopped loop leaves nothing subscribed. */
  const settled = (): Promise<void> =>
    new Promise((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(guard)
        map.off('idle', onIdle)
        resolve()
      }
      const onIdle = (): void => finish()
      const guard = setTimeout(finish, maxWaitMs)
      map.once('idle', onIdle)
    })

  const run = async (): Promise<void> => {
    while (!stopped) {
      step()
      await settled()
      if (stopped) return
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, minStepMs)
      })
    }
  }
  void run()

  return () => {
    stopped = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
}
