// iter-301 — Paired-symbol position invariant test.
//
// User-reported bug class: "도로 번호 렌더링할 때 라벨이랑 라벨 뒤
// 흰색 박스 위치가 다르던 문제". Shield (icon) + road number (text)
// must dispatch at the SAME (anchorX, anchorY) per pairKey. Drift
// here would render the number offset from the shield even when
// both survive collision.
//
// This test runs without WebGPU init via Object.create + manual
// field injection (same pattern as vtr-tile-load-diagnostic). The
// IconStage's _iconDebugHook (iter-301) and TextStage's
// _debugHook are the public surface for collecting per-call
// anchor coordinates.

import { describe, it, expect } from 'vitest'
import { IconStage } from '@xgis/map'
import { TextStage } from '@xgis/map'
import { TextStageDiagnostics } from '@xgis/map'
import type { LabelDef } from '@xgis/compiler'

interface Capture {
  kind: 'icon' | 'text'
  pairKey: string | undefined
  x: number
  y: number
  name: string  // icon name OR resolved text
}

function makeIconStageStub(): IconStage {
  const stage = Object.create(IconStage.prototype) as IconStage
  ;(stage as unknown as { pending: unknown[] }).pending = []
  ;(stage as unknown as { dpr: number }).dpr = 1
  ;(stage as unknown as { missingIconNames: Set<string> }).missingIconNames = new Set()
  ;(stage as unknown as { dispatchedIconNames: Set<string> }).dispatchedIconNames = new Set()
  ;(stage as unknown as { _iconDebugHook: null }).
    _iconDebugHook = null
  return stage
}

function makeTextStageStub(): TextStage {
  const stage = Object.create(TextStage.prototype) as TextStage
  ;(stage as unknown as { pending: unknown[] }).pending = []
  ;(stage as unknown as { pendingLine: unknown[] }).pendingLine = []
  ;(stage as unknown as { _diag: TextStageDiagnostics })._diag = new TextStageDiagnostics()
  ;(stage as unknown as { droppedPairKeys: Set<string> }).droppedPairKeys = new Set()
  ;(stage as unknown as { cameraZoom: number }).cameraZoom = 12
  ;(stage as unknown as { opts: { defaultFont: string } }).opts = { defaultFont: 'Noto Sans' }
  ;(stage as unknown as { _debugHook: null })._debugHook = null
  ;(stage as unknown as { _traceRecorder: null })._traceRecorder = null
  return stage
}

describe('iter-301 paired-symbol position invariant', () => {
  it('icon and text submitted with same pairKey share (anchorX, anchorY)', () => {
    const iconStage = makeIconStageStub()
    const textStage = makeTextStageStub()

    const captures: Capture[] = []
    iconStage.setIconDebugHook((name, x, y, pairKey) => {
      captures.push({ kind: 'icon', name, x, y, pairKey })
    })
    textStage.setLabelDebugHook((text, x, y, _placement) => {
      captures.push({ kind: 'text', name: text, x, y, pairKey: undefined })
    })

    // Simulate a shield dispatch: 3 features at distinct anchors,
    // each gets icon + text with matching pairKey.
    const features = [
      { x: 100, y: 200, ref: '10', shield: 'us-interstate_2', pair: 'shield-seq-0' },
      { x: 350, y: 200, ref: '45', shield: 'us-interstate_2', pair: 'shield-seq-1' },
      { x: 100, y: 500, ref: '288', shield: 'us-interstate_3', pair: 'shield-seq-2' },
    ]
    const labelDef: LabelDef = {
      text: { kind: 'expr', expr: { ast: { kind: 'StringLiteral', value: 'x' } as never } },
      size: 10,
    }
    for (const f of features) {
      iconStage.addIcon(f.x, f.y, f.shield, { pairKey: f.pair })
      // Pair the text label at SAME (x, y) — this is the contract
      // map.ts's dispatchIcon + addLabel maintain. Replicate here
      // so a future regression that drifts the two apart fails.
      textStage.addLabel(
        { parts: [{ kind: 'literal', value: f.ref }] } as never,
        {},
        f.x, f.y,
        labelDef,
        undefined, 'highway-shield', f.pair,
      )
    }

    expect(captures.length).toBe(6)  // 3 features × (icon + text)

    // Pair by index: even = icon, odd = text for each feature.
    for (let i = 0; i < features.length; i++) {
      const icon = captures[i * 2]!
      const text = captures[i * 2 + 1]!
      expect(icon.kind).toBe('icon')
      expect(text.kind).toBe('text')
      // The INVARIANT we want to lock: icon and text use identical
      // anchor coords for the same feature.
      expect(icon.x).toBe(text.x)
      expect(icon.y).toBe(text.y)
      expect(icon.pairKey).toBe(features[i]!.pair)
    }
  })

  it('iconDebugHook captures pairKey verbatim (string or undefined)', () => {
    const stage = makeIconStageStub()
    const captures: Array<{ name: string; pairKey: string | undefined }> = []
    stage.setIconDebugHook((name, _x, _y, pairKey) => {
      captures.push({ name, pairKey })
    })
    stage.addIcon(0, 0, 'school', { pairKey: 'p1' })
    stage.addIcon(0, 0, 'park')  // no pairKey
    stage.addIcon(0, 0, 'shield', { pairKey: 'p2' })
    expect(captures).toEqual([
      { name: 'school', pairKey: 'p1' },
      { name: 'park', pairKey: undefined },
      { name: 'shield', pairKey: 'p2' },
    ])
  })

  it('null hook is safe (no-op when unset)', () => {
    const stage = makeIconStageStub()
    expect(() => stage.addIcon(0, 0, 'x')).not.toThrow()
    stage.setIconDebugHook(null)
    expect(() => stage.addIcon(0, 0, 'x')).not.toThrow()
  })

  it('debug hook fires BEFORE prepare() — captures all submissions including unmatched names', () => {
    const stage = makeIconStageStub()
    const captures: string[] = []
    stage.setIconDebugHook(name => { captures.push(name) })
    // 'nonexistent' would be dropped at prepare() (no atlas), but
    // the dispatch hook fires regardless — confirms instrumentation
    // is at the submission boundary, not the render boundary.
    stage.addIcon(0, 0, 'nonexistent')
    expect(captures).toEqual(['nonexistent'])
  })
})
