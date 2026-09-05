// ═══ #2499 step 0 — boot shader provenance: every shader the driver compiles at boot came from the bake ═══
//
// The bake exists so a first frame costs zero shader emits, and nothing measured that at
// the seam where it is decided: the BYTES handed to the driver. The baked-source store
// counts LOOKUPS (`hits` / `misses` / `absent` / `closed`), but a call site that never asks
// the store — a `MaterialDesc` whose `shader:` is a bare emit result, a `vsCode: gl2 ?
// emitX() : undefined`, a `device.createShaderModule({ code: emitX() })` — appears in no
// counter, and the pixels are identical either way, so no render gate can see it. This gate
// measures the quantity the subsystem moves: it wraps `GPUDevice.prototype.createShaderModule`
// and `WebGL2RenderingContext.prototype.shaderSource` BEFORE the page boots, lets
// `demo.html?id=minimal` reach idle, and classifies every source it saw:
//
//   baked    — byte-equal to a source in one of the six committed artifacts. BYTES CARRY NO
//              PROVENANCE: the seam serves the same text on a hit and on a miss
//              (`wgsl-for.ts`: `bakedSource(id) ?? shipSource(emit())`, and `baked-sync`
//              pins artifact === shipSource(live emit)), so this bucket means "closed-set
//              bytes", whether the store served them or a keyed miss re-emitted them. Whether
//              the boot READ its bake is the store's own accounting, read through
//              `window.__xgisBakedStore()` (install.ts): `misses === 0` and the served set.
//   host     — an RHI-internal helper (`rhi:` label prefix; e.g. mip generation), not a DSL emit
//   open     — a per-STYLE variant program (compiled under a `shader-<variant.key>` pipeline
//              label): style-derived bytes the closed set is DEFINED to exclude (plan §7
//              decision 1 keeps these on the runtime emit) — reported, never pinned
//   RUNTIME  — everything else: a closed-set shader emitted at runtime, or a family the
//              closed set has no key shape for (#2499 names both kinds)
//
// The RUNTIME set is pinned per backend as a SHRINK-ONLY table (`RUNTIME_AT_BOOT`), one row
// per ENTRY-POINT SIGNATURE with the number of distinct programs behind it — the legacy
// polygon module and its split-bind twin declare identical entries, so they are one row
// `×2`, and baking either one shrinks the count. Pipeline labels are deliberately NOT part
// of a row: they churn with every new Material variant and would red this gate for reasons
// that have nothing to do with provenance (they are still printed, for diagnosis). WebGL2 is
// empty (#2459 measured zero runtime lowerings there and this arm keeps it so); WebGPU
// carried the fail-before #2499 records and is empty since its step 1. A count that drops
// WITHOUT the table shrinking reds (the table would then claim an emit the boot no longer
// performs), and a new row or a higher count reds — an eighth family cannot arrive un-baked
// in silence, which is the point.
//
// Anti-vacuity arms run first: the artifacts parsed into a non-trivial source set, the page
// compiled at least one shader, and at least one compiled source IS baked — a hand-off that
// rewrote the text (a prefix, a re-minify) would otherwise read as "everything is runtime"
// and the message would blame the wrong half.
//
// PROVENANCE MUST NOT MOVE A PIXEL. Each backend boots twice — baked, then `?nobake=1`
// (`debug-flags.ts`, the seam switched off: every family runs its thunk) — and the two
// frames must hash equal (§5's strongest rung; the `_1678` hillshade gate's shape, on both
// backends). The `nobake` boot also proves the switch: the store must have served NOTHING
// (`hits === 0`, nothing installed) — not "compiled zero baked programs", which the byte
// identity above makes impossible to observe.

