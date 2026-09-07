// ═══ The hex parser, proved against the three bodies it replaced ═══
//
// `compiler`'s `hexToRgba`, map's `parseColor` and map's `feature-helpers` `hexToRgba`
// each carried this parse. One of them said so — "NOTE (#1666): this is the FOURTH copy
// of that gate" — and the first two differed only by `slice` vs `substring`, which are
// the same function for non-negative in-order indices.
//
// So the three retired bodies are kept here VERBATIM and the survivor is asserted equal
// to each across every shape the four length branches reach, plus the shapes the regex
// gate must reject. "The existing tests still pass" is the wrong bar: the copies drifted
// once already (the `#rgba` branch landed in one and was mirrored into the others by
// hand, 6acc299), so what needs proving is that folding them changes NO answer.

import { describe, it, expect } from 'vitest'
import { parseHexRgba, HEX_COLOR_RE } from './color'

// ── the retired bodies, verbatim ────────────────────────────────────────────────────────
// Copied from compiler/src/ir/render-node-helpers.ts, map/src/render/renderer-helpers.ts
// and map/src/feature-helpers.ts as they stood at 1260623a. Do NOT refactor them to share
// anything: being the INDEPENDENT second implementation is their whole value. `substring`
// vs `slice` is preserved exactly as each copy had it.

function retiredCompilerHexToRgba(hex: string): [number, number, number, number] {
  let r = 0,
    g = 0,
    b = 0,
    a = 1
  if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) {
    return [0, 0, 0, 1]
  }
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
  } else if (hex.length === 5) {
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
    a = parseInt(hex[4] + hex[4], 16) / 255
  } else if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16) / 255
    g = parseInt(hex.slice(3, 5), 16) / 255
    b = parseInt(hex.slice(5, 7), 16) / 255
  } else if (hex.length === 9) {
    r = parseInt(hex.slice(1, 3), 16) / 255
    g = parseInt(hex.slice(3, 5), 16) / 255
    b = parseInt(hex.slice(5, 7), 16) / 255
    a = parseInt(hex.slice(7, 9), 16) / 255
  }
  return [r, g, b, a]
}

/** map/src/render/renderer-helpers.ts — `substring`, not `slice`, is how it was written. */
function retiredMapParseColor(hex: string): [number, number, number, number] {
  let r = 0,
    g = 0,
    b = 0,
    a = 1
  if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) {
    return [0, 0, 0, 1]
  }
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
  } else if (hex.length === 5) {
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
    a = parseInt(hex[4] + hex[4], 16) / 255
  } else if (hex.length === 7) {
    r = parseInt(hex.substring(1, 3), 16) / 255
    g = parseInt(hex.substring(3, 5), 16) / 255
    b = parseInt(hex.substring(5, 7), 16) / 255
  } else if (hex.length === 9) {
    r = parseInt(hex.substring(1, 3), 16) / 255
    g = parseInt(hex.substring(3, 5), 16) / 255
    b = parseInt(hex.substring(5, 7), 16) / 255
    a = parseInt(hex.substring(7, 9), 16) / 255
  }
  return [r, g, b, a]
}

function retiredFeatureHexToRgba(
  hex: string | null | undefined,
): [number, number, number, number] | null {
  if (typeof hex !== 'string') return null
  if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) {
    return null
  }
  let r = 0,
    g = 0,
    b = 0,
    a = 1
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
  } else if (hex.length === 5) {
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
    a = parseInt(hex[4] + hex[4], 16) / 255
  } else if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16) / 255
    g = parseInt(hex.slice(3, 5), 16) / 255
    b = parseInt(hex.slice(5, 7), 16) / 255
  } else if (hex.length === 9) {
    r = parseInt(hex.slice(1, 3), 16) / 255
    g = parseInt(hex.slice(3, 5), 16) / 255
    b = parseInt(hex.slice(5, 7), 16) / 255
    a = parseInt(hex.slice(7, 9), 16) / 255
  }
  return [r, g, b, a]
}

// ── the survivors, wired exactly as the three call sites now wire them ───────────────────
const compilerHexToRgba = (hex: string): [number, number, number, number] =>
  parseHexRgba(hex) ?? [0, 0, 0, 1]
const mapParseColor = (hex: string): [number, number, number, number] =>
  parseHexRgba(hex) ?? [0, 0, 0, 1]
const featureHexToRgba = (
  hex: string | null | undefined,
): [number, number, number, number] | null => (typeof hex !== 'string' ? null : parseHexRgba(hex))

// ── inputs ──────────────────────────────────────────────────────────────────────────────
/** Every accepted length, both digit cases, the channel extremes, and the shapes the gate
 *  must reject — including the two the copies' own comments name as paid-for bugs. */
