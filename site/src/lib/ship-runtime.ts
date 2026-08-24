// ═══ Shipping-plugin variants, emitted in the BROWSER, on demand ═══
//
// The page ships only the plugin-free shader — the code tabs it already had. The moment a
// visitor flips an inline/mangle/minify toggle, this module lazily pulls the DSL emit core,
// the emit-prod plugins, that example's DSL module and a highlighter, and produces the
// variant on the spot. A visitor who never touches a toggle downloads none of it.
//
// ── why not bake every combination into the HTML (the first cut) ──
// 24 combinations per page cost +50 KB gzipped and +23k DOM nodes on the heaviest example:
// domain-warp went 3,056 -> 26,392 elements and domInteractive 115ms -> 273ms, measured
// A/B against the same page without them.
//
// ── why not prerender the combinations and fetch them ──
// That works and keeps expressive-code's own markup, but it makes every toggle a network
// round-trip and leaves nothing usable offline.
//
// ── why SHIKI here and not something 11x smaller ──
// Prism with the two shader grammars is 6.3 KB gzipped against Shiki's 69.9 KB, so it was
// the obvious choice — and it is wrong. Measured per CHARACTER against the build-time
// output on four shaders (4,361 coloured characters): Prism disagrees with expressive-code
// on 10-17% of them, because the two tokenizers genuinely differ — Shiki reads `f32` as a
// keyword, Prism as a builtin, in the same class as `abs`/`clamp`, so no CSS map can
// separate them. Flipping a toggle would recolour the whole block. Shiki here is the SAME
// engine, grammar and theme the build uses, and the same measurement returns 0.00% drift on
// all four. The colour is identical by construction, and there is no palette map to rot.
//
// Everything below is behind dynamic import(), so the cost lands on the first toggle and
// nowhere else, and the chunks are shared across all 36 example pages.

import type { EmitPlugin } from '@xgis/shader-dsl'

/** Which emitted source a panel shows. Mirrors the code tabs. */
export type ShipTarget = 'wgsl' | 'glsl-vs' | 'glsl-fs'

/** The plugins the toggles expose, in EXECUTION order — inline()/forceInline() rewrite the
 *  IR, mangle() renames what survives, minify() compacts the text. Also the order of the
 *  bits in a combination string, so a page's toggles and its bit string cannot disagree. */
export const SHIP_PLUGINS = ['inline', 'forceInline', 'mangle', 'minify'] as const

/** How a toggle spells its own call, when the bare name under-describes it. forceInline
 *  takes a strength and the two are not comparable, so the label has to say which. */
const SHIP_CALL: Partial<Record<(typeof SHIP_PLUGINS)[number], string>> = {
  forceInline: `forceInline({ strength: 'all' })`,
}

/** The caveat a toggle carries, shown as its label's tooltip. Only forceInline has one, and
 *  it is not cosmetic: 'all' is the reason fp64 examples can show zero df64_ helpers, and
 *  also the reason the byte badge jumps an order of magnitude. */
export const SHIP_HINTS: Partial<Record<(typeof SHIP_PLUGINS)[number], string>> = {
  forceInline:
    'inline() honours FuncDecl.opaque, so it is a complete no-op on the fp64 examples — ' +
    "the df64 library is never inlined and never removed. forceInline({ strength: 'all' }) " +
    'unlocks that opacity and tree-shakes the emptied declarations, so df64_* leaves the ' +
    'output entirely. Costs 5-27x the emitted bytes, and FXC can TDR on ANGLE-D3D11 ' +
    'compiling fully-inlined df64 bodies — this is a demonstration, not a shipping default.',
}

/** Every example module, as lazy dynamic imports — Vite code-splits one chunk per file, so
 *  a page pulls only its own. Filesystem-bound glob, hence the relative path (same reason
 *  shader-examples.ts keeps its raw-source glob relative).
 *
 *  The exclusions are load-bearing, not tidiness: unlike that file's `?raw` glob, this one
 *  is a real module graph, so Vite tries to bundle EVERY match for the browser — and the
 *  directory also holds the suites and the registry's node-side helpers (`_scan.ts` reads
 *  the directory with `node:fs`), which fails the build outright. */
const exampleModules = import.meta.glob([
  '../../../shader-dsl/examples/*.ts',
  '!**/_*.ts',
  '!**/*.test.ts',
  '!**/index.ts',
  '!**/print.ts',
  '!**/measure.ts',
])

interface Toolchain {
  emit: (target: ShipTarget, plugins: EmitPlugin[]) => string
  call: (target: ShipTarget, names: string[]) => string
  /** Rendered code block, coloured exactly as the build-time panel beside it. */
  highlight: (code: string, target: ShipTarget) => string
}

