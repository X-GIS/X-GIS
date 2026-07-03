#!/usr/bin/env node
// UserPromptSubmit router for the local `debug-toolkit` skill.
// Fires ONLY when the prompt signals a LOCALIZATION intent — "where does this
// diverge / get corrupted", a render artifact whose cause is unknown, a
// watchpoint / call-sequence / gdb-parity ask. On a match it injects a compact
// directive so the model applies the toolkit's CPU→GPU→visual method instead
// of guessing from a static read. Kept narrow to avoid firing on every prompt.
'use strict'

let input = ''
process.stdin.on('data', (d) => {
  input += d
})
process.stdin.on('end', () => {
  let prompt = ''
  try {
    prompt = String(JSON.parse(input).prompt || '')
  } catch {
    prompt = input
  }
  const p = prompt.toLowerCase()

  // Localization-intent triggers (KR + EN). Narrow on purpose — NOT bare
  // "debug"/"디버그" (too common); require a where/which/diverge signal.
  const TRIGGERS = [
    'watchpoint',
    'watch point',
    'cross-path',
    'call hierarchy',
    'call tree',
    'call sequence',
    'call order',
    'devassert',
    'devwatch',
    'readback parity',
    'where does it diverge',
    'where it diverges',
    'where the value',
    'gets corrupted',
    'fill is offset',
    'draws offset',
    'outline offset',
    'which path is',
    'localize the',
    'localise the',
    'step debugger',
    '어디서 갈리',
    '어디서 틀',
    '어디서 어긋',
    '어디서 깨',
    '값이 어디',
    '어디서 망가',
    '순차적으로 호출',
    '호출 순서',
    '호출순서',
    '콜 시퀀스',
    '콜 트리',
    '두 경로',
    '같아야',
    '왜 다르게',
    '왜 작게',
    '너무 가늘',
    '너무 작게',
    '오프셋',
    '워치포인트',
    '감시점',
  ]

  if (!TRIGGERS.some((k) => p.includes(k))) return

  const ctx = [
    '[MAGIC KEYWORD: DEBUG-TOOLKIT] This turn LOCALIZES a divergence whose',
    'symptom is a wrong pixel / wrong value many boundaries downstream of its',
    "cause. X-GIS's dominant archetype is two SIBLING paths that must agree",
    '(fill vs outline, CPU vs GPU projection, polygon vs line shader) silently',
    'diverging — sub-pixel until an over-zoom/pitch/projection axis amplifies',
    'it. Do NOT ship a cause reasoned from a static read (those are repeatedly',
    'WRONG here). Apply the debug-toolkit method in ORDER: (1) CPU cross-path —',
    'decode the SAME quantity from both paths to a common frame and',
    'devAssertClose(a,b,eps) at the seam; FIRES ⇒ cause is in the DATA (CPU),',
    'PASSES ⇒ cause is in the SHADER (GPU); use devWatch(name,value) as a',
    'watchpoint that is exhaustive over EXECUTION (every tile/frame), not the',
    'one camera you screenshot. (2) GPU readback-parity — run the suspect',
    'shader math in a compute pass, mapAsync back, compare the two vertex',
    'shaders / the CPU mirror to pin the term. (3) visual-artifact-bisect —',
    'real-GPU screenshot, toggle ONE variable (fill-only vs outline-only; zoom',
    'sweep to see if error ∝ magnification) to say which path is RIGHT. Use the',
    'primitives in runtime/src/dev/dev-assert.ts (import.meta.env.DEV-gated,',
    'stripped in prod). For "which functions run in order", LSP gives structure',
    'not order — read the body (source order + branches) or runtime-trace.',
    'Full method: .claude/skills/debug-toolkit/SKILL.md',
  ].join(' ')

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
    }),
  )
})