const ACCEPTED = [
  '#000',
  '#fff',
  '#FFF',
  '#f0a',
  '#abc',
  '#0000', // #rgba, alpha 0 — the short-alpha branch (6acc299)
  '#fff8',
  '#F0Ac',
  '#000000',
  '#ffffff',
  '#FFFFFF',
  '#1a2b3c',
  '#00000000', // #rrggbbaa, fully transparent
  '#ffffffff',
  '#12345678',
  '#AbCdEf01',
] as const

const REJECTED = [
  '#zzz', // the NaN case every copy's comment names — parseInt('zz', 16) is NaN
  '#12345', // 5 hex digits: a length the gate must not let through
  '#1234567', // 7 digits
  '#12', // too short
  '#', //
  '', //
  'fff', // no leading #
  '#ff f', // internal space
  'rgb(1,2,3)', // a form this parser does not handle at all
  '#ffffff ', // trailing space — `$` anchor is what rejects it
] as const

describe('parseHexRgba — one parser for the three that existed (#2534)', () => {
  it('the corpus REACHES every branch, so the equalities below are not vacuous', () => {
    // A differential over inputs that all take one path proves almost nothing. This is the
    // instrument check: each of the four length branches, and the reject arm, must fire.
    const lengths = new Set(ACCEPTED.map((h) => h.length))
    expect([...lengths].sort((a, b) => a - b)).toEqual([4, 5, 7, 9])
    expect(REJECTED.every((h) => parseHexRgba(h) === null)).toBe(true)
    expect(ACCEPTED.every((h) => parseHexRgba(h) !== null)).toBe(true)
  })

  for (const hex of ACCEPTED) {
    it(`equals all three retired bodies on ${hex}`, () => {
      expect(compilerHexToRgba(hex)).toEqual(retiredCompilerHexToRgba(hex))
      expect(mapParseColor(hex)).toEqual(retiredMapParseColor(hex))
      expect(featureHexToRgba(hex)).toEqual(retiredFeatureHexToRgba(hex))
      // …and the three answered the SAME thing as each other, which is the premise that
      // made folding them legal in the first place.
      expect(compilerHexToRgba(hex)).toEqual(mapParseColor(hex))
      expect(compilerHexToRgba(hex)).toEqual(retiredFeatureHexToRgba(hex))
    })
  }

  for (const hex of REJECTED) {
    it(`rejects ${JSON.stringify(hex)} the way each retired body did`, () => {
      // The contracts DIFFER here and must keep differing — two answer opaque black, one
      // answers null. A fold that unified them would pass every arm above and break this.
      expect(compilerHexToRgba(hex)).toEqual(retiredCompilerHexToRgba(hex))
      expect(compilerHexToRgba(hex)).toEqual([0, 0, 0, 1])
      expect(mapParseColor(hex)).toEqual(retiredMapParseColor(hex))
      expect(featureHexToRgba(hex)).toBeNull()
    })
  }

  it('keeps the nullish-input guard that belongs to feature-helpers alone', () => {
    // The shared kernel takes a string; only this call site accepts null/undefined, and
    // only it may answer null for them.
    expect(featureHexToRgba(null)).toBeNull()
    expect(featureHexToRgba(undefined)).toBeNull()
    expect(featureHexToRgba(null)).toEqual(retiredFeatureHexToRgba(null))
    expect(featureHexToRgba(undefined)).toEqual(retiredFeatureHexToRgba(undefined))
  })

  it('never answers NaN — the reason the gate runs before parseInt', () => {
    // Each copy carried a comment saying an ungated `parseInt('zz', 16)` put NaN into a
    // colour channel, sampled by the GPU (map) and stored in colour tuples (compiler).
    for (const hex of [...ACCEPTED, ...REJECTED]) {
      for (const v of compilerHexToRgba(hex)) expect(Number.isNaN(v)).toBe(false)
      expect(featureHexToRgba(hex)?.every((v) => !Number.isNaN(v)) ?? true).toBe(true)
    }
  })

  it('HEX_COLOR_RE is the same predicate the parser gates on', () => {
    // compiler/src/convert/colors.ts gates on the SHAPE without parsing — it warns and
    // skips emission. That site was the fourth home of this regex, so it has to agree.
    for (const hex of ACCEPTED) expect(HEX_COLOR_RE.test(hex)).toBe(true)
    for (const hex of REJECTED) expect(HEX_COLOR_RE.test(hex)).toBe(false)
  })

  it('has no lastIndex state — a shared /g-less regex is safe to reuse', () => {
    // A module-level regex is only safe to export because it carries no `g`/`y` flag; with
    // one, alternate calls would return alternating answers.
    expect(HEX_COLOR_RE.global).toBe(false)
    expect(HEX_COLOR_RE.sticky).toBe(false)
    expect(HEX_COLOR_RE.test('#fff')).toBe(HEX_COLOR_RE.test('#fff'))
  })
})
