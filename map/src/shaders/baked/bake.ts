// ═══ Baked shaders — artifact assembly (the logic map/scripts/bake-shaders.ts drives) ═══
//
// The generator is a thin driver by design: `map/scripts/` is OUTSIDE map's tsconfig
// `include` (rootDir is `src`), so anything living there is invisible to `tsc --build`
// — the repo's typecheck authority. Everything that can be wrong therefore lives here,
// under map/src, where the build checks it and the sync gate can import it: the key
// walk, the dedup, and the exact text of the emitted modules. The script only
// configures the host seams, calls these two functions, and writes + formats files.

import { BAKED_GROUPS, bakedGroupOf } from './ids'
import {
  BAKED_SHADER_KEYS,
  bakedContentHash,
  currentBakedMeta,
  type BakedArtifact,
  type BakedGroup,
  type BakedLanguage,
} from './registry'

/** The two axes an artifact FILE is keyed on. Language, because a device reads exactly
 *  one; group, because a boot downloads only the groups it needs (see `BakedGroup`). The
 *  group domain is re-exported from the id leaf, which owns the family → group table —
 *  `map/scripts/bake-shaders.ts` walks this pair to write one file per cell. */
export const BAKED_LANGUAGES: readonly BakedLanguage[] = ['glsl', 'wgsl']
export { BAKED_GROUPS }

/** Committed artifact file name per (language, group), relative to this directory. */
export const bakedArtifactFile = (language: BakedLanguage, group: BakedGroup): string =>
  `baked-${language}-${group}.generated.ts`

/** The const each artifact module exports. `baked-sync.test.ts` imports the four consts
 *  by name directly, and `seed-hillshade.ts` names the two hillshade ones in its dynamic
 *  import — so this spelling is a contract, not an internal detail. */
export const bakedExportName = (language: BakedLanguage, group: BakedGroup): string =>
  `BAKED_${language.toUpperCase()}_${group.toUpperCase()}`

/** Emit every registry key of `(language, group)` NOW and content-address the results.
 *
 *  Requires the host seams to be configured (`configureProjections`, and
 *  `applyBodyOption` for the body consts) — the same contract every draper emit has.
 *  Two ids sharing a hash MUST share the source; a hash collision is asserted away
 *  here rather than trusted, because the artifact would otherwise serve one shader's
 *  bytes for another.
 *
 *  The content store is per FILE, so a source shared across the split (the GLSL vertex
 *  stage hillshade and raster both spell) is stored in each file that addresses it.
 *  That is the price of the split and it is the right way round: the alternative is a
 *  shared chunk every group must download to resolve its own index. */
export function buildBakedArtifact(language: BakedLanguage, group: BakedGroup): BakedArtifact {
  const contents: Record<string, string> = {}
  const index: Record<string, string> = {}
  for (const key of BAKED_SHADER_KEYS) {
    if (key.language !== language || bakedGroupOf(key.family) !== group) continue
    const source = key.emit()
    const hash = bakedContentHash(source)
    const seen = contents[hash]
    if (seen !== undefined && seen !== source)
      throw new Error(
        `bake: content-hash collision on ${hash} (${key.id}) — two distinct sources share an address`,
      )
    contents[hash] = source
    index[key.id] = hash
  }
  return { meta: currentBakedMeta(), contents, index }
}

// ── The size report (`bun run bake:shaders --report`) ──
//
// The lazy split is only worth its extra file if `boot` is MATERIALLY smaller than
// `boot + lazy` for the language in question — #1679 increment 9 decides keep-or-collapse
// on exactly that comparison, and a decision made without the numbers is a decision made
// twice. So the generator measures what it just wrote.
//
// The measured bytes are the RENDERED MODULE's, not the sum of the shader strings: the
// module is what a chunk actually carries (JSON escaping and the index included), and gzip
// is what the wire carries. The gzip function is INJECTED because `Bun.gzipSync` exists
// only in the script's runtime, and everything typechecked has to live under map/src.

