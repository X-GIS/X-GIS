<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# tokens

## Purpose
Design-token color resolution. Holds a Tailwind-compatible color palette and resolves token names to hex strings (`resolveColor("red-500") → "#ef4444"`), so `.xgis` sources and the converter can use Tailwind-style color names anywhere a color is expected. This is the design-token layer underneath the lexer's `Color` token and the IR's color values.

## Key Files
| File | Description |
|------|-------------|
| `colors.ts` | The Tailwind color palette + `resolveColor(name)`. Maps `<hue>-<shade>` token names to hex. |

## For AI Agents

### Working In This Directory
- `resolveColor` is the single token→hex entry; the lexer produces `Color`/identifier tokens and the IR/convert layers resolve named colors through here. Keep the palette Tailwind-faithful.
- Unknown tokens should resolve predictably (return null / passthrough) rather than throw — the fuzz test exercises arbitrary names.

### Testing Requirements
- Colocated `colors-fuzz.test.ts`; plus `src/__tests__/colors-named.test.ts`, `colors-css.test.ts` (and CSS-color completeness tests, though CSS named colors may live alongside).

### Common Patterns
- Static palette object + a thin lookup function; no state.

## Dependencies

### Internal
- `resolveColor` re-exported from `src/index.ts`; consumed by `ir/`, `convert/colors`.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
