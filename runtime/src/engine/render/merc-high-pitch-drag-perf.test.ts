// Unit-level perf gate for the Mercator high-pitch drag jank class
// (user report #10, 2026-05-19 — Liberty Seoul z17 pitch68 bearing285
// drag-pan p95 = 107 ms originally; reduced to 62 ms via iter-167/168/169
// across-frame caches. Target < 50 ms.).
//
// E2E spec at playground/e2e/_perf-merc-high-pitch-drag.spec.ts measures
// the full browser path (camera + GPU + label dispatch + draw). The work
// the drag profile (memory: project_merc_high_pitch_drag_2026_05_20)
// pinned as dominant — ~58 % CPU on the text/label pipeline — is
// CAMERA-INDEPENDENT: the per-label `(text, font, size, def)` shape
// inputs do not change during pure pan, only the screen anchor does.
//
// This test mirrors that workload at the unit level by driving
// TextStage.prepare() 120 times with a fixed corpus of point labels
// (label-set sized to match z17 Seoul Liberty: ~180 dispatched labels
// per frame from getDispatchedLabelTexts() probes) and only mutating
// the per-frame anchor (`pan dx=10, dy=0`). Atlas + GlyphAtlasHost
// state is real; rasterizer is the deterministic Mock. The test
// passes if per-frame p95 wall time stays under 5 ms — well within
// the budget that lets the full render frame finish in 50 ms (label
// prepare is one slice of the frame; even with x10 amortisation it
// still leaves headroom for tile selection + draw encoding).
//
// Why this proxy works: every fix that drops the E2E p95 must drop
// this prepare() p95 too, because the E2E hot path goes through this
// exact code. Conversely, regressing this gate is the same shape as
// regressing #10 drag jank. See the perf memory for the slice 1-3
// landings (iter-167/168/169) that this test now guards.
//
// Implementation notes:
//   - Use the same Proxy-based GPUDevice stub as
//     bilingual-prepare-scatter.test.ts; prepare() is CPU-only.
//   - The MockRasterizer returns a deterministic 8x8 SDF — atlas
//     metrics + slot assignment behave identically to production.
//   - One TextStage is shared across all frames so the layout cache
//     state persists (the production stage is owned by the host).
//   - `beginFrame()` is called per frame to reset the FrameArena
//     watermark — production behaviour (`map.ts renderFrame`).
//   - addLabel + prepare run per frame, with anchorX shifted by dx
//     each frame to simulate pan.

import { describe, it, expect } from 'vitest'
import { TextStage } from '../text/text-stage'
import { MockRasterizer } from '../text/sdf/glyph-rasterizer'
import type { LabelDef, TextValue } from '@xgis/compiler'
import type { TextDraw } from '../text/text-renderer'

// WebGPU bitflag globals the GPU classes reference at construction —
// not present in the node test env. Values per the WebGPU spec.
const g = globalThis as Record<string, unknown>
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }
g.GPUBufferUsage ??= {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
}
g.GPUTextureUsage ??= {
  COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
}
g.GPUColorWrite ??= { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 }

function stubDevice(): GPUDevice {
  const stub: unknown = new Proxy(function () { return stub }, {
    get(_t, p) {
      if (p === 'size') return 1 << 22
      if (p === 'width' || p === 'height') return 4096
      if (p === 'limits') return { maxTextureDimension2D: 8192 }
      if (p === Symbol.toPrimitive) return () => 0
      return stub
    },
    apply() { return stub },
  })
  return stub as GPUDevice
}

function litValue(s: string): TextValue {
  return { kind: 'expr', expr: { ast: { kind: 'StringLiteral', value: s } as never } }
}

// Synthetic corpus mirroring z17 Seoul Liberty point-label
// distribution: a mix of CJK + Latin place names, repeated to reach
// ~180 labels/frame (the per-frame label count
// `getDispatchedLabelTexts` reports for that camera, per the memory
// note). Repetition is intentional — production has many labels
// sharing the same `name` field (POI categories, road shields)
// which the layout cache should collapse to one entry per text.
const NAMES = [
  'Seoul', 'Gangnam', 'Jongno', 'Yongsan', 'Mapo',
  '서울', '강남', '종로', '용산', '마포',
  'Itaewon', 'Hongdae', 'Sinchon', 'Apgujeong', 'Cheongdam',
  '이태원', '홍대', '신촌', '압구정', '청담',
  'Bus Stop', 'Subway', 'School', 'Park', 'Cafe',
  'Restaurant', 'Hospital', 'Hotel', 'Bank', 'Pharmacy',
] as const

// iter-#10 production scale: Liberty Seoul z17 dispatches ~180-300
// addLabel calls per frame. Use 500 to add headroom (post-Phase A
// regressions show up as quadratic ensure() loops here).
const LABELS_PER_FRAME = 500

function buildLabelDef(textStr: string): { value: TextValue; def: LabelDef } {
  return {
    value: litValue(textStr),
    def: {
      text: litValue(textStr),
      size: 12,
      font: ['Noto Sans'],
      anchor: 'center',
    } as LabelDef,
  }
}

