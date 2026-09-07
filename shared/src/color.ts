// ═══ Hex colour — the one parser, cross-package ═══
//
// `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` → RGBA in 0..1. Three copies of this
// body existed, one of which said so in its own comment: "NOTE (#1666): this is the
// FOURTH copy of that gate" (`map/src/render/renderer-helpers.ts`). They were the
// compiler's `hexToRgba`, map's `parseColor` and map's `feature-helpers` `hexToRgba`
// — and the first two differed from each other ONLY by `slice` vs `substring`, which
// are the same function for non-negative in-order indices.
//
// What genuinely differed between them is the REJECT CONTRACT, not the parse: two
// answered opaque black, one answered null. That stays at the call sites (one line
// each) rather than becoming a parameter here, so each caller's contract is readable
// where it is relied on.
//
// THE REGEX GATE IS LOAD-BEARING, and every copy carried a comment saying why: without
// it `parseInt('zz', 16)` is NaN, and a NaN colour channel propagated to the GPU (map)
// and into stored colour tuples (compiler's shader-gen / fold-trivial-case). Rejecting
// first is the whole reason this is not three lines of `parseInt`.

/** The hex shapes this codebase accepts, per CSS Color Module 4. Exported because
 *  `compiler/src/convert/colors.ts` gates on the SHAPE without parsing — it warns and
 *  skips emission rather than answering a colour, so it needs the predicate, not the
 *  tuple. That site was the fourth home of this regex. */
export const HEX_COLOR_RE = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** Parse a hex colour to `[r, g, b, a]` in 0..1, or `null` if `hex` is not one of the
 *  four accepted shapes. Callers that need a total function supply their own fallback.
 *
 *  The `#rgba` (length 5) branch is the CSS Color Module 4 short-alpha form and is not
 *  optional: before it existed that length fell through to the default and every
 *  `#xxxa` colour silently turned black (fixed in 6acc299, mirrored into the copies). */
export function parseHexRgba(hex: string): [number, number, number, number] | null {
  if (!HEX_COLOR_RE.test(hex)) return null

  let r = 0,
    g = 0,
    b = 0,
    a = 1
  if (hex.length === 4) {
    // #rgb — each digit doubles to a full byte
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
  } else if (hex.length === 5) {
    // #rgba — short alpha, same doubling
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
    a = parseInt(hex[4] + hex[4], 16) / 255
  } else if (hex.length === 7) {
    // #rrggbb
    r = parseInt(hex.slice(1, 3), 16) / 255
    g = parseInt(hex.slice(3, 5), 16) / 255
    b = parseInt(hex.slice(5, 7), 16) / 255
  } else if (hex.length === 9) {
    // #rrggbbaa
    r = parseInt(hex.slice(1, 3), 16) / 255
    g = parseInt(hex.slice(3, 5), 16) / 255
    b = parseInt(hex.slice(5, 7), 16) / 255
    a = parseInt(hex.slice(7, 9), 16) / 255
  }
  return [r, g, b, a]
}
