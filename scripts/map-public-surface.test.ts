// ═══ @xgis/map's published declaration surface is a COMMITTED artifact (#2601) ═══
//
// WHAT THIS IS FOR. `map` is the only package with a publish pass — `vite build`
// plus `map/scripts/build-dts.ts`, which bundles `src/public.ts` into a single
// `dist/index.d.ts` with the sibling `@xgis/*` types inlined. Until this file
// existed there was NO gate on what that bundle contains, so a member could join
// the published surface with no diff and no reviewer signal. `shader-dsl` has
// carried the equivalent since #1842 for the same reason: a changelog entry is a
// commit SUBJECT and does not identify a surface delta.
//
// This matters right now because #2601 adopts `@internal` + `stripInternal` on the
// publish pass so #2537 can move `render()`'s phases out of a class whose members
// are `private` today. That widening is safe only if something watches the result,
// and the guard has to exist BEFORE the widening, not after.
//
// WHY IT READS THE BUILT BUNDLE RATHER THAN THE SOURCE. The quantity is "what a
// consumer receives", and only the bundler knows it: `src/public.ts` exports 30-odd
// symbols, but `VectorTileRenderer` — the subject of #2508/#2537 — is not among
// them and reaches `dist/index.d.ts` TRANSITIVELY, through `MapRendererContent`.
// A source-side reader would have to re-implement rollup-plugin-dts's closure and
// would then be a second authority over what "published" means. So the test calls
// the same `bundlePublicDts()` the publish script calls (~7s) and reads its output.
//
// WHY IT LIVES IN `scripts/` AND NOT `map/src/`. Parking it beside the code would
// put a `scripts/` import inside map's tsconfig `rootDir` and break `tsc --build` —
// the reason vitest.config.ts already gives for the repo-tooling tests here. CI's
// `data` leg runs `data/src scripts`, so this is covered.
//
// WHAT IT DOES NOT DO. It gates NAMES, not signatures. map's bundle inlines every
// support type from geo / compiler / engine / rhi*, so recording their shapes would
// churn this file on unrelated upstream edits — and a gate that is noisy at random
// trains people to rubber-stamp its diff (§12). A member joining, leaving, or
// changing visibility is what this catches, and that is the #2601 failure mode.

import { beforeAll, describe, expect, it } from 'vitest'
import * as ts from 'typescript'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SIBLING_DTS, bundlePublicDts } from '../map/scripts/dts-bundle'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SNAPSHOT = join(ROOT, 'map', 'src', '__api__', 'surface.md')
const UPDATE = process.env.UPDATE_API_SURFACE === '1'
const REBAKE = 'bun run bake:map-surface'

// Floors, not equalities: they exist so a reader that silently stops seeing the
// surface fails LOUDLY instead of reporting a clean zero (§12 — a blind
// instrument reports nothing, and nothing reads as "no findings"). Set well under
// the measured values (462 / 50 / 2625 / 849 at #2601) so ordinary churn does not
// touch them; the snapshot below is what actually pins the surface.
const FLOOR = { declarations: 380, exported: 30, members: 2000, privateSlots: 600 } as const

// Statement kinds a declaration bundle legitimately carries that are not
// declarations. Anything outside this set and the reader's own list is an
// unrendered statement — it fails rather than being dropped silently.
const NON_DECLARATION = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ExportDeclaration,
])

interface Decl {
  readonly kind: string
  readonly name: string
  readonly exported: boolean
  readonly members: readonly string[]
}

interface Surface {
  readonly decls: readonly Decl[]
  readonly exported: readonly string[]
  readonly memberCount: number
  readonly privateSlotCount: number
  readonly internalTagCount: number
}

const modifiersOf = (n: ts.Node): readonly ts.ModifierLike[] =>
  ts.canHaveModifiers(n) ? (ts.getModifiers(n) ?? []) : []

const isPrivate = (n: ts.Node): boolean =>
  modifiersOf(n).some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)

/** The member's name as a consumer would write it. Index/call/construct
 *  signatures have no name and are labelled by their kind so they still appear —
 *  dropping them would hide a real surface change. */
