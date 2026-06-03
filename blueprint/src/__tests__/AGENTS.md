<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# blueprint/src/__tests__

## Purpose
Vitest unit tests for the `@xgis/blueprint` package. Three focused test files guard the codegen contract, per-node lint diagnostics, and the `.xgis`-to-graph import converter. No DOM dependency — all tests operate on plain node/edge arrays or string source code.

## Key Files
| File | Description |
|------|-------------|
| `contract.test.ts` | Pins `NODE_SPECS` field keys and pin IDs against the codegen contract. Asserts all 10 node types (`background`, `fn`, `import`, `layer`, `map`, `preset`, `reroute`, `source`, `style`, `symbol`), exact `fields[].key` order for 8 node types, the 4 typed layer input pins (`source:source`, `style:style`, `apply:preset`, `symbol:symbol`) including `apply.multi=true` and `source.required=true`, and two round-trip tests: `starterGraph()` producing parseable `.xgis` containing `source land` / `layer continents`, and reroute knots being transparent (chain source→reroute→layer→reroute→map still emits correct `.xgis`). |
| `diagnostics.test.ts` | Unit tests for `computeNodeIssues`. Covers: empty name / empty URL on a source, unwired layer (no source), unwired map (no layers), duplicate source names, and a fully-wired clean graph returning `issues.size === 0`. |
| `import-skip.test.ts` | Tests `xgisToGraph` filtering of unusable no-URL geojson sources. Verifies that a source declared as `geojson` with no `url` field is dropped along with its dependent layers, the valid tilejson source and its layer are kept, edges are re-wired correctly (layer→source + layer→map), and no dangling edges reference dropped node IDs. |

## For AI Agents

### Working In This Directory
- `contract.test.ts` is the primary gate for any change to `types.ts`, `codegen.ts`, or `@xgis/compiler`'s `LANGUAGE_SCHEMA`. Run it first after touching those files.
- When adding a new node type to `NODE_SPECS`, add field-key and pin-id assertions to `contract.test.ts` before the type passes review.
- `diagnostics.test.ts` must be extended whenever a new lint rule is added to `diagnostics.ts`. Tests use raw `BPNode[]`/`BPEdge[]` arrays — no `BlueprintEditor` instantiation needed.
- `import-skip.test.ts` covers `xgisToGraph` in `import.ts`. If the import converter gains new filtering logic (e.g. for tilejson missing url, or symbol sources), add cases here. The test spies on `console.warn` — restore the mock before asserting to avoid noisy output.
- The `parses()` helper in `contract.test.ts` wraps `Lexer`/`Parser` — this is the round-trip gate; if the compiler rejects the codegen output the test throws.

### Testing Requirements
- Run: `bun run test` from `blueprint/` (runs `vitest run`).
- All three files must pass before merging any change to `blueprint/src/`.
- Do not add DOM-dependent tests here; `BlueprintEditor` DOM tests belong in a separate integration layer.

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
- `@xgis/compiler` — `Lexer`, `Parser` (round-trip parse in contract test)

### External
- `vitest` (test runner + `vi.spyOn`, via root workspace)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
