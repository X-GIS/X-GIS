# Phase 1 Plan — Source-Honest Principle + TileScheme Metadata

**Status:** pending approval (consensus loop iteration 2 — Architect/Critic feedback applied)
**Spec:** `D:/X-GIS/.omc/specs/deep-dive-bg-flat-not-projection-curved.md`
**Trace:** `D:/X-GIS/.omc/specs/deep-dive-trace-bg-flat-not-projection-curved.md`
**Branch:** `feature/ecef-tile-pipeline-phase1` (created from `main` before any code change). Two PRs land off this branch in sequence: **1a** then **1b**.
**Scope:** Two cleanly-separated PRs serving distinct risk profiles.
- **Phase 1a** (UX-visible, principle ships): remove polar-cap auto-call from renderer hot path. Keep `setPolarCapsEnabled` as no-op + one-shot warn. Keep all `polar-cap-*` modules + public exports intact (they are the standalone tool the principle defers to).
- **Phase 1b** (invisible scaffolding): add `scheme: TileScheme` field to `TileSourceMeta`. Single-variant union (`'web-mercator-xyz'`). Adds `getSourceScheme(name)` accessor on `TileCatalog`.

No ECEF migration, no shader change, no new tile data formats. That work belongs to Phase 2+.

---

## Requirements Summary

X-GIS currently has two coupled defects:

1. **Renderer auto-invents data** on non-Mercator projection switch — `map.ts:870-872` auto-enables polar-cap synthesis, and `source-manager.ts:469-476` injects synthesized polar geometry into every GeoJSON source via `setSourceData`. The user's source-honest principle forbids this: the renderer must not invent data the source did not provide.
2. **No tile-scheme discriminator** exists. Every backend silently assumes Web Mercator XYZ tile bounds (±85.0511° latitude clamp). Future Phase 2 (ECEF VS) and Phase 3 (EPSG:4326 backend) need a scheme field on backend metadata to branch dispatch safely.

Phase 1a fixes (1). Phase 1b adds the metadata scaffolding for (2). Both land off the same feature branch but as separate PRs so the UX-visible change and the invisible scaffolding have independent review surfaces, CHANGELOG entries, and rollback paths.

## Acceptance Criteria

### Phase 1a — polar-cap auto-call removal (PR #1)

| AC | Criterion | Verification |
|----|-----------|--------------|
| AC1a.1 | `map.ts:870-872` auto-`setPolarCapsEnabled(true)` call on non-Mercator projection switch removed. | Grep for `setPolarCapsEnabled\(true\)` returns no auto-call sites in `map.ts` or `source-manager.ts`. |
| AC1a.2 | `source-manager.ts:469-476` `isPolarCapsEnabled()` branch + `injectPolarCaps` auto-invocation removed from the `setSourceData` path. | Grep + read. |
| AC1a.3 | `XGISMap.setPolarCapsEnabled(...)` public API kept; behavior changes to **no-op + one-shot `xlog.warn(...)`** ("Polar cap synthesis is no longer renderer-driven. Use the `injectPolarCaps` / `synthesizePolarCaps` exports as a pre-processing step on your data, or accept honest source coverage."). Uses `xlog.warn` (not raw `console.warn`) so hosts that registered a log sink via `setLogSink(...)` still capture the warning — host log-sink contract documented at `runtime/src/engine/log.ts:1-23`. No throw — hard-throw would instantly break every globe/ortho/azimuthal demo on next load. | Unit test: `expect(map.setPolarCapsEnabled(true)).not.toThrow()`; spy on the registered log sink shows the one-shot message; repeated calls do not re-warn. |
| AC1a.4 | `synthesizePolarCaps`, `injectPolarCaps`, `findClampBoundarySpans` public exports at `runtime/src/index.ts:6-13` **remain in place**. They are the principle's "standalone tool". | Grep verifies exports intact. |
| AC1a.5 | `polar-cap-detect.ts`, `polar-cap-synth.ts`, `polar-tile-pyramid-gap.test.ts` files **unchanged**. `polar-cap-detect.test.ts` (8 cases) + `polar-cap-synth.test.ts` continue to pass — they exercise the standalone helpers, not the renderer wiring. | `bunx vitest run runtime/src/data/polar-cap-synth.test.ts runtime/src/loader/polar-cap-detect.test.ts runtime/src/engine/projection/polar-tile-pyramid-gap.test.ts` — all green. |
| AC1a.6 | Mercator (`projType 0`) full pixel-diff against pre-change baseline = **byte-identical**, **no snapshot test regenerations required**. Reason: the auto-call is gated by `projType !== 'mercator'` (`map.ts:870`) so for projType 0 the removed branch was dead — removal is provably a no-op on Mercator. | Existing pixel-diff suite + render-gate CI (`gh pr checks`). Snapshot dirs untouched in the diff. |
| AC1a.7 | Non-Mercator projections (1..7) on GeoJSON sources: polar regions **no longer auto-synthesized**. This is the deliberate behavior change. Existing visual baselines that depended on auto-caps are updated with explicit commit note "Phase 1a: polar caps no longer auto-synthesized; source-honest revert of `project_polar_cap_fix_2026_05_18`". | Manual baseline review + PR body documents the unwound feature. |
| AC1a.8 | PR body explicitly references memory `project_polar_cap_fix_2026_05_18.md` and explains the source-honest principle reversal. | PR description inspection. |
| AC1a.9 | All existing tests pass (`bunx vitest run runtime`). | CI green. |

