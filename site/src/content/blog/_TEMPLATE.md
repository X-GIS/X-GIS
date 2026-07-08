---
# COPY THIS FILE to `YYYY-MM-DD-your-slug.md` and fill it in. This `_TEMPLATE.md`
# is excluded from the published collection (see src/content.config.ts), so it
# never ships — it exists only to be copied.
#
# Delete every HTML comment (<!-- ... -->) before you publish. They are guidance,
# not content.
title: 'A specific claim, not a topic' # e.g. "The no-op that hid a hundred fences" — NOT "Notes on stubs"
description: 'One or two sentences a stranger reads to decide whether to click. Name the concrete thing, the specific bug or number, and the takeaway. This is the promise the body must keep.' # 160–260 chars is the comfortable measure.
date: 2026-01-01T12:00:00Z # Use a TIME on same-day posts — the blog order tie-breaks on it.
tags: ['area', 'topic'] # 2–5 lowercase tags. The first tag is the kicker shown above the title.
lang: en # Repo content is English (see /CLAUDE.md §0). Korean posts go under /ko with lang: ko.
# series: { name: 'WebGL2 backend program', order: 3 } # OPTIONAL — only for posts that form an arc.
draft: false
---

<!--
════════════════════════════════════════════════════════════════════════════
  READ THIS FIRST — the one bar every article must clear
