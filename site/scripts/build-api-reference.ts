// ═══ Generate the shader-dsl API reference into src/content/api (#1695 item 1) ═══
//
// One pipeline, two stages: TypeDoc emits the markdown, then this script normalises the
// links it cannot. The output is GITIGNORED and regenerated on every build, so there is no
// committed artifact to drift from the source — TSDoc at the definition site stays the only
// authority for what a symbol means.
//
// WHY A NORMALISE STAGE AT ALL. typedoc-plugin-markdown 4.12 writes cross-references using
// the configured `fileExtension`, so every one of the ~1.5k internal links ends in `.md`.
// There is no option to suppress that (checked: `preserveLinkExtension` does not exist in
// this version; the only related knobs are `fileExtension`, `entryFileName`,
// `flattenOutputFiles`). Emptying `fileExtension` would produce extensionless files that
// Astro's glob loader cannot parse as markdown. Serving the `.md` in the URL was the other
// option and was rejected: this reference exists because the API was too hard to find, and
// `/api/index/functions/emitConst.md` is not a URL anyone types.
//
// THE TWO GATES BELOW ARE THE POINT, not decoration. `excludeInternal` is what keeps the
// five symbols tagged `@internal` in #1697 out of the published pages — they are exported
// only because `index.ts` star-re-exports two backend modules, and un-exporting them is a
// breaking change nobody has taken yet. If a future TypeDoc renames or drops that option,
// nothing else in the build would notice: the pages would simply reappear. So this script
// checks the RENDERED OUTPUT, never the config — a config key that a version silently
// ignores is exactly the failure a config assertion cannot see.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(SITE, 'src', 'content', 'api')

/** The gate that owns the `@internal` list. Read rather than transcribed: two copies of this
 *  set would drift, and the copy that goes stale is the one that stops catching anything. */
const GATE = join(SITE, '..', 'shader-dsl', 'src', 'api-doc-coverage.test.ts')

const die = (msg: string): never => {
  console.error(`\n[api-reference] ${msg}\n`)
  process.exit(1)
}

/** The deployed base path, DERIVED from astro.config rather than repeated here.
 *
 *  Astro prefixes the routes it generates with `base`, but a link written inside markdown is
 *  literal text it never rewrites — so every one of the ~1.5k cross-references has to carry
 *  the base itself. Hardcoding `/api/` worked locally (base `/`) and would have 404'd on
 *  every link of the deployed site, which serves under `/X-GIS`: a bug that no local build
 *  could show, since `isCI` is false here.
 *
 *  Parsed, not duplicated: astro.config.mjs stays the single authority for what the base is,
 *  and an unparseable config stops the build rather than silently falling back to `/`. */
