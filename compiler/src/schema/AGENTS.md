<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# schema

## Purpose
A declarative schema describing the X-GIS top-level language constructs (the 8 real constructs: source, layer, background, preset, fn, symbol, style, keyframes). It is the single source of truth that downstream tooling — chiefly the `@xgis/blueprint` visual node editor — derives its node catalogue from, instead of maintaining a parallel hand-written table that silently drifts from the grammar. Scope is the constructs and their fields only; editor-only presentation (titles, colors, which field renders as a textarea) lives elsewhere.

## Key Files
| File | Description |
|------|-------------|
| `language.ts` | `LANGUAGE_SCHEMA` + `SOURCE_TYPES`, `ANCHORS`, and the supporting types `ConstructDef`, `SchemaProperty`, `SchemaRef`, `SchemaValueKind`, `SchemaPinType`. The machine-readable construct catalogue. |

## For AI Agents

### Working In This Directory
- This is the contract with `@xgis/blueprint`. When the grammar gains a construct or a construct gains a field, update `LANGUAGE_SCHEMA` here — the blueprint editor reads it rather than re-encoding the grammar.
- Keep it scoped to language semantics; do NOT add editor-presentation fields (colors, layout) here.

### Testing Requirements
- Colocated `language.test.ts` (asserts the schema covers the real constructs). `src/__tests__/schema/`-style coverage may assert drift vs. the parser.

### Common Patterns
- Plain data: each construct is a `ConstructDef` with typed `SchemaProperty[]`; pin/value kinds are enumerated for the node editor.

## Dependencies

### Internal
- Conceptually mirrors `parser/ast` constructs; consumed by `@xgis/blueprint`.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
