#!/usr/bin/env node
// UserPromptSubmit router for the local `prove-or-refute` skill.
// Fires ONLY when the prompt signals an adjudication intent (confirm/refute a
// code claim, suspected regression, "does this fix actually work", a demand for
// rigorous/inductive/mathematical proof). On a match it injects a compact
// directive so the model applies the skill's proof bar VERBATIM — no manual
// /prove-or-refute call needed. Kept narrow to avoid firing on every prompt.
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

  // Adjudication-intent triggers (KR + EN). Narrow on purpose.
  const TRIGGERS = [
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
  ]

  if (!TRIGGERS.some((k) => p.includes(k))) return

  const ctx = [
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
  ].join(' ')

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
    }),
  )
})