function basePath(): string {
  const cfg = readFileSync(join(SITE, 'astro.config.mjs'), 'utf8')
  const m = /base:\s*isCI\s*\?\s*'([^']*)'\s*:\s*'([^']*)'/.exec(cfg)
  if (m === null)
    die(
      `could not read \`base\` out of astro.config.mjs. Refusing to guess: falling back to '' ` +
        `would emit links that work locally and 404 on every page of the deployed site.`,
    )
  const raw = process.env.GITHUB_ACTIONS ? m![1] : m![2]
  return raw.replace(/\/+$/, '')
}
const BASE = basePath()
const API = `${BASE}/api`

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

// ── the symbols that must NOT appear, sourced from the gate ────────────────────────────────
/** Parse the keys of the gate's `INTERNAL` table. Keys look like
 *  `src/core/backends/wgsl.ts#wgslType`; only the symbol name matters here. */
function internalSymbols(): string[] {
  const src = readFileSync(GATE, 'utf8')
  const block = /const INTERNAL: Readonly<Record<string, string>> = \{(.*?)\n\}/s.exec(src)
  if (block === null)
    die(
      `could not find the INTERNAL table in ${relative(SITE, GATE)}. This script refuses to ` +
        `run rather than skip the exclusion check: a silently-empty list would let every ` +
        `@internal symbol publish while this build stayed green.`,
    )
  const names = [...block![1].matchAll(/'[^']*#([A-Za-z0-9_]+)'\s*:/g)].map((m) => m[1])
  if (names.length === 0)
    die(
      `parsed ZERO symbols out of the INTERNAL table. The table's shape changed; fix this ` +
        `reader. An empty list makes the exclusion check below vacuous.`,
    )
  return names
}

// ── 1. generate ───────────────────────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true })

const td = spawnSync(
  join(SITE, 'node_modules', '.bin', 'typedoc'),
  // `--publicPath` overrides typedoc.json so the base is decided in ONE place (basePath()
  // above) rather than being frozen into a config file that cannot see GITHUB_ACTIONS.
  ['--options', join(SITE, 'typedoc.json'), '--publicPath', `${API}/`],
  { cwd: SITE, encoding: 'utf8' },
)
const log = `${td.stdout ?? ''}${td.stderr ?? ''}`
process.stdout.write(log)
if (td.status !== 0) die(`typedoc exited ${td.status}`)

// A `{@link X}` whose target is excluded renders as plain text and warns forever. A warning
// that is always present is how a real one later gets ignored — so it is an error here.
const dangling = [...log.matchAll(/links to "([^"]+)" which was resolved but is not included/g)]
if (dangling.length > 0)
  die(
    `${dangling.length} doc link(s) point at a symbol the reference does not publish: ` +
      `${dangling.map((m) => m[1]).join(', ')}.\n` +
      `A {@link} to an @internal symbol is the usual cause. Write it as inline code instead — ` +
      `the link cannot resolve for a reader, and the warning would be permanent.`,
  )

const pages = walk(OUT).filter((f) => f.endsWith('.md'))
if (pages.length < 100)
  die(
    `typedoc emitted only ${pages.length} pages (expected a few hundred). Something resolved ` +
      `far less of the API than it should — treat this as a broken generation, not a small API.`,
  )

// ── 2. the exclusion gate, checked against the rendered pages ──────────────────────────────
const forbidden = internalSymbols()
const leaked = forbidden.filter((name) =>
  pages.some((p) => p.endsWith(`/${name}.md`) || p.endsWith(`\\${name}.md`)),
)
if (leaked.length > 0)
  die(
    `the reference published ${leaked.length} symbol(s) tagged @internal: ${leaked.join(', ')}.\n` +
      ``.concat(
        `Either \`excludeInternal\` stopped being honoured (a TypeDoc upgrade can rename or ` +
          `drop an option without failing), or the tag was removed from the source. These are ` +
          `exported only because index.ts star-re-exports two backend modules — publishing ` +
          `them promises a surface nobody chose (#1697).`,
      ),
  )

// ── 2b. scaffolding must never reach a reader ─────────────────────────────────────────────
// scripts/add-tsdoc-templates.ts writes stub comments so an author only has to supply the
// prose a machine cannot. The coverage gate refuses to count those as documentation — but
// TypeDoc renders whatever prose it finds, so a bulk `--write` followed by a build would
// publish pages reading "TODO(#1695): what is this function for". Blank is better than that,
// and neither is the goal: scaffold freely, publish only what someone actually wrote.
const STUB_SENTINEL = 'TODO(#1695):'
const stubbed = pages.filter((p) => readFileSync(p, 'utf8').includes(STUB_SENTINEL))
if (stubbed.length > 0)
  die(
    `${stubbed.length} page(s) would publish an unfilled TSDoc stub:\n  ` +
      stubbed
        .slice(0, 8)
        .map((p) => relative(OUT, p))
        .join('\n  ') +
      (stubbed.length > 8 ? `\n  … and ${stubbed.length - 8} more` : '') +
      `\nThese carry "${STUB_SENTINEL}" from scripts/add-tsdoc-templates.ts, which writes the\n` +
      `mechanical half of a comment for an author to finish. Replace the sentinel line with\n` +
      `real prose, or revert the stub — a page that tells the reader "TODO" is worse than the\n` +
      `blank one it replaced.`,
  )

// ── 3. normalise links ────────────────────────────────────────────────────────────────────
let rewritten = 0
for (const page of pages) {
  const before = readFileSync(page, 'utf8')
  // `](/api/a/b/Name.md)` and `](/api/a/b/Name.md#anchor)` -> drop the extension, keep the
  // anchor. Anchored to the `/api/` prefix so a link to an external .md is left alone.
  // …then drop the `README` entry-page segment, so a module's index is `/api/index` rather
  // than `/api/index/README` and the package root is `/api`. The route does the same mapping
  // (see src/pages/api/[...slug].astro); both go through the same shape so they cannot drift.
  const after = before
    .replace(new RegExp(`\\]\\((${API}/[^)#\\s]*?)\\.md(?=[)#])`, 'g'), ']($1')
    .replace(new RegExp(`\\]\\((${API})/README(?=[)#])`, 'g'), ']($1')
    .replace(new RegExp(`\\]\\((${API}/[^)#\\s]*?)/README(?=[)#])`, 'g'), ']($1')
  if (after !== before) {
    writeFileSync(page, after)
    rewritten += (before.match(new RegExp(`\\]\\(${API}/[^)#\\s]*?\\.md(?=[)#])`, 'g')) ?? [])
      .length
  }
}

/** File path under OUT -> the URL path the route serves it at. The ONE place this mapping
 *  lives on the generator side; [...slug].astro carries its mirror. */
const routeOf = (rel: string): string =>
  rel
    .replace(/\\/g, '/')
    .replace(/\.md$/, '')
    .replace(/(^|\/)README$/, '')
    .replace(/\/$/, '')

const mdLink = new RegExp(`\\]\\(${API}/[^)#\\s]*?\\.md(?=[)#])`)
const stillMd = pages.filter((p) => mdLink.test(readFileSync(p, 'utf8')))
if (stillMd.length > 0)
  die(
    `${stillMd.length} page(s) still contain a \`.md\` link after normalisation — the rewrite ` +
      `missed a link shape. Every such link is a 404 for a reader.`,
  )

// ── 4. every link resolves to a page that exists ──────────────────────────────────────────
// The gate that matters, and the one whose absence let a broken reference build clean. A
// successful `astro build` says NOTHING about whether a cross-reference resolves: routes are
// generated from filenames and links are text inside markdown, so the two can disagree for
// every page on the site and still exit 0. This caught exactly that — Astro's default
// `generateId` slugifies (lowercases), and 250 of the 332 pages have capitals in their name,
// so three quarters of the reference 404'd while the build reported success. Compare the
// link set against the page set, both derived, and name the missing targets.
const pageIds = new Set(pages.map((p) => routeOf(relative(OUT, p))))
const targets = new Set<string>()
for (const page of pages)
  for (const m of readFileSync(page, 'utf8').matchAll(
    new RegExp(`\\]\\((${API})(/[^)#\\s]+)?`, 'g'),
  ))
    targets.add((m[2] ?? '').replace(/^\//, '').replace(/\/$/, ''))

const broken = [...targets].filter((t) => !pageIds.has(t)).sort()
if (broken.length > 0)
  die(
    `${broken.length} of ${targets.size} cross-reference target(s) resolve to no generated ` +
      `page:\n  ${broken.slice(0, 12).join('\n  ')}${broken.length > 12 ? `\n  … and ${broken.length - 12} more` : ''}\n` +
      `The routes and the links are derived separately — a mismatch is invisible to ` +
      `\`astro build\`, which exits 0 with every link on the site broken. If the names differ ` +
      `only by case, Astro's content-collection \`generateId\` is slugifying them; ` +
      `src/content.config.ts must preserve case for the \`api\` collection.`,
  )

console.log(
  `[api-reference] ${pages.length} pages, ${rewritten} links normalised, ` +
    `${forbidden.length} @internal symbol(s) verified absent, ` +
    `${targets.size} cross-reference target(s) resolved.`,
)
