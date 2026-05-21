#!/usr/bin/env bun
// Hand-rolled mutation tester. Zero-dep (per project memory:
// avoid adding npm dependencies — Stryker is overkill for the
// targeted scope X-GIS needs).
//
// Workflow
// --------
//
// 1. Read target source file.
// 2. For each mutation rule (operator flip, boolean negate, etc),
//    enumerate every match position.
// 3. For each match: write mutated source, run target test
//    pattern via `bunx vitest run <filter>`, restore source.
//    Test fail → mutant killed (good coverage).
//    Test pass → mutant SURVIVED (coverage gap; surface bug).
// 4. Report mutation score = killed / (killed + survived).
//
// Limits
// ------
//
// - Regex-based substitution: ignores comments, strings, JSX. A
//   mutation INSIDE a comment is wasted work. Acceptable noise
//   for the focused-target use case.
// - One mutation per run. Compound mutations are out of scope.
// - Test-run cost dominates: 20 mutations × 1s test = 20s. Use
//   small focused test filters.
//
// Usage
// -----
//
//   bun scripts/mutate.ts <target-file> <vitest-filter>
//
// Example
// -------
//
//   bun scripts/mutate.ts compiler/src/tiler/geodesic.ts geodesic-fuzz

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

interface MutationRule {
  /** Label for reporting. */
  label: string
  /** Match pattern. Anchor to operator chars only, not strings/comments. */
  pattern: RegExp
  /** Replacement — function form so we can swap pairs (< → <=, <= → <). */
  swap: (matched: string) => string
}

const MUTATIONS: MutationRule[] = [
  // Comparison operator flips
  { label: 'lt→le', pattern: /(?<![<>!=])<(?!=|<)/g, swap: () => '<=' },
  { label: 'le→lt', pattern: /<=/g, swap: () => '<' },
  { label: 'gt→ge', pattern: /(?<![<>!=])>(?!=|>)/g, swap: () => '>=' },
  { label: 'ge→gt', pattern: />=/g, swap: () => '>' },
  // Equality
  { label: 'eq→neq', pattern: /===/g, swap: () => '!==' },
  { label: 'neq→eq', pattern: /!==/g, swap: () => '===' },
  // Logical
  { label: 'and→or', pattern: /&&/g, swap: () => '||' },
  { label: 'or→and', pattern: /\|\|/g, swap: () => '&&' },
  // Arithmetic
  { label: 'plus→minus', pattern: /(?<![+])\+(?![+=])/g, swap: () => '-' },
  { label: 'minus→plus', pattern: /(?<![-])-(?![-=>])/g, swap: () => '+' },
  // Boolean literal
  { label: 'true→false', pattern: /\btrue\b/g, swap: () => 'false' },
  { label: 'false→true', pattern: /\bfalse\b/g, swap: () => 'true' },
  // Math.{max,min}
  { label: 'max→min', pattern: /Math\.max/g, swap: () => 'Math.min' },
  { label: 'min→max', pattern: /Math\.min/g, swap: () => 'Math.max' },
]

interface MutantResult {
  rule: string
  offset: number
  original: string
  mutated: string
  outcome: 'killed' | 'survived' | 'error'
}

function runTests(filter: string): boolean {
  try {
    execSync(`bunx vitest run ${filter}`, {
      stdio: 'pipe',
      cwd: process.cwd(),
      timeout: 60_000,
    })
    return true  // all tests pass
  } catch {
    return false  // one or more tests fail
  }
}

function stripCommentAndStringRanges(src: string): Array<[number, number]> {
  // Return ranges to SKIP. Naive — handles // …, /* … */, '…', "…",
  // `…` (no template-literal interpolation handling). Mutations
  // INSIDE these ranges are skipped.
  const skip: Array<[number, number]> = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === '/' && c2 === '/') {
      const end = src.indexOf('\n', i)
      skip.push([i, end < 0 ? src.length : end])
      i = end < 0 ? src.length : end
      continue
    }
    if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2)
      skip.push([i, end < 0 ? src.length : end + 2])
      i = end < 0 ? src.length : end + 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      let j = i + 1
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') j++  // skip escaped char
        j++
      }
      skip.push([i, j + 1])
      i = j + 1
      continue
    }
    i++
  }
  return skip
}

function isInSkipRange(offset: number, skipRanges: Array<[number, number]>): boolean {
  for (const [start, end] of skipRanges) {
    if (offset >= start && offset < end) return true
  }
  return false
}

async function main(): Promise<void> {
  const [target, filter] = process.argv.slice(2)
  if (!target || !filter) {
    console.error('usage: bun scripts/mutate.ts <target-file> <vitest-filter>')
    process.exit(1)
  }

  const original = readFileSync(target, 'utf8')
  const skipRanges = stripCommentAndStringRanges(original)
  const results: MutantResult[] = []

  console.log(`[mutate] target = ${target}`)
  console.log(`[mutate] filter = ${filter}`)
  console.log(`[mutate] skip ranges (comments/strings) = ${skipRanges.length}`)

  // Baseline — ensure tests pass cleanly before any mutation.
  console.log('[mutate] baseline test run...')
  if (!runTests(filter)) {
    console.error('[mutate] baseline tests FAIL — aborting; fix tests first')
    process.exit(1)
  }
  console.log('[mutate] baseline green')

  let total = 0
  for (const rule of MUTATIONS) {
    const matches = [...original.matchAll(rule.pattern)]
    for (const m of matches) {
      const offset = m.index!
      if (isInSkipRange(offset, skipRanges)) continue
      total++
    }
  }
  console.log(`[mutate] total mutants = ${total}`)
  if (total === 0) return

  let processed = 0
  try {
    for (const rule of MUTATIONS) {
      const matches = [...original.matchAll(rule.pattern)]
      for (const m of matches) {
        const offset = m.index!
        if (isInSkipRange(offset, skipRanges)) continue
        const matchedText = m[0]
        const replacement = rule.swap(matchedText)
        const mutated = original.substring(0, offset)
          + replacement
          + original.substring(offset + matchedText.length)
        writeFileSync(target, mutated)
        const passed = runTests(filter)
        const outcome: MutantResult['outcome'] = passed ? 'survived' : 'killed'
        results.push({
          rule: rule.label, offset,
          original: matchedText, mutated: replacement,
          outcome,
        })
        processed++
        const mark = outcome === 'killed' ? '✓' : '✗'
        console.log(`[${processed}/${total}] ${mark} ${outcome.padEnd(8)} [${rule.label}] @${offset}: '${matchedText}' → '${replacement}'`)
      }
    }
  } finally {
    writeFileSync(target, original)  // ALWAYS restore
  }

  const killed = results.filter(r => r.outcome === 'killed').length
  const survived = results.filter(r => r.outcome === 'survived').length
  const score = killed + survived > 0 ? (killed / (killed + survived)) * 100 : 0
  console.log('\n[mutate] ───────────────────────────────────────')
  console.log(`[mutate] killed:   ${killed}`)
  console.log(`[mutate] survived: ${survived}`)
  console.log(`[mutate] score:    ${score.toFixed(1)}%`)
  if (survived > 0) {
    console.log('\n[mutate] surviving mutants (coverage gaps):')
    for (const r of results) {
      if (r.outcome === 'survived') {
        const lineNum = original.substring(0, r.offset).split('\n').length
        console.log(`  ${target}:${lineNum} [${r.rule}] '${r.original}' → '${r.mutated}'`)
      }
    }
  }
}

main().catch(err => {
  console.error('[mutate] error:', err)
  process.exit(1)
})
