<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-29 -->

# blueprint/src/__tests__

## Purpose
Vitest unit tests for the `@xgis/blueprint` package. Six focused test files guard the codegen contract, per-node lint diagnostics, the `.xgis`-to-graph import converter, and three editor-level seams (unknown-node deserialize, load-history reset, wire-undo bookkeeping). No DOM-environment dependency: the contract/diagnostics/import tests operate on plain node/edge arrays or string source; the editor tests `Object.create` a `BlueprintEditor` and stub the render side-effects, since the repo vitest config runs bare Node with no jsdom.

## Key Files
| File | Description |
|------|-------------|
| `contract.test.ts` | Pins `NODE_SPECS` field keys and pin IDs against the codegen contract. Asserts all 10 node types (`background`, `fn`, `import`, `layer`, `map`, `preset`, `reroute`, `source`, `style`, `symbol`), exact `fields[].key` order for 8 node types, the 4 typed layer input pins (`source:source`, `style:style`, `apply:preset`, `symbol:symbol`) including `apply.multi=true` and `source.required=true`, and two round-trip tests: `starterGraph()` producing parseable `.xgis` containing `source land` / `layer continents`, and reroute knots being transparent (chain source→reroute→layer→reroute→map still emits correct `.xgis`). |
| `diagnostics.test.ts` | Unit tests for `computeNodeIssues`. Covers: empty name / empty URL on a source, unwired layer (no source), unwired map (no layers), duplicate source names, and a fully-wired clean graph returning `issues.size === 0`. |
| `import-skip.test.ts` | Tests `xgisToGraph` filtering of unusable no-URL geojson sources. Verifies that a source declared as `geojson` with no `url` field is dropped along with its dependent layers, the valid tilejson source and its layer are kept, edges are re-wired correctly (layer→source + layer→map), and no dangling edges reference dropped node IDs. |
| `deserialize-unknown-node.test.ts` | The paste/undo trust boundary on untrusted JSON: `spawn()` drops an unknown-type node instead of throwing, and `restore()` (undo/redo replay) survives an unknown-type node in the snapshot. `Object.create`s the editor and exercises the real `History`/`record()`/`spawn()`/`restore()` machinery. |
| `load-history-reset.test.ts` | The load→mutate→load→undo seam: `load()` calls `history.reset()`, so an undo after a load is a no-op (does NOT revert to the pre-load graph). Exercises a real `History` against the editor's `load()`/`undo()`/`record()`/`restore()`. |
| `wire-undo-reconnect.test.ts` | Wire-gesture undo bookkeeping: reconnecting an input wire records ONE undo step for the whole gesture (#bug4), a standalone connect still records normally, and `insertReroute` nulls `selEdge` for the split edge so a later Delete is a clean no-op (#bug5). |

## For AI Agents

### Working In This Directory
- `contract.test.ts` is the primary gate for any change to `types.ts`, `codegen.ts`, or `@xgis/compiler`'s `LANGUAGE_SCHEMA`. Run it first after touching those files.
- When adding a new node type to `NODE_SPECS`, add field-key and pin-id assertions to `contract.test.ts` before the type passes review.
- `diagnostics.test.ts` must be extended whenever a new lint rule is added to `diagnostics.ts`. Tests use raw `BPNode[]`/`BPEdge[]` arrays — no `BlueprintEditor` instantiation needed.
- `import-skip.test.ts` covers `xgisToGraph` in `import.ts`. If the import converter gains new filtering logic (e.g. for tilejson missing url, or symbol sources), add cases here. The test spies on `console.warn` — restore the mock before asserting to avoid noisy output.
- The `parses()` helper in `contract.test.ts` wraps `Lexer`/`Parser` — this is the round-trip gate; if the compiler rejects the codegen output the test throws.

### Testing Requirements
- Run: `bun run test` from `blueprint/` (runs `vitest run`).
- All files must pass before merging any change to `blueprint/src/`.
- The editor-seam tests (`deserialize-unknown-node` / `load-history-reset` / `wire-undo-reconnect`) `Object.create` a `BlueprintEditor` and stub the render side-effects rather than constructing a live DOM scene — the repo vitest config runs bare Node (no jsdom). Follow that harness shape for new editor-logic tests instead of adding a DOM environment.

### Common Patterns
- Import pattern: `import { ... } from '../types'`, `import { graphToXgis } from '../codegen'`, `import { xgisToGraph } from '../import'`.
- Node construction helper: `const n = (type, data) => ({ id: uid('n'), type, x: 0, y: 0, data })`.
- Edge construction: `{ id: uid('e'), from: { node: 'n1', pin: 'out' }, to: { node: 'n2', pin: 'source' } }`.

## Dependencies

### Internal
- `../types` — `NODE_SPECS`, `starterGraph`, `uid`, `defaultData`, `BPNode`, `BPEdge`, `BPGraph`
- `../codegen` — `graphToXgis`
- `../diagnostics` — `computeNodeIssues`
- `../import` — `xgisToGraph`
- `../editor` — `BlueprintEditor` (the editor-seam tests `Object.create` it)
- `@xgis/compiler` — `Lexer`, `Parser` (round-trip parse in contract test)

### External
- `vitest` (test runner + `vi.spyOn`, via root workspace)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
