// Dev-only runtime invariant checks — the C `assert()` / `#ifdef DEBUG`
// analog, built for X-GIS's recurring bug archetype:
//
//   "Two sibling paths that MUST agree (fill vs outline, CPU vs GPU
//    projection, polygon shader vs line shader) silently diverge —
//    sub-pixel at native zoom, only visible once an over-zoom / pitch /
//    projection axis AMPLIFIES the drift."
//
// A cross-path assert turns that silent drift into a throw AT the line
// where the two values part, instead of a wrong pixel five boundaries
// (CPU → worker → buffer → shader → composite) downstream with no signal
// pointing back. See .claude/skills/debug-toolkit.
//
// STRIPPING — every check is gated on `import.meta.env.DEV`, which Vite
// replaces with the literal `false` in the production app build, so
// esbuild dead-code-eliminates the body to nothing. It is `true` under
// the dev server AND vitest, so the checks are live exactly when you
// debug or test, and cost zero in shipped builds. The gate is read at
// each call (not via a re-exported const) so the replacement + DCE is
// reliable across modules.

declare global {
  // Vite injects import.meta.env; declare only the flag we read so this
  // compiles without depending on vite/client. Merges with the standard
  // ImportMeta (which already carries `url`, used for worker URLs).
  interface ImportMeta { readonly env: { readonly DEV: boolean } }
}

/** True under dev server + vitest, statically false (and stripped) in the
 *  production app build. Exported for dev-only probe blocks that should
 *  themselves vanish in prod: `if (DEV) { ...expensive cross-check... }`. */
export const DEV: boolean = import.meta.env.DEV

/** Throw in dev iff `cond` is false. `msg` may be a thunk so the failure
 *  string is only built when the assert actually fires. Stripped in prod. */
export function devAssert(cond: boolean, msg: string | (() => string)): void {
  if (!import.meta.env.DEV) return
  if (!cond) throw new Error(`[xgis devAssert] ${typeof msg === 'function' ? msg() : msg}`)
}

/** Cross-path equivalence — two scalar values that MUST agree. The
 *  workhorse for the "sibling paths diverge" archetype. Reports the actual
 *  delta so the failure tells you HOW FAR apart (sub-pixel drift vs gross),
 *  which is the difference between a rounding bug and a wrong-origin bug.
 *  NaN-safe: a NaN on either side fires (a NaN matrix / asin-domain miss is
 *  itself a defect). */
export function devAssertClose(
  a: number, b: number, eps: number, msg: string | (() => string),
): void {
  if (!import.meta.env.DEV) return
  const d = Math.abs(a - b)
  if (!(d <= eps)) {
    throw new Error(`[xgis devAssertClose] ${typeof msg === 'function' ? msg() : msg} — |${a} − ${b}| = ${d} > ${eps}`)
  }
}

/** Watchpoint emulation (gdb `watch`): call each tick with a NAMED value.
 *  The first tick the value moves beyond `eps` from its previous reading,
 *  `onChange` fires (default: console.warn + a captured stack). Unlike a
 *  screenshot — which only sees the one camera you pointed at — this is
 *  EXHAUSTIVE over execution: it catches the divergence on whatever tile /
 *  frame / projection first triggers it, including the axis you never
 *  thought to look at. Stripped in prod. */
const _watch = new Map<string, number>()
export function devWatch(
  name: string, value: number, eps = 0,
  onChange?: (prev: number, next: number) => void,
): void {
  if (!import.meta.env.DEV) return
  const prev = _watch.get(name)
  if (prev !== undefined && Math.abs(prev - value) > eps) {
    if (onChange) onChange(prev, value)
    else console.warn(`[xgis devWatch] ${name}: ${prev} → ${value}\n${new Error().stack ?? ''}`)
  }
  _watch.set(name, value)
}

/** Reset a watchpoint's remembered value (e.g. at the start of a frame /
 *  tile batch so a per-iteration watch doesn't compare across batches). */
export function devWatchReset(name?: string): void {
  if (!import.meta.env.DEV) return
  if (name === undefined) _watch.clear()
  else _watch.delete(name)
}