export interface BakedReportRow {
  readonly language: BakedLanguage
  readonly group: BakedGroup
  readonly keys: number
  /** DISTINCT sources — the GLSL vertex stage is shared verbatim across permutations, so
   *  this collapses hard and the gap between it and `keys` is what the dedup bought. */
  readonly distinct: number
  readonly rawBytes: number
  readonly gzipBytes: number
}

export function bakedReportRow(
  language: BakedLanguage,
  group: BakedGroup,
  artifact: BakedArtifact,
  moduleText: string,
  gzip: (bytes: Uint8Array) => Uint8Array,
): BakedReportRow {
  const raw = new TextEncoder().encode(moduleText)
  return {
    language,
    group,
    keys: Object.keys(artifact.index).length,
    distinct: Object.keys(artifact.contents).length,
    rawBytes: raw.byteLength,
    gzipBytes: gzip(raw).byteLength,
  }
}

const pad = (s: string | number, w: number): string => String(s).padStart(w)

/** The report text. Per (language, group): keys, distinct sources, raw and gzip bytes —
 *  then, per language, the ONE comparison increment 9 turns on. */
export function formatBakedReport(rows: readonly BakedReportRow[]): string {
  const out: string[] = [
    'baked shader artifacts — bytes are the COMMITTED MODULE text (raw / gzip)',
    '',
    `${'language'.padEnd(9)}${'group'.padEnd(11)}${pad('keys', 5)}${pad('distinct', 10)}${pad('raw', 11)}${pad('gzip', 10)}`,
  ]
  for (const r of rows)
    out.push(
      `${r.language.padEnd(9)}${r.group.padEnd(11)}${pad(r.keys, 5)}${pad(r.distinct, 10)}` +
        `${pad(r.rawBytes, 11)}${pad(r.gzipBytes, 10)}`,
    )
  out.push('', 'what a boot downloads (hillshade is seeded separately, and is in both arms):')
  for (const language of BAKED_LANGUAGES) {
    const of = (group: BakedGroup): BakedReportRow | undefined =>
      rows.find((r) => r.language === language && r.group === group)
    const hill = of('hillshade')
    const boot = of('boot')
    const lazy = of('lazy')
    if (!hill || !boot || !lazy) continue
    const split = hill.gzipBytes + boot.gzipBytes
    const collapsed = split + lazy.gzipBytes
    const saved = collapsed - split
    out.push(
      `  ${language}: split = hillshade+boot = ${split} B gzip; collapsed = +lazy = ${collapsed} B gzip ` +
        `→ the lazy split keeps ${saved} B (${((100 * saved) / collapsed).toFixed(1)}%) off every boot`,
    )
  }
  return out.join('\n')
}

/** Entries in KEY order — what `index` wants, since its keys are the registry ids a
 *  reader looks things up by. */
const sortedEntries = (o: Readonly<Record<string, string>>): [string, string][] =>
  Object.keys(o)
    .sort()
    .map((k) => [k, o[k] as string])

/** Entries grouped by SOURCE LENGTH, not by key (#1875).
 *
 *  Either order makes the bake reproducible, which is the only property this file needs
 *  from a sort. But the keys are content HASHES, so hash order scatters near-identical
 *  shaders to pseudo-random distances from each other — and this corpus is mostly
 *  redundancy: dozens of sources sharing a projection prelude, a df64 library and an
 *  identical header. gzip's window is 32 KB against a ~370 KB artifact, so it collapses
 *  that redundancy only where similar sources sit near each other. Length is what puts
 *  them there: shaders of a family differ by a variant clause, not an order of magnitude.
 *  Measured over the six committed artifacts, with not one emitted byte changed, gzip
 *  goes 106_742 -> 83_830 (-21.5%), and no artifact gets worse.
 *
 *  Length, not the source text: lexicographic order was tried and is worse (-16.9%) AND
 *  regresses one artifact (+4.6% on wgsl-hillshade), because two near-identical shaders
 *  that differ early in the string sort far apart. The hash is the tiebreak, which is
 *  what keeps this a TOTAL order and so still reproducible.
 *
 *  Two things this is NOT. It is not a brotli win — brotli's window spans the file and
 *  finds those matches wherever they sit (every ordering lands within 0.7%), so the
 *  transfer saving is for gzip-only clients. And it is not primarily about bytes: hash
 *  order makes an artifact's compressed size a function of hash luck rather than of its
 *  content, so ANY emit change reshuffles the file and moves gzip by more than the change
 *  itself does. That is what made a #1867 measurement read as a "+3.2% gzip regression"
 *  that did not exist. Ordering on the content makes a size delta mean what it says. */