### Phase 1b — TileScheme metadata field (PR #2)

| AC | Criterion | Verification |
|----|-----------|--------------|
| AC1b.1 | `TileScheme` literal-union type exported from `runtime/src/data/tile-source.ts`. Phase 1b ships **single variant**: `export type TileScheme = 'web-mercator-xyz'`. JSDoc lists future reserved variants (`'epsg-4326-quadtree'`, `'s2-cube-sphere'`) but they are **not** in the union yet (YAGNI; added when Phase 3/4 consumes them). | Grep + tsc. |
| AC1b.2 | `TileSourceMeta` (`tile-source.ts:112-118`) gains `readonly scheme: TileScheme` field — **not** on `TileSource` itself. Rationale: `tile-source.ts:104-118` documents `TileSourceMeta` as the canonical attach-time metadata surface; the `TileSource` interface comment at `tile-source.ts:19-43` reserves the behavioral surface for fetch/decode/predicate methods. Architect P0-1. | tsc + interface comment audit. |
| AC1b.3 | All **4** existing `TileSource` implementations populate `meta.scheme = 'web-mercator-xyz'`: `PMTilesBackend` (`pmtiles-backend.ts:50`), `VirtualPMTilesBackend` (`virtual-pmtiles-backend.ts:65`), `GeoJSONRuntimeBackend` (`geojson-runtime-backend.ts:21`), `VirtualCatalogAdapter` (`virtual-catalog-adapter.ts:24`). No separate raster backend exists (Architect/Critic confirmed). | Grep `implements TileSource` returns 4; grep `scheme:` shows each meta has the field. |
| AC1b.4 | `VirtualCatalogAdapter` (which proxies to an underlying source) declares the scheme **of its underlying source** — adapter does not own a tile scheme, it forwards. Implementation is **lazy**: `meta.scheme` is computed from `wrapped.meta.scheme` at access time, not at adapter-construction time. If `meta.scheme` is read before a wrap target attaches, the getter throws (`"VirtualCatalogAdapter.meta.scheme read before wrap target attached"`). **No silent default** — defaulting to `'web-mercator-xyz'` would be tautological today but silently lies the moment Phase 3 lands `'epsg-4326-quadtree'`, violating source-honest principle 1. | Unit test: pre-wrap meta-read throws; post-wrap returns wrapped scheme. |
| AC1b.5 | `TileCatalog` exposes `getSourceScheme(sourceName: string): TileScheme \| undefined` accessor returning the scheme declared by the source at `attachBackend` time. Reads via `mergeBackendMeta` (`tile-catalog.ts:272`). | Unit test: register source, assert `catalog.getSourceScheme('foo') === 'web-mercator-xyz'`. AC1.4-replacement. |
| AC1b.6 | **No cross-scheme dispatch guard added.** The original AC1.4 dispatch-refusal test required a contrived synthetic non-existing scheme to exercise — over-specifies behavior with zero current consumer. Catalog hot-path (`tile-catalog.ts:896-945`) unchanged. | Confirm no new branches in `requestTiles`. |
| AC1b.7 | Mercator (`projType 0`) full pixel-diff against pre-change baseline = **byte-identical**, **no snapshot regenerations**. Reason: the field is read-only, used only by the new accessor; no consumer in Phase 1b. | Pixel-diff + grep `getSourceScheme` shows zero callers in Phase 1b runtime code (test-only). |
| AC1b.8 | New tests: `runtime/src/data/tile-source.scheme.test.ts` asserts each of 4 backends produces `meta.scheme === 'web-mercator-xyz'`. **For `GeoJSONRuntimeBackend`, assert at BOTH meta-write sites** — initial construction (`geojson-runtime-backend.ts:31`) AND after `setData()` re-assigns `this.meta` (`geojson-runtime-backend.ts:56`) — to catch re-assignment drift. `runtime/src/data/tile-catalog-scheme-accessor.test.ts` asserts `getSourceScheme` returns the declared value; unregistered name returns `undefined`. | Vitest. |
| AC1b.9 | `runtime/src/data/AGENTS.md` updated with one short section documenting `TileScheme` and the source-honest contract. Section heading: `## Tile scheme discriminator (Phase 1b)`. `runtime/src/AGENTS.md` line referencing polar-cap as a capability is amended to "polar-cap synth is a public utility, no longer renderer-driven" (Phase 1a follow-up note). | Diff inspection. |
| AC1b.10 | Bundle-size baseline captured BEFORE Phase 1b changes (e.g. `bun run build` then sum gzipped dist size). After: delta < 1 KB gzipped. Baseline number recorded in PR body. | `bun run build` twice + diff. |
| AC1b.11 | All existing tests pass (`bunx vitest run runtime`). | CI green. |