describe('Mercator high-pitch drag p95 — across-frame layout cache (#10)', () => {
  it('prepare() p95 + ensure() call count gates over 120 pan frames', () => {
    const stage = new TextStage(
      stubDevice(), 'bgra8unorm',
      { rasterizer: new MockRasterizer() },
    )
    // Capture TextDraws so renderer.draw isn't required.
    ;(stage as unknown as { renderer: { setDraws(d: TextDraw[]): void } }).renderer.setDraws =
      (_d: TextDraw[]) => { /* noop */ }
    // Disable the real GPU upload — `prepare()` calls `gpu.flush()`
    // which would walk into the WebGPU stub.
    ;(stage as unknown as { gpu: { flush(): void } }).gpu.flush = () => { /* noop */ }

    // Per-frame ensure() call counter — the iter-161 CPU profile pinned
    // 21.5 % of drag CPU on `ensure` (atlas-state.ts:44). A correct
    // across-frame fast path on (preloadString + hasAllGlyphs) collapses
    // those calls from O(labels × chars) per frame to O(unique-text)
    // per frame (small + slow-growing). Spy on the host's `ensure`.
    const host = (stage as unknown as { host: { ensure: (fk: string, cp: number) => unknown } }).host
    let ensureCalls = 0
    const realEnsure = host.ensure.bind(host)
    host.ensure = (fk: string, cp: number) => {
      ensureCalls++
      return realEnsure(fk, cp)
    }

    // Build the per-frame corpus once. Each entry's def is reused
    // across all frames (immutable shape — only anchor changes).
    const corpus: Array<{ value: TextValue; def: LabelDef }> = []
    for (let i = 0; i < LABELS_PER_FRAME; i++) {
      corpus.push(buildLabelDef(NAMES[i % NAMES.length]!))
    }
    // Stable base anchors for each label — gives a roughly screen-
    // distributed layout so collision pass exercises realistic
    // bbox checks. Anchor coords are in physical px (1920x1080@dpr2).
    const baseAnchors: Array<[number, number]> = []
    for (let i = 0; i < LABELS_PER_FRAME; i++) {
      const x = 100 + (i * 53) % 3500
      const y = 100 + (i * 71) % 1900
      baseAnchors.push([x, y])
    }

    const FRAMES = 120
    const PAN_DX = 10  // px/frame — matches a steady drag-pan
    const PAN_DY = 0
    const perFrameMs: number[] = []

    // Warm-up frame: cold caches (first frame pays the full price).
    // Excluded from p95 — production sees one cold frame on initial
    // render, not on every drag tick. The drag p95 gate is about
    // steady-state behaviour.
    stage.beginFrame()
    for (let i = 0; i < corpus.length; i++) {
      const [bx, by] = baseAnchors[i]!
      stage.addLabel(corpus[i]!.value, {}, bx, by, corpus[i]!.def)
    }
    stage.prepare()
    stage.reset()
    // Reset ensureCalls after warm-up — the cold-frame admissions
    // are amortised across all subsequent frames and don't reflect
    // steady-state cost.
    ensureCalls = 0

    for (let f = 0; f < FRAMES; f++) {
      stage.beginFrame()
      const dx = (f + 1) * PAN_DX
      const dy = (f + 1) * PAN_DY
      for (let i = 0; i < corpus.length; i++) {
        const [bx, by] = baseAnchors[i]!
        // Only the anchor changes per frame — text + def shape is
        // immutable (matches pure-pan invariant).
        stage.addLabel(corpus[i]!.value, {}, bx + dx, by + dy, corpus[i]!.def)
      }
      const t0 = performance.now()
      stage.prepare()
      const t1 = performance.now()
      perFrameMs.push(t1 - t0)
      stage.reset()
    }

    // Stats — sorted copy for p95.
    const sorted = perFrameMs.slice().sort((a, b) => a - b)
    const p95Idx = Math.floor(sorted.length * 0.95)
    const p95 = sorted[p95Idx]!
    const median = sorted[Math.floor(sorted.length * 0.5)]!
    const max = sorted[sorted.length - 1]!
    const sum = perFrameMs.reduce((a, b) => a + b, 0)
    const mean = sum / perFrameMs.length

    const stats = stage.getLayoutCacheStats()
    const ensurePerFrame = ensureCalls / FRAMES
    // eslint-disable-next-line no-console
    console.log(
      `[merc-pitch-drag-perf] frames=${FRAMES} labels/frame=${LABELS_PER_FRAME} `
      + `mean=${mean.toFixed(2)}ms median=${median.toFixed(2)}ms `
      + `p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms `
      + `cacheHits=${stats.hits} cacheMisses=${stats.misses} `
      + `hitRate=${(stats.hitRate * 100).toFixed(1)}% `
      + `ensure/frame=${ensurePerFrame.toFixed(0)}`,
    )

    // Steady-state pan p95 target. The browser drag (#10) p95 goal
    // is < 50 ms end-to-end; the prepare() share of that budget should
    // stay well under 5 ms once the layout cache hit-rate climbs to
    // near 100 % (pan is camera-independent for shaping inputs).
    expect(p95).toBeLessThan(5)
    // Layout cache hit-rate gate — pure pan should hit ≥ 99 %
    // (every label's content is camera-independent and the corpus is
    // stable across frames). A miss here means the cache key still
    // contains a camera-dependent field.
    expect(stats.hitRate).toBeGreaterThan(0.99)
    // ensure() call-count gate. iter-161 CPU profile pinned `ensure`
    // at 21.5 % of drag CPU. preloadString + hasAllGlyphs walk every
    // codepoint of every pending label per frame, calling ensure()
    // ~LABELS_PER_FRAME × avgCharsPerLabel times (~5000 at this
    // corpus). A correct string-level fast path collapses to ≤ corpus
    // unique-text count (≤ NAMES.length × 2 for preload + hasAll).
    // 200 / frame leaves headroom for the cold-path codepoint walks
    // hitting the (text-stage-internal) atlas overflow guard. With no
    // optimisation the figure is ~5000 / frame.
    expect(ensurePerFrame).toBeLessThan(200)
  })
})
