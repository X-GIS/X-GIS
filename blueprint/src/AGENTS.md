<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-29 -->

# blueprint/src

## Purpose
All TypeScript source for `@xgis/blueprint`. Implements the visual node editor for the X-GIS style language: graph model, code generation, MapLibre/`.xgis` import, per-node diagnostics, undo/redo history, minimap, search palette, Bézier wire geometry, and GeoJSON data-peek. Zero runtime npm dependencies — the editor runs as pure vanilla DOM + SVG.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Public package entry: re-exports `types`, `codegen`, `import`, `editor`. |
| `types.ts` | Core model: `BPNode`, `BPEdge`, `BPGraph`, `BPFrame`; `NODE_SPECS` catalogue built from `@xgis/compiler`'s `LANGUAGE_SCHEMA`; `PinType`, `PinSpec`, `FieldSpec`; `PIN_COLOR` (Unreal-style typed wire colours); `pinCompatible`; `uid`; `defaultData`; `starterGraph`. |
| `editor.ts` | `BlueprintEditor` class — pan/zoom, drag-wire, marquee, multi-select, node CRUD, comment frames, reroute knots, snap-to-grid, align/distribute, copy-paste, undo/redo, inspector panel, tooltips, node LOD. Drag state uses a discriminated union. |
| `codegen.ts` | `graphToXgis(g: BPGraph): string` — emits valid `.xgis` source from a graph, in language-defined order, with reroute-transparent wire resolution via `incoming()`. |
| `import.ts` | Reverses codegen → `BPGraph`. `xgisToGraph(src)` block-splits raw `.xgis`; `styleToGraph(style)` runs `convertMapboxStyle` then `xgisToGraph`; `importText(text)` dispatches heuristically (JSON `{` → style, else `.xgis`). Internal `autoLayout` arranges nodes into role-based columns. |
| `diagnostics.ts` | `computeNodeIssues(nodes, edges): Map<id, string[]>` — pure per-node lint, no DOM. |
| `history.ts` | `History` — bounded 100-entry undo/redo stack of opaque `JSON.stringify` snapshots. |
| `minimap.ts` | `renderMinimap(el, view)` — corner overview canvas, shown only for graphs with ≥12 nodes. |
| `palette.ts` | `openSearchPalette(opts)` — contextual search/create overlay; pure view, no state. |
| `geometry.ts` | `bezier(x1,y1,x2,y2): string` — horizontal-tangent cubic Bézier SVG path for wires. Pure, stateless. |
| `datapeek.ts` | `peekData(node, el)` — fetches a GeoJSON `source` URL and reports feature count + property keys into a DOM element. |
| `blueprint.css` | Editor chrome styles; exported as `@xgis/blueprint/blueprint.css`. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `__tests__/` | Vitest unit tests: codegen contract, diagnostics, import-skip guard, plus editor-level guards (unknown-node deserialize, load-history-reset, wire-undo-reconnect) (see `__tests__/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- Zero-dependency constraint is strict: no npm imports other than `@xgis/compiler`. All DOM/SVG manipulation is vanilla.
- `NODE_SPECS` is computed at module load from `LANGUAGE_SCHEMA`. It auto-tracks new compiler constructs; `contract.test.ts` pins the exact field keys and pin IDs that `codegen.ts` references — update the test when the schema changes.
- `editor.ts` uses a discriminated union `Drag` type for all pointer-drag states. Add new drag kinds to that union; never use ad-hoc boolean flags.
- `codegen.ts` and `import.ts` must stay in sync: any new node type needs both an emitter and a block recogniser.
- `BPGraph` must remain JSON-roundtrippable (no class instances, no `undefined` fields). History snapshots are `JSON.stringify(graph)`.
- Node IDs must always come from `uid()`; node data must always be initialised with `defaultData(type)`.

### Testing Requirements
- `bun run test` from `blueprint/` runs all `__tests__/*.test.ts` files.
- `contract.test.ts` is the primary gate — must pass after any change to `types.ts`, `codegen.ts`, or the compiler schema.
- `diagnostics.test.ts` covers the pure-lint path; `import-skip.test.ts` guards the import guard branch.

### Common Patterns
- Wire resolution in `codegen.ts`: always use `incoming(g, node, pin)` — it transparently traverses reroute knots.
- New drag interactions: extend the `Drag` discriminated union in `editor.ts`, never add standalone boolean flags.

## Dependencies

### Internal
- `@xgis/compiler` — `LANGUAGE_SCHEMA`, `ConstructDef`, `convertMapboxStyle`

### External
- None at runtime.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
