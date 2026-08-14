// ═══ Every /api/ link in the BUILT site resolves to a built page (#1695) ═══
//
// The companion to build-api-reference.ts, and the one that checks the artifact a reader
// actually gets. The generator can only compare links against the markdown FILE names it
// just wrote; the routes those files become are decided later, by the `api` collection's
// `generateId` in src/content.config.ts. Those two can disagree for every page on the site
// and `astro build` still exits 0 — which is not hypothetical, it is what happened: Astro's
// default `generateId` slugifies, 250 of the 332 pages have capitals in their name, and the
// first green build shipped a reference whose cross-references 404'd three times in four.
//
// So this runs at POSTBUILD and reads dist/: link text out of the rendered HTML, route set
// off the filesystem. A gate that reasons about the config instead would have missed the
// original bug entirely, because the config was not wrong — it was absent, and the default
// was.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = dirname(dirname(fileURLToPath(import.meta.url)))
const DIST_API = join(SITE, 'dist', 'api')

const die = (msg: string): never => {
  console.error(`\n[api-links] ${msg}\n`)
  process.exit(1)
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

if (!existsSync(DIST_API))
  die(
    `dist/api does not exist. Either the build did not run, or the api collection produced no ` +
      `routes — both mean the reference is not published, which this check must not pass over.`,
  )

const htmls = walk(DIST_API).filter((f) => f.endsWith('index.html'))
if (htmls.length < 100)
  die(
    `only ${htmls.length} built /api/ pages (expected a few hundred). Treat this as a broken ` +
      `build rather than a small API — the generator asserts its own page count separately.`,
  )

/** The route set, as URLs: dist/api/index/functions/emitConst/index.html -> index/functions/emitConst */
const routes = new Set(
  htmls.map((f) =>
    relative(DIST_API, f)
      .replace(/\\/g, '/')
      .replace(/\/index\.html$/, ''),
  ),
)

/** Every internal /api/ href in the rendered HTML, minus anchors and the base prefix. */
const targets = new Map<string, string>()
for (const f of htmls)
  for (const m of readFileSync(f, 'utf8').matchAll(/href="[^"]*?\/api\/([^"#]+)/g))
    targets.set(m[1].replace(/\/$/, ''), relative(DIST_API, f))

const broken = [...targets].filter(([t]) => !routes.has(t)).sort(([a], [b]) => a.localeCompare(b))
if (broken.length > 0)
  die(
    `${broken.length} of ${targets.size} /api/ link(s) in the BUILT site point at no built page:\n` +
      broken
        .slice(0, 12)
        .map(([t, from]) => `  /api/${t}   (linked from ${from})`)
        .join('\n') +
      (broken.length > 12 ? `\n  … and ${broken.length - 12} more` : '') +
      `\nIf these differ from a real route only by CASE, the \`api\` collection's ` +
      `\`generateId\` in src/content.config.ts has gone back to slugifying. astro build ` +
      `cannot see this: routes come from filenames, links are text, and neither validates ` +
      `the other.`,
  )

console.log(`[api-links] ${routes.size} routes, ${targets.size} link target(s), all resolve.`)