════════════════════════════════════════════════════════════════════════════

  Strip the word "X-GIS" from your draft. Is there still a transferable lesson a
  senior engineer ANYWHERE would bookmark? If not, you have written an internal
  changelog, not an article. Fix that before anything else.

  Insight lives in the SPECIFIC, not the general. The recurring failure mode
  (audited across the whole blog) is writing the clean final answer and the
  general maxim, while cutting the concrete problem, the wrong turn, and the raw
  observation that actually produced the "aha". Do the opposite.

  ── STEP 0: MINE THE SESSION YOU JUST FINISHED (do this before writing a word) ──

  You are writing at the end of a work session. The facts are in what you just
  did — use them, invent nothing:

    git log --oneline --author=Claude <branch> | head -40   # what landed
    git show <sha>                                          # what actually changed
    git diff <base>..HEAD -- <paths>                        # the real edit

  The article's specifics — every number, symptom, failing input, error string,
  code snippet — MUST come from that record, the code, or the tests. If a fact
  is not recoverable from the repo, DO NOT invent it: either leave it out or say
  plainly "we infer this / did not measure this." A fabricated number is worse
  than an admitted gap. (The blog has been burned by both an invented git-log
  line and a fabricated code snippet — reviewers caught them. Don't add a third.)

  Best of all: recover the DEAD ENDS you actually hit this session — the first
  fix that didn't work, the hypothesis that was wrong, the thing that looked
  green but wasn't. That is the most valuable content and it evaporates the
  moment the session ends. Write it down while you still have it.
-->

<!--
  OPENING — lead with a concrete fact, not a topic sentence.
  Bad:  "Precision matters in map rendering."
  Good: "At a world coordinate near 10^8, f32's spacing is 8 metres: every
         sub-integer detail is unrepresentable."
  A number, an error message, a measured symptom. Earn the click in two lines.
-->

Open with the sharpest concrete fact you have — the symptom, the number, the
error the reader would have hit too. State the problem quantified, not in the
abstract.

## The wrong first move

<!--
  THE DEAD END — this section is what separates an article from a docs page.
  Show the fix you tried that DIDN'T work, or the hypothesis that was wrong, and
  WHY it was tempting ("the diff was all 'add explicit import,' the kind of
  change that reads as tightening"). If you genuinely hit no dead end, you may be
  writing about work too simple to be worth an article — reconsider the topic.
  Never manufacture a fake wrong turn; recover a real one from the session.
-->

What looked reasonable and was wrong — with the reason it looked reasonable.

## What actually happened

<!--
  THE INVESTIGATION — show the RAW OBSERVATION that produced the insight, not
  just the conclusion. The conclusion is "a missing tile masqueraded as a corrupt
  one"; the observation is "we dumped the .pbf bytes and saw <!DOCTYPE html>."
  Keep the observation. Readers learn the move from the observation, not the
  verdict. Show code, a diff, an actual command and its output.
-->

The observation, then the diagnosis it forced. Ground it in real code:

```ts
// Prefer a real snippet from the change you shipped, copied verbatim.
```

## The fix

<!--
  Show it in code/diff. State any danger in the PAST TENSE if it actually
  happened this session ("a rename desynced the two GLSL stages and the program
  failed to link — here's the log"), not the conditional ("a rename COULD
  desync…"). "Can" is a docs page; "did" is a war story. Only use "can" for a
  risk that genuinely never fired, and say so.
-->

## How we know it holds

<!--
  Verification is part of the story, not an afterthought. What gate, test, or
  measurement proves the fix is real and the regression can't come back? A number
  here ("worst delta 0.0 across 96,000 axes") is worth a paragraph of prose.
-->

## What generalizes

<!--
  THE TAKEAWAY — optional, and dangerous. Keep a closing lesson ONLY if the
  reader would have DISAGREED with it before reading the body. "Incremental
  migrations localize regressions" — nobody disagrees; cut it. "Giving a
  dependency an explicit import path can STRENGTHEN it" — counter-intuitive;
  keep it. Prefer one earned sentence of prose to a bulleted maxim list. The
  strongest posts have NO bullet-list ending; they trust the body to have taught
  the lesson already.

  Banned: vanity numbers (lines of code, files touched) — use SYMPTOM numbers
  (217 refs → 87; 1687 → 1468 bytes). Banned: truisms, aphorisms the body didn't
  earn, and "Ship X" slogans.
-->

## References

<!--
  Cite real sources with links; the [1]/[2] markers auto-link to this list.
  Cross-link sibling posts by their real /blog/<slug> path where they genuinely
  continue the story — as a feature, not an apology for what this post omits.
-->

1. Author, ["Title"](https://example.com) — one line on what it establishes.

<!--
════════════════════════════════════════════════════════════════════════════
  BEFORE YOU PUBLISH — checklist (delete this block)
════════════════════════════════════════════════════════════════════════════
  [ ] Strip "X-GIS": a transferable lesson still remains.
  [ ] Every number/symptom/incident is grounded in repo code, git, or tests —
      nothing invented. Gaps are admitted, not filled with a plausible guess.
  [ ] There is at least one real DEAD END or wrong hypothesis, shown.
  [ ] Each "aha" shows the raw OBSERVATION that produced it, not just the verdict.
  [ ] Dangers that fired are PAST TENSE; dangers that didn't are flagged as such.
  [ ] No vanity numbers (LOC, file counts). No unearned closing aphorisms.
  [ ] No category-list bullets where the ONE failing value would be sharper.
  [ ] Code snippets are real (copied from the change), not illustrative fiction.
  [ ] Frontmatter: title is a claim, description keeps a promise the body pays,
      date has a time if same-day, first tag is the intended kicker.
  [ ] All HTML comments from this template are deleted.

  Reading aids you can use (see the blog's rendering pipeline):
  - $…$ / $$…$$        LaTeX math (KaTeX, build-time, no client JS)
  - ```lang fences      syntax-highlighted (expressive-code), copy button
  - :::warning / :::note / :::tip   admonition callouts (great for gotchas/traps)
  - tables              auto-wrapped with a mobile scroll affordance
  - ![alt](/path.jpg)   figures render framed with a mono caption
  - diagrams            author a Mermaid `.mmd` in site/diagrams/, render it to
    a committed SVG (site/diagrams/render.sh), embed as a <figure><img>. Build-
    time only, no client JS — same rule as KaTeX. See site/diagrams/README.md.
  - <LiveShader id=".."/> a live shader embed — but the file must be .mdx and
    import the component (see 2026-07-07-porting-the-shadertoy-classics.mdx)
-->
