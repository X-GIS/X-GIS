<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# _cache

## Purpose
Cache-key infrastructure that replaces hand-concatenated cache keys (the old `${kh}:${woh}:${ueXor}:...` pattern) with type-safe, auto-derived, version-aware keys. Three legs: a structural hash over a typed state object, a Lamport-clock version counter on mutable cells, and an explicit key-shape type so adding a new cache dependency is a one-line type-checked change instead of a silently-forgotten string field. Used by the render-bundle cache and other memoized per-frame computations.

## Key Files
| File | Description |
|------|-------------|
| `structural-key.ts` | `structuralHash(stateObject)` — auto-derives a hash from a typed state object. Adding a dependency = one field, no manual concatenation. |
| `versioned-state.ts` | `VersionedState` — monotonic version counter on a mutable cell; cache keys read `.version()` not the raw value, bumped on `.set()`. The Lamport-clock half of the pattern. |
| `bundle-cache-key.ts` | Explicit TYPE for the render-bundle cache key shape — adding a new dependency to the bundle key becomes a compile error until handled. |

## For AI Agents

### Working In This Directory
- These are pure, GPU-free utilities. The whole point is to make cache-invalidation bugs into compile errors — when a memoized computation gains a new dependency, add it to the typed key here, never as a loose string concat at the call site.
- `VersionedState.version()` must monotonically increase on every mutation; never reset it without invalidating consumers.

### Testing Requirements
- `structural-key.test.ts`, `versioned-state.test.ts`, `bundle-cache-key.test.ts`. Add a case proving a new dependency changes the key (and that an unchanged state does not).

### Common Patterns
- Typed state object → structural hash → versioned cells. Cache miss should be impossible to forget by construction.

## Dependencies

### Internal
- None beyond local modules.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
