<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# blueprint/src

## Purpose
All TypeScript source for `@xgis/blueprint`. Implements the visual node editor, graph model, code generation, import, diagnostics, undo/redo history, minimap, search palette, wire geometry, and data-peek utilities. Zero runtime dependencies — the editor runs as pure vanilla DOM + SVG in any modern browser.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Public package entry point: re-exports `types`, `codegen`, `import`, `editor`. |
| `types.ts` | `BPNode`, `BPEdge`, `BPGraph`, `BPFrame` model types; `NODE_SPECS` catalogue derived from `@xgis/compiler`'s `LANGUAGE_SCHEMA`; `PinType`, `PinSpec`, `FieldSpec`; `PIN_COLOR` (Unreal-style typed wire colours); `pinCompatible`; `uid`; `defaultData`; `starterGraph`. |
| `editor.ts` | `BlueprintEditor` class — all interaction: pan/zoom, drag-wire, marquee, multi-select, node CRUD, comment frames, reroute knots, snap-to-grid, align/distribute, copy-paste, undo/redo, inspector panel, tooltips, node LOD. |
| `codegen.ts` | `graphToXgis(g: BPGraph): string` — emits valid `.xgis` source from a graph, in language-defined order, with reroute-transparent wire resolution. |
| `import.ts` | `importStyleToGraph(src: string): Promise<BPGraph>` — reverses codegen: MapLibre `style.json` or raw `.xgis` → `BPGraph` by calling `convertMapboxStyle` then block-splitting. |
| `diagnostics.ts` | `computeNodeIssues(nodes, edges): Map<id, string[]>` — pure per-node lint, no DOM. |
| `history.ts` | `History` — bounded 100-entry undo/redo stack of opaque string snapshots. |
| `minimap.ts` | `renderMinimap(el, view)` — corner overview canvas, shown only for graphs with ≥12 nodes. |
| `palette.ts` | `openSearchPalette(opts)` — contextual search/create overlay; pure view. |
| `geometry.ts` | `bezier(x1,y1,x2,y2): string` — horizontal-tangent cubic Bézier SVG path for wires. Pure function, no state. |
| `datapeek.ts` | `peekData(node, el)` — fetches a GeoJSON `source` URL and reports feature count + property keys into a DOM element. |
| `blueprint.css` | Editor chrome styles; exported as `@xgis/blueprint/blueprint.css`. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `__tests__/` | Vitest unit tests: codegen contract, diagnostics, import-skip guard (see `__tests__/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- Zero-dependency constraint is strict: no npm imports other than `@xgis/compiler`. All DOM/SVG manipulation is vanilla.
- `NODE_SPECS` is computed at module load from `LANGUAGE_SCHEMA`. It auto-tracks new compiler constructs; the `contract.test.ts` pins the specific field keys and pin IDs that `codegen.ts` references.
- `editor.ts` uses a discriminated union `Drag` type for all pointer-drag states. Add new drag kinds to that union; never use ad-hoc boolean flags.
- `codegen.ts` and `import.ts` must stay in sync: any new node type needs both an emitter and a block recogniser.
- `BPGraph` must remain JSON-roundtrippable (no class instances, no `undefined` fields). History snapshots are `JSON.stringify(graph)`.

### Testing Requirements
- `bun run test` from `blueprint/` runs all three `__tests__/*.test.ts` files.
- `contract.test.ts` is the primary gate — must pass after any change to `types.ts`, `codegen.ts`, or the compiler schema.

### Common Patterns
- New node IDs: always `uid()` (crypto.randomUUID prefix); never construct manually.
- New node data: always `defaultData(type)` for zero-value fields.
- Wire resolution in `codegen.ts`: always use `incoming(g, node, pin)` — it transparently traverses reroute knots.

## Dependencies

### Internal
- `@xgis/compiler` — `LANGUAGE_SCHEMA`, `ConstructDef`, `convertMapboxStyle`

### External
- None at runtime.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