## Implementation Steps

| # | Phase | Step | Verify |
|---|-------|------|--------|
| 0 | — | Create branch `feature/ecef-tile-pipeline-phase1` from `main`. | `git branch --show-current`. |
| 1 | 1a | `runtime/src/engine/map.ts:870-872` — delete the auto-`setPolarCapsEnabled(true)` call inside the projection-change handler. | Diff. AC1a.1. |
| 2 | 1a | `runtime/src/engine/source-manager.ts:469-476` — delete the `isPolarCapsEnabled` branch + `injectPolarCaps` call inside `setSourceData`. | Diff. AC1a.2. |
| 3 | 1a | `runtime/src/engine/map.ts:585-598` — change `setPolarCapsEnabled` body from "set `_polarCapsEnabled = enabled` + reprocess sources" to: no-op + one-shot `xlog.warn(...)` (idempotent via module-scoped `_warned` flag). Use `xlog` (not raw `console.warn`) per AC1a.3 + host log-sink contract. | Unit test. AC1a.3. |
| 4 | 1a | Verify `runtime/src/index.ts:6-13` public exports of `injectPolarCaps`, `synthesizePolarCaps`, `findClampBoundarySpans` are unchanged. | Grep. AC1a.4. |
| 5 | 1a | Verify all `polar-cap-*` test files pass without modification. | Vitest target run. AC1a.5. |
| 6 | 1a | Run Mercator pixel-diff suite — must be byte-identical without snapshot regeneration. | Pixel-diff. AC1a.6. |
| 7 | 1a | Update visual baselines for non-Mercator GeoJSON-with-polar-extent fixtures (if any) with explicit commit note. | Manual baseline review. AC1a.7. |
| 8 | 1a | Open PR #1 (`[Phase 1a] Source-honest: remove polar-cap auto-call from renderer`). Body references memory `project_polar_cap_fix_2026_05_18.md`. | `gh pr view`. AC1a.8. |
| 9 | 1a | CI green on PR #1; merge to feature branch (or main if user opts for direct-to-main per phase). | CI badge. AC1a.9. |
| 10 | 1b | `runtime/src/data/tile-source.ts:112-118` — add `readonly scheme: TileScheme` field to `TileSourceMeta`. Define `TileScheme` as single-variant union near the top of the file. JSDoc references future reserved variants. | tsc. AC1b.1, AC1b.2. |
| 11 | 1b | `runtime/src/data/sources/pmtiles-backend.ts:50` — populate `meta: { …, scheme: 'web-mercator-xyz' }` in the constructor's meta-build block (find the existing `this.meta = ...` assignment site; same for steps 12-14). | Build. AC1b.3. |
| 12 | 1b | `runtime/src/data/sources/virtual-pmtiles-backend.ts:65` — same. | Build. AC1b.3. |
| 13 | 1b | `runtime/src/data/sources/geojson-runtime-backend.ts:21` — same. | Build. AC1b.3. |
| 14 | 1b | `runtime/src/data/sources/virtual-catalog-adapter.ts:24` — proxy via lazy getter: `meta.scheme` returns `wrapped.meta.scheme` at access time. If read before wrap target attaches, **throw** (per AC1b.4 — no silent `'web-mercator-xyz'` default). Implement as a `get scheme()` accessor on the meta object, or compute `meta` lazily on first read. | Read + unit test. AC1b.4. |
| 15 | 1b | `runtime/src/data/tile-catalog.ts` — add `getSourceScheme(name: string): TileScheme \| undefined` accessor. Reads from the per-source meta map populated in `attachBackend` / `mergeBackendMeta` (`tile-catalog.ts:272`). | Unit test. AC1b.5. |
| 16 | 1b | Add tests: `tile-source.scheme.test.ts`, `tile-catalog-scheme-accessor.test.ts`. | Vitest. AC1b.8. |
| 17 | 1b | Update `runtime/src/data/AGENTS.md` with `## Tile scheme discriminator (Phase 1b)` section. Amend `runtime/src/AGENTS.md` polar-cap note per AC1b.9. | Diff. AC1b.9. |
| 18 | 1b | Capture bundle-size baseline pre-1b (`bun run build` + size sum). Apply 1b. Re-measure. Diff < 1 KB gzipped. | Build artifact size. AC1b.10. |
| 19 | 1b | Run Mercator pixel-diff — byte-identical, no snapshot regen. | Pixel-diff. AC1b.7. |
| 20 | 1b | Open PR #2 (`[Phase 1b] TileScheme metadata field + getSourceScheme accessor`). | `gh pr view`. |
| 21 | 1b | CI green; merge. | CI badge. AC1b.11. |

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Phase 1a's no-op + warn variant of `setPolarCapsEnabled` is too lenient — users miss the migration. | Medium | Low | One-shot `console.warn` is sufficient for surface visibility. CHANGELOG entry + PR body link memory note. Hard-throw can be revisited in Phase 2+ once the ecosystem has adapted. |
| Existing visual baselines that depended on auto-cap injection regress. | High (deliberate) | Medium (UX) | Update baselines explicitly with commit note. Document in PR body as intentional source-honest revert of `project_polar_cap_fix_2026_05_18` (9 days old). Provide migration recipe: call `injectPolarCaps` on the GeoJSON in app code before passing to `setSourceData`. |
| Phase 1b's `TileScheme` single-variant union creates dead-code warnings or tsc complaints. | Low | Low | Single literal `'web-mercator-xyz'` is a valid type. JSDoc documents future variants; no in-code reservation. |
| `VirtualCatalogAdapter` scheme proxy semantics are ambiguous if the wrapped source is set lazily. | Low | Low | Default `'web-mercator-xyz'` (the only variant) on pre-set; switch to forwarded value once wrap target is attached. Documented as Phase 3 follow-up if alternate schemes appear. |
| `polar-tile-pyramid-gap.test.ts` semantics depend on the auto-cap path that Phase 1a removes. | Medium | Low-Medium | Read this test file in step 5 verification; if it asserts on auto-cap-injected geometry, mark it as expected-to-fail under Phase 1a and document the failure as the intended source-honest behavior. If it tests the standalone helpers only, no change needed. |
| Bundle-size delta exceeds 1 KB due to type system + 4 meta-field additions + new accessor. | Low | Low | Single string field × 4 backends + one accessor function ≈ 50 bytes minified. Measured AC1b.10. |
| Phase 1b ships pure scaffolding with no current consumer — YAGNI critique. | Medium | Low | Architect's Phase 1b ≈ Option C analysis acknowledged. Mitigation: Phase 1b's `getSourceScheme` accessor is the legitimate Phase 2 entry point; landing it now lets Phase 2's ECEF VS migration target only WebMerc scheme without redesigning the catalog interface. Keep diff small (~50 LOC) so revert cost is trivial if Phase 2 redesigns. |

