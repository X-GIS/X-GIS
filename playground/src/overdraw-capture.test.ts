// ═══ ?debug=overdraw — the screen-coverage stat is a real fraction (#2356) ═══
//
// The panel's whole reason to exist is quantitative: eyeballing a downscaled overdraw
// heatmap is the trap CLAUDE.md §5 names, so this overlay inverts the colormap and prints
// numbers instead. One of those numbers was not a measurement. `readCanvas` pushes into
// `counts` only for PAINTED samples, and both `statsLine` arguments were
// `totalSampled(...)` = `counts.length` — so `cover = painted / total` was
// `counts.length / counts.length`, identically 100% for every frame that painted a single
// pixel. A half-empty frame and a full one printed the same 화면덮음.
//
// The overlay is DOM-driven with no exported seam, so the test drives the real
// `installOverdrawCapture` against a minimal DOM stub: the only modelled behaviour is
// `getImageData` returning the synthetic frame, and everything else is inert.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installOverdrawCapture } from './overdraw-capture'

/** The overlay's own colormap (overdraw-compose.ts), replicated so the fixture paints
 *  colours the inverter actually resolves back to a count. */
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
function colormapRGB(count: number): [number, number, number] {
  const s = clamp01(count / 16)
  return [
    clamp01(3 * s - 0.5) * 255,
    clamp01(2.5 * s) * clamp01(2 - 2 * s) * 255,
    clamp01(0.6 - 1.5 * s) * 255,
  ]
}
/** The empty-pixel sentinel the shader writes where nothing drew. */
const BG: [number, number, number] = [0.02 * 255, 0.02 * 255, 0.04 * 255]

const SIDE = 8 // 8x8 → stride 1, so all 64 grid points are sampled

/** An 8x8 RGBA frame whose first `paintedRows` rows are painted at overdraw `count`. */
function frame(paintedRows: number, count = 4): Uint8ClampedArray {
  const px = new Uint8ClampedArray(SIDE * SIDE * 4)
  const paint = colormapRGB(count)
  for (let y = 0; y < SIDE; y++) {
    const rgb = y < paintedRows ? paint : BG
    for (let x = 0; x < SIDE; x++) {
      const i = (y * SIDE + x) * 4
      px[i] = rgb[0]
      px[i + 1] = rgb[1]
      px[i + 2] = rgb[2]
      px[i + 3] = 255
    }
  }
  return px
}

class El {
  style = { cssText: '' }
  textContent = ''
  disabled = false
  src = ''
  width = 0
  height = 0
  children: El[] = []
  handlers: Record<string, Array<() => void>> = {}
  addEventListener(type: string, fn: () => void): void {
    ;(this.handlers[type] ??= []).push(fn)
  }
  click(): void {
    for (const fn of this.handlers.click ?? []) fn()
  }
  append(...c: El[]): void {
    this.children.push(...c)
  }
  appendChild(c: El): void {
    this.children.push(c)
  }
  replaceChildren(): void {
    this.children = []
  }
  remove(): void {}
}

/** Install the overlay over a stub DOM whose canvas reads back `px`, tap 측정, and return
 *  the report text the panel printed. */
async function runPanel(px: Uint8ClampedArray): Promise<string> {
  const created: El[] = []
  const canvas = new El()
  canvas.width = SIDE
  canvas.height = SIDE
  Object.assign(canvas, {
    toDataURL: () => `data:image/png;base64,${'A'.repeat(2000)}`,
    getContext: () => ({
      imageSmoothingEnabled: false,
      drawImage: () => {},
      getImageData: () => ({ data: px }),
    }),
  })

  const doc = {
    getElementById: () => null,
    createElement: (): El => {
      const el = new El()
      Object.assign(el, {
        getContext: () => ({
          imageSmoothingEnabled: false,
          drawImage: () => {},
          getImageData: () => ({ data: px }),
        }),
      })
      created.push(el)
      return el
    },
    querySelector: (sel: string): El | null => (sel === 'canvas' ? canvas : null),
    body: new El(),
  }
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  vi.stubGlobal(
    'Image',
    class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_v: string) {
        queueMicrotask(() => this.onload?.())
      }
    },
  )

  const camera = { zoom: 3, centerX: 0, centerY: 0, pitch: 0, bearing: 0 }
  installOverdrawCapture({ getCamera: () => camera, invalidate: () => {} })

  // panel = [bar, pre, imgs]; bar = [run, copy, close].
  const panel = doc.body.children[0]!
  const pre = panel.children[1]!
  panel.children[0]!.children[0]!.click()
  // Two 4 s settles plus slack; async-advancing also flushes the Image onload microtask.
  await vi.advanceTimersByTimeAsync(10_000)
  return pre.textContent
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('?debug=overdraw — 화면덮음 is painted / SAMPLED (#2356)', () => {
  it('a half-painted frame reports 50%, not 100%', async () => {
    const report = await runPanel(frame(SIDE / 2))
    // Pre-fix both pitch lines read 화면덮음=100% — `painted` and `total` were the same
    // expression, so the ratio could not be anything else.
    expect(report).toContain('화면덮음=50%')
    expect(report).not.toContain('화면덮음=100%')
    // The painted-pixel stats are unchanged: 32 samples, all at overdraw 4.
    expect(report).toContain('평균=4.0×')
  })

  it('CONTROL — a fully painted frame still reports 100%', async () => {
    // Separates "coverage is now a real fraction" from "coverage is now always wrong".
    const report = await runPanel(frame(SIDE))
    expect(report).toContain('화면덮음=100%')
  })

  it('CONTROL — an entirely background frame reports no painted pixels at all', async () => {
    // `statsLine` short-circuits on an empty `counts`, so this exercises the branch that
    // never reaches the coverage arithmetic — the divide-by-zero neighbour of the defect.
    const report = await runPanel(frame(0))
    expect(report).toContain('(그려진 픽셀 없음 / 캡처 실패)')
    expect(report).not.toContain('화면덮음')
  })

  it('coverage tracks the painted fraction across the range', async () => {
    for (const [rows, pctText] of [
      [1, '13%'],
      [2, '25%'],
      [6, '75%'],
    ] as const) {
      expect(await runPanel(frame(rows))).toContain(`화면덮음=${pctText}`)
    }
  })
})
