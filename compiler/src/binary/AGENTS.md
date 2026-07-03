<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# binary

## Purpose

The `.xgb` (X-GIS Compiled Binary) serialization format. Serializes a compiled scene (`BinaryScene` — `BinaryLoad` + `BinaryShow` records) into a compact little-endian `ArrayBuffer` and deserializes it back, so a host can ship pre-compiled scenes without re-running the full lexer→parser→IR pipeline. Currently at format version 2; version 1 files are still accepted on read.

## Key Files

| File        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `format.ts` | `serializeXGB(scene)` / `deserializeXGB(buffer)` + `BinaryScene`, `BinaryLoad`, `BinaryShow` types. Header layout: magic `"XGIS"` (u32 LE `0x53494758`) + `VERSION` u16 + per-section count u16. Strings are length-prefixed (u16 + UTF-8 bytes). `BinaryShow` v2 fields: `projection` string, `visible` u8, `opacity` f32, `zOrder` u16. `crs` is intentionally absent — `.xgb` consumers assume EPSG:4326; a future version bump would be needed to support non-4326 sources. Private `BinaryEncoder` / `BinaryDecoder` helper classes handle all DataView-style LE reads/writes inline. |

No subdirectories exist under this directory.

## For AI Agents

### Working In This Directory

- Bump `VERSION` (currently `2`) whenever the on-wire layout changes; old-version reads must be handled explicitly in `deserializeXGB` (see the `version >= 2` guard for the v2 show fields).
- `serializeXGB` and `deserializeXGB` must be exact round-trip inverses — the binary test asserts this.
- This serializes the runtime command form (`BinaryScene`), not the compiler IR `Scene`; keep `BinaryShow` fields in sync with whatever `emitCommands` produces in `ir/emit-commands`.
- `BinaryLoad` does NOT carry `crs` — this is a documented non-goal (AC12). Do not add `crs` without a VERSION bump and a matching deserialize branch.
- `BinaryEncoder` uses a `number[]` accumulator flushed via `Uint8Array`; `BinaryDecoder` uses a `DataView` with a manual `pos` cursor — both are little-endian throughout.

### Testing Requirements

- `compiler/src/__tests__/binary.test.ts` — serialize → deserialize round-trip covering LoadCommand and ShowCommand payloads, including v2 fields.

### Common Patterns

- All multi-byte writes/reads use explicit LE helpers (`writeU16`, `readF32`, etc.) — never use implicit endianness.
- Strings: `writeString` encodes via `TextEncoder`, prefixes with u16 byte length; `readString` slices the underlying buffer to avoid a copy.

## Dependencies

### Internal

- Operates on `BinaryScene` / `BinaryLoad` / `BinaryShow` shapes; downstream consumers access these via the top-level `compiler/src/index.ts` re-export.
- Logically coupled to `ir/emit-commands` (the producer of `ShowCommand`/`LoadCommand` that maps to `BinaryShow`/`BinaryLoad`).

### External

- None (uses only `TextEncoder` / `TextDecoder` / `DataView` from the platform).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