function memberLabel(m: ts.ClassElement | ts.TypeElement): string {
  if (ts.isConstructorDeclaration(m)) return 'constructor'
  if (ts.isIndexSignatureDeclaration(m)) return '[index]'
  if (ts.isCallSignatureDeclaration(m)) return '[call]'
  if (ts.isConstructSignatureDeclaration(m)) return '[construct]'
  const name = m.name === undefined ? '' : m.name.getText()
  if (name === '') return `[${ts.SyntaxKind[m.kind]}]`
  if (ts.isGetAccessor(m)) return `get ${name}`
  if (ts.isSetAccessor(m)) return `set ${name}`
  return name
}

function readSurface(code: string): Surface {
  const sf = ts.createSourceFile('index.d.ts', code, ts.ScriptTarget.ES2022, true)

  // Exported-ness comes from the bundle's trailing `export { … }` / `export type
  // { … }` clauses; rollup-plugin-dts emits every declaration bare and re-exports
  // at the end, so a modifier check would report zero exports.
  const exported = new Set<string>()
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st)) continue
    const clause = st.exportClause
    if (clause === undefined || !ts.isNamedExports(clause)) continue
    for (const spec of clause.elements) exported.add((spec.propertyName ?? spec.name).text)
  }

  const decls: Decl[] = []
  let memberCount = 0
  let privateSlotCount = 0
  const unrendered: string[] = []

  for (const st of sf.statements) {
    let kind = ''
    let name = ''
    let members: readonly (ts.ClassElement | ts.TypeElement)[] = []
    if (ts.isClassDeclaration(st)) {
      kind = 'class'
      name = st.name?.text ?? '(anonymous)'
      members = st.members
    } else if (ts.isInterfaceDeclaration(st)) {
      kind = 'interface'
      name = st.name.text
      members = st.members
    } else if (ts.isTypeAliasDeclaration(st)) {
      kind = 'type'
      name = st.name.text
    } else if (ts.isEnumDeclaration(st)) {
      kind = 'enum'
      name = st.name.text
    } else if (ts.isFunctionDeclaration(st)) {
      kind = 'function'
      name = st.name?.text ?? '(anonymous)'
    } else if (ts.isModuleDeclaration(st)) {
      kind = 'module'
      name = st.name.getText()
    } else if (ts.isVariableStatement(st)) {
      kind = 'const'
      name = st.declarationList.declarations.map((d) => d.name.getText()).join(', ')
    } else {
      if (!NON_DECLARATION.has(st.kind)) unrendered.push(ts.SyntaxKind[st.kind])
      continue
    }
    const rendered: string[] = []
    for (const m of members) {
      const label = memberLabel(m)
      if (isPrivate(m)) {
        privateSlotCount++
        rendered.push(`private ${label}`)
      } else {
        memberCount++
        rendered.push(label)
      }
    }
    rendered.sort()
    decls.push({ kind, name, exported: exported.has(name), members: rendered })
  }

  if (unrendered.length > 0) {
    throw new Error(
      `map-public-surface: ${unrendered.length} statement(s) in the bundle were neither ` +
        `rendered nor recognised as non-declarations: ${[...new Set(unrendered)].join(', ')}.\n` +
        `Teach the reader that kind — silently skipping it would hide whatever it declares.`,
    )
  }

  decls.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind))
  return {
    decls,
    exported: [...exported].sort(),
    memberCount,
    privateSlotCount,
    // Counted on the emitted text, so it MEASURES the flag rather than assuming it:
    // `stripInternal` is off today and this reads 1 (compiler's `SceneProgram.program`,
    // `scene-builder.ts:194`). #2601 INC-B turns the flag on and this must reach 0.
    internalTagCount: (code.match(/@internal/g) ?? []).length,
  }
}

