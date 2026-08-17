// ═══ Baked shaders — the lookup STORE the emit seam reads (#1679 phase B, increment 2) ═══
//
// Increment 1 gave the two halves one spelling for every baked id (`ids.ts`). This is the
// other end of that string: the process-scoped map an installed artifact fills and the
// seam (`wgsl-for.ts`, increment 3) asks. Nothing reads it yet — deliberately, so the
// accounting below lands and is gated on its own, before a single call site changes.
//
// ── WHY THREE FALL-THROUGH OUTCOMES AND NOT ONE ──
//
// A lookup that does not serve bytes is not one event. It is three, and only one of them
// is a bug:
//
//   * CLOSED  — the body moved under the bake (`bakedAvailableForBody`). Expected: the
//               artifact embeds EARTH_R / WGS84_A as LITERALS, so on another planet its
//               bytes are wrong and the runtime emit must answer. Costs a slower frame.
//   * ABSENT  — nothing that carries this id's family is installed. Expected all through
//               this campaign: increment 4 installs the BOOT group only (`install.ts`),
//               so every `lazy` id is absent by design, and nine baked GLSL ids are
//               provably unreachable dead payload (#1679's rejected "every registry id
//               is consumed" gate).
//   * MISS    — the family IS installed and the id is NOT in it. A BUG, every time: a
//               call site keyed to a string the bake never wrote. This is the #996 class
//               — silent, permanent, and invisible to every other gate, because a miss
//               just runs the thunk and renders correctly. It is only ever slower.
//
// Folding those into one served/emitted counter is what makes `misses === 0` unassertable
// at the early increments, where most of the closed set is uninstalled by design. Split,
// the gate is meaningful from increment 3 onward.
//
// ── WHAT "INSTALLED" MEANS, and why it is read off the artifact ──
//
// `registry.ts` groups keys by DOWNLOAD FILE (`BakedGroup`), and that grouping is not
// reachable from here: this module runs in the shipped bundle, where a value import of
// the registry drags all 24 dsl emitters back in (Gate 9 of `architecture-invariants`).
// So coverage is not re-spelled — it is READ OFF the installed artifact's own index, at
// `<language>/<family>` granularity (the id's first two tokens; `ids.ts` owns that token
// order). That is strictly finer than the download unit, needs no second authority, and
// survived increment 4 deleting the `group` field outright.
//
// One consequence, and it is the one we want: an index entry whose content hash resolves
// to nothing still registers its family as covered, so a truncated bake reads as MISS —
// a bug, loudly — rather than as an expected ABSENT.
//
// What this granularity does NOT catch is a mistyped FAMILY token (`wgsl/hillshsde/...`),
// which reads ABSENT. That case is caught by name instead: every fall-through id is
// recorded in `bakedSeamEmitted()`, and a gate over the seam's ids belongs against
// `BAKED_SHADER_KEYS` in a test, where the registry IS importable.
//
// ── THE GUARD IS PER LOOKUP ──
//
// Not an install-time snapshot. `bakedAvailableForBody` memoises on (body epoch, meta
// identity), so asking on every lookup is a map read; and it means a process that flips
// to the Moon and back RE-OPENS the bake, where a snapshot would have closed it for the
// rest of the page's life.
//
// ── IMPORT CEILING ──
//
// `../../body-epoch` and `./body-guard` as values, `./registry` for TYPES ONLY. The seam
// will import THIS module, so anything added here lands in the bundle and, worse, could
// close a cycle back through `render/material/wgsl-for.ts`. Neither of the two value
// imports reaches that file (body-epoch is a leaf; body-guard reaches only the two dsl
// const tables), and it stays that way.

import { bodyEpochValue } from '../../body-epoch'
import { bakedAvailableForBody } from './body-guard'
import type { BakedArtifact, BakedMeta } from './registry'

/** One installed source, WITH the meta of the artifact it came from. Per entry rather
 *  than per store: two devices on one page install two artifacts (a WebGL2 map the GLSL
 *  half, a WebGPU map the WGSL half), and the guard must be asked about the artifact that
 *  would actually serve these bytes. */
interface Entry {
  readonly source: string
  readonly meta: BakedMeta
}

interface StoreState {
  /** id → the bytes an artifact installed for it. */
  readonly entries: Map<string, Entry>
  /** `<language>/<family>` → the meta of the artifact that covers it. Present for EVERY
   *  index key, including ones whose content hash did not resolve. */
  readonly coverage: Map<string, BakedMeta>
  hits: number
  misses: number
  absent: number
  closed: number
  /** The ids that were SERVED and the ids that fell through, by name — bounded by the
   *  closed set (106 short strings) because the seam's ids are build-time constants. A
   *  gate that reads only counters cannot name the severed half; these can. An id may
   *  appear in both across a body flip, which is exactly what the flip did to it. */
  readonly served: Set<string>
  readonly emitted: Set<string>
}

