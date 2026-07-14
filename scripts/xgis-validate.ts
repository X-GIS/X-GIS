#!/usr/bin/env bun
// ═══ xgis validate — parse-level conformance checker (#1073 slice 1) ═══
//
// Runs the compiler front-end over each path given on the command line and
// reports per-file diagnostics: the lexer + parser always, plus resolveImports
// when the file declares an `import` (so a cherry-pick/splice against a missing
// or malformed target is caught too). This is the SMALLEST honest form of the
// validator — no lowering, no package, no publishing, no LSP; those are later
// tooling work (the LSP needs #1065, and `fmt`/`convert` are out of this slice).
// The grammar it enforces is documented in docs/spec/xgis-language.md.
//
// Exit status: 0 iff every file parses; 1 if any file is rejected; 2 on a usage
// error (no paths given).
//
//   bun scripts/xgis-validate.ts <file.xgis> [more.xgis ...]

import { readFileSync } from 'node:fs'
import { Lexer } from '../compiler/src/lexer/lexer'
import { Parser } from '../compiler/src/parser/parser'
import { resolveImports, type FileReader } from '../compiler/src/module/resolver'

const files = process.argv.slice(2)

if (files.length === 0) {
  process.stderr.write('usage: bun scripts/xgis-validate.ts <file.xgis> [more.xgis ...]\n')
  process.exit(2)
}

const readFile: FileReader = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

let failures = 0

for (const file of files) {
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    failures++
    process.stdout.write(`error ${file}\n      cannot read file\n`)
    continue
  }

  try {
    const program = new Parser(new Lexer(source).tokenize()).parse()
    // Only touch the filesystem resolver when the file actually imports —
    // resolution reads sibling files and re-parses them through the same gate.
    if (program.body.some((s) => s.kind === 'ImportStatement')) {
      resolveImports(program, file, readFile)
    }
    process.stdout.write(`ok    ${file}\n`)
  } catch (e) {
    failures++
    const message = e instanceof Error ? e.message : String(e)
    process.stdout.write(`error ${file}\n      ${message}\n`)
  }
}

process.exit(failures === 0 ? 0 : 1)
