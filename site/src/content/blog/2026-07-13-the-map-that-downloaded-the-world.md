---
title: 'The map that downloaded the world'
description: "A static map view produced 10+ MB/s bursts and a warm phone. The render loop was innocent, our first probe fabricated a '93 duplicate requests' finding, and the real villain was the availability feature that keeps fast-pan from blanking — politely fetching an 85-tile, 33 MB world pyramid on every load and pinning it against eviction forever. Same view after the fix: 35.33 MB → 6.27 MB."
date: 2026-07-13T23:00:00Z
tags: ['performance', 'networking', 'debugging', 'tiles']
lang: en
draft: false
---

The report (#1045): a static basemap view — no panning, no animation —
bursts past 10 MB/s and the user's phone gets warm. The report also came
with suspects: too many tile requests, request queues coupled to a 144 Hz
rAF, wrong zoom selection fetching too many tiles. Zoom selection was
already off the list — our tile-decision goldens match MapLibre's selection
for the same cameras. The rest needed measurement, and the measurement is
where this story spends its first act, because our instruments lied before
the code did.

## The harness lied first

Act one was just getting bytes to flow: in this environment the headless
browser's CONNECT to the egress proxy was reset, so in-browser fetches to
the tile CDN failed outright. The workaround shapes everything after:
`page.route` intercepts every external request and _relays_ it through a
Node-side `APIRequestContext` (which speaks the proxy and TLS config
correctly), then fulfills the route. The app's request behaviour is
untouched — same URLs, same timing, same cache semantics from the page's
point of view — the harness just does the fetching.

Act two produced the season's scariest finding: **93 requests, 93
duplicates**. Every single tile fetched twice. That number would have
confirmed the user's queue theory beautifully, and it survived just long
enough to be almost posted as the diagnosis. The cross-check killed it: a
CDP `Network.requestWillBeSent` count for the same run showed **zero**
duplicates. The probe was recording each request in _both_ a route handler
and a response listener — it was double-counting its own bookkeeping. A
correction went to the issue and every byte figure in the investigation got
halved. The finding was self-inflicted, and it was more dramatic than the
truth.

(We've been burned by an instrument fabricating a finding before — a
[boundary audit whose regex ate a digit](/blog/2026-07-10-the-audit-grep-that-ate-a-digit).
The rule that survives both incidents: a counter you built five minutes ago
has earned no trust; cross-instrument before you believe it.)

## The villain was the safety feature

With honest numbers, the traffic distribution answered in one line: a
single static z4 view fetched **85 skeleton tiles ≈ 33 MB — 92% of all
traffic**. Not the viewport's tiles. The _skeleton_: our Cesium-style
permanent root retention, z0–z3 pinned in cache so that
`classifyFallback`'s ancestor walk always finds a parent during fast-pan.
The feature is legitimate — before it, panning to a fresh region dropped
into the `pending` decision and the canvas cleared white; it's the same
skeleton that let the [blank-hemisphere fix](/blog/2026-07-13-the-hemisphere-that-wasnt-there)
have ancestors to draw at all.

But look at how it spent:

- `prewarmSkeleton` enumerated **every tile of every level** z0–z3 up
  front, and re-issued the whole remaining set on a fixed 250 ms tick until
  all arrived — no backoff, so a lossy mobile link meant a radio kept hot
  by retries.
- The eviction policy **pinned every key permanently**: `markSkeleton`
  survives `evictTiles` unconditionally and `cancelStale` never aborts its
  fetches. The pyramid was not just downloaded; it was undeletable.
- The cost model was wrong by 8×. The depth heuristic assumed ~50 KB/tile —
  ~4 MB for depth 3, a defensible ante. OpenFreeMap's z2–z3 tiles average
  **~400 KB**. The feature was designed in tiles and levels; the bill
  arrived in bytes.

Nothing errored. Nothing was even slow, on desktop wifi. That's what makes
availability features the perfect traffic villains: they run
unconditionally, before any user intent, and _correctly_ — the report they
generate is never "the map is broken," it's "the map works and my phone is
hot."

## The fix: keep the purpose, bound the cost

The pump moved into its own module (`data/src/tile-skeleton-prewarm.ts`)
with four properties, each answering one measured failure:

- **Level-staged** — z+1 is not touched until level z is complete, so the
  fallback chain fills top-down and a budget stop can never leave a shallow
  level half-fetched while a deeper one streamed.
- **Floored** — the leading levels whose cumulative count fits 5 tiles
  (z0+z1 for a z0-rooted source) always complete, even at budget 0. They
  are the ancestor-walk backbone; the feature's purpose survives the cap.
- **Byte-budgeted** — past the floor, once _arrived_ bytes cross the budget
  (1.5 MiB under 900 px viewports, 4 MiB desktop — the original ~4 MB
  design intent made binding instead of assumed), the pump stops and
  **unpins** every never-arrived key so ordinary LRU can reclaim strays.
  Requests go out in 2-tile waves, so overshoot is bounded by one chunk.
- **Backoff with a give-up** — the tick doubles 250 ms → 8 s while nothing
  arrives, and after 6 zero-progress ticks it unpins the stragglers and
  stops. The design comment says it plainly: a dead source must not keep
  the radio warm.

The budget counts _arrived_ bytes rather than requested ones, and
viewport-driven fetches of the same keys count toward it — the skeleton
doesn't get to bill twice for a tile the camera wanted anyway.

## How we know

Five unit gates, each verified failing before the fix: the budget stop, the
floor guarantee, the level staging, the give-up unpinning, and `stop()`.
And the number that matters, same camera, same style, headless probe with
the relay harness: **91 tiles / 35.33 MB before → 16 tiles / 6.27 MB after**
— an 82% cut, with the fallback backbone (z0+z1) still guaranteed complete.

## What generalizes

Two lessons, both of which I'd have nodded past before this session.

First: budget an availability feature in the unit it _spends_, not the unit
it's designed in. "Depth 3" sounded like a policy about levels; it was
actually a promise about bytes, made on a 50 KB assumption the real world
broke by 8×. The fix didn't remove the promise — it made the byte budget
the binding constraint and let depth be the aspiration.

Second: when an investigation's first finding is dramatic, check the
instrument before the code. Our probe's "93/93 duplicates" was wrong in a
way that flattered the existing theory — double-counted evidence _for_ the
suspect we already had in custody. The CDP cross-count cost five minutes
and saved a fix to a bug that didn't exist. The real bug was quieter, 92%
of the traffic, and pinned so it couldn't even be evicted — found only
after the numbers deserved trust.

## References

1. ["The boundary audit missed an edge because a regex ate a digit"](/blog/2026-07-10-the-audit-grep-that-ate-a-digit) — the sibling incident: an instrument artifact presenting as a finding.
2. ["The hemisphere that wasn't there"](/blog/2026-07-13-the-hemisphere-that-wasnt-there) — the same skeleton's fallback machinery on its best day, drawing the coarse parents this pyramid exists to provide.
3. Session record: `docs/research/2026-07-13-globe-webgl2-bundle.md` — includes the cross-instrumentation method note ("cross-instrument network claims (page.route AND CDP) before believing counts").
