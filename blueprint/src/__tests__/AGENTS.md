<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# blueprint/src/__tests__

## Purpose
Vitest unit tests for the `@xgis/blueprint` package. Three focused test files: a codegen contract test that pins the exact field keys and pin IDs that `codegen.ts` emits (so any drift from `NODE_SPECS` or `LANGUAGE_SCHEMA` fails loudly), a diagnostics test for the pure per-node lint function, and an import-skip guard for the block-splitter parser.

## Key Files
| File | Description |
|------|-------------|
| `contract.test.ts` | Pins `NODE_SPECS` field keys and pin IDs against the expected codegen contract. Verifies all 10 node types are present, each type's `fields[].key` array matches the exact order codegen expects, layer input pins carry the correct typed IDs (`source:source`, `style:style`, `preset:preset`, `symbol:symbol`), `graphToXgis(starterGraph())` produces parseable `.xgis` (round-trips through `Lexer` + `Parser`), and UID generation produces unique values. |
| `diagnostics.test.ts` | Unit tests for `computeNodeIssues`. Covers: empty name lint, missing source wire, duplicate source/layer names, empty import path, unconnected map sink. Uses constructed `BPNode[]`/`BPEdge[]` arrays directly — no DOM. |
| `import-skip.test.ts` | Guards the `splitBlocks` string/comment/brace-aware scanner in `import.ts` against malformed input: unclosed strings, nested braces, comment-only input, empty input. |

## Subdirectories
*(none)*

## For AI Agents

### Working In This Directory
- `contract.test.ts` is the primary correctness gate for any change to `types.ts`, `codegen.ts`, or `@xgis/compiler`'s `LANGUAGE_SCHEMA`. Run it first after touching those files.
- When adding a new node type to `NODE_SPECS`, add the corresponding field-key and pin-id assertions to `contract.test.ts` before the type passes review.
- `diagnostics.test.ts` should be extended whenever a new lint rule is added to `diagnostics.ts`. Tests use raw node/edge arrays — no `BlueprintEditor` instantiation needed.
- The `parses()` helper in `contract.test.ts` throws if `Lexer`/`Parser` reject the codegen output — this is the round-trip gate.

### Testing Requirements
- Run: `bun run test` from `blueprint/` (runs `vitest run`).
- All three files must pass before merging any change to `blueprint/src/`.
- Do not add DOM-dependent tests here; `BlueprintEditor` DOM tests belong in a separate integration layer.

### Common Patterns
- Import pattern: `import { ... } from '../types'`, `import { graphToXgis } from '../codegen'`.
- Node construction: `{ id: uid(), type: 'source', x: 0, y: 0, data: defaultData('source') }`.
- Edge construction: `{ id: uid(), from: { node: 'n1', pin: 'out' }, to: { node: 'n2', pin: 'source' } }`.

## Dependencies

### Internal
- `../types` — `NODE_SPECS`, `starterGraph`, `uid`, `defaultData`, `BPNode`, `BPEdge`, `BPGraph`
- `../codegen` — `graphToXgis`
- `@xgis/compiler` — `Lexer`, `Parser` (for round-trip parse in contract test)

### External
- `vitest` (test runner, via root workspace)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
