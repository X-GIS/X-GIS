// ═══ DEV owner-leak detector (#2266, ownership P0b) ═══
//
// GPU bytes exert no JS GC pressure ("the iOS staircase"), so an owner that
// goes unreachable WITHOUT destroy() leaks device memory until whole-device
// teardown with no symptom the heap profiler will attribute. This detector
// makes that class LOUD in dev: an owner registers at construction and
// unregisters in destroy(); if the GC collects a still-registered owner, a
// FinalizationRegistry callback names it.
//
// Deliberately a DETECTOR, never a reclamation path (recorded as a rejected
// alternative in docs/research/2026-09-01-data-ownership-audit.md §7): GC
// timing is non-deterministic and VRAM budgets cannot wait for it.
//
// Cost model: inactive (prod, or `__XGIS_INVARIANTS` unset, or no
// FinalizationRegistry in the environment) every call is one boolean check
// and returns. Active only under DEV + `globalThis.__XGIS_INVARIANTS`, the
// same switch the byte-accounting and replacement-invariant audits use.

import { DEV } from './dev-assert'

/** The registry surface the detector uses — injectable so tests can assert
 *  the register/unregister bookkeeping without depending on real GC timing. */
export interface LeakRegistryLike {
  register(target: object, heldValue: string, unregisterToken: object): void
  unregister(token: object): void
}

let registry: LeakRegistryLike | null | undefined

/** Test seam: inject a fake registry (or null to force-inactive). Passing
 *  undefined restores lazy auto-detection. */
export function _setLeakRegistryForTest(r: LeakRegistryLike | null | undefined): void {
  registry = r
}

function activeRegistry(): LeakRegistryLike | null {
  if (!DEV) return null
  if (!(globalThis as { __XGIS_INVARIANTS?: boolean }).__XGIS_INVARIANTS) return null
  if (registry === undefined) {
    registry =
      typeof FinalizationRegistry === 'undefined'
        ? null
        : new FinalizationRegistry<string>((label) => {
            console.warn(
              `[XGIS LEAK] ${label} was garbage-collected without destroy() — ` +
                `a GPU-holding owner went unreachable undestroyed (its device ` +
                `memory is stranded until whole-device teardown).`,
            )
          })
  }
  return registry
}

/** Register a GPU-holding owner at construction. `label` names it in the
 *  leak warning (e.g. 'Material', 'GPUArena poly-vertex'). The object itself
 *  is the unregister token — pair with {@link untrackOwner} in destroy(). */
export function trackOwner(obj: object, label: string): void {
  activeRegistry()?.register(obj, label, obj)
}

/** Unregister an owner whose destroy() ran — a subsequent collection is then
 *  the normal end of life, not a leak. Safe when tracking was never active. */
export function untrackOwner(obj: object): void {
  activeRegistry()?.unregister(obj)
}
