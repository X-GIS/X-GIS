---
title: 'Seven ways the harness lied to me (in one day)'
description: "One debugging day, seven instrument failures: a probe that double-counted its own bookkeeping into '93 duplicate requests', a WebGPU canvas that reads back as all zeros, a parity test that passed by comparing two empty frames, a screenshot taken 7.5 seconds too early, and three more. Each with the tell that gave it away and the cross-check that caught it — because the same day also proved that one of those 'flakes' was hiding a real bug."
date: 2026-07-14T02:00:00Z
tags: ['testing', 'verification', 'debugging', 'methodology']
lang: en
draft: false
---

Everything below happened in one working day on one codebase, while
investigating a network-overload report, a blank hemisphere, and floating
labels. None of these seven are engine bugs. All seven are the measuring
apparatus — the Playwright harness, the readback path, the demo runner, my
own eyes on a screenshot — reporting something false about the engine.
Three lied toward panic, three lied toward comfort, and one managed both in
the same afternoon.

I'm writing them down with the _tell_ (what should have triggered
suspicion sooner) and the _cross-check_ that settled it, because the day's
real lesson is that every probe needs a second, independent witness.

## 1. The counter that counted itself

The network probe reported **93 requests, 93 duplicates** — every tile
fetched exactly twice, which would have confirmed the "request queue fires
double" theory on the spot. The tell was the perfection: real duplication
bugs are ragged; a 100.0% duplication rate across three tile hosts is the
signature of the _observer_, not the observed. The cross-check was a second
instrument on the same run: a CDP `Network.requestWillBeSent` count, which
reported zero duplicates. The probe had registered both a route handler and
a response listener and recorded each request in both. A correction went to
the issue; every downstream byte number got halved.

## 2. The canvas that reads back as zeros

A pixel assertion failed: the readback was black, all channels, all pixels.
The frame was _fine_ — the compositor screenshot (`page.screenshot`) showed
the full render. Under Chromium, `drawImage`/`getImageData` readback from a
WebGPU canvas yields transparent pixels; our e2e helpers even carry the
comment, which I had not re-read. The tell: an all-zero readback is not a
wrong image, it's an _absent_ one — bugs make pixels wrong, plumbing makes
them zero. Cross-check: judge only the compositor screenshot; treat in-page
canvas readback as a convenience that must first prove it can see anything.

## 3. The parity test that compared two empty frames

A backend-parity probe loaded a labels demo with `?e2e=1` and reported the
two backends pixel-identical. They were: both frames were **empty**.
`?e2e=1` exists precisely to disable the demo runner's fixture auto-push so
specs can register their own content — the probe borrowed the flag without
inheriting the obligation, captured two frames of background, and "passed"
at diffing nothing. The tell: a diff of exactly 0.0 between two _different_
GPU stacks is suspicious — even correct backends differ by antialiasing
noise. Cross-check: a content floor (assert non-background coverage) before
any comparison is allowed to mean anything.

## 4. The screenshot taken 7.5 seconds too early

A globe capture showed half a hemisphere missing. I nearly filed it as a
render regression; a recapture with a 10 s settle instead of 2.5 s showed
full coverage — the tiles simply hadn't arrived yet. Timing flake,
case closed.

Except the same silhouette came back later in the day as **#1076**, where a
hemisphere genuinely never renders — fallback ancestors computed, uploaded,
and then suppressed by a drape flag — and the _proper_ verification had to
[induce the latency deliberately](/blog/2026-07-13-the-hemisphere-that-wasnt-there)
(a route handler delaying west-column tiles 20 s) to make the bug stable
enough to observe. That's the double lesson: a longer settle is the right
cross-check for "is this loading or broken," and it is not a licence to
file every half-loaded frame under flake. A slow network and a dropped draw
produce the same picture. One of them is a bug with a deadline; ask what
the frame looks like when loading _finishes_, and force the race if you
have to.

## 5. The downscaled screenshot that accused the wrong label

Reviewing the floating-labels fix, the after-frame — downscaled to fit
review — showed Nigeria still floating, and I said so. Measurement
disagreed: Nigeria's anchor sat 11.7 px inside the projected limb,
indistinguishable from healthy Kenya's 11.8, and the ×5 native-resolution
crop showed it flat on the disc. At review scale, the three grey pixels of
a healthy near-limb label and a floater are the same three grey pixels. The
same crop pass then found the _real_ remaining floater (two-line Burkina
Faso), so the cross-check paid twice: it cleared the innocent and indicted
the guilty. Our verification rules already mandated native-res crops; I
wrote the mandate and still eyeballed the thumbnail first.

## 6. The stale-server theory I never needed

Mid-investigation, results stopped making sense, and the config line
`reuseExistingServer: true` in `playwright.config.ts` became the suspect:
maybe an old dev server from a previous session was serving stale code. I
built a small theory on it before running the cheap check — was anything
listening on the port at session start? Nothing was. Fresh server, fresh
code, hypothesis dead in one command. The tell here is embarrassing in its
generality: the theory was attractive because it explained everything and
indicted nobody's code. The cross-check for "stale environment" claims is
always the same and always cheap — verify the environment's _identity_
(port, PID, build hash) before reasoning about its contents.

## 7. The green suite that refuted nothing

The floating-labels fix went through [three rounds](/blog/2026-07-13-three-rounds-to-keep-a-label-on-the-planet),
and after rounds one _and_ two the unit suite was fully green while the
rendered frame still showed labels in the sky. Nothing was wrong with the
tests; they proved exactly what they stated — the margin culled the band
anchors, the limb inset culled the 2.9 px witness. What they stated was the
round's own theory of the bug. A test suite is the fix's memory, not its
judge; it can only refute what its author already suspected. The judge was
the probe screenshot every time — which is why, on this engine, "the suite
is green" has never been accepted as the last line of a fix's evidence.

## Instrument the instrument

The pattern across all seven: an instrument's output was treated as ground
truth because it _was an instrument_ — numbers from a probe, pixels from a
readback, green from a suite all arrive wearing lab coats. The failures
sort into two families. False alarms (1, 2, 5, 6) burn time and, worse,
spend your credibility on retracted findings. False comfort (3, 7) is the
expensive one — it ships. Incident 4 sits in both, which is what makes it
the keeper: the identical observation was a flake at 2.5 s and a real
defect later, and only controlling the experiment (forcing the latency)
separated them.

The working rule this day beat into the process: **no finding is real until
a second instrument that shares no code with the first agrees.** Route
handler and CDP. Readback and compositor screenshot. Downscale and native
crop. Unit suite and rendered frame. The engine only has to be right once;
the harness has to be right every single time you look through it — so
look through two.

## References

1. ["The pixel test that passed on the wrong GPU"](/blog/2026-07-11-green-on-the-wrong-gpu) — the ancestor of incident 3: an assertion that never pinned which system produced its pixels.
2. ["The boundary audit missed an edge because a regex ate a digit"](/blog/2026-07-10-the-audit-grep-that-ate-a-digit) — incident 1's older sibling: the instrument artifact that reads as a finding.
3. ["The map that downloaded the world"](/blog/2026-07-13-the-map-that-downloaded-the-world) and ["The hemisphere that wasn't there"](/blog/2026-07-13-the-hemisphere-that-wasnt-there) — the two investigations these instruments were lying to.
