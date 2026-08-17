// ═══ A hand-written doc may not name a symbol that no longer exists (#1700) ═══
//
// #1699 published a generated reference at /api, which regenerates from the TSDoc on every
// build and therefore cannot go stale. It did NOT replace the two hand-written authorities
// that describe the same API:
//
//   site/src/pages/shader-dsl/reference.astro   53 transcribed `sig` rows
//   shader-dsl/AUTHORING.md                     task-shaped prose, backticked headings
//
// Both are worth keeping — the generated reference is exhaustive and flat, and answers
// "what does emitConst do"; it cannot answer "what do I reach for to declare a layout",
// which is exactly what reference.astro's grouping and AUTHORING.md's worked examples give.
// The defect is narrower than "duplication": all three carry SIGNATURES, and until this file
// only one of them was checked against anything.
//
// WHAT THIS CATCHES, precisely: a symbol that is renamed or un-exported while a hand-written
// row keeps naming it. That row then reads as authoritative and is simply false — the
// silent-rot failure, and the one that actually happens.
//
// WHAT IT DOES NOT CATCH, stated so nobody mistakes green here for more than it is: PARAMETER
// drift. `fn(name?, params, ret?, body, opts?)` gaining a sixth parameter leaves this gate
// green, because comparing a prose signature against a TS signature is a brittle parse that
// would fail on formatting rather than on truth. The real fix for that is #1700 — a row that
// LINKS to its generated page instead of transcribing the signature cannot drift at all, and
// the ceiling arm below is what pushes in that direction.
//
// WHY IT LIVES IN scripts/ — `site/` is not in vitest's `include`, and adding it would need a
// new CI leg. `scripts/**/*.test.ts` is already included AND already CI-covered (the `data`
// leg passes `data/src scripts`; see .github/workflows/test.yml). Same precedent, and the
// same reason, as the changelog-generator suite parked here.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REFERENCE = join(ROOT, 'site', 'src', 'pages', 'shader-dsl', 'reference.astro')
const AUTHORING = join(ROOT, 'shader-dsl', 'AUTHORING.md')

// ── the truth: what @xgis/shader-dsl actually exports ─────────────────────────────────────
// Resolved from the source, not from the generated site: the generated pages are gitignored
// and only exist after a site build, so depending on them would make this gate unrunnable in
// the leg that runs it. Options are hardcoded for the reason api-doc-coverage.test.ts gives —
// `moduleResolution` is a measured silent kill switch, and a config edit must not be able to
// shrink what this gate can see.
const ENTRIES = ['index.ts', 'dev.ts', 'emit-prod.ts', join('core', 'ir', 'index.ts')].map((f) =>
  join(ROOT, 'shader-dsl', 'src', f),
)
const program = ts.createProgram(ENTRIES, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  types: [],
})
const checker = program.getTypeChecker()

const EXPORTS = new Set<string>()
/** Per-entry counts, kept because the UNION cannot see a broken resolver. Measured: setting
 *  `moduleResolution: 'classic'` collapses index.ts from 284 exports to 91 — and the union
 *  stays at 332 either way, because core/ir/index.ts re-supplies exactly what index.ts loses.
 *  A floor on the union is therefore an assertion that CANNOT FAIL for the case it exists to
 *  catch (§12); the floor has to sit on the number the resolver actually moves. */
const PER_ENTRY = new Map<string, number>()
for (const entry of ENTRIES) {
  const sf = program.getSourceFile(entry)
  const mod = sf === undefined ? undefined : checker.getSymbolAtLocation(sf)
  const syms = mod === undefined ? [] : checker.getExportsOfModule(mod)
  PER_ENTRY.set(entry, syms.length)
  for (const sym of syms) EXPORTS.add(sym.getName())
}

/** Floors measured at the commit that added this gate. They catch a resolver that silently
 *  sees LESS — never to pin an exact surface size, which is expected to grow. */
const ENTRY_FLOOR: Readonly<Record<string, number>> = {
  'index.ts': 284,
  'dev.ts': 33,
  'emit-prod.ts': 17,
  [join('core', 'ir', 'index.ts')]: 193,
}

/** Members of the value-node interface — what `.add` / `.swizzle` / `.x` are. They are not
 *  exports, so checking them against EXPORTS would red on every operator row. */
