#!/usr/bin/env node
// ═══ The project's SINGLE UserPromptSubmit router ═══
//
// Every `command` hook spawns a shell process on every prompt. This used to be
// TWO hooks (one per skill), so each prompt paid two spawns — and on Windows,
// where a spawned shell can attach a console window, that is two windows per
// prompt. Anything that re-feeds prompts automatically (the ralph-loop plugin's
// Stop hook re-submits the same prompt every iteration) multiplies that by the
// iteration count, which is how a single request turned into a storm of
// terminals.
//
// So skills REGISTER here instead of each adding a hook: one process per prompt,
// no matter how many skills route. Adding a skill is an entry in ROUTES, not a
// third spawn.
//
// Behaviour is otherwise unchanged. stdin is read once; every route whose
// triggers match contributes its directive, and the directives are joined —
// exactly what two independent hooks produced when both matched. No match at all
// ⇒ no output, same as before.
'use strict'

/** @type {{ name: string, triggers: string[], directive: string }[]} */
const ROUTES = [
  {
    // Fires ONLY when the prompt signals an adjudication intent (confirm/refute a
    // code claim, suspected regression, "does this fix actually work", a demand
    // for rigorous/inductive/mathematical proof). Narrow on purpose.
    name: 'prove-or-refute',
    triggers: [
      'prove',
      'refute',
      'disprove',
      'proof',
      'adjudicate',
      '증명',
      '반증',
      '반례',
      '귀납',
      '수학적 증명',
      '엄밀',
      'regression',
      '회귀',
      'is this a bug',
      'is it a bug',
      'real bug',
      'confirm the bug',
      'confirm or refute',
      '버그 맞',
      '버그인지',
      '버그가 맞',
      '진짜 버그',
      'does this fix',
      'does the fix',
      'does this work',
      'does it actually',
      '진짜 되',
      '진짜 맞',
      '정말 되',
      '제대로 되',
      '진짜 고쳐',
      'fail-before',
      'witness',
      'invariant',
      '불변식',
      'rigorous proof',
    ],
    directive: [
      '[MAGIC KEYWORD: PROVE-OR-REFUTE] This turn adjudicates a CODE CLAIM',
      '(bug / regression / "does this fix work"). Follow the prove-or-refute skill',
      'VERBATIM, in Q.E.D. form — a claim is worth nothing until PROVEN, and a proof',
      'that does not close is a hypothesis, not a verdict. Do NOT settle it with a',
      'confident static read or a single-shot "I ran it once" (proves nothing about',
      'untested inputs). For EACH claim, write a FORMAL proof: (1) state the',
      'PROPOSITION, quantified — `∃ input : wrong output` to confirm, `∀ input :',
      'correct` to refute; (2) PROVE it with justified steps (each step = a file:line',
      'fact / a Lemma / an exhaustive Case split / a Base+Step induction — never',
      '"should"/"probably"), by construction (exact witness input + derive the wrong',
      'output stepping the code logic), induction (on a count / recursion depth),',
      'invariant-violation, exhaustive-case, or contradiction; one counterexample is',
      'a complete disproof; (3) close with ∎ (Q.E.D.) — if you cannot, the VERDICT is',
      'NEEDS-PROBE, name the unproven step. Then: VERDICT (CONFIRMED-REAL | REFUTED |',
      'NEEDS-PROBE) + (confirmed) a WITNESS precise enough to become a fail-before',
      'test that fails-before / passes-after / asserts the RIGHT thing (non-vacuous)',
      '+ Realist-Check severity (worst case + bounding mitigations) + reachability;',
      '(refuted) the governing INVARIANT and why it holds. To prove a bug CANNOT',
      'exist, use 귀류법 (reductio): an ∃-bug is not killed by one no-bug example —',
      'assume it fires, extract its necessary condition C, prove an invariant Inv with',
      'Inv ⟹ ¬C, derive C ∧ ¬C = ⊥ ∎; then ATTACK Inv — if an input breaks it, the',
      'bug is CONFIRMED (refuting and hunting are the same act). Be adversarial BOTH',
      'ways (attack your own confirmation AND your own refutation). Inherently-visual',
      'claim → NEEDS-PROBE → visual-artifact-bisect. Full method:',
      '.claude/skills/prove-or-refute/SKILL.md',
    ].join(' '),
  },
  {
    // Fires ONLY when the prompt signals a LOCALIZATION intent — "where does this
    // diverge / get corrupted", a render artifact whose cause is unknown, a
    // watchpoint / call-sequence / gdb-parity ask. Narrow on purpose — NOT bare
    // "debug"/"디버그" (too common); require a where/which/diverge signal.
    name: 'debug-toolkit',
    triggers: [
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
    ],
    directive: [
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
    ].join(' '),
  },
]

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

  const matched = ROUTES.filter((r) => r.triggers.some((k) => p.includes(k)))
  if (matched.length === 0) return

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: matched.map((r) => r.directive).join('\n\n'),
      },
    }),
  )
})
