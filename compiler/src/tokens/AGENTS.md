<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# tokens

## Purpose
Design-token color resolution for the X-GIS compiler. Holds a Tailwind-compatible color palette, a full CSS Color Module Level 4 named-color table (148 entries), and a `resolveColor` function that maps any color expression — Tailwind utility (`red-500`), CSS named color (`cornflowerblue`), hex literal (`#3399cc`), or CSS function (`rgb()`, `hsl()`, `hwb()`, `lab()`, `oklab()`, `lch()`, `oklch()`) — to a canonical hex string. Also exports round-trip Lab/LCh math (`srgbToLab`, `labToHex`, `labToLch`, `lchToLab`, `parseSrgbHex`) used by the IR's `interpolate-lab`/`interpolate-hcl` stop densification. This is the sole color-resolution layer under the lexer, IR, and convert pipelines.

## Key Files
| File | Description |
|------|-------------|
| `colors.ts` | Tailwind PALETTE (22 hues × 11 shades), NAMED_COLORS (CSS Color 4, 148 entries), `resolveColor(name) → string \| null`, `parseCssColorFn` (rgb/rgba/hsl/hsla/hwb/lab/oklab/lch/oklch → hex), `parseSrgbHex`, `srgbToLab`, `labToHex`, `labToLch`, `lchToLab`. No runtime dependencies. |

No subdirectories. `colors-fuzz.test.ts` is colocated (see Testing below).

## For AI Agents

### Working In This Directory
- `resolveColor` is the single public entry point; it dispatches by input shape: hex literal passthrough → NAMED_COLORS → CSS function → `<hue>-<shade>` PALETTE regex. All branches return `null` on failure — never throw.
- Bare identifier vs. hyphenated form is disambiguated by input shape, not name: `red` → NAMED_COLORS (`#ff0000`); `red-500` → PALETTE (`#ef4444`). These intentionally coexist.
- `parseCssColorFn` handles both comma-separated and modern whitespace/slash-separated CSS syntax. Lab/OKLab/LCH/OKLCH conversions follow CSS Color Module 4 §10 + Ottosson 2020 via Bradford D50↔D65 CAT — do not simplify the matrices.
- Alpha is omitted from the hex string when it equals 1.0 (opaque); included as the 8th nibble pair when `a < 0.999`.
- `srgbToLab` / `labToHex` / `labToLch` / `lchToLab` are used by `ir/` stop densification for `interpolate-lab` and `interpolate-hcl` expressions — keep the round-trip invertible.
- Keep the Tailwind palette values pixel-faithful to the official Tailwind v3 palette. CSS named-color values are verbatim from https://www.w3.org/TR/css-color-4/#named-colors.

### Testing Requirements
- Colocated `colors-fuzz.test.ts` exercises arbitrary input names (unknown tokens must return `null`, not throw).
- Additional coverage lives in `compiler/src/__tests__/colors-named.test.ts` and `colors-css.test.ts` (CSS function forms and named-color completeness).
- Run with `bun run test` or `vitest` from the compiler package root.

### Common Patterns
- Static palette + lookup function — zero state, zero side effects.
- All internal helpers (`parseChannel`, `parsePercent`, `parseAlpha`, `parseHue`, `hslToRgb`, `hwbToRgb`, `labToSrgb`, `oklabToSrgb`, `linearToSrgb`, etc.) are module-private; only `resolveColor`, `parseSrgbHex`, `srgbToLab`, `labToHex`, `labToLch`, `lchToLab` are exported.

## Dependencies

### Internal
- `resolveColor` is re-exported from `compiler/src/index.ts`; consumed by `ir/` (color stop densification), `convert/` (Mapbox→X-GIS color conversion), and the lexer's Color token resolution path.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
