<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# _cache

## Purpose

Type-safe, version-aware cache-key infrastructure for the WebGPU render engine. Replaces the fragile hand-concatenated string keys (the `${kh}:${woh}:${ueXor}:${rebuildEpoch}:...` pattern from iter-226) with three composable primitives: a structural FNV-1a hash over typed state literals, a Lamport-clock version counter for mutable cells, and an explicit compile-time key-shape contract for render-bundle caches. Used by `VectorTileRenderer` bundle caching and any other memoized per-frame computation that needs cache-miss-by-construction guarantees.

## Key Files

| File                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `structural-key.ts`   | `structuralHash<T>(state)` / `structuralHashKey<T>(state)` — iterative (non-recursive, stack-overflow-safe since iter-300) depth-first FNV-1a 32-bit hash over a typed POJO. Sorts object keys for insertion-order independence; handles arrays, primitives, null/undefined, and cycles (WeakSet guard). Base36 convenience wrapper matches the short-key format prior manual keys used.                                                                                                                      |
| `versioned-state.ts`  | `VersionedState<T>` — mutable cell with `.set()`/`.bump()`/`.value`/`.version()`. Version is a 32-bit wrapping int bumped on every semantic mutation; cache keys read `.version()`, not the raw value, so float-matrix noise and same-reference mutations never cause spurious misses or false hits. Also exports `Epoch` — a lighter counter (no `_value` slot) for pure generation signals like `bindGroupRebuildEpoch`.                                                                                    |
| `bundle-cache-key.ts` | `BundleKeyState` interface — the canonical list of every dimension a `RenderBundle`'s recorded GPU commands depend on: `sliceLayer`, `phase`, `neededKeys`, `epochs`, `fallbackKeys`, `fallbackVisibleKeys`, `worldOffsets`, `bindGroupEpoch`, `pickOn`, `samples`, `mainPipelineLabel`, `linePipelineLabel`. Adding a new bundle dependency = one new required field here; every call site that builds a `BundleKeyState` literal fails typecheck until updated. Also exports `isBundleKeyState` type guard. |

## For AI Agents

### Working In This Directory

- All three files are pure, GPU-free utilities — no WebGPU imports, no DOM, no async.
- The structural hash is intentionally NOT a structural-equality check. Hash collision (32-bit FNV, ~1-in-50M for hundreds of keys) means a cache hit on a different state is theoretically possible; do not use it where false positives are safety-critical — use `VersionedState` version integers for those paths.
- `VersionedState.version()` must only increase. Never reset it without invalidating all consumers.
- When adding a bundle dependency, add the field to `BundleKeyState` first, then fix all build errors at call sites. Never add a field only to the call-site literal without adding it to the type — TypeScript's excess-property check on `satisfies` will silently pass extra fields.
- The iterative `hashValue` stack in `structural-key.ts` pushes keys as strings and values interleaved in reverse order; maintain that push order if extending the walk (object keys must remain sorted for determinism).
- `Epoch.value()` returns the counter; `VersionedState.version()` does the same — don't mix them up with `.value` (the raw cell value on `VersionedState`).

### Testing Requirements

- Test files: `structural-key.test.ts`, `versioned-state.test.ts`, `bundle-cache-key.test.ts` (all co-located).
- Any change to `BundleKeyState` must be accompanied by a test asserting the new field causes a hash change when it differs.
- Tests for `structuralHash` must cover: same-structure-different-order objects hash equally (sorted keys), arrays with same values but different length hash differently, cycle detection does not throw.

### Common Patterns

- Bundle cache key construction: build a `BundleKeyState` literal with `as const satisfies BundleKeyState`, pass to `structuralHashKey`, prefix with a namespace (`vt:`, `oit:`, etc.).
- Mutable epoch wiring: hold an `Epoch` on the owner object, call `.bump()` in any mutating path, read `.value()` inside the `BundleKeyState` literal as `bindGroupEpoch`.
- Expensive object cells (Maps, tile arrays): wrap in `VersionedState`, call `.bump()` after in-place mutations, expose `.version()` to cache key construction.

## Dependencies

### Internal

- None beyond local modules (no imports from other X-GIS packages).

### External

- None (pure TypeScript, no npm dependencies).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
