<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-23 -->

# schema

## Purpose

Declarative machine-readable catalogue of the 8 real X-GIS language constructs (`import`, `source`, `symbol`, `style`, `preset`, `fn`, `layer`, `background`). Acts as the single source of truth that `@xgis/blueprint` derives its node palette from, replacing any hand-maintained parallel table that would silently drift from the grammar. Scope is strictly language semantics — construct keywords, field names, value kinds, and cross-block reference pins; editor presentation (colors, layout, output-sink nodes) lives in the blueprint editor, not here.

## Key Files

| File          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`    | Barrel re-export of `language.ts` — exports `LANGUAGE_SCHEMA`, `SOURCE_TYPES`, `ANCHORS`, and type definitions (`ConstructDef`, `SchemaProperty`, `SchemaRef`, `SchemaValueKind`, `SchemaPinType`).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `language.ts` | Exports `LANGUAGE_SCHEMA: Record<string, ConstructDef>` — 8 construct entries keyed by keyword. Also exports `SOURCE_TYPES` (7 accepted `source { type: … }` values), `ANCHORS` (9 accepted `symbol { anchor: … }` values), and the supporting types `ConstructDef`, `SchemaProperty`, `SchemaRef`, `SchemaValueKind`, `SchemaPinType`. Each `ConstructDef` carries `keyword`, `astKind` (mirrors `parser/ast.ts` Statement kind), `category` (`Data`/`Style`/`Render`/`Logic`), optional `produces` (output pin type), `properties: SchemaProperty[]`, and optional `refs: SchemaRef[]` for typed cross-block input pins. |

## For AI Agents

### Working In This Directory

- `language.ts` is a codegen contract: `SchemaProperty.key` values (e.g. `strokeWidth`) are stable identifiers consumed by both the blueprint editor and compiler codegen. Never rename a key — add a new one and deprecate the old one if needed.
- When the grammar gains a construct or a new field, update `LANGUAGE_SCHEMA` here AND add a `SAMPLES` entry in `language.test.ts` — the conformance test asserts `Object.keys(SAMPLES).sort()` equals `Object.keys(LANGUAGE_SCHEMA).sort()`, so omitting either side fails CI.
- `astKind` must match the exact `kind` string used in `parser/ast.ts` Statement union types. Drift here is silent at schema-definition time but breaks any consumer that switches on `astKind`.
- The `refs` array on `layer` defines 4 typed input pins (`source` required, `style`, `apply` multi-preset, `symbol`). The conformance test asserts every `ref.refType` names a real producing construct, so adding a ref to a non-producing construct fails immediately.
- Do NOT add editor-only fields (colors, textarea hints, palette ordering) — those belong in `@xgis/blueprint`.

### Testing Requirements

- `language.test.ts` runs under vitest. Three assertion groups: (1) every construct has a `SAMPLES` entry (no-drift guard), (2) per-construct: keyword equals map key and a minimal snippet parses to the declared `astKind` via the real `Lexer` + `Parser`, (3) all `ref.refType` values name a producing construct. Run with `bun run vitest compiler/src/schema/language.test.ts` or as part of the full suite.

### Common Patterns

- Plain data module — no side effects, no class instances. Each entry is a `ConstructDef` literal with typed `SchemaProperty[]`.
- `SchemaValueKind` drives how the blueprint editor renders a field: `'enum'` + `options` → dropdown, `'expr'` → expression editor, `'pipe'` → multi-line pipe list.
- `SchemaPinType` (`'source' | 'style' | 'preset' | 'symbol' | 'layer'`) maps to typed wires in the blueprint node graph.

## Dependencies

### Internal

- Conceptually mirrors `parser/ast.ts` construct kinds (astKind must stay in sync); consumed at runtime by `@xgis/blueprint` visual editor.

### External

- None (pure data, no npm imports).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
