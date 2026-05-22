<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# binary

## Purpose
The `.xgb` (X-GIS Compiled Binary) serialization format. Serializes a compiled scene (the `SceneCommands` — `LoadCommand` / `ShowCommand`) into a compact little-endian binary blob and deserializes it back, so a host can ship pre-compiled scenes without re-running the full lexer→parser→IR pipeline. Format: magic `"XGIS"` (4 bytes) + `u16` version + `u16` command count + the command stream.

## Key Files
| File | Description |
|------|-------------|
| `format.ts` | `serializeXGB(scene)` / `deserializeXGB(bytes)` + the `BinaryScene` type. Encodes/decodes the `.xgb` container (magic, version, command count, LoadCommand/ShowCommand stream). |

## For AI Agents

### Working In This Directory
- Bump the `u16` version when the on-wire layout changes, and keep `serializeXGB`/`deserializeXGB` exact round-trip inverses — the binary test asserts round-trip equality.
- This serializes the runtime command form (`SceneCommands`), not the IR `Scene`; keep it in sync with whatever `emitCommands` produces.

### Testing Requirements
- `src/__tests__/binary.test.ts` (serialize → deserialize round-trip).

### Common Patterns
- Manual `DataView`-style little-endian read/write keyed off the documented header layout.

## Dependencies

### Internal
- Operates on the `SceneCommands` shape from `ir/emit-commands`; exported via `src/index.ts`.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
