// ═══ A region's bind group and its draw must come from the SAME draper (#1437) ═══
//
// THE BUG THIS EXISTS FOR, measured on screen and invisible to everything else.
//
// #1437 keyed drapers by compiled `filter:` predicate, because the predicate is baked into the
// pipeline. `groupFor` still minted the bind group from `ensureDraper()` — no arguments, so the
// UNFILTERED draper — while the draw ran the FILTERED draper's pipeline. Binding 0 is the
// draper's own global uniform buffer and `draw` writes only its own, so the shader read a
// buffer nobody had written: the whole 128-byte block was zero. That is not a subtle shift —
// a zero MVP collapses every vertex, so the drape vanished entirely, and `cov_data` being zero
// would have rejected every fragment even if it had not.
//
// 4 020 unit tests, `bun run build`, and tsc were all green: the two drapers are the same TYPE,
// and no test drove a FILTERED arm through the draw path. One headless WebGL2 render showed a
// black map (CLAUDE.md §5). This gate is the cheap, CI-fast twin of that render.
//
// It asserts the INVARIANT, not the call shape: the buffer bound at binding 0 for the region's
// group must be a buffer the draw actually writes. A source-text check for "groupFor does not
// call ensureDraper" would pass the moment somebody passed the wrong draper explicitly.

import { describe, it, expect } from 'vitest'
import { coverageFromGrids, type CoverageInput } from '@xgis/data/coverage'
import { Lexer, Parser, lower } from '@xgis/compiler'
import { CoverageRenderer } from './coverage-renderer'

/** The lowered `filter:` clause a coverage layer carries. */
function filterExpr(src: string): { ast: unknown } {
  const scene = lower(
    new Parser(
      new Lexer(
        `xgis 1\nsource s { type: geojson }\nlayer l { source: s, filter: ${src} | fill-red-500 }\n`,
      ).tokenize(),
    ).parse(),
  )
  const node = scene.renderNodes.find((n) => n.name === 'l')
  if (!node?.filter) throw new Error(`filter did not lower for: ${src}`)
  return node.filter
}

interface Buf {
  __buf: true
  id: number
}
interface Group {
  __bg: true
  uniform: Buf | undefined
}

/** Mock RHI that remembers which buffer each bind group put at binding 0, and every buffer the
 *  frame writes — the two halves the invariant compares. */
function makeCtx(): {
  ctx: unknown
  groups: Group[]
  written: Set<Buf>
} {
  let id = 0
  const groups: Group[] = []
  const written = new Set<Buf>()
  const rhi = {
    backend: 'webgl2' as const,
    caps: { maxSampleCount: 1 },
    createBindGroupLayout: () => ({ __layout: true }),
    createPipeline: () => ({ __pipe: true }),
    createShaderModule: () => ({ __mod: true }),
    createSampler: () => ({ __sampler: true }),
    createBuffer: (): Buf => ({ __buf: true, id: ++id }),
    createBindGroup: (_l: unknown, entries: { binding: number; resource: { buffer?: Buf } }[]) => {
      const g: Group = {
        __bg: true,
        uniform: entries.find((e) => e.binding === 0)?.resource.buffer,
      }
      groups.push(g)
      return g
    },
    createView: () => ({ __view: true }),
    createTexture: (d: { label?: string }) => ({ __tex: true, label: d.label ?? '' }),
    writeTexture: () => {},
    writeBuffer: (b: Buf) => void written.add(b),
    destroyTexture: () => {},
    destroySampler: () => {},
    destroyBuffer: () => {},
  }
  return { ctx: { rhi, format: 'bgra8unorm' }, groups, written }
}

/** A grid whose depths straddle any threshold these tests use. */
function handle(): ReturnType<typeof coverageFromGrids> {
  const n = 4
  const input: CoverageInput = {
    product: 's102',
    origin: [10, 50],
    spacing: [1, 1],
    size: [n, n],
    vertical: { datumCode: null, sign: 'down' },
    bands: [
      {
        name: 'depth',
        unit: 'metres',
        kind: 'f32',
        nodata: -9999,
        values: Float32Array.from(Array.from({ length: n * n }, (_, i) => i * 2)),
      },
    ],
  }
  return coverageFromGrids(input)
}

const MVP = new Float32Array(16)
/** A recording pass — every method the material's draw path calls, doing nothing. The gate is
 *  about which BUFFER the group carries, so the pass only has to not throw. */
const pass = (): unknown => ({
  setPipeline: () => {},
  setBindGroup: () => {},
  setVertexBuffer: () => {},
  setIndexBuffer: () => {},
  draw: () => {},
  drawIndexed: () => {},
})
const draw = (r: CoverageRenderer): void => {
  r.render(pass() as never, MVP, [0, 0], [0, 0, 0, 0], null, 5)
}

describe('coverage drape — one draper owns both the pipeline and the uniform buffer', () => {
  it('a FILTERED region binds a uniform buffer the draw actually writes', () => {
    const { ctx, groups, written } = makeCtx()
    const r = new CoverageRenderer(ctx as never)
    r.setCoverage(handle(), { ramp: 'viridis', filter: filterExpr('.depth > 2.0') })
    draw(r)

    // Non-vacuity first: without a bind group carrying a binding-0 buffer, and without a write,
    // the assertion below would hold trivially.
    const bound = groups.map((g) => g.uniform).filter((b): b is Buf => b !== undefined)
    expect(bound.length, 'a bind group put a buffer at binding 0').toBeGreaterThan(0)
    expect(written.size, 'the draw wrote a uniform buffer').toBeGreaterThan(0)

    // THE INVARIANT. Pre-fix this failed: the group held the unfiltered draper's buffer and the
    // draw wrote the filtered draper's, so the shader read 128 zero bytes.
    for (const b of bound) {
      expect(written.has(b), 'the bound uniform buffer is one the draw writes').toBe(true)
    }
  })

  it('an UNFILTERED region keeps the same property', () => {
    // The case that was already correct — kept so a fix that only special-cases the filtered
    // path cannot pass by breaking the path that used to work.
    const { ctx, groups, written } = makeCtx()
    const r = new CoverageRenderer(ctx as never)
    r.setCoverage(handle(), { ramp: 'viridis' })
    draw(r)
    const bound = groups.map((g) => g.uniform).filter((b): b is Buf => b !== undefined)
    expect(bound.length).toBeGreaterThan(0)
    for (const b of bound) expect(written.has(b)).toBe(true)
  })

  it('an uncompilable predicate fails LOUDLY rather than drawing unfiltered', () => {
    const { ctx } = makeCtx()
    const r = new CoverageRenderer(ctx as never)
    // A second band the GPU arm cannot bind. Silence here would paint every cell while the
    // style says otherwise — the defect class this whole path exists to close.
    expect(() =>
      r.setCoverage(handle(), { ramp: 'viridis', filter: filterExpr('.depth == "deep"') }),
    ).toThrow(/filter/)
  })

  it('a predicate over a band this layer does not drape names both bands', () => {
    const { ctx } = makeCtx()
    const r = new CoverageRenderer(ctx as never)
    expect(() =>
      r.setCoverage(handle(), { ramp: 'viridis', filter: filterExpr('.speed > 1.0') }),
    ).toThrow(/speed(.|\n)*depth|depth(.|\n)*speed/)
  })
})