import { test, expect, type Page } from '@playwright/test'
import { awaitMapIdle, captureMapFrame, hashScreenshot } from './helpers/visual'
// Relative deep imports (charter): Playwright transpiles specs in raw Node, where the
// @xgis/* workspace alias does not resolve. The generated artifacts import only a type.
import { BAKED_GLSL_BOOT } from '../../map/src/shaders/baked/baked-glsl-boot.generated'
import { BAKED_GLSL_HILLSHADE } from '../../map/src/shaders/baked/baked-glsl-hillshade.generated'
import { BAKED_GLSL_LAZY } from '../../map/src/shaders/baked/baked-glsl-lazy.generated'
import { BAKED_WGSL_BOOT } from '../../map/src/shaders/baked/baked-wgsl-boot.generated'
import { BAKED_WGSL_HILLSHADE } from '../../map/src/shaders/baked/baked-wgsl-hillshade.generated'
import { BAKED_WGSL_LAZY } from '../../map/src/shaders/baked/baked-wgsl-lazy.generated'

// Declared here, where it covers the fixture too: a budget inside the test body governs
// the body only, and a loaded SwiftShader runner times out in context setup (§12).
test.describe.configure({ timeout: 240_000 })

interface Seen {
  lang: 'wgsl' | 'glsl'
  label: string
  code: string
}

/** Every distinct source the six artifacts carry, both languages, all three groups. */
const BAKED: ReadonlySet<string> = new Set(
  [
    BAKED_GLSL_BOOT,
    BAKED_GLSL_HILLSHADE,
    BAKED_GLSL_LAZY,
    BAKED_WGSL_BOOT,
    BAKED_WGSL_HILLSHADE,
    BAKED_WGSL_LAZY,
  ].flatMap((a) => Object.values(a.contents)),
)

/** RHI-internal helpers (rhi-webgpu.ts `rhi:mipgen`) are not DSL emits — no bake to come from. */
const HOST_LABEL = /^rhi:/
/** A per-style variant pipeline (pipeline-factory.ts `label: \`shader-${variant.key}\``). A
 *  program compiled under one such label is style-derived wherever else it was also compiled. */
const OPEN_SET_LABEL = /^shader-./

/** The fail-before, per backend. SHRINK-ONLY — see the header. Rows are `<lang> <entry
 *  points> ×<distinct programs>`, sorted. EMPTY on both backends since #2499 step 1: the
 *  split-bind twins (`wgsl/polygon-split`, `wgsl/line-split`) and `wgsl/oit-compose/s<n>` are
 *  `WgslOnlyFamily` keys in the boot artifact, and `buildShader(null)` reads `wgsl/polygon`.
 *  The rows this table carried on the way down, for the record: `wgsl vs_main+…+fs_overdraw
 *  ×2` (the legacy polygon base and its split twin), `wgsl vs_line+… ×1`, `wgsl
 *  vs_full+fs_compose ×1`. A new row is a new un-baked family — decide its key shape in
 *  ids.ts, do not add it here. */
const RUNTIME_AT_BOOT: Readonly<Record<'webgpu' | 'webgl2', readonly string[]>> = {
  webgl2: [],
  webgpu: [],
}

// Runs before any page script (addInitScript). Plain JS on purpose — it is evaluated in
// the page, where no TS exists; the two `orig.call`s keep the driver path bit-identical.
const INIT = `(() => {
  const rec = [];
  window.__xgisShaderProvenance = rec;
  const G = globalThis.GPUDevice;
  if (G && G.prototype && G.prototype.createShaderModule) {
    const orig = G.prototype.createShaderModule;
    G.prototype.createShaderModule = function (desc) {
      rec.push({ lang: 'wgsl', label: desc && desc.label ? String(desc.label) : '', code: String(desc && desc.code) });
      return orig.call(this, desc);
    };
  }
  const W = globalThis.WebGL2RenderingContext;
  if (W && W.prototype && W.prototype.shaderSource) {
    const orig = W.prototype.shaderSource;
    W.prototype.shaderSource = function (sh, src) {
      rec.push({ lang: 'glsl', label: '', code: String(src) });
      return orig.call(this, sh, src);
    };
  }
})();`

/** The entry-point signature a program is pinned by (WGSL), or its uniform blocks (GLSL
 *  spells one `main` per stage), or a head of the text when neither is present. */