const groupedEntries = (o: Readonly<Record<string, string>>): [string, string][] =>
  Object.entries(o).sort(
    ([ka, a], [kb, b]) => a.length - b.length || (ka < kb ? -1 : ka > kb ? 1 : 0),
  )

/** The TypeScript source of a committed artifact module.
 *
 *  One JSON-escaped line per entry — the LOC ceiling walker
 *  (`map/src/loc-ceiling-ratchet.test.ts`) counts NEWLINES over every non-test .ts
 *  under map/src, so a pretty-printed source (thousands of lines of shader text)
 *  would blow the 800-line new-file cap on the first family. Keys are sorted so the
 *  output is a function of the CONTENT, not of iteration order.
 *
 *  NO provenance header (no SHA, no timestamp): a branch commit stamped into a
 *  generated file stops being reachable the moment the PR squash-merges, which is
 *  exactly how #1397 turned main red for everyone. The regeneration COMMAND is the
 *  durable pointer; `baked-sync.test.ts` is what proves the bytes are current. */
export function renderBakedModule(
  language: BakedLanguage,
  group: BakedGroup,
  artifact: BakedArtifact,
): string {
  const name = bakedExportName(language, group)
  const upper = language.toUpperCase()
  const lines: string[] = [
    '// GENERATED by map/scripts/bake-shaders.ts — DO NOT EDIT. Regenerate: bun run bake:shaders',
    '//',
    `// The '${group}' group of the closed ${upper} shader set, baked at build time`,
    '// (#1678 / #1484). One file per (language, group), so a boot downloads only what it will',
    "// read: 'hillshade' seeds the emit pool, 'boot' is installed into the baked-source store",
    "// at device attach, and 'lazy' is imported by nothing at runtime — the bundler drops it",
    '// whole. `contents` stores each DISTINCT source once, addressed by its content hash;',
    '// `index` maps every `map/src/shaders/baked/registry.ts` id onto its content.',
    '// `meta` pins the body consts + projection-graph fingerprint this bake is valid under.',
    '//',
    '// `baked-sync.test.ts` re-emits every registry key and byte-compares it against this',
    '// file, so a drifted artifact fails the suite rather than shipping a stale shader.',
    '',
    "import type { BakedArtifact } from './registry'",
    '',
    `export const ${name}: BakedArtifact = {`,
    '  meta: {',
    `    EARTH_R: ${artifact.meta.EARTH_R},`,
    `    EARTH_E2: ${artifact.meta.EARTH_E2},`,
    `    WGS84_A: ${artifact.meta.WGS84_A},`,
    `    WGS84_E2: ${artifact.meta.WGS84_E2},`,
    `    projectionFingerprint: ${JSON.stringify(artifact.meta.projectionFingerprint)},`,
    '  },',
    '  contents: {',
    ...groupedEntries(artifact.contents).map(
      ([hash, src]) => `    ${JSON.stringify(hash)}: ${JSON.stringify(src)},`,
    ),
    '  },',
    '  index: {',
    ...sortedEntries(artifact.index).map(
      ([id, hash]) => `    ${JSON.stringify(id)}: ${JSON.stringify(hash)},`,
    ),
    '  },',
    '}',
    '',
  ]
  return lines.join('\n')
}
