// flavor-select: real-world signal fixtures → the flavor a device NEEDS.

import { describe, it, expect } from 'vitest'
import { recommendFp64Flavor, isAppleGpu } from './flavor-select'

describe('recommendFp64Flavor', () => {
  it('Apple WebGPU adapter.info → integer', () => {
    // Chrome-on-mac (the macOS oracle) reports vendor 'apple'.
    expect(recommendFp64Flavor({ adapterInfo: { vendor: 'apple', architecture: '' } })).toBe(
      'integer',
    )
    expect(recommendFp64Flavor({ adapterInfo: { vendor: 'apple', architecture: 'metal-3' } })).toBe(
      'integer',
    )
  })

  it('Apple WebGL2 renderer strings → integer', () => {
    for (const r of [
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
      'Apple GPU', // iOS Safari
      'ANGLE Metal Renderer: Apple M2 Pro',
    ]) {
      expect(recommendFp64Flavor({ rendererString: r })).toBe('integer')
    }
  })

  it('iOS/mac WebKit user-agent fallback → integer', () => {
    expect(
      recommendFp64Flavor({
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1',
      }),
    ).toBe('integer')
  })

  it('NVIDIA / D3D11 / Vulkan → float (D3D11 stays float deliberately)', () => {
    for (const s of [
      { adapterInfo: { vendor: 'nvidia', architecture: 'turing' } },
      {
        rendererString:
          'ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 (0x00001E87) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      { rendererString: 'ANGLE (NVIDIA, Vulkan 1.4.341 (NVIDIA GeForce RTX 2080), NVIDIA)' },
      {
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36',
      },
    ]) {
      expect(recommendFp64Flavor(s)).toBe('float')
    }
  })

  it('no signals → float (the byte-identical default)', () => {
    expect(recommendFp64Flavor({})).toBe('float')
    expect(isAppleGpu({})).toBe(false)
  })

  it('any single Apple signal wins over non-Apple co-signals', () => {
    expect(
      recommendFp64Flavor({
        adapterInfo: { vendor: 'apple' },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0)', // masked / contradictory UA
      }),
    ).toBe('integer')
  })
})