function signatureOf(p: Program): string {
  const entries = [...p.code.matchAll(/@(?:vertex|fragment|compute)\s*fn\s+(\w+)/g)].map(
    (m) => m[1],
  )
  const blocks = [...p.code.matchAll(/uniform\s+(\w+)\s*\{/g)].map((m) => m[1])
  const names =
    entries.length > 0
      ? entries.join('+')
      : blocks.length > 0
        ? `uniform ${blocks.join('+')}`
        : p.code.slice(0, 48).replace(/\s+/g, ' ')
  return `${p.lang} ${names}`
}

/** Diagnosis line: every pipeline label the program was compiled under, its size, and how
 *  many times the driver compiled it (rhi-webgpu.ts:698 creates one module per pipeline). */
function describeProgram(p: Program): string {
  return `${signatureOf(p)} — ${p.code.length} chars, compiled ${p.compiles}× as [${[...p.labels].sort().join('|')}]`
}

/** One distinct program (by bytes), however many pipelines compiled it. */
interface Program {
  lang: 'wgsl' | 'glsl'
  code: string
  labels: Set<string>
  compiles: number
}

interface Provenance {
  seen: number
  baked: number
  host: number
  open: readonly Program[]
  runtime: readonly Program[]
}

function classify(seen: readonly Seen[]): Provenance {
  let baked = 0
  let host = 0
  const programs = new Map<string, Program>()
  for (const s of seen) {
    if (BAKED.has(s.code)) baked++
    else if (HOST_LABEL.test(s.label)) host++
    else {
      const p = programs.get(s.code) ?? {
        lang: s.lang,
        code: s.code,
        labels: new Set(),
        compiles: 0,
      }
      p.labels.add(s.label)
      p.compiles++
      programs.set(s.code, p)
    }
  }
  const all = [...programs.values()]
  const isOpen = (p: Program): boolean => [...p.labels].some((l) => OPEN_SET_LABEL.test(l))
  return {
    seen: seen.length,
    baked,
    host,
    open: all.filter(isOpen),
    runtime: all.filter((p) => !isOpen(p)),
  }
}

/** `window.__xgisBakedStore()` (map/src/shaders/baked/install.ts). */
interface StoreReading {
  ids: number
  hits: number
  misses: number
  absent: number
  closed: number
  served: readonly string[]
  emitted: readonly string[]
}

interface Boot {
  seen: Seen[]
  /** Hash of the settled, chrome-free map frame (captureMapFrame → hashScreenshot). */
  hash: string
  store: StoreReading
}

async function bootAndCollect(
  page: Page,
  url: string,
  backend: 'webgpu' | 'webgl2',
): Promise<Boot> {
  await page.addInitScript(INIT)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisMap?: unknown }).__xgisMap !== undefined,
    undefined,
    { timeout: 120_000 },
  )
  const idle = await awaitMapIdle(page, 90_000)
  expect(idle, `${backend}: the map must reach idle before its first frame is measured`).toBe(
    'idle',
  )
  const marker = await page.evaluate(
    () => (window as unknown as { __xgisActiveBackend?: string | null }).__xgisActiveBackend,
  )
  // Assert the backend, so a silent fallback cannot green the other backend's arm.
  expect(marker, `window.__xgisActiveBackend for ${url}`).toBe(backend)
  // Capture BEFORE reading the record: the frame is what the boot compiled shaders for, so
  // anything a late pass compiles on the way to it is part of the boot's provenance.
  const hash = await hashScreenshot(page, await captureMapFrame(page))
  const seen = await page.evaluate(
    () => (window as unknown as { __xgisShaderProvenance?: Seen[] }).__xgisShaderProvenance ?? [],
  )
  const store = await page.evaluate(() => {
    const w = window as unknown as { __xgisBakedStore?: () => StoreReading }
    return w.__xgisBakedStore?.() ?? null
  })
  expect(
    store,
    `${backend}: window.__xgisBakedStore is not published — install.ts did not run`,
  ).not.toBeNull()
  return { seen, hash, store: store! }
}

/** The two-boot arm: provenance pinned on the baked boot, then the bake switched off and the
 *  frame required to be byte-identical. Returns nothing — every claim is an expect. */