const NODE_MEMBERS = (() => {
  const out = new Set<string>()
  const sf = program.getSourceFile(join(ROOT, 'shader-dsl', 'src', 'core', 'ir', 'node.ts'))
  if (sf === undefined) return out
  // `Node` and `ReadonlyNode` are CLASSES with real accessors (`get x()`, `get rgb()`), not
  // interfaces and not Proxy-synthesised — so their members are statically enumerable, and
  // `Node extends ReadonlyNode` means the instance type carries both.
  ts.forEachChild(sf, (n) => {
    if (
      ts.isClassDeclaration(n) &&
      n.name !== undefined &&
      (n.name.text === 'Node' || n.name.text === 'ReadonlyNode')
    ) {
      const sym = checker.getSymbolAtLocation(n.name)
      if (sym === undefined) return
      for (const p of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(sym)))
        out.add(p.getName())
    }
  })
  return out
})()

// ── the hand-written claims ───────────────────────────────────────────────────────────────
/** `{ sig: '…' }` rows, unescaped. */
function referenceSigs(): string[] {
  const src = readFileSync(REFERENCE, 'utf8')
  return [...src.matchAll(/\{\s*sig:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"))
}

/** ### `x` headings, which is how AUTHORING.md names a symbol it is about to describe. */
function authoringHeadings(): string[] {
  return [...readFileSync(AUTHORING, 'utf8').matchAll(/^###\s+`([^`]+)`/gm)].map((m) => m[1])
}

/** Pull every identifier a doc string presents as a CALL or a MEMBER. A row lists siblings
 *  with ` · `, and a member form leads with a dot. */
function claimedNames(text: string): { calls: string[]; members: string[] } {
  const calls: string[] = []
  const members: string[] = []
  for (const alt of text.split(/·|\s{2,}/)) {
    for (const m of alt.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)/g)) members.push(m[1])
    const call = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(alt)
    if (call !== null) calls.push(call[1])
  }
  return { calls, members }
}

/** Names a hand-written doc may use that are NOT exports or node members, each with the
 *  reason. SHRINK-ONLY: when one becomes a real export, its row must go in the same commit
 *  (arm A2) — an allowlist entry that outlives its reason is how debt becomes permanent. */
const NOT_A_SYMBOL: Readonly<Record<string, string>> = {
  case:
    'a method on the SwitchChain builder (core/ir/builder.ts:1266), reached only through ' +
    'Switch(); also a JS keyword (#1700)',
  default: 'the SwitchChain terminator (`.default(body?)`), same builder as `case` (#1700)',
  elif: 'a chained method on the If builder, not a standalone export (#1700)',
  else: 'same — the If chain terminator, and a JS keyword besides (#1700)',
  of: 'a method on an ioStruct handle (`.of(node)`), reached only through a handle (#1700)',
  at: 'a method on a storageBuffer / array handle (`.at(i)`) (#1700)',
  var: 'a method on an ioStruct handle (`.var(name?)`), spelled like the keyword (#1700)',
  struct: 'a property of a declarator handle (`.struct`), not an export (#1700)',
  binding:
    'a property of a declarator handle (`.binding`) — the EXPORT of that name is a ' +
    'different thing, so this row is about the property (#1700)',
  decl: 'a property of an ioStruct handle (`.decl`) (#1700)',
  type: 'a property of an ioStruct handle (`.type`) (#1700)',
  field: 'a property of a uniformStruct handle (`.field`) (#1700)',
  arr: 'a property of an arrayOf field handle (`.arr`) (#1700)',
  cols: 'a property of a mat64 handle (`.cols`) (#1700)',
  body: 'a named property of the fn options bag, shown in a signature (#1700)',
  opts: 'same — the fn options bag (#1700)',
}

describe('#1700 — reader sanity (every arm below is vacuous without these)', () => {
  it('each entry point resolved to at least its measured export count', () => {
    // PER ENTRY, deliberately. A floor on the union is worthless here: `moduleResolution:
    // 'classic'` drops index.ts from 284 to 91 with no diagnostic and no throw, and the union
    // stays at 332 regardless because core/ir/index.ts re-supplies the difference. Every arm
    // below is a membership test against EXPORTS, so a silently-shrunken set turns real doc
    // drift into a green run — the exact vacuity this arm exists to prevent.
    for (const [file, floor] of Object.entries(ENTRY_FLOOR)) {
      const entry = ENTRIES.find((e) => e.endsWith(file))!
      const n = PER_ENTRY.get(entry) ?? 0
      expect(
        n,
        `${file} resolved to ${n} exports, below the ${floor} measured when this gate was ` +
          `seeded. The RESOLVER is what changed, not the API. Fix the reader, not the ` +
          `assertion. (A genuine shrink of the public surface is fine — lower this floor ` +
          `deliberately, in the commit that shrinks it.)`,
      ).toBeGreaterThanOrEqual(floor)
    }
  })

  it('the node-member set resolved', () => {
    expect(
      NODE_MEMBERS.size,
      'no members read off Node/ReadonlyNode — every operator row (.add, .swizzle, .x …) ' +
        'would then read as an unknown name and this gate would red for the wrong reason',
    ).toBeGreaterThan(20)
  })

  it('AUTHORING.md was read and parsed', () => {
    expect(
      authoringHeadings().length,
      'fewer than 8 backticked ### headings parsed out of AUTHORING.md — the reader is ' +
        'broken or the file moved, and arm A1 would then pass over an empty set',
    ).toBeGreaterThanOrEqual(8)
  })
})

describe('#1700 — every name a hand-written doc claims still exists', () => {
  // reference.astro is NOT scanned here any more, and that is a tightening rather than a
  // gap: since #1700 it lists bare symbol NAMES and resolves each one through the api
  // collection at build time, throwing on a miss. That catches strictly more than this text
  // scan could — including a symbol that still exists but is `@internal`, and therefore
  // published nowhere for a reader to follow. The arm below pins that guard in place.
  const sources: Readonly<Record<string, () => string[]>> = {
    'shader-dsl/AUTHORING.md': authoringHeadings,
  }

  for (const [file, read] of Object.entries(sources)) {
    it(`A1: ${file} names no symbol that has been renamed or un-exported`, () => {
      const unknown: string[] = []
      for (const text of read()) {
        const { calls, members } = claimedNames(text)
        for (const name of calls)
          if (!EXPORTS.has(name) && !NODE_MEMBERS.has(name) && NOT_A_SYMBOL[name] === undefined)
            unknown.push(`${name}(…)  in "${text.slice(0, 60)}"`)
        for (const name of members)
          if (!NODE_MEMBERS.has(name) && !EXPORTS.has(name) && NOT_A_SYMBOL[name] === undefined)
            unknown.push(`.${name}  in "${text.slice(0, 60)}"`)
      }
      expect(
        unknown.sort(),
        `${file} documents ${unknown.length} name(s) that are neither a live export of ` +
          `@xgis/shader-dsl nor a member of its value node:\n  ${unknown.join('\n  ')}\n` +
          `A hand-written signature does not move when the source does, so the row now reads ` +
          `as authoritative and is false. Either fix the name, or — better, and the point of ` +
          `#1700 — replace the transcribed signature with a link to its generated page under ` +
          `/api, which cannot drift. If the name is genuinely not a symbol (a builder method ` +
          `reached only through a handle), add it to NOT_A_SYMBOL with the reason.`,
      ).toEqual([])
    })
  }

  it('A2: no NOT_A_SYMBOL entry has since become a real symbol (shrink-only)', () => {
    const promoted = Object.keys(NOT_A_SYMBOL)
      .filter((n) => EXPORTS.has(n))
      .sort()
    expect(
      promoted,
      `these names are excused as "not a symbol" but ARE exported now:\n  ${promoted.join('\n  ')}\n` +
        `Delete their rows in the same commit that exported them — otherwise A1 stops ` +
        `checking a name it could check, and the excuse outlives its reason.`,
    ).toEqual([])
    for (const [name, reason] of Object.entries(NOT_A_SYMBOL))
      expect(reason, `NOT_A_SYMBOL['${name}'] must cite the issue that resolves it`).toMatch(/#\d+/)
  })
})

describe('#1700 — the transcription ratchet, now fully closed', () => {
  // This started at a ceiling of 53 — the hand-written signatures reference.astro carried —
  // and the arm existed to force that number DOWN. It reached zero: the page now lists bare
  // symbol names and links each to its generated page, so there is no second copy of a
  // signature anywhere on the site. The arm stays as a one-way latch.
  it('reference.astro transcribes NO signatures', () => {
    const n = referenceSigs().length
    expect(
      n,
      `reference.astro transcribes ${n} signature(s). It carried 53 before #1700 and now ` +
        `carries none: every row is a NAME linking to its generated page, which cannot drift ` +
        `because the page does not restate the signature. Re-introducing one restores the ` +
        `defect this ratchet was built to remove — nothing checks a transcribed parameter ` +
        `list against the source. Link to /api/<kind>/<name> instead.`,
    ).toBe(0)
  })

  it('reference.astro still VERIFIES its names against the published reference', () => {
    // The reason dropping the text scan above is safe. If this guard is deleted, the page
    // silently regains the ability to name a symbol nobody publishes — a dead link for a
    // reader, and invisible to every other arm here.
    const src = readFileSync(REFERENCE, 'utf8')
    expect(
      src,
      'reference.astro no longer resolves its symbol names through the api collection. ' +
        'Without `routeFor` it can link to a symbol that was renamed, un-exported, or ' +
        'tagged @internal, and the build will happily emit the 404.',
    ).toMatch(/function routeFor\(/)
    expect(
      /throw new Error\(/.test(src),
      'routeFor no longer THROWS on an unknown name — it must fail the build, not fall back ' +
        'to a placeholder href. A guard that degrades instead of failing is not a guard.',
    ).toBe(true)
    expect(
      src,
      'reference.astro no longer reads the api collection, so `routeFor` has nothing real to ' +
        'resolve against',
    ).toContain("getCollection('api')")
  })
})

describe('#1700 — this gate actually runs in CI', () => {
  // The #996 lesson: a PATH-KEYED gate needs a companion assertion that every key still
  // resolves. Here the keys live in test.yml's `changes` filter, and the failure is total —
  // not a weaker check, but no check at all, reported as green.
  //
  // MEASURED, not hypothetical. The first push of this file (PR #1701) posted all 17 checks
  // GREEN in ~4 seconds. `scripts/**` was in no filter, so `code` was false; every leg spins
  // up, `if`-skips all its steps by design, and posts success having run nothing. The gate
  // had never executed once. The same hole made it dark in the scenario it exists for: an
  // edit to reference.astro sets `site=true` and `code=false`, so the doc could rot while
  // CI stayed green — the exact thing this file was written to prevent.
  //
  // Asserting on the config is right HERE and nowhere else in this file: "does a CI leg run
  // this test" has no artifact a test can observe from inside the run. Everything else is
  // checked against the source.
  const REQUIRED = ['scripts/**', 'site/src/pages/shader-dsl/reference.astro']

  it('test.yml `code` filter names every path this gate depends on', () => {
    const wf = readFileSync(join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8')
    const code = /^\s{12}code:\n((?:\s{14}.*\n)+)/m.exec(wf)
    expect(
      code,
      'could not find the `code:` filter block in .github/workflows/test.yml. This arm ' +
        'refuses to guess: if the reader is broken it must say so rather than pass, or it ' +
        'becomes the second gate in a row that is green while running nothing.',
    ).not.toBeNull()

    const missing = REQUIRED.filter((p) => !code![1].includes(`'${p}'`))
    expect(
      missing,
      `test.yml's \`code\` filter does not list:\n  ${missing.join('\n  ')}\n` +
        `Without every one of these, a PR touching only that path sets code=false, all ` +
        `test legs skip their steps, and the checks post GREEN in seconds having run this ` +
        `file zero times. Note the deliberate \`site/**\` exclusion stays — only the ONE ` +
        `page this gate reads is listed, not the whole site.`,
    ).toEqual([])
  })

  it('vitest actually collects this file', () => {
    // The other half: being named in a CI filter buys nothing if vitest's own `include`
    // stops matching. Cheap to assert, and it fails loudly instead of silently narrowing.
    const cfg = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')
    expect(
      cfg,
      "vitest.config.ts no longer includes 'scripts/**/*.test.ts', so this file is not " +
        'collected by any run — local or CI — and every arm above is unreachable.',
    ).toContain("'scripts/**/*.test.ts'")
  })
})