/** Load (once) everything needed to emit + colour this example's shaders. */
export async function shipToolchain(exampleFile: string): Promise<Toolchain> {
  const key = `../../../shader-dsl/examples/${exampleFile}`
  const loader = exampleModules[key]
  if (!loader) throw new Error(`[ship] no example module for '${exampleFile}'`)
  const [dsl, mod, hl] = await Promise.all([
    import('@xgis/shader-dsl'),
    loader() as Promise<Record<string, { module: unknown }>>,
    loadHighlighter(),
  ])
  // The example file exports exactly one ShaderExample; take it by shape, not by name, so
  // adding an example never needs a name table here.
  const example = Object.values(mod).find((v) => v && typeof v === 'object' && 'module' in v)
  if (!example) throw new Error(`[ship] '${exampleFile}' exports no shader example`)
  const m = example.module as Parameters<typeof dsl.emitModule>[0]

  return {
    emit: (target, plugins) =>
      target === 'wgsl'
        ? dsl.emitModule(m, { plugins })
        : dsl.emitGlslModule(m, target === 'glsl-vs' ? 'vertex' : 'fragment', { plugins }),
    call: (target, names) => {
      const bag = names.length ? `, { plugins: [${names.join(', ')}] }` : ''
      if (target === 'wgsl') return `emitModule(m${bag})`
      return `emitGlslModule(m, '${target === 'glsl-vs' ? 'vertex' : 'fragment'}'${bag})`
    },
    // Trailing newline is trimmed for DISPLAY only — inside a <pre> it renders as a stray
    // blank line the build-time panel does not have, so leaving it would make a toggle
    // visibly add a line. The byte badge still counts the untrimmed string: those are real,
    // shipped bytes.
    highlight: (code, target) =>
      hl.codeToHtml(code.trimEnd(), {
        lang: target === 'wgsl' ? 'wgsl' : 'glsl',
        theme: 'github-dark-default',
      }),
  }
}

/** Build the plugin array for a combination string like `101`. */
export async function shipPlugins(bits: string): Promise<EmitPlugin[]> {
  const prod = await import('@xgis/shader-dsl/emit-prod')
  const make = {
    inline: prod.inline,
    // 'all' rather than the plugin's own 'size-win' default: the point of exposing this
    // beside inline() is that it is the one setting under which the df64 call graph
    // actually disappears. SHIP_HINTS carries what that costs.
    forceInline: () => prod.forceInline({ strength: 'all' }),
    mangle: prod.mangle,
    minify: prod.minify,
  }
  return SHIP_PLUGINS.filter((_, i) => bits[i] === '1').map((n) => make[n]())
}

/** The names the call label prints, e.g. `['inline()', 'minify()']`. */
export const shipPluginNames = (bits: string): string[] =>
  SHIP_PLUGINS.filter((_, i) => bits[i] === '1').map((n) => SHIP_CALL[n] ?? `${n}()`)

/** The all-off combination — derived from SHIP_PLUGINS rather than written as a literal,
 *  so adding a toggle cannot leave a stale `'000'` silently matching nothing. */
export const SHIP_BITS_NONE = '0'.repeat(SHIP_PLUGINS.length)

/** `1,845 B` when a combination changes nothing, else `plain B → bytes B (±pct%)`.
 *  inline() can GROW the text (a multi-call helper is duplicated at each call site) and
 *  forceInline({ strength: 'all' }) always does, by 5-27x, so the delta is signed — growth
 *  there is the documented cost, not a regression. */
export function shipBadge(bytes: number, plain: number): string {
  const fmt = (n: number): string => n.toLocaleString()
  if (bytes === plain) return `${fmt(bytes)} B`
  const pct = Math.round((Math.abs(bytes - plain) / plain) * 100)
  return `${fmt(plain)} B → ${fmt(bytes)} B (${bytes < plain ? '−' : '+'}${pct}%)`
}

/** Shiki, fine-grained: core + the JS regex engine (the oniguruma WASM is the heavier half
 *  and buys nothing here) + only the two shader grammars and the one theme
 *  astro.config.mjs gives expressive-code. Anything wider would be paid for on every first
 *  toggle. */
async function loadHighlighter() {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, wgsl, glsl, theme] =
    await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('@shikijs/langs/wgsl'),
      import('@shikijs/langs/glsl'),
      import('@shikijs/themes/github-dark-default'),
    ])
  return createHighlighterCore({
    langs: [wgsl.default, glsl.default],
    themes: [theme.default],
    engine: createJavaScriptRegexEngine(),
  })
}
