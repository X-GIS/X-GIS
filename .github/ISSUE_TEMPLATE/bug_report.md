---
name: Bug report
about: A render/correctness/behavior defect. Mirrors the repo's issue house style.
title: '[scope] short symptom (style · location · zoom)'
labels: bug
---

<!-- `scope` in the title is the subsystem, e.g. [render/globe], [map/api],
[compiler], [render/projection]. Delete these comments before submitting. -->

## Symptom

<!-- What is wrong, quantified. A number, an error string, a measured pixel
offset — not "looks off". For a render bug, name the style, camera hash, and
zoom (e.g. OFM Bright · `#22.00/37.44234/126.90450` · Seoul · z22). -->

## Repro

<!-- Exact steps: demo id / style, camera, projection. A COMPARE-page hash is
ideal. Attach the X-GIS screenshot if visual. -->

## Expected (parity reference)

<!-- What SHOULD happen, and against what — usually MapLibre at the same view.
"MapLibre centres the arrow on the line; X-GIS offsets it." -->

## Likely cause / root cause

<!-- Optional but valued: the file:line you suspect and why. Be honest that a
bug report is a HYPOTHESIS — the stated cause may be refuted on reading. Note
any sibling issue this is distinct from / related to (e.g. "distinct from #399"). -->

## Confidence & how found

<!-- e.g. "high (confirmed via git history)" / "medium (static trace, not run)";
and how it surfaced (demo QA sweep, parity survey, agent audit). -->

<!-- Verification note: CI has no GPU. A render bug's fix needs a LOCAL real-GPU
gate (pixel-match / directional pixel-diff), not just a unit test — see
docs/adr/0004 and CONTRIBUTING.md. -->
