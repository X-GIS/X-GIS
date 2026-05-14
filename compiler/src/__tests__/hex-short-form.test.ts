// Unit tests for CSS hex short-form support across the colour
// resolution pipeline:
//
//   - hexToRgba                              (ir/render-node.ts)
//   - resolveColor                           (tokens/colors.ts)
//   - resolveColorFromAST                    (codegen/shader-gen.ts — private)
//   - lowerMatchColorToMatch.resolveColorOfAST (codegen/compute-lowering.ts — via lowering)
//
// CSS spec allows 3/4/6/8 hex digits (lengths 4/5/7/9 including
// the leading `#`). Until this commit the codepaths that consume
// ColorLiteral ASTs only accepted 6/8 digits — user styles like
// `fill: #fff` would silently emit transparent.

import { describe, expect, it } from 'vitest'
import { hexToRgba } from '../ir/render-node'
import { resolveColor } from '../tokens/colors'
import { lowerMatchColorToMatch } from '../codegen/compute-lowering'
import type { DataExpr } from '../ir/render-node'

describe('hexToRgba — short form', () => {
  it('#fff (3-digit) expands to white', () => {
    expect(hexToRgba('#fff')).toEqual([1, 1, 1, 1])
  })

  it('#f00 (3-digit) expands to red', () => {
    expect(hexToRgba('#f00')).toEqual([1, 0, 0, 1])
  })

  it('#fff8 (4-digit) expands with alpha 8 → 8/15 ≈ 0x88/255', () => {
    const [r, g, b, a] = hexToRgba('#fff8')
    expect(r).toBe(1)
    expect(g).toBe(1)
    expect(b).toBe(1)
    // 0x88 / 255 ≈ 0.533
    expect(a).toBeCloseTo(0x88 / 255, 5)
  })

  it('round-trips short and long forms to identical floats', () => {
    expect(hexToRgba('#f00')).toEqual(hexToRgba('#ff0000'))
    expect(hexToRgba('#abc')).toEqual(hexToRgba('#aabbcc'))
    expect(hexToRgba('#f008')).toEqual(hexToRgba('#ff000088'))
  })
})

describe('resolveColor — short-form hex passes through unchanged', () => {
  it('returns #fff verbatim (already in canonical form)', () => {
    expect(resolveColor('#fff')).toBe('#fff')
  })

  it('returns #f008 verbatim', () => {
    expect(resolveColor('#f008')).toBe('#f008')
  })

  it('lowercases uppercase short-form hex', () => {
    expect(resolveColor('#FFF')).toBe('#fff')
  })
})

describe('lowerMatchColorToMatch — short-form hex arm value', () => {
  // The compute-lowering adapter is the public entry point; its
  // private resolveColorOfAST was previously the choke point that
  // rejected #fff. Verifying the lowering accepts short form is the
  // visible behaviour change.
  function matchExprWithArm(armHex: string): DataExpr {
    return {
      ast: {
        kind: 'FnCall',
        callee: { kind: 'Identifier', name: 'match' },
        args: [{ kind: 'FieldAccess', object: null, field: 'class' }],
        matchBlock: {
          kind: 'MatchBlock',
          arms: [
            { pattern: 'fire', value: { kind: 'ColorLiteral', value: armHex } },
          ],
        },
      },
    }
  }

  it('accepts #fff in match arm (regression: previously dropped)', () => {
    const spec = lowerMatchColorToMatch(matchExprWithArm('#fff'))
    expect(spec).not.toBeNull()
    expect(spec!.arms).toHaveLength(1)
    expect(spec!.arms[0]!.colorHex).toBe('#fff')
  })

  it('accepts #f00 in match arm', () => {
    const spec = lowerMatchColorToMatch(matchExprWithArm('#f00'))
    expect(spec!.arms[0]!.colorHex).toBe('#f00')
  })

  it('accepts #fff8 in match arm (4-digit with alpha)', () => {
    const spec = lowerMatchColorToMatch(matchExprWithArm('#fff8'))
    expect(spec!.arms[0]!.colorHex).toBe('#fff8')
  })

  it('still accepts long-form #ffffff (no regression)', () => {
    const spec = lowerMatchColorToMatch(matchExprWithArm('#ffffff'))
    expect(spec!.arms[0]!.colorHex).toBe('#ffffff')
  })

  it('still rejects malformed hex (e.g. #ff has 2 digits)', () => {
    // Two-digit hex is not a CSS shape; the adapter drops the arm.
    const spec = lowerMatchColorToMatch(matchExprWithArm('#ff'))
    // The arm is silently skipped (resolveColorOfAST returns null),
    // so spec.arms ends up empty. The default still synthesises.
    expect(spec!.arms).toHaveLength(0)
  })
})