async function bakedVsLive(page: Page, url: string, backend: 'webgpu' | 'webgl2'): Promise<void> {
  const baked = await bootAndCollect(page, url, backend)
  assertProvenance(backend, baked.seen)
  // The store's own word on whether the boot READ its bake (bytes cannot say — header).
  expect(baked.store.hits, `${backend}: the bake served nothing on a baked boot`).toBeGreaterThan(0)
  expect(
    baked.store.misses,
    `${backend}: a keyed call site asked for an id the installed artifact does not carry — ` +
      `a bake drift (re-run bun run build, then bun run bake:shaders). Emitted: ` +
      `${baked.store.emitted.join(', ')}`,
  ).toBe(0)
  if (backend === 'webgpu')
    expect(
      baked.store.served.some((id) => id.startsWith('wgsl/polygon/')),
      `the WebGPU polygon base shader did not come from the store (served: ` +
        `${baked.store.served.join(', ')}) — buildShader(null) stopped asking it (#2499)`,
    ).toBe(true)

  const live = await bootAndCollect(page, `${url}&nobake=1`, backend)
  expect(live.store.ids, `${backend} ?nobake=1: an artifact was still installed`).toBe(0)
  expect(live.store.hits, `${backend} ?nobake=1: the store still served a lookup`).toBe(0)
  expect(classify(live.seen).seen, `${backend} ?nobake=1 compiled nothing`).toBeGreaterThan(0)
  expect(
    live.hash,
    `${backend}: the ?nobake=1 frame differs from the baked frame — serving baked bytes ` +
      `moved a pixel (or the scene is not deterministic on this rasterizer; check the same ` +
      `URL twice before blaming the bake)`,
  ).toBe(baked.hash)
}

function assertProvenance(backend: 'webgpu' | 'webgl2', seen: readonly Seen[]): void {
  const p = classify(seen)
  // Anti-vacuity: the page compiled something, and the hand-off is byte-transparent.
  expect(
    p.seen,
    `${backend}: no shader reached the driver — the wrapper did not install`,
  ).toBeGreaterThan(0)
  expect(
    p.baked,
    `${backend}: ${p.seen} shaders compiled and NONE is byte-equal to a baked source — the ` +
      `driver hand-off rewrites the text, so this gate is blind (fix the instrument, not the bake)`,
  ).toBeGreaterThan(0)
  const perSignature = new Map<string, number>()
  for (const r of p.runtime)
    perSignature.set(signatureOf(r), (perSignature.get(signatureOf(r)) ?? 0) + 1)
  const rows = [...perSignature].map(([sig, n]) => `${sig} ×${n}`).sort()
  const detail = [
    ...p.runtime.map((r) => `RUNTIME ${describeProgram(r)}`),
    ...p.open.map((r) => `open    ${describeProgram(r)}`),
  ].sort()
  expect(
    rows,
    `${backend}: programs compiled at boot from a RUNTIME emit (baked=${p.baked}, host=${p.host}, ` +
      `open=${p.open.length}, seen=${p.seen} module compiles). Each row is a family that pays its ` +
      `emit on the first-frame path — #2499. A row or count NOT in RUNTIME_AT_BOOT is a new ` +
      `un-baked family; a table row NOT here is a family that now reads its bake — shrink the ` +
      `table.\n  ${detail.join('\n  ')}`,
  ).toEqual([...RUNTIME_AT_BOOT[backend]].sort())
}

test.describe('#2499 — boot shader provenance (demo.html?id=minimal, ?adaptive=0)', () => {
  test('the six committed artifacts parse into a non-trivial source set', () => {
    // Without this every membership test below is over an empty set and reads as "all runtime".
    expect(BAKED.size, 'distinct baked sources across the six artifacts').toBeGreaterThan(40)
  })

  test('WebGL2: every shader compiled at boot is baked, and ?nobake=1 draws the same frame', async ({
    page,
  }) => {
    await bakedVsLive(page, '/demo.html?id=minimal&adaptive=0&forcegl2=1', 'webgl2')
  })

  test('WebGPU: every shader compiled at boot is baked minus the pinned rows, and ?nobake=1 draws the same frame', async ({
    page,
  }) => {
    await bakedVsLive(page, '/demo.html?id=minimal&adaptive=0', 'webgpu')
  })
})
