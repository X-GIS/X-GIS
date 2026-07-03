// ═══════════════════════════════════════════════════════════════════
// PerfMarks — Plan AAA Phase C.3 (iter-256) diagnostic
// ═══════════════════════════════════════════════════════════════════
//
// Per-phase timing for the per-frame render loop. Tracks rolling
// average per named phase so iter-237/241/etc.-style wall-clock
// variance can be decomposed into "where is the CPU spending the
// frame" rather than guessing.
//
// Usage at a call site:
//
//   import { markStart, markEnd } from '../__profile__/perf-marks'
//   markStart('render.tile-select')
//   doStuff()
//   markEnd('render.tile-select')
//
// Cost: ~50 ns per mark pair (two `performance.now()` calls + a
// Map.get/set). Negligible vs the phases being measured.
//
// Read: `globalThis.__xgisPerfPhases.get()` returns the rolling
// average per phase in ms. Window size = 60 frames; older samples
// fall off the ring buffer.

interface PhaseState {
  startTs: number // -1 when not active
  /** iter-263 — per-call ring (legacy, averages per invocation). */
  ring: Float32Array
  ringIdx: number
  ringFilled: number
  /** iter-263 — per-frame ring (sum of all durations within ONE
   *  frame, captured at endOfFrame call). Use for sub-marks that
   *  fire multiple times per frame to get true "how much per
   *  frame" instead of averaged-per-call. */
  perFrameSum: number
  perFrameRing: Float32Array
  perFrameRingIdx: number
  perFrameRingFilled: number
}

const WINDOW = 60

// iter-XXX — perf-marks are a diagnostic, not a production feature. Recording
// costs ~8-12% of frame CPU during high-pitch drag (measured #2 hottest file),
// so it is OFF by default and markStart/markEnd/flushPerFrameMarks early-return
// to do zero performance.now()/Map work. Opt in via `__xgisPerfMarks = true`
// before load, or call setPerfMarksEnabled(true) at runtime, to restore full
// diagnostics. The recorded semantics are identical when enabled.
// Enable via (a) `__xgisPerfMarks = true` before load, (b) the `?perfmarks=1`
// URL flag, or (c) the `?gpuprof=1` flag (so the GPU-timer profiling URL also
// turns on the CPU per-pass marks — one flag arms the whole mobile scoreboard),
// or (d) setPerfMarksEnabled(true) / __xgisPerfPhases.setEnabled(true) at runtime.
function urlPerfFlag(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const p = new URL(window.location.href).searchParams
    return p.get('perfmarks') === '1' || p.get('gpuprof') === '1'
  } catch {
    return false
  }
}
let ENABLED =
  (globalThis as { __xgisPerfMarks?: boolean }).__xgisPerfMarks === true || urlPerfFlag()

/** Toggle perf-marks recording. Off by default in production. */
export function setPerfMarksEnabled(b: boolean): void {
  ENABLED = b
}

const _states = new Map<string, PhaseState>()

function getOrCreate(name: string): PhaseState {
  let s = _states.get(name)
  if (!s) {
    s = {
      startTs: -1,
      ring: new Float32Array(WINDOW),
      ringIdx: 0,
      ringFilled: 0,
      perFrameSum: 0,
      perFrameRing: new Float32Array(WINDOW),
      perFrameRingIdx: 0,
      perFrameRingFilled: 0,
    }
    _states.set(name, s)
  }
  return s
}

export function markStart(name: string): void {
  if (!ENABLED) return
  const s = getOrCreate(name)
  s.startTs = performance.now()
}

export function markEnd(name: string): void {
  if (!ENABLED) return
  const s = _states.get(name)
  if (s === undefined || s.startTs < 0) return
  const dur = performance.now() - s.startTs
  s.ring[s.ringIdx] = dur
  s.ringIdx = (s.ringIdx + 1) % WINDOW
  if (s.ringFilled < WINDOW) s.ringFilled++
  // iter-263 — accumulate per-frame sum; flushed at endFrame().
  s.perFrameSum += dur
  s.startTs = -1
}

/** iter-263 — flush per-frame accumulators into per-frame ring.
 *  Call once per frame (e.g. from map.ts endFrame). */
export function flushPerFrameMarks(): void {
  if (!ENABLED) return
  for (const s of _states.values()) {
    s.perFrameRing[s.perFrameRingIdx] = s.perFrameSum
    s.perFrameRingIdx = (s.perFrameRingIdx + 1) % WINDOW
    if (s.perFrameRingFilled < WINDOW) s.perFrameRingFilled++
    s.perFrameSum = 0
  }
}

/** Get rolling average per phase (ms). Sorted by descending mean.
 *  iter-263: includes per-FRAME mean alongside per-CALL mean.
 *  Per-call = averaged across invocations (biased when phase fires
 *  N×/frame). Per-frame = total ms spent in this phase per frame
 *  (correct for sub-marks). Use per-frame for budget analysis.
 *
 *  `maxFrameMs` is the WORST single frame in the per-frame ring — the
 *  mean alone hides bursts (a phase that is 2 ms on 59 frames and 50 ms
 *  on one averages ~3 ms), and bursty stalls are exactly the mobile case
 *  we're chasing. Localizing a spike needs the worst frame, not the mean. */
export function getPhaseAverages(): Array<{
  name: string
  meanMs: number
  perFrameMs: number
  maxFrameMs: number
  samples: number
}> {
  const out: Array<{
    name: string
    meanMs: number
    perFrameMs: number
    maxFrameMs: number
    samples: number
  }> = []
  for (const [name, s] of _states) {
    if (s.ringFilled === 0) continue
    let sum = 0
    for (let i = 0; i < s.ringFilled; i++) sum += s.ring[i]!
    let frameSum = 0
    let frameMax = 0
    for (let i = 0; i < s.perFrameRingFilled; i++) {
      const v = s.perFrameRing[i]!
      frameSum += v
      if (v > frameMax) frameMax = v
    }
    const perFrameMs = s.perFrameRingFilled > 0 ? frameSum / s.perFrameRingFilled : 0
    out.push({
      name,
      meanMs: sum / s.ringFilled,
      perFrameMs,
      maxFrameMs: frameMax,
      samples: s.ringFilled,
    })
  }
  out.sort((a, b) => b.perFrameMs - a.perFrameMs)
  return out
}

export function resetPhaseTimings(): void {
  _states.clear()
}

// Side-effect: expose via globalThis for harness + DevTools.
;(
  globalThis as {
    __xgisPerfPhases?: {
      getPhaseAverages: typeof getPhaseAverages
      resetPhaseTimings: typeof resetPhaseTimings
      setEnabled: typeof setPerfMarksEnabled
    }
  }
).__xgisPerfPhases = {
  getPhaseAverages,
  resetPhaseTimings,
  // Exposed so a DevTools / remote-debugged-phone console can arm the per-pass
  // marks at runtime (then drive an animation and read getPhaseAverages()).
  setEnabled: setPerfMarksEnabled,
}