## Verification Steps

### Phase 1a
1. `bunx tsc -p runtime/tsconfig.json --noEmit` — zero errors.
2. `bunx vitest run runtime/src/engine runtime/src/data/polar-cap-synth.test.ts runtime/src/loader/polar-cap-detect.test.ts runtime/src/engine/projection/polar-tile-pyramid-gap.test.ts` — all green.
3. `bunx vitest run runtime` — full suite green.
4. Mercator pixel-diff: capture baseline on main, apply 1a, re-run — byte-identical, no snapshot dir changed.
5. Render-gate CI green (`gh pr checks` on PR #1).

### Phase 1b
6. `bunx tsc -p runtime/tsconfig.json --noEmit` — zero errors.
7. `bunx vitest run runtime/src/data` — new scheme tests green, existing tests still green.
8. `bunx vitest run runtime` — full suite green.
9. Bundle-size: `bun run build`, sum gzipped artifact sizes; delta vs pre-1b < 1 KB.
10. Mercator pixel-diff byte-identical, no snapshot regeneration.
11. Render-gate CI green (`gh pr checks` on PR #2).

### Rollback procedure (if AC1a.6 or AC1b.7 byte-identity fails)
- Revert the offending PR via `git revert`. Branch returns to pre-change state.
- Re-investigate the perturbation: most likely candidate = (1a) an unrelated path inside `setSourceData` that was implicitly relying on the removed branch's side effects; (1b) accidentally consuming `getSourceScheme` from a hot path in Phase 1b's tests via test-bleed. File a follow-up before re-attempting.

---

## RALPLAN-DR Summary (Short Mode, iteration 2)

### Principles
1. **Source-honest rendering** — renderer never invents data the source does not provide. (Phase 1a payload.)
2. **Minimum reversible step** — each PR is independently revertible; 1a is purely subtractive on renderer wiring, 1b is purely additive on metadata.
3. **Reference convergence** — `TileSchemeMeta.scheme` is the gateway for Cesium-style EPSG:4326 / 3D Tiles 1.1 S2 in later phases.
4. **Backwards-clean** — Mercator (the 99% case) must remain byte-identical without snapshot regeneration in both 1a and 1b.
5. **Test infrastructure first** — Phase 1b adds the `getSourceScheme` accessor so Phase 2 has a typed read surface from day one.

### Decision Drivers
1. **User explicit principle**: data-honest, no fake fill / no stretch.
2. **Phased merges** — separate UX-visible change from invisible scaffolding so review surfaces, CHANGELOG entries, and rollback paths are independent (Architect P0-3 + Critic Critical #5).
3. **Lowest risk first step toward Tier 3** — tile-scheme metadata field unlocks Phase 2+ without forcing shader/data changes today.

### Viable Options

**Option A — Single PR bundling polar-cap removal + TileScheme field on TileSource interface.** (Original v1.)
- Pros: One review, one merge.
- Cons: Bundles UX-visible behavior change with invisible scaffolding (Critic Critical #5: contradicts Driver "phased merges"); puts the metadata field on the wrong interface (Architect P0-1).
- **Rejected**: violates Driver 2.

**Option B — Style-spec-level scheme declared by host on each source.**
- Pros: Decouples scheme from backend implementation; allows multi-scheme PMTiles archives.
- Cons: Creates two sources of truth (host config vs backend data). Backend, not host, owns the scheme truth because backend owns the data semantics. Host-declared scheme can lie about its data; this defeats principle 1. Note: this rejection is NOT based on "PMTiles spec pins Web Mercator" (Critic Critical #4 — that claim is false; PMTiles v3 is format-only and Protomaps publishes EPSG:4326 PMTiles).
- **Rejected**: violates principle 1 — single source of truth must be the backend.

**Option C — Defer abstraction entirely; ship polar-cap revert only.**
- Pros: Smallest diff. Phase 2 introduces the field when actually needed.
- Cons: Phase 2's ECEF VS migration will modify backend constructors anyway; coupling those changes with the metadata-field addition is harder than landing them separately. Phase 1b is small (~50 LOC) and explicitly designed to be revertible.
- **Acknowledged as legitimate alternative.** Plan v2 partially accepts it by splitting Phase 1a/1b — 1a alone is morally equivalent to Option C's scope; 1b's marginal value is "Phase 2 starts with the read accessor already in place".
- **Chosen path: 1a + 1b (Architect/Critic split)** because 1b is trivially revertible and de-risks Phase 2 sequencing.

### Invalidation Rationale
- B violates source-honest (rejection rationale now corrected — host-side scheme creates dual sources of truth).
- C is plausible but rejected by margin: 1b is small enough that landing it now is cheaper than landing it inside Phase 2's larger ECEF refactor.

---

## ADR

**Decision:** Split Phase 1 into two PRs.
- **PR #1 (Phase 1a)**: Remove polar-cap auto-call sites from renderer (`map.ts:870-872`, `source-manager.ts:469-476`). Convert `setPolarCapsEnabled` to no-op + one-shot `console.warn`. Keep `polar-cap-*` modules and public exports intact.
- **PR #2 (Phase 1b)**: Add `scheme: TileScheme` field to `TileSourceMeta` (NOT `TileSource`). Single-variant union (`'web-mercator-xyz'` only; future variants in JSDoc). Add `TileCatalog.getSourceScheme(name)` accessor. Four backends populate `meta.scheme`; `VirtualCatalogAdapter` proxies to wrapped source.

**Drivers:** User-explicit source-honest principle (PR #1 payload); Tier 3 ECEF / 3D Tiles 1.1 target (PR #2 scaffolding); phased merges with independent review/rollback (Architect P0-3, Critic Critical #5).

**Alternatives considered:**
- A (single-PR monolith on `TileSource` interface): rejected — violates phased-merges driver; wrong interface placement (Architect P0-1, Critic Critical #1).
- B (host-declared scheme via style spec): rejected — violates source-honest (backend owns data truth, not host). Note: original v1 rejection rationale citing "PMTiles spec pins Web Mercator" is incorrect (Critic Critical #4); corrected rationale = single source of truth.
- C (defer abstraction): partially accepted via Phase 1a/1b split — Phase 1a alone matches Option C scope; Phase 1b adds the field marginal cost to de-risk Phase 2 sequencing.

**Why chosen:** 1a/1b split honors phased-merges driver, places metadata correctly per documented interface scope (`tile-source.ts:104-118`), and unlocks Phase 2's ECEF VS rewrite by providing a typed dispatch read surface. Mercator byte-identity (AC1a.6, AC1b.7) ensures zero production risk on the 99% projection.

**Consequences:**
- **Phase 1a**: Hosts running `setPolarCapsEnabled(true)` get one-shot `console.warn`; their polar caps go away. They must migrate to calling `injectPolarCaps` on their GeoJSON before `setSourceData` (the public exports remain available). This is a reversal of the 9-day-old feature shipped in `project_polar_cap_fix_2026_05_18` — explicitly intentional under source-honest principle. PR body links the memory note.
- **Phase 1b**: Backends now carry a metadata discriminator. The catalog exposes `getSourceScheme(name)`. No consumers in Phase 1b runtime — Phase 2's ECEF VS will be the first consumer. If Phase 2 redesigns the catalog interface, the 50-LOC investment is trivially revertible.
- **Architectural commitment**: X-GIS will not auto-stretch / auto-cap imagery or geometry. This differs from MapLibre's globe behavior; documented as intentional under source-honest principle.

**Follow-ups (future phases, not in this plan):**
- **Phase 2 (ECEF VS migration)**: `project_geom` polygon/line/point/raster VS rewrite, `background-renderer.ts` deletion, camera ECEF rebuild. First consumer of `getSourceScheme`.
- **Phase 3 (EPSG:4326 backend)**: real `EPSG4326Backend` implementation + 2-root quadtree. Adds `'epsg-4326-quadtree'` variant to the `TileScheme` union.
- **Phase 4 (S2 cube-sphere)**: 3D Tiles 1.1 `3DTILES_bounding_volume_S2` compat. Adds `'s2-cube-sphere'` variant.
- Optional separate track: extract `polar-cap-detect` / `polar-cap-synth` into a dedicated `@xgis/polar-cap-tool` CLI so hosts have a clean migration path.

---

## Test Plan

### Unit (new, Phase 1a)
- `runtime/src/data/polar-cap-synth.test.ts`, `runtime/src/loader/polar-cap-detect.test.ts`, `runtime/src/engine/projection/polar-tile-pyramid-gap.test.ts` — unchanged content; verify pass (AC1a.5). If `polar-tile-pyramid-gap.test.ts` asserts on auto-cap geometry, mark expected-to-fail per Risk Row "polar-tile-pyramid-gap test semantics".
- New: `runtime/src/engine/map-polar-cap-deprecation.test.ts` — asserts `setPolarCapsEnabled(true)` does not throw + emits one-shot `console.warn`; repeated call does not re-warn.

### Unit (new, Phase 1b)
- `runtime/src/data/tile-source.scheme.test.ts` — for each of 4 `TileSource` backends, instantiate (with minimal config) and assert `instance.meta.scheme === 'web-mercator-xyz'`.
- `runtime/src/data/tile-catalog-scheme-accessor.test.ts` — register a source via `attachBackend`, assert `catalog.getSourceScheme(name) === 'web-mercator-xyz'`. Unregistered name returns `undefined`.

### Integration / Visual
- Mercator (`projType 0`) pixel-diff baseline → apply 1a → byte-identical, no snapshot regen (AC1a.6).
- Mercator pixel-diff baseline → apply 1b → byte-identical, no snapshot regen (AC1b.7).
- Non-Mercator GeoJSON-with-polar-extent fixtures: regenerate baselines in Phase 1a with explicit commit note (AC1a.7).
- All other non-Mercator fixtures: unchanged — Phase 1 doesn't touch VS, so existing visual artifacts (flat bg, sparse-vertex straight lines) remain. Documented as expected.

### Observability
- Phase 1a's `setPolarCapsEnabled` no-op emits one-shot `console.warn` so hosts notice the migration.
- No new runtime metrics required.

### Bundle size
- Phase 1b only: capture pre-1b baseline; delta < 1 KB gzipped (AC1b.10). Number recorded in PR body.

---

## Open Questions

1. **`VirtualCatalogAdapter` semantics**: is it strictly a proxy, or can it hold its own data independent of the wrapped `TileSource`? Affects AC1b.4 default — if the adapter can have data without a wrap target, default `'web-mercator-xyz'` is correct. Verify during Step 14.
2. **`polar-tile-pyramid-gap.test.ts` reliance**: does this test assert on auto-cap-injected geometry, or only on the standalone helpers? Verify during Step 5.
3. **Visual baseline regeneration scope**: how many fixtures depended on the auto-cap path? Likely ≤ 4 (per memory note's pixel-survey count). Enumerate during Step 7.

---

## Changelog (this plan revision)

- **v3 (this iteration, post-architect-re-review minor amendments)**: AC1a.3 uses `xlog.warn` (not `console.warn`) to preserve host log-sink contract per `runtime/src/engine/log.ts:1-23`. AC1b.4 `VirtualCatalogAdapter` semantics: lazy meta-scheme proxy that throws on pre-wrap read (no silent default to `'web-mercator-xyz'` — prevents Phase 3 source-honest violation). AC1b.8 asserts `meta.scheme` at both `GeoJSONRuntimeBackend` meta-write sites (initial + post-`setData()`).
- **v2**: Applied all 5 Critic Critical findings + 2 Major findings + 1 Architect P0-1 + 1 P1-4 + 1 P1-5 + 1 P2-6 + 1 P2-7. Plan split into Phase 1a (UX-visible polar-cap removal) + Phase 1b (TileSchemeMeta scaffolding). Field moved to `TileSourceMeta`. AC1.4 dispatch-guard replaced with `getSourceScheme` accessor. `setPolarCapsEnabled` hard-throw downgraded to no-op + warn. Backend count corrected 5→4. YAGNI: single-variant union. Snapshot-regen sub-AC added. Option B rejection rationale rewritten (PMTiles v3 spec citation removed). PR body explicitly documents `project_polar_cap_fix_2026_05_18` revert. Rollback procedure added. Open questions section added.
- **v1 (initial)**: First draft from spec.
