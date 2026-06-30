import { describe, it, expect } from 'vitest'
import { rhiStencilToGpu } from '@xgis/engine'
import {
  STENCIL_WRITE, STENCIL_TEST, STENCIL_CLIPMASK_WRITE, STENCIL_CLIPMASK_TEST,
} from '@xgis/engine'

// P0.1 (engine/content split — RHI contract extension) byte-identity gate.
// The new RHI stencil config (RhiPipelineDesc.depthStencil.stencil + setStencilReference)
// must map to the SAME GPU stencil fields the renderers hand-write today
// (gpu-shared STENCIL_*), so routing the per-tile clip-mask pipeline through the RHI
// at P1 is byte-for-byte the current raw path — no clip-mask drift. rhiStencilToGpu is
// pure, so this asserts the mapping WITHOUT a GPUDevice.

const stencilOf = (s: GPUDepthStencilState) => ({
  stencilFront: s.stencilFront,
  stencilBack: s.stencilBack,
  stencilWriteMask: s.stencilWriteMask,
  stencilReadMask: s.stencilReadMask,
})

describe('rhiStencilToGpu — byte-identity vs gpu-shared STENCIL_* states', () => {
  it('write state (compare always, passOp replace, masks 0xFF) == STENCIL_WRITE', () => {
    expect(rhiStencilToGpu({ compare: 'always', passOp: 'replace', writeMask: 0xFF, readMask: 0xFF }))
      .toEqual(stencilOf(STENCIL_WRITE))
  })

  it('test state (compare equal, passOp keep, write 0x00 / read 0xFF) == STENCIL_TEST', () => {
    expect(rhiStencilToGpu({ compare: 'equal', passOp: 'keep', writeMask: 0x00, readMask: 0xFF }))
      .toEqual(stencilOf(STENCIL_TEST))
  })

  it('clip-mask write + test mirror the same shapes', () => {
    expect(rhiStencilToGpu({ compare: 'always', passOp: 'replace', writeMask: 0xFF, readMask: 0xFF }))
      .toEqual(stencilOf(STENCIL_CLIPMASK_WRITE))
    expect(rhiStencilToGpu({ compare: 'equal', passOp: 'keep', writeMask: 0x00, readMask: 0xFF }))
      .toEqual(stencilOf(STENCIL_CLIPMASK_TEST))
  })

  it('absent config == the inert STENCIL_DISABLED shape (compare always, keep, masks 0x00)', () => {
    expect(rhiStencilToGpu()).toEqual({
      stencilFront: { compare: 'always', passOp: 'keep' },
      stencilBack: { compare: 'always', passOp: 'keep' },
      stencilWriteMask: 0x00,
      stencilReadMask: 0x00,
    })
  })
})