function render(s: Surface): string {
  const body = s.decls
    .map((d) => {
      const head = `${d.kind} ${d.name}${d.exported ? ' *' : ''}`
      return d.members.length === 0 ? head : `${head}\n${d.members.map((m) => `  ${m}`).join('\n')}`
    })
    .join('\n')
  return (
    `# @xgis/map — published declaration surface\n\n` +
    `GENERATED FILE — do not hand-edit. Re-bake with \`${REBAKE}\` and commit the diff.\n\n` +
    `Every declaration in \`map/dist/index.d.ts\`, the bundle \`map/scripts/build-dts.ts\`\n` +
    `produces from \`map/src/public.ts\`. \`*\` marks a name the bundle re-exports; the rest\n` +
    `are support types folded in from the sibling \`@xgis/*\` packages and reachable only\n` +
    `through an exported one. Members are names, not signatures — see the header of\n` +
    `\`scripts/map-public-surface.test.ts\` for why.\n\n` +
    `- declarations: ${s.decls.length}\n` +
    `- exported names: ${s.exported.length}\n` +
    `- members: ${s.memberCount} (plus ${s.privateSlotCount} \`private\` name slots)\n` +
    `- \`@internal\` tags surviving into the bundle: ${s.internalTagCount}\n\n` +
    `## Exported\n\n` +
    '```\n' +
    s.exported.join('\n') +
    '\n```\n\n' +
    `## Declarations\n\n` +
    '```\n' +
    body +
    '\n```\n'
  )
}

const missingInputs = SIBLING_DTS.filter((f) => !existsSync(f))

describe('@xgis/map published surface', () => {
  if (missingInputs.length > 0) {
    it('cannot read the bundle — the sibling declarations are not built', () => {
      expect.fail(
        `${missingInputs.length} sibling .d.ts input(s) are missing, so the publish bundle ` +
          `cannot be produced:\n` +
          missingInputs.map((f) => `  - ${relative(ROOT, f)}`).join('\n') +
          `\nRun \`bun run build\` first (CI's test job already does, test.yml:436).`,
      )
    })
    return
  }

  let surface: Surface
  let rendered: string

  beforeAll(async () => {
    surface = readSurface(await bundlePublicDts())
    rendered = render(surface)
  }, 60_000)

  describe('the reader sees the surface at all', () => {
    it('finds a plausible number of declarations, exports and members', () => {
      expect(surface.decls.length).toBeGreaterThanOrEqual(FLOOR.declarations)
      expect(surface.exported.length).toBeGreaterThanOrEqual(FLOOR.exported)
      expect(surface.memberCount).toBeGreaterThanOrEqual(FLOOR.members)
      // The private floor is the arm that proves the reader DESCENDS into class
      // bodies: a reader that returned only top-level names would pass the three
      // above and report zero here.
      expect(surface.privateSlotCount).toBeGreaterThanOrEqual(FLOOR.privateSlots)
    })

    it('names every declaration and every member', () => {
      const blank = surface.decls.filter(
        (d) =>
          d.name.trim() === '' || d.kind.trim() === '' || d.members.some((m) => m.trim() === ''),
      )
      expect(blank.map((d) => `${d.kind} ${d.name}`)).toEqual([])
    })

    it('sees a known exported class WITH its members', () => {
      // The canary: `XGISMap` and `Camera` are both named outright in
      // `map/src/public.ts`, so a reader that resolved nothing, or that found the
      // classes but not their bodies, fails here and says which half it lost.
      const map = surface.decls.find((d) => d.name === 'XGISMap' && d.kind === 'class')
      expect(map, 'XGISMap is not in the bundle — the reader resolved nothing').toBeDefined()
      expect(map?.exported, 'XGISMap is in the bundle but not re-exported').toBe(true)
      expect(
        map?.members,
        'XGISMap has no member `camera` — the reader saw no class body',
      ).toContain('camera')
      expect(surface.decls.some((d) => d.name === 'Camera' && d.kind === 'class')).toBe(true)
    })
  })

  describe('the committed snapshot matches the bundle', () => {
    it('has not drifted', () => {
      if (UPDATE) {
        mkdirSync(dirname(SNAPSHOT), { recursive: true })
        writeFileSync(SNAPSHOT, rendered)
        return
      }
      if (!existsSync(SNAPSHOT)) {
        expect.fail(`${relative(ROOT, SNAPSHOT)} is missing — bake it with \`${REBAKE}\``)
      }
      const committed = readFileSync(SNAPSHOT, 'utf8')
      expect(
        rendered,
        `${relative(ROOT, SNAPSHOT)} and the built bundle disagree.\n` +
          `A published-surface change is intentional or it is a bug; either way it must be ` +
          `visible in the diff. Re-bake with \`${REBAKE}\` and review what moved.`,
      ).toBe(committed)
    })
  })
})