const emptyState = (): StoreState => ({
  entries: new Map(),
  coverage: new Map(),
  hits: 0,
  misses: 0,
  absent: 0,
  closed: 0,
  served: new Set(),
  emitted: new Set(),
})

let state: StoreState = emptyState()

/** The id's coverage unit: `<language>/<family>`, i.e. its first two tokens. A
 *  two-token id (`wgsl/text`) is its own unit. */
function coverageKeyOf(id: string): string {
  const afterLanguage = id.indexOf('/')
  if (afterLanguage < 0) return id
  const afterFamily = id.indexOf('/', afterLanguage + 1)
  return afterFamily < 0 ? id : id.slice(0, afterFamily)
}

/** Add this artifact's sources alongside whatever is already installed. The BOOT path:
 *  a second group, or a second device's language, must not evict the first. */
export function mergeBakedSources(artifact: BakedArtifact): void {
  for (const [id, hash] of Object.entries(artifact.index)) {
    state.coverage.set(coverageKeyOf(id), artifact.meta)
    const source = artifact.contents[hash]
    // A dangling hash leaves the family COVERED and the id unserved — see the header:
    // that is a bake drift, and it must read as a miss rather than as an expected absent.
    if (source === undefined) continue
    state.entries.set(id, { source, meta: artifact.meta })
  }
}

/** The store becomes exactly this artifact: previously installed sources AND the
 *  accounting are dropped first. For a caller that wants a defined starting point (a
 *  spec, a process that owns the store outright); anything adding to a store already in
 *  use wants `mergeBakedSources`. */
export function installBakedSources(artifact: BakedArtifact): void {
  state = emptyState()
  mergeBakedSources(artifact)
}

type FallThrough = 'closed' | 'absent' | 'miss'

function fellThrough(id: string, why: FallThrough): undefined {
  state.emitted.add(id)
  if (why === 'closed') state.closed++
  else if (why === 'absent') state.absent++
  else state.misses++
  return undefined
}

/** The baked source for this id, or `undefined` — in which case the caller runs its
 *  thunk exactly as it does today. Every outcome is counted (see the header); the three
 *  undefined-returning ones are told apart, because only `miss` is a bug. */
export function bakedSource(id: string): string | undefined {
  const entry = state.entries.get(id)
  if (entry !== undefined) {
    if (!bakedAvailableForBody(entry.meta)) return fellThrough(id, 'closed')
    state.hits++
    state.served.add(id)
    return entry.source
  }
  const meta = state.coverage.get(coverageKeyOf(id))
  if (meta === undefined) return fellThrough(id, 'absent')
  // Covered but unserved. A closed body is the reason FIRST — a flip must not manufacture
  // a page full of "bugs" out of lookups that would have hit.
  return fellThrough(id, bakedAvailableForBody(meta) ? 'miss' : 'closed')
}

/** The ids this process SERVED from the bake, sorted. */
export function bakedSeamServed(): readonly string[] {
  return [...state.served].sort()
}

/** The ids that fell through to their thunk, sorted — closed, absent and miss together,
 *  because the caller emitted for all three. The counters say which. */
export function bakedSeamEmitted(): readonly string[] {
  return [...state.emitted].sort()
}

export interface BakedStoreStats {
  /** Installed sources, and the `<language>/<family>` units they cover. */
  readonly ids: number
  readonly coverage: number
  readonly hits: number
  /** The bug counter: the family is installed and the id is not in it. */
  readonly misses: number
  readonly absent: number
  readonly closed: number
  /** The body epoch these counters are being read under. A nonzero `closed` means one of
   *  two different things — the process flipped body mid-run, or the artifact was baked
   *  for another planet from the start — and the epoch is what separates them. */
  readonly bodyEpoch: number
}

export function bakedStoreStats(): BakedStoreStats {
  return {
    ids: state.entries.size,
    coverage: state.coverage.size,
    hits: state.hits,
    misses: state.misses,
    absent: state.absent,
    closed: state.closed,
    bodyEpoch: bodyEpochValue(),
  }
}

/** Test-only: drop the installed sources AND the accounting. Does not touch the body
 *  guard's memo — that is `_resetBakedBodyGuardMemo`'s, and a spec that flips bodies
 *  calls both. */
export function _resetBakedStore(): void {
  state = emptyState()
}
