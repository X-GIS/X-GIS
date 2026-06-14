import { describe, it, expect } from 'vitest'
import { formatDMS, formatDM } from './gis-formatter'

// Sexagesimal carry: when seconds (DMS) or minutes (DM) round UP to 60 at
// the chosen precision, the overflow must carry into the next-coarser unit
// instead of printing an out-of-range "60". Military-precision domain.

describe('formatDMS sexagesimal carry', () => {
  it('seconds rounding to 60 carry into minutes', () => {
    // 1.0166555556° → 1°0'60.0" (buggy) → correct 1°1'0.0"
    expect(formatDMS(1.0166555556, undefined, 1)).toBe("1°1'0.0\"")
  })

  it('seconds + minutes cascade carry into degrees', () => {
    // 89.99999° → 89°59'60.0" (buggy) → correct 90°0'0.0"
    expect(formatDMS(89.99999, undefined, 1)).toBe("90°0'0.0\"")
    expect(formatDMS(89.99999, 'lat', 1)).toBe("90°0'0.0\"N")
  })

  it('carry preserves hemisphere suffix on negative values', () => {
    expect(formatDMS(-1.0166555556, 'lat', 1)).toBe("1°1'0.0\"S")
  })

  it('non-boundary control is unchanged', () => {
    expect(formatDMS(37.5665, 'lat', 1)).toBe("37°33'59.4\"N")
  })
})

describe('formatDM sexagesimal carry', () => {
  it('minutes rounding to 60 carry into degrees', () => {
    // 10 + 59.9997/60 → 10°60.000' (buggy) → correct 11°0.000'
    expect(formatDM(10 + 59.9997 / 60, 'lat', 3)).toBe("11°0.000'N")
  })

  it('non-boundary control is unchanged', () => {
    expect(formatDM(37.5665, 'lat', 3)).toBe("37°33.990'N")
  })
})
