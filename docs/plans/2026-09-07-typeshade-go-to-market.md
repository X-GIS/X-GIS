# TypeShade — go-to-market plan (2026-09-07)

**Artifact type:** GTM plan — STP · Play Bigger category design · brand platform · GTM canvas · launch sequence · content calendar · AARRR + OKR alignment · budget · marketing risk register · **Owner:** head of go-to-market (solo owner executes) · **Status:** input to `04-ia-wireframe.md`, the copy deck, and the launch bundle
**Source corpus, read in full:** `docs/design/00-brief.md` (**BR**) · `docs/design/02-messaging.md` (**MSG**) · `docs/design/01-research.md` Part D (**P1–P10**) · `docs/plans/2026-09-07-typeshade-strategic-plan.md` (**SP**) · `docs/plans/2026-09-07-shader-dsl-standalone-product-strategy.md` (**PS**) · the STP artifact and the two positioning verdicts supplied with this brief (**V1**, **V2**).
**Availability checks (`ls`, 2026-09-07):** `docs/plans/2026-09-07-typeshade-ecosystem-embedding.md` — **absent**, so **SP §6.4 is the authoritative host ranking** here; `docs/design/04-ia-wireframe.md` — **absent**, so section slots come from **MSG §6**. Re-check both before acting on host order or slot names.
**Honesty envelope (SP §14, absolute):** no "production-ready" / "1.0" · no `npm i typeshade` as a CTA · no "used by \<host\>" · no star or download number about TypeShade · no adapter, matrix or playground spoken of as shipped · no "replaces TypeGPU / TSL" · no MSL / HLSL / SPIR-V as a TypeShade feature. **Every hours or money figure below is a proposed budget — judgement, not measurement** (same discipline as SP §11.2). Items marked ⚠ are from memory and are flagged where they appear.

## 0. Executive summary

1. **Beachhead is settled and cross-checked three ways** (STP weighted matrix 4.70; SP §6.4 host properties; SP §7 option value): **MapLibre custom-layer authors**, then deck.gl extensions, then PixiJS filters.
2. **The category is not "another shader DSL".** TypeShade claims **the shader compiler for TypeScript whose outputs' agreement is a compiler output** — proof is the category-defining act, dual-target is its first proof (SP §13 D1(b)).
3. **Headline of record = the V1 graft:** "Write the shader once." over a typed-and-proven subline. Stance, section order and positioning statement come from candidate (b); the h1 does not ship unaltered. Pre-agreed fallback is (b)'s own line.
4. **Launch bundle = compiler tag + playground + site + governance, one day** (PS §6.3, SP §13 D7). **Adapters are not in it** — KR2.1 dates them at month 6, and claiming one early breaks SP §14.
5. **Nothing is for sale at launch.** Line A (services) is an outbound motion with no on-site CTA; line B opens only at two external consumers on a tagged release (PS §6.5).
6. **Channel bullseye:** Show HN · Graphics Programming Weekly · the three host communities. Everything else is the outer ring until one of those returns a non-owner sketch.
7. **The one metric that decides Q2:** ≥ 20 non-owner playground sketches/month by month 6 (SP §12 KR1.2). Zero at month 6 means stop marketing and fix the whole product (SP §12.1).
8. **Marketing's largest risk is over-claiming**, because the product's only differentiator is proof: one caught claim costs the positioning permanently (SP §14).
9. **Cash out of pocket is near zero**; the one thing to buy is the attorney trademark search and the KR 09+42 filing, and it must precede the launch post (SP §9 R7, PS §9).
10. **The event nothing can manufacture** — a host ships a backend and adapter users change nothing (SP §6.5) — is what the whole 20-week sequence exists to be ready for.

## 1. STP — segmentation, targeting, positioning-to-segment

**Framework:** Segmentation → Targeting → Positioning (Kotler ⚠ from memory), beachhead + bowling alley (Moore, *Crossing the Chasm*, 1991 ⚠ from memory), JTBD (Christensen / Ulwick ⚠ from memory). Tightened from the STP artifact supplied with this brief; sizing caveat there applies unchanged — **no source measures the custom-layer / extension / filter-author fraction**, and host npm installs are an upper bound on reach, never an audience number.

### 1.1 Segments and targeting matrix

Weights: Pain 0.35 · Strategic fit (SP §6) 0.25 · Accessibility 0.25 · Reach 0.15. Reach is deliberately down-weighted — the largest-reach segment has the least pain (SP §1.3 T1).

| # | Segment | Cut on | Reach proxy, npm wk (measured 2026-09-07, SP §15) | Pain | Score | Rank | GTM treatment |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **S1** | MapLibre custom-layer authors | host | `maplibre-gl` 4,366,094 | Highest — **dated** (roadmap phase 4) | **4.70** | **1** | **Beachhead.** All launch assets aimed here |
| **S2** | deck.gl / luma.gl extension authors | host | `deck.gl` 202,573 | Highest — blocked today | **4.05** | 2 | Pin 2, wave 2 (T+8→) |
| **S3** | PixiJS filter authors | host | `pixi.js` 920,303 | High — in the API signature | **3.60** | 3 | Pin 3, wave 3 (T+12→) |
| **S5** | Engine maintainers mid-migration | job | `@babylonjs/core` 272,819 + the three pins | High — they own the port | 3.45 | 4 | **Depth axis**, not a pin: rungs 3–4, MapLibre only (SP §13 D2) |
| **S7** | Agent-assisted teams | pain | TS most-used on GitHub, +66% YoY contributors | Emerging, unmeasured | 3.40 | 5 | **Time axis**: served on every pin by `llms.txt` + MCP + skill (D4) |
| **S6** | Studios with a WebGL2 codebase | job | `regl` 776,433 · `glslify` 565,493 (stale-publish proxies) | Highest per team, self-scheduled | 3.20 | 6 | Revenue **line A**, outbound only — not an adoption funnel |
| **S4** | three.js / creative | host | `three` 14,025,392 | **Low — already solved** (T1) | 2.35 | 7 | **Not targeted.** One honest docs line, never a pitch |

**Sensitivity.** S1 holds first under inverted pain/reach weights (4.30 vs S2 3.45), with accessibility dropped (3.45 vs 3.05) and with fit at zero (3.45 vs 3.05). The ranking does not depend on the weights.

### 1.2 Beachhead and bowling alley

**Beachhead: S1.** Moore's six criteria all pass (STP §2.4): dated reason to buy · whole product achievable solo (adapter + example + matrix ≈ 1–2 weeks, SP §6.3 rung 1) · one project, one docs site, one issue tracker · no entrenched competitor · big enough / small enough · the seller has domain credibility (X-GIS is a globe engine on both backends).

```
PIN 1 MapLibre layers ─(adjacent problem, adjacent people)→ PIN 2 deck.gl extensions
        └────────────(same emit pair, different host)──────→ PIN 3 PixiJS filters
   ─(matrix = the credibility a host-less team buys on)→ PIN 4 generic apps (line A) → PIN 5 three.js, reach only, last
```

Carried forward between pins: the adapter *shape* (insulation layer + `reflect()` bindings), the matrix generator, the forward-compat contract text, the CI harness, the launch narrative. Rebuilt per pin: the host artifact returned, the example, one matrix column.

### 1.3 JTBD — one row per targeted segment

| Segment | When… I want… so I can… | Emotional | Social |
| --- | --- | --- | --- |
| **S1** | When the host's roadmap ports my shader language out from under me, I want to write the shader once in a form both backends are generated from, so I can ship now and still work after the flip | **Relief** | Author of the layer that did **not** need porting |
| **S2** | When my extension is WebGL-only because it injects GLSL, I want the GLSL chunk today and the WGSL one from the same source, so I can stop waiting for the host | **Agency** | First extension in that ecosystem not WebGL-only |
| **S3** | When the API asks for a `gl` and a `gpu` program per effect, I want both from one typed source, so I can ship one filter instead of two kept in step | **Confidence** | A filter with no caveat in its README |
| **S5** | When my engine carries two backends for years, I want every shader feature to land once, so I can finish the port without freezing the roadmap | **Safety** (reversible: 0 deps, MIT, plain text out) | De-risked the migration for every downstream author |
| **S6** | When a port means writing every shader twice, I want one source with agreement machine-checked, so I can schedule a build change instead of a rewrite | **Control over a date** | A plan with a number and a gate, not an estimate |
| **S7** | When an agent writes my shader, I want the mistake to be a type error at author time, so I can review generated code as fast as it is produced | **Trust without reading every line** | Agent-written graphics code that survives review |

**Self-identification lines** (STP §5, printable today, none names a host): S1 *"Your custom layer's GLSL has an expiry date on the host's roadmap."* · S2 *"Your extension injects GLSL, so it stays WebGL-only until someone rewrites it."* · S3 *"One effect, two programs: the API asks for both, or it will not run."* Placement recommendation stands: **one `Who writes this` block between MSG §6 sections 2 and 3**, three lines, scan-row shaped (**P5**), never a table (**P10**) — 7 blocks before the footer, inside the P7 median of 6–7.

## 2. Category design (Play Bigger)

**Framework:** Play Bigger — category design, point of view, from/to, category king (Ramadan, Peterson, Lochhead, Maney, 2016 ⚠ from memory). Like Moore's statement (MSG §1), **the category is an internal alignment artifact**: the word "category" never appears on the page.

| Element | Content |
| --- | --- |
| **Category name (of record)** | **The shader compiler for TypeScript** — qualified *engine-agnostic* (BR positioning sentence). Short, sayable, and already the brief's own words; no new coinage is introduced at launch |
| **What makes it a category and not a slot** | The **point of view** below, not the noun. The noun places it; the POV differentiates it |
| **Point of view (the "different", not the "better")** | *Agreement between two shader outputs is something a compiler should **produce and prove**, not something a human should re-check by hand.* A compiler that emits two languages without an oracle has shipped half the artifact |
| **The missing thing in the world** | Nobody publishes evidence that two emitted shaders agree. The oracle exists (SP §1.3 S1: no comparable library ships one), and so does the artifact that would make it public — the **host × adapter × backend matrix**, which SP §14 calls *"the differentiator — nobody publishes one"* |
| **Category-defining artifact (the "lightning strike" object)** | Not an event: the **playground URL + the matrix page**. One shows the category's promise in 5 seconds; the other proves it per host version, in CI, or fails the build (SP §6.2 #3, R12) |
| **Category king test** | When a reader asks *"is my shader proven on both backends?"* the expected answer is a TypeShade matrix cell. Leading indicator: SP §6.5's *host ships a backend, adapter users change nothing* |
| **What falsifies the category** | SP §8 **S3**: a browser vendor, Khronos/Slang or a complete `@typegpu/gl` ships JS-native multi-target compilation. Then the category collapses into the platform and the retreat is the proof layer + the complete GLSL ES 3.00 backend + fp64 + shader CI (line B) |

### 2.1 The from/to shift

| | From (the world today) | To (the world the category asserts) |
| --- | --- | --- |
| **The artifact** | A shader is text you port | A shader is typed source; the target languages are build output |
| **Agreement** | Assumed, then discovered in a bug report | **Measured** — a CPU f64 oracle over the same source; every emitted variant compiled by Tint and by WebGL2 in CI |
| **A backend change** | A scheduled rewrite ("port GLSL shaders to WGSL") | A build step that already covers it |
| **Layouts** | std140 / std430 offsets hand-derived, breaking on a host upgrade | `reflect()` derives them |
| **Who writes it** | A specialist, by hand, twice | A typed surface an agent can get right and a compiler can prove |

### 2.2 Why the incumbents are not in this category

One honest line each, docs only, never a scorecard (**P10**, MSG §3 objection 11). Wording below is the **maximum** that may be published.

| Incumbent | The category it is in | Line of record | Why it is not in ours |
| --- | --- | --- | --- |
| **three.js TSL** | A renderer's authoring layer | "Tied to its renderer." | `WebGPURenderer` auto-falls back to WebGL2 from the same TSL source — so it *solves* the tax for its users rather than competing on it (SP §1.3 T1). **Never "replaces TSL"** (SP §14). Add the reader-serving line: *"A renderer that already falls back to WebGL2 may not need this."* |
| **TypeGPU** | A typed WebGPU runtime | "Its WebGL2 backend is experimental." | Documented as lacking compute shaders, storage buffers and bind groups (docs.swmansion.com/TypeGPU/ecosystem/typegpu-gl/, fetched 2026-09-07). Different axis: runtime ergonomics, not emitted-output proof |
| **WESL** | A WGSL language extension + module distribution | "Complementary." | Wardley square (6) is **partner / adopt, never build a rival registry** (SP §2.1/§2.3). WESL standardises modules; it does not emit GLSL ES 3.00 and does not prove agreement |
| **Hand-written twin shaders** | The status quo, not a product | "The tax." | 64% of >400 respondents adapt shaders across platforms/APIs/tools; ~10% call it one of their largest engineering costs (Khronos 2026). This is the incumbent to displace, and the only one the page may name as a problem |

**Do not fight on authoring syntax** (PS §1, SP §2.3 "accept the inertia"). Every competitor fights there; staying out is a positional decision.

## 3. Brand platform

| Element | Statement | Traces to |
| --- | --- | --- |
| **Purpose** (why it is maintained) | So a shader is written once and its two outputs are provably the same thing — and so that stays true when an agent, not a person, writes it | SP §0, §3, §13 D1 |
| **Promise** (the source every headline is cut from; never printed verbatim) | *Write the shader once; both GPU APIs get one, and their agreement is checked rather than assumed.* | MSG §2 |
| **Positioning statement of record (Moore, D1(b)-amended)** | **For** TypeScript developers and engine maintainers **who** must put the same shader on more than one GPU API, **TypeShade is** an engine-agnostic shader compiler for TypeScript **that** turns one typed source into shader code whose outputs are proven to agree — today WGSL and GLSL ES 3.00. **Unlike** three.js TSL, tied to its renderer, and TypeGPU, whose WebGL2 backend is experimental, **TypeShade** proves it: a CPU f64 oracle over the same source, and every emitted variant compiled by Tint and by WebGL2 in CI. | MSG §1 amended per SP §13 **D1(b)** and **V1/V2** — dual-target moves out of the key-benefit slot into the differentiation slot. **This is the whole of D1 as a structural edit** |
| **Headline of record** | `# Write the shader once.` / *Typed TypeScript, proven to agree — WGSL and GLSL ES 3.00 from one source.* | **V1 graft**: job-shaped h1 (P1 assigns the headline to desire), typed+proven leading the subline, dual-target demoted to the subline's evidence clause |
| **Pre-agreed fallback** | `# Typed shaders you can prove.` / *TypeScript in; WGSL and GLSL ES 3.00 out, checked by a CPU f64 oracle.* | Candidate (b) unaltered. Switch **only** if the five-stranger test says the job headline reads as a promise about host upgrades rather than about authoring |
| **The 2031 edit, pre-committed** | One clause of one line. Triggered by **SP §8's S2 signpost** (a top-5 web engine ships WebGPU-only defaults), never by the calendar | SP §1.4, §9 R5, V1, V2 |

### 3.1 Personality — archetype

⚠ Jungian brand archetypes (Mark & Pearson, *The Hero and the Outlaw*, 2001) cited from memory.

| | Archetype | Expressed as | Never |
| --- | --- | --- | --- |
| **Primary** | **Sage** — the authority whose claim is evidence | Numbers with units and a route to reproduce them; "Agreement is measured, not promised" | Lecturing; explaining WGSL or std140 to the reader |
| **Secondary** | **Craftsman / Maker** — a tool made by someone who uses it daily | "In production today inside the X-GIS globe engine"; the pinned commit printed | Artisanal preciousness; "we built this because we loved…" |
| **Forbidden** | Magician, Hero, Outlaw | — | "Unleash", "supercharge", "stop hand-writing shaders like it's 2019". A voice that oversells is evidence against a proof claim (MSG §7) |

### 3.2 Voice — NN/g four dimensions (from MSG §7, unchanged)

| Dimension | Position | Do | Don't |
| --- | --- | --- | --- |
| Funny ←→ **Serious** | 4 / 5 serious | "The GPU has no f64. The emulation does." | A joke that must be decoded |
| Formal ←→ **Casual** | 3 / 5 casual-neutral | "That is the whole source for the shader running above." | "a comprehensive suite of tooling designed to…" |
| **Respectful** ←→ Irreverent | 4.5 / 5 respectful | "Both emitted shaders are compiled by the real compilers, every commit." | Mocking the reader's current practice |
| Enthusiastic ←→ **Matter-of-fact** | 4.5 / 5 matter-of-fact | "36 examples, each emitting both targets." | "Incredibly fast, beautifully typed shaders!" |

Rules that bind every channel, not only the page: every adjective carries a number or a proper name; never "we"; present tense; ≤ 20 words per sentence; jargon only as a label on a proof; numbers render from source with their unit; pre-release status stated once, after the first claim (**P9**). The MSG §7 forbidden-word list applies to launch posts, README files, conference abstracts and outbound email verbatim.

### 3.3 Visual identity principles (input to `05-design-system.md`)

| # | Principle | Consequence |
| --- | --- | --- |
| 1 | **The live shader is the colour of the page** | Dark near-black ground, **one** accent; the palette must not compete with the canvas (BR design direction) |
| 2 | **Proof is typography, not decoration** | Every proof chip is real text, never an image of text; a number always adjacent to its unit and its label (MSG §8) |
| 3 | **One strict type scale, generous whitespace, mobile-first** | Benchmarks: Linear, Vercel, Stripe, Raycast, Bun, Vite, Tailwind (BR). Zero horizontal overflow at 390 / 768 / 1440; wide artifacts go first on mobile — a second argument against tables |
| 4 | **Motion is restrained and has one job** | One live canvas and nothing beyond it; `prefers-reduced-motion` → one still frame (01-research Part D, motion note) |
| 5 | **No borrowed credibility we do not have** | No customer-logo band (one production consumer, named in prose); no comparison table (**P10**); version state is a nav chip after the claim, never a lead (**P9**) |
| 6 | **Off-page surfaces inherit the same system** | OG image, favicon, badge, slide template and README header use the same ground, accent and type scale — the OG image carries the headline of record and nothing else |

### 3.4 Ingredient branding — the mark

**Framework:** ingredient branding, Intel Inside shape (Kotler & Pfoertsch, 2010 ⚠ from memory; SP §6.1). The purpose is that a host's users ask for the ingredient — but the mark must never imply an endorsement that SP §14 forbids.

| Question | Answer |
| --- | --- |
| **Wording** | **"Built with TypeShade"** — and only this. **"TypeShade inside" is rejected**: it reads as a claim about the *host's* internals, which is exactly the "used by \<host\>" claim SP §14 bans while no adapter is shipped |
| **Who may use it** | The **author of the artifact** — a custom layer, an extension, a filter, an app — that compiles its shaders with TypeShade. It is the author's claim about their own work, and it is true by construction |
| **Who may not** | A **host project** may not be described as "built with TypeShade" by us, ever, under any adoption level; only the host itself may say what it is built with. We may state, once the matrix is green, the checkable fact: *"host X version Y, adapter version Z, both backends — green in CI"* |
| **When it may first appear** | At `0.1.0` for artifact authors (the compiler is public and MIT). Beside a **host name**, only when that host has a green matrix row — never before (SP §6.2 #4: claim only what the matrix proves) |
| **Form** | One SVG badge and one Markdown snippet in the docs, in the §3.3 system; the badge links to the matrix page, not to the homepage — the link is the evidence, which is the whole point of the mark |
| **Retirement rule** | If a matrix cell goes red or stale (> 30 days un-run, SP R12), the cell fails the build and the badge's claim for that host is withdrawn in the same release |

## 4. Go-to-market canvas

### 4.1 Launch goals (12 months, tied to SP §12 OKRs)

| # | Goal | Target | OKR |
| --- | --- | --- | --- |
| G1 | Exist publicly and survive inspection | `0.1.0` tagged with `api-surface.test.ts` freeze; `GOVERNANCE.md` + `SECURITY.md` at tag; npm release with provenance; 0 missed monthly releases Q2–Q4 | KR1.1, KR1.3, KR1.4 |
| G2 | Prove the artifact is shareable | ≥ 20 non-owner playground sketches / month by month 6 | KR1.2 |
| G3 | Publish the differentiator | host × adapter × backend matrix green in CI and published by month 4 | KR2.2 |
| G4 | Embed in one host ecosystem | `@typeshade/maplibre` + `@typeshade/deck` published with runnable examples by month 6; ≥ 1 host docs/ecosystem listing by month 9; ≥ 3 non-owner host issues/PRs mentioning TypeShade by month 12 | KR2.1, KR2.3, KR2.4 |
| G5 | Fund the floor without adoption | anchor-tenant contract written by end Q1; ≥ 2 line-A outbound conversations by month 6 | KR3.1, KR3.2 |

### 4.2 Whole product at launch (Moore layers) — and the divergence, stated

| Layer | Item | In the launch bundle? | Note |
| --- | --- | --- | --- |
| Generic | The compiler | ✅ | Exists today |
| Expected | `0.1.0` tag + API freeze + changelog + semver + npm release with provenance | ✅ | KR1.1 / KR1.4 |
| Expected | **Browser playground, one URL per sketch** | ✅ **centrepiece** | SP §13 **D7**: before `0.1.0`. The single biggest gap (SP §5.3) |
| Expected | Landing page + docs + `AUTHORING.md` | ✅ | Same day (PS §6.3) |
| Trust | `GOVERNANCE.md` (BF-1 named + 90-day dead-man switch) + `SECURITY.md` | ✅ | SP §13 **D3** |
| Augmented | `llms.txt` + MCP compile/validate tool + agent skill | ✅ | SP §13 **D4** (Q1) |
| Augmented | `@typeshade/maplibre` + example | ⛔ **wave 2, T+4 → T+8** | — |
| Augmented | Host × adapter × backend matrix, published | ⛔ **T+10 (month ~4)** | KR2.2 |
| Augmented | `@typeshade/deck` + example | ⛔ **month 6** | KR2.1 |
| Potential | Shader CI as a product; support SLA | ⛔ | Line **B**, opens at two external consumers (PS §6.5) |

> **Divergence recorded (§1 of CLAUDE.md — surface the tradeoff, do not pick silently).** The brief for this document asked for "compiler + playground + adapters" at launch. **Adapters cannot be in the launch bundle**: KR2.1 dates them at month 6, SP §6.3 rung 1 costs 1–2 weeks per host on top of a playground that does not exist yet, and announcing one that is not published is precisely the SP §14 violation that costs the proof positioning permanently. The launch bundle is therefore the **Expected + Trust** layers complete; adapters ship in waves, each with its own small announcement and its own matrix column. **The order is: playground → tag → adapter → matrix → the host relationship.**

### 4.3 Pricing posture at launch

| Line | Posture at launch | Opens when | On-site treatment |
| --- | --- | --- | --- |
| **A** — migration / integration services (PS §3A) | **Open day 0**, outbound only | now | A `/services` page exists but is **not in the landing-page CTA ladder** — MSG §5 deliberately leaves Revenue unserved, and a services CTA beside a pre-release compiler reads as a bait. Reached from the launch post and outbound email |
| **G** — anchor-tenant contract (SP §11.3) | Internal, written by end Q1 | now | Never public |
| **B** — shader CI / support SLA (PS §3B) | Not offered, not priced, not teased | two external consumers on a tagged release | Nothing on the site |
| **E** — sponsorship (PS §3E) | A footer link, not a CTA | now | Credibility signal, never runway: PixiJS $118,918.03 lifetime / est. $40,250.02/yr (opencollective.com/pixijs, fetched 2026-09-07) is below one salary |
| **C / D / F** — effects, course, hosted editor | Not mentioned | after the playground shows what people make (PS §6.5) | Nothing |

**No pricing page, no waitlist, no countdown, no "contact sales".** A price list on a `0.1.0` compiler with an unfrozen changelog is the fastest available way to lose the proof positioning.

### 4.4 Channels, ranked (Bullseye — Weinberg & Mares, *Traction* ⚠ from memory)

Ranked by: does the pin's audience already read it · can one maintainer sustain it · does it survive the honesty envelope.

| Ring | Channel (real name) | Serves | Why it ranks here | Honesty constraint |
| --- | --- | --- | --- | --- |
| **Inner 1** | **Show HN** (news.ycombinator.com) | S1·S2·S3·S6·S7 | The only channel that reaches all pins at once and rewards a *runnable* artifact; PS §6.3 puts it first | Title states the artifact, not a superlative. Pre-release stated in the first comment, not hidden |
| **Inner 2** | **Graphics Programming Weekly** (newsletter) | S1·S2·S3·S5 | The single densest concentration of people who feel the tax; carried by PS §6.3 | Submit the methodology post, not the launch hype |
| **Inner 3** | **The three host communities** — MapLibre GitHub issues/Discussions + maplibre.org docs · deck.gl GitHub Discussions + vis.gl · PixiJS GitHub Discussions (an inbound already exists: **#11027**, "how to make the GLSL porting easier", PS §3A) | S1·S2·S3·S5 | Where the pain is stated *in the host's own words*; rung 2 of the ladder runs through here | **Answer a question; never announce.** No "used by", no adapter promised before it is published |
| Middle | **r/webgpu**, **r/GraphicsProgramming** | S2·S6·S7 | Named in PS §6.3; tolerant of technical depth, hostile to marketing | Post the playground link and the CI gates, not the pitch |
| Middle | **WebGPU Discord** | S1·S2·S5·S7 | Where host maintainers actually are (PS §6.3) | Conversation, not broadcast |
| Middle | **JavaScript Weekly**, **Frontend Focus** | S3·S6 | Reach into the Pixi/agency half (PS §6.3) | One measured claim per submission |
| Middle | **Chrome "What's New in WebGPU" ecosystem round-up** | all | Vendor-adjacent credibility; PS §3E/§6.3 names the route | Submit a fact, never a request for endorsement |
| Middle | **Bluesky + X** graphics-programming circles, cross-posted to **Mastodon** ⚠ *instance not named in the corpus; verify before spending* | S3·S4·S7 | Where shader visuals travel; PS §6.3 | One visual per claim; no thread of superlatives |
| Outer | **discourse.threejs.org** | S4 | Reach, not pain (SP §1.3 T1). Ranked low **on purpose** | Post the honest line only: a renderer that already falls back may not need this. **Any "replaces TSL" framing is an SP §14 breach** |
| Outer | **YouTube** (own channel, 60–120 s clips) | S3·S6·S7 | High production cost per minute for a solo owner; clips are re-used from the playground | Screen capture with the backend named on screen |
| Outer | **Conferences: JSNation · JSConf · FOSDEM JS devroom · Web3D** (PS §6.4: two talks in year one), plus **FOSS4G / OSGeo-adjacent venues** ⚠ *from memory, not in the corpus — verify before spending*, which would put the beachhead pitch in front of geospatial engineers directly | S1·S5·S6 | Highest credibility per hour, longest lead time | The talk is the methodology, not the product tour |
| Excluded | **Product Hunt** | — | "Low-value for a compiler; skip it" (PS §6.3) | — |
| Excluded | **Paid ads of any kind** | — | No product to buy; no funnel to pay for | — |

### 4.5 Partner marketing per host (SP §6.3 rungs 1–2 only, except MapLibre per D2)

| Host | Rung 1 (code, solo) | Rung 2 (listing, days + a relationship) | Rung 3–4 | First message |
| --- | --- | --- | --- | --- |
| **MapLibre** | `@typeshade/maplibre` returning a `CustomLayerInterface`, bindings from `reflect()`, one runnable example, one matrix column | PR or request to the docs / ecosystem page | **Committed (SP §13 D2)** — an example the host maintains, then a piece the host needs upstreamed | *"Your layer keeps working when phase 4 lands."* (SP §6.4) |
| **deck.gl / luma.gl** | `@typeshade/deck` emitting the shader-module chunk the host injects, example, matrix column | vis.gl / OpenJS ecosystem listing; process, not a DM | Not committed | Their own docs sentence, quoted back: extensions *"all remain WebGL-only today because they rely on GLSL shader injections"* |
| **PixiJS** | `@typeshade/pixi` emitting the `GlProgram` + `GpuProgram` pair, example, matrix column | Answer **#11027** with a working artifact, not a promise | Not committed | *"`{ gl, gpu }`, from one typed source."* — gated on the adapter existing (STP §5.2) |
| **three.js** | None planned before pin 5 | None | None | Docs line only |
| **Babylon.js** | None in year one (rank 5, SP §6.4) | — | — | — |

### 4.6 Developer-relations assets

| Asset | Serves | Ships | Method note |
| --- | --- | --- | --- |
| **Launch post** (own blog + Show HN + newsletters) | all | T0 | One claim per section, one visual per claim, every number measured (PS §6.3) |
| **Examples gallery** (36 examples, each emitting both targets; 13 fp64) | S1·S3·S6 | T0 | Emitted at build time; CTA `See the examples` |
| **Playground** — write / see / share a URL | all, esp. S7 | T0 | The growth loop (PS §6.1). One URL per sketch is the metric surface for G2 |
| **Benchmark post with methodology (P6)** | S5·S6 | T+6 | **A reproducibility benchmark, not a speed benchmark**: emit determinism (byte-stable goldens), compile pass rate on Tint and on WebGL2, oracle parity — each with its command, conditions and a re-run route. **No runtime-performance claim** is made: none is measured in the corpus, and a SwiftShader number would not support one |
| **Migration guide: raw GLSL ES 3.00 → typed module** | S1·S6 | T+4 | The line-A door opener |
| **Migration guides: coming from TSL (T+7) / from TypeGPU (T+10)** | S4 · S2·S7 | T+7, T+10 | Docs only, never a landing-page claim. One honest line each, no scorecard (**P10**); the TSL guide carries the reader-serving line verbatim |
| **Forward-compatibility contract, published as an RFC** | S1·S5 | T+8 | The SP §6.2 text, opened for critique in the mirror's Discussions — rung-2 seeding that costs no claim |
| **Case study: X-GIS** | S5·S6 | T+11 | The **only** production consumer that may be named until SP §6.5's third-party case study lands |
| **Two conference talks** | S5·S6 | CFPs T+2 → T+8 | PS §6.4 |

### 4.7 The AI-agent channel (SP §13 D4 — `llms.txt` + MCP tool + agent skill)

| Surface | What ships | Evidence for and against | Rule |
| --- | --- | --- | --- |
| **`llms.txt`** at the site root + per-page markdown | T0 | For: cheap, PS §5. Against: **10.13% of 300,000 domains, no major provider confirming production use** as of Q1 2026 (SE Ranking, via SP §13 D4) | Ship it, expect nothing from it alone. It is a footer CTA (MSG §5), not a channel plan |
| **MCP server: compile + validate, returning coded `SD####` diagnostics** | T0–T+2 | MCP is a governed standard under the Linux Foundation (Dec 2025) with **> 10,000 public servers** (SP §1.3 O4). 94% of LLM compilation errors are type-check failures (github.blog 2026-01-08, citing arXiv 2504.09246 + Octoverse 2025) | The round-trip through the **real** compiler is the asset — an agent that can check itself recommends what it can check |
| **Agent skill in public skill registries** | T+2 | A `webgpu-threejs-tsl` skill is **already published** there (PS §5) — the channel is live and a competitor is in it | Ship the skill as authoring guidance, not as a pitch |
| **Context7 listing** | T+2 | PS §5 | — |

## 5. Launch sequence — T−8 weeks → T+12 weeks

Hours are a **proposed budget, judgement not measurement**, and sit **on top of** the ~12 h/month maintenance floor (SP §11.2), which is funded by the anchor tenant and is not marketing time. T0 = the one-day launch bundle (PS §6.3): `0.1.0` on npm, the landing page and the playground on the same day.

| Week | Workstream | Deliverable | h | Depends on | Gate |
| --- | --- | --- | --- | --- | --- |
| **T−8** | Legal | KIPRIS search run; attorney similarity search commissioned (B.1 list); KR 09+42 filing started | 4 | PS App. B.1 | **Blocking**: SP R7 — file before the launch post |
| **T−8** | Product | Playground scope frozen: author pane, both emits, both backends, one URL per sketch | 6 | D7 | — |
| **T−7** | Product | Playground build begins (pre-bundled compiler or esbuild-wasm, PS §6.1) | 12 | zero-dep core | — |
| **T−6** | Product | Playground build continues; share-URL encoding decided (fragment-only, no server) | 12 | — | Share URL must work with JS analytics blocked |
| **T−6** | Site | `04-ia-wireframe.md` + `05-design-system.md` land; copy deck frozen against §3 | 8 | MSG §6, §3.3 | Headline of record fixed |
| **T−5** | Product | Playground on both backends, verified headlessly (WebGPU **and** WebGL2) | 10 | BR tech constraints | Both backends asserted in the harness, no silent fallback |
| **T−5** | Trust | `GOVERNANCE.md` (BF-1 + 90-day switch) and `SECURITY.md` drafted | 4 | D3 | — |
| **T−4** | Product | `api-surface.test.ts` freeze reviewed; `0.1.0` release notes drafted | 6 | KR1.1 | No third `⚠ BREAKING` after the tag (SP R8) |
| **T−4** | Agent | `llms.txt`, per-page markdown, MCP compile/validate tool scaffolded | 8 | D4 | Round-trips through the real compiler |
| **T−3** | Site | Page built; every number rendered at build time (**P6**) | 12 | design system | **Honesty graft (V1/V2):** the 878,943-byte figure is **off the page** — it is measured on the X-GIS tree and cannot be computed at build time from the pinned mirror. It stays in outbound and strategy material only |
| **T−3** | Content | Launch post written; every claim traced; forbidden-word pass run | 6 | copy deck | — |
| **T−2** | QA | `06-qa.md`: responsive 390/768/1440, a11y names, contrast, console clean, both backends | 10 | site built | Zero horizontal overflow; no console errors |
| **T−2** | Distribution | Five-stranger test on the headline pair; fallback decision recorded | 3 | §3 | If the job headline reads as a host-upgrade promise → switch to the (b) fallback |
| **T−1** | Distribution | Newsletter submissions queued; Show HN title + first comment drafted; host-community *answers* prepared (not announcements) | 6 | launch post | Trademark filing receipt in hand — **else slip T0** |
| **T−1** | QA | Dry run: publish to a staging URL, re-read every page screenshot at full resolution | 6 | — | Owner sign-off |
| **T0** | **Launch** | `0.1.0` on npm with provenance · site live · playground live · governance published · launch post · Show HN | 8 | all above | All four artifacts live **before** the first post goes out |
| **T+1** | Distribution | Newsletters land; answer every Show HN and Reddit thread within the day | 8 | T0 | Reply, never defend |
| **T+2** | Agent | MCP tool + agent skill + Context7 listing published | 6 | T0 | — |
| **T+2** | Content | Playground gallery drop; conference CFPs submitted | 6 | T0 | — |
| **T+3** | Product | `@typeshade/maplibre` begins (rung 1: adapter + example + matrix column) | 14 | 0.1.0 tag | Bindings from `reflect()`, never hand-written |
| **T+4** | Content | Migration guide 1 (raw GLSL → typed module); line-A outbound begins | 8 | — | KR3.2: ≥ 2 conversations by month 6 |
| **T+5** | Product | Adapter continues; matrix generator built (CI-only, stale cell fails the build) | 14 | — | SP R12 |
| **T+6** | Content | Methodology / reproducibility benchmark post → Graphics Programming Weekly | 8 | matrix generator | No runtime-performance claim |
| **T+7** | Content | TSL migration guide (docs only) | 5 | — | Honest line, no comparison table |
| **T+8** | Product | **`@typeshade/maplibre` published** + runnable example; forward-compat contract RFC opened | 12 | matrix column green | First time a host may be named beside a **matrix cell**, never beside "used by" |
| **T+9** | Partner | Rung 2: request/PR for the MapLibre docs or ecosystem listing | 6 | adapter published | KR2.3 by month 9 |
| **T+10** | Product | **Matrix page published**, green in CI | 10 | adapter + generator | **KR2.2 (month 4)** — the category-defining artifact |
| **T+10** | Content | TypeGPU migration guide (docs only) | 4 | — | — |
| **T+11** | Content | X-GIS case study | 6 | — | Only nameable production consumer |
| **T+12** | Review | Q-gate: sketches/month, host listing, external repos; kill/pivot decision recorded | 4 | §7 | SP §12.1 Q2 gate |

**Pre-launch total ≈ 113 h over 8 weeks (~14 h/week). Post-launch T+1→T+12 ≈ 119 h (~10 h/week).**
**Blocking dependencies, in order:** trademark filing → playground on both backends → `0.1.0` tag + governance → site + launch post → adapter → matrix. Any slip in the first three slips T0; nothing after T0 may be announced before it exists.

## 6. Content calendar — 12 weeks post-launch

One primary artifact per week (a solo owner cannot sustain two). Pillars: **P-1** write it once · **P-2** proven to agree · **P-3** fits what you have (MSG §2). Every title passes the forbidden-word list.

| Wk | Format | Primary channel | Working title | Pillar | CTA |
| --- | --- | --- | --- | --- | --- |
| 1 | Launch post | Blog → Show HN → JS Weekly / Frontend Focus | *One typed source, two shader languages, and the check that they agree* | P-1 + P-2 | `Get started` |
| 2 | Gallery drop | Playground → Bluesky / X | *Twelve sketches, each running on both backends* | P-1 | `See the examples` |
| 3 | Methodology post | Blog → r/GraphicsProgramming | *How the CPU f64 oracle is built — and what it cannot catch* | P-2 | `Read the CI gates` |
| 4 | Migration guide | Docs → r/webgpu | *From raw GLSL ES 3.00 to a typed module* | P-1 | `Get started` |
| 5 | 90-second clip | YouTube → Bluesky / X | *Zoom past what f32 holds* | P-3 | `Open the deep-zoom example` |
| 6 | Benchmark + methodology | Blog → **Graphics Programming Weekly** | *A benchmark you can re-run: every emitted variant, on Tint and on WebGL2* | P-2 | `Read the CI gates` |
| 7 | Migration guide | Docs → discourse.threejs.org | *Coming from TSL: what transfers, and when you do not need this* | P-3 | `See the examples` |
| 8 | RFC | Mirror Discussions → MapLibre + deck.gl issues | *What a host adapter must guarantee: the forward-compatibility contract* | P-2 | Comment on the RFC |
| 9 | Agent post | Blog → MCP registries → Context7 | *Compiling a shader from an MCP tool, and reading the `SD####` back* | P-2 | `llms.txt` |
| 10 | Migration guide | Docs → r/webgpu | *Coming from TypeGPU* | P-3 | `See the examples` |
| 11 | Case study | Blog → WebGPU Discord | *A globe engine on two backends, from one shader source* | P-3 | `Get started` |
| 12 | Release + roadmap | Blog → newsletter | *0.2.0, the release train, and what the matrix will say next* | P-2 | `Read the CI gates` |

**Cadence rules.** Monthly release post regardless of news (PS §6.4; `bun run changelog` generates it). A "shader of the week" from playground submissions starts only once submissions exist — an empty feature is worse than none. **Never** publish a post whose claim outruns a shipped artifact.

## 7. Funnel and metrics (AARRR + OKR alignment)

**Framework:** Pirate metrics (McClure ⚠ from memory), instrumented against what a **static site on GitHub Pages behind Cloudflare** can actually observe.

| Stage | Definition here | Instrument (what genuinely exists) | Target | Source |
| --- | --- | --- | --- | --- |
| **Acquisition** | A first session on typeshade.dev, or a first mirror visit | **Cloudflare Web Analytics** (free, cookieless; both zones are on Cloudflare — PS App. B.4) for pageviews + referrers; **GitHub traffic API** (14-day views / clones / referrers); newsletter and HN referrer strings | No target — a vanity number by itself | PS App. B.4 |
| **Activation** | A person **creates and shares** a playground sketch, or opens `AUTHORING.md` | Share produces a URL; count referred hits to the share path in CF analytics + GitHub traffic on `AUTHORING.md`. ⚠ Custom client events are **not** available on CF Web Analytics' free tier — verify before designing a metric on them | **≥ 20 non-owner sketches / month by month 6** | SP §12 KR1.2, §6.5 |
| **Retention** | Someone comes back and depends on it | Non-owner issues on the mirror; external repos importing `typeshade` (GitHub code search); release-cadence adherence | ≥ 5 non-owner issues / month by month 9; ≥ 10 external repos by month 9; 0 missed releases Q2–Q4 | SP §6.5, KR1.4 |
| **Referral** | Someone else says it, in a place we do not control | Host issues/PRs **not authored by the owner** mentioning TypeShade; host docs/ecosystem listing; newsletter pickups | ≥ 1 listing by month 9; ≥ 3 non-owner host mentions by month 12; ≥ 1 third-party production case study by month 12 | SP §12 KR2.3/KR2.4, §6.5 |
| **Revenue** | A line-A conversation, then an engagement | Inbound email; outbound log | ≥ 2 outbound conversations by month 6; ≥ 1 paid engagement **or** a funded fellowship by month 12 | SP §12 KR3.2/KR3.3 |
| **Embedding (the extra stage this product needs)** | The matrix is public and green; adapter installs are real | CI matrix status; `api.npmjs.org` adapter installs (as an *embedding* signal only) | Matrix published month 4; ≥ 100 adapter installs/wk by month 12 | SP §12 KR2.2, §6.5 |

### 7.1 Measurable but banned

| Quantity | Measurable? | Ruling |
| --- | --- | --- |
| npm downloads of `typeshade` | Yes | **Banned as health** (SP §6.5): `glslify` last published 2020-09-02 → 565,493/wk; `regl` 2024-11-12 → 776,433/wk. Downloads measure installed history, not life |
| GitHub stars | Yes | **Banned as a public claim** (SP §14). Internal use only, as one chasm signal among several |
| Doc traffic as a funnel | Yes | **Never fund on it** (SP §1.1, PS §5): Tailwind docs traffic −40% since early 2023, revenue −80%, 75% of engineering laid off 2026-01-06 (devclass.com 2026-01-08) |
| The 878,943-byte figure | Measured on the X-GIS tree | Usable in outbound, strategy and the case study; **not on the landing page** — it cannot be computed at build time from the pinned mirror, which **P6** requires (V1) |

### 7.2 Kill / pivot criteria (SP §12.1, restated as marketing decisions)

| Quarter | Gate | Marketing action if missed |
| --- | --- | --- |
| Q1 | `0.1.0` tagged, playground live, governance published, trademark filed | Trademark blocked in KR 09/42 → **re-name before launch** from PS App. A's runner-ups. Nothing publishes under a contested name |
| Q2 | ≥ 20 external sketches/month **or** ≥ 1 host docs listing | 0 sketches **and** 0 adapter installs after 3 months → **stop marketing**; the artifact is not shareable. Fix the whole product (SP §5.3), do not buy more distribution |
| Q3 | Two external consumers on a tagged release | No external consumer by month 9 → drop C/D/F permanently; hold anchor tenant + embedding; keep pushing rungs 3–4 on MapLibre only |
| Q4 | Line A covers the floor's opportunity cost | 0 line-A enquiries in 12 months → services is not a business here; pursue H (fellowship) / I (absorption-in-place), not C/F |
| **Any time** | SP §8 **S2 signpost** fires (a top-5 web engine ships WebGPU-only defaults) | Execute the pre-committed 2031 edit **immediately** — one clause of one line (SP §9 R5) |

## 8. Budget

### 8.1 Money (12 months)

| Item | Cost | Status | Buy or do |
| --- | --- | --- | --- |
| `typeshade.dev` + `typeshade.com` | Registered 2026-09-07 via Gabia, expire 2027-09-07 — **sunk**; renewal cost not recorded in the corpus | done | Do (renew) |
| Cloudflare (2 zones, Free plan) + Cloudflare Web Analytics | **$0** | done (both zones ACTIVE 2026-09-07) | Do. Paid analytics (Plausible / Fathom class) is **not bought** — CF Web Analytics + the GitHub traffic API cover §7 |
| GitHub Pages, GitHub org, npm org | **$0** | done | Do |
| **Attorney similarity search + KR filing, classes 09 + 42**; Madrid extension to US / EU / JP within the 6-month priority window | **Quote required — no figure in the corpus; do not estimate** | **not started — blocking T0** | **BUY.** The one professional service on the list (PS §9, SP §11.5 RACI = E) |
| Merchant of record (Polar / Paddle / Lemon Squeezy) | 5% + $0.50 per transaction (Polar, since 2026-05) | **not needed at launch** — nothing is for sale | Defer to line B/C |
| Conference travel (2 talks, PS §6.4) | Not in the corpus; depends on acceptance and location | CFPs at T+2 | Decide on acceptance |
| Design, video, copy contractors | **$0** | — | Do — the voice is the product; outsourcing it is how a proof brand starts over-claiming |

**Read:** cash out of pocket for the launch is effectively the trademark work. Everything else is time.

### 8.2 Hours per month (proposed budget, judgement)

| Phase | Marketing + whole-product h/month | Maintenance floor h/month (SP §11.2, **separate**) | Total |
| --- | --- | --- | --- |
| T−8 → T0 (2 months) | ≈ 57 | 12 | ≈ 69 |
| T+1 → T+3 | ≈ 40 | 12 | ≈ 52 |
| T+4 → T+12 (per month) | ≈ 36 | 12 | ≈ 48 |
| Steady state after T+12 | ≈ 16 (one post + one release + community replies) | 12 | ≈ 28 |

**If the owner cannot fund ~48 h/month, cut in this order:** YouTube clips → conference CFPs → the second and third migration guides → the deck.gl adapter. **Never cut:** the playground, the matrix, governance, or the monthly release — those are the whole product and the trust layer, and cutting them turns the marketing into claims with nothing behind them.

## 9. Marketing risks (L / I on 1–5, score = L×I)

| ID | Risk | L | I | Score | Trigger | Mitigation |
| --- | --- | --- | --- | --- | --- | --- |
| **M1** | **Over-claiming** — one line beyond the envelope ("production-ready", "used by MapLibre", an unshipped adapter, a star count) | 3 | 5 | **15** | Any draft containing an SP §14 item | A **pre-publication checklist run on every artifact** (post, README, slide, email, badge): each claim → its source line; each number → its unit and re-run route (**P6**); the forbidden-word list applied. Nothing publishes without it. Being caught once costs the positioning permanently |
| **M2** | **Launching before the playground** — the shareable artifact is the whole flywheel | 3 | 5 | **15** | T−2 QA with no working share URL on both backends | **Slip T0.** PS §6.1 and SP §13 D7 both make the playground the launch centrepiece; a launch without it spends the one Show HN slot on a page nobody can use |
| **M3** | **A host announces its own shader DSL or completes the gap** (`@typegpu/gl` gains compute or bind groups; Slang ships JS bindings; a host builds an in-house authoring layer) | 3 | 4 | **12** | The announcement itself (SP §9 R4, §8 S3) | Do not fight on syntax. Re-lead on the proof layer + the complete GLSL ES 3.00 backend + fp64 + shader CI; publish a factual, non-defensive note the same week; **never** a comparison table (**P10**) |
| **M4** | **The launch reads as anti-TSL** and the largest community answers back | 3 | 3 | 9 | Any thread where "replaces TSL" is attributed to us | The three.js line is *reader-serving*: a renderer that already falls back may not need this. It is in the docs before launch so it can be quoted, not improvised |
| **M5** | **Trademark not filed before the launch post** | 2 | 4 | 8 | T−1 with no filing receipt | T0 slips. The name is the one non-copyable asset (PS §4); PS App. A holds the runner-ups |
| **M6** | **The dual-target headline outlives its thesis** | 3 | 4 | **12** | SP §8 S2 signpost fires | Already mitigated structurally: D1(b) put dual-target in the *differentiation* slot, so the 2031 change is one clause, not a repositioning (§3, V2) |
| **M7** | **Marketing outruns the whole product** — distribution spend against 0 external sketches | 3 | 3 | 9 | SP §12.1 Q2 gate missed | Stop marketing; fix the whole product (SP §5.3). This is a written rule, not a judgement call, so it survives the sunk cost |
| **M8** | **The matrix rots and the badge lies** — the ingredient mark points at a stale cell | 2 | 4 | 8 | A matrix cell not re-run in 30 days (SP R12) | CI-generated only; a stale cell fails the build; the badge's host claim is withdrawn in the same release (§3.4) |
| **M9** | **A funnel built on doc traffic** | 3 | 2 | 6 | Any plan whose revenue depends on page views | Sell what an agent cannot substitute — lines A and B (PS §5); measure Referral and Embedding, not traffic |

## 10. Sources

**In-repo (read in full for this document):** `docs/plans/2026-09-07-typeshade-strategic-plan.md` **SP** §0, §1.1–§1.4, §2.1–§2.3, §3, §4.1–§4.2, §5.1–§5.3, §6.1–§6.5, §7, §8, §9, §10, §11.2–§11.7, §12, §12.1, §13 (D1–D7), §14, §15 · `docs/plans/2026-09-07-shader-dsl-standalone-product-strategy.md` **PS** §0–§6.5, §9, §10, App. A, App. B.1–B.4 · `docs/design/00-brief.md` · `docs/design/02-messaging.md` · `docs/design/01-research.md` Part D (**P1–P10**) · the STP artifact and the two positioning verdicts (**V1**, **V2**) supplied with this brief. **Absent, verified by `ls` 2026-09-07 (re-check before acting):** `docs/plans/2026-09-07-typeshade-ecosystem-embedding.md` · `docs/design/04-ia-wireframe.md`.

**Public sources, carried by SP §15 / PS Sources, fetched 2026-09-07:** khronos.org/blog/shader-ecosystem-survey-results-2026 (> 400 respondents, fielded 2026-06-16→07-10; 64% / ~10% / 53%; GLSL 60 · HLSL 41 · SPIR-V 39 · Slang 34; WGSL 14.9% n=60 via the gamedev.net summary) · maplibre.org/roadmap/maplibre-gl-js/graphics-modernization/ · maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/ · deck.gl/docs/developer-guide/webgpu · openjsf.org/blog/deckgl-v9 · vis.gl · pixijs.com/8.x/guides/migrations/v8 · PixiJS GitHub discussion #11027 · opencollective.com/pixijs ($118,918.03 lifetime, est. $40,250.02/yr, 168 contributors) · threejs.org/manual/en/webgpurenderer.html · caniuse.com/webgpu (87.35%) · github.com/gpuweb/gpuweb/wiki/Implementation-Status · docs.swmansion.com/TypeGPU/ecosystem/typegpu-gl/ · github.blog "Why AI is pushing developers toward typed languages" 2026-01-08 (citing arXiv 2504.09246, Octoverse 2025) · blog.modelcontextprotocol.io + MCP ecosystem statistics (> 10,000 public servers) · SE Ranking `llms.txt` adoption (10.13% of 300,000 domains) · devclass.com 2026-01-08 (Tailwind: docs traffic −40%, revenue −80%, 75% of engineering laid off 2026-01-06) · zod.dev/blog/clerk-fellowship 2024-06-11.

**Measured against public registries 2026-09-07 (SP §15):** `three` 14,025,392/wk · `maplibre-gl` 4,366,094 · `pixi.js` 920,303 · `regl` 776,433 · `glslify` 565,493 · `@babylonjs/core` 272,819 · `deck.gl` 202,573 · `typegpu` 142,702.

**Measured on the X-GIS tree 2026-09-07 (SP §3, §15):** 58 DSL modules · 14,063 non-test LOC · 144 importing files · 878,943 emitted bytes in 6 baked artifacts · 146 test files · 0 deps / 0 peerDeps / 0 devDeps. **The byte figure is outbound-only** — see §7.1.

**Owned-asset state, 2026-09-07 (PS App. B.2 / B.4):** `typeshade.dev` + `typeshade.com` registered via Gabia (expire 2027-09-07); both Cloudflare zones ACTIVE, `.com` → `.dev` 301 verified; npm `typeshade@0.0.0` and `@typeshade/core@0.0.0` published as placeholders; GitHub org `typeshade` created; trademark KR/US/EM/WO 0 hits, one identical JP mark in classes 14 + 25.

**⚠ From memory — not fetched, verify before spending or citing publicly:** Moore, *Crossing the Chasm* (1991) · Ramadan, Peterson, Lochhead & Maney, *Play Bigger* (2016) · Mark & Pearson, *The Hero and the Outlaw* (2001) · Kotler & Pfoertsch, *Ingredient Branding* (2010) · Weinberg & Mares, *Traction* / Bullseye (2014) · McClure's AARRR pirate metrics · Kotler's STP · Christensen / Ulwick on JTBD · NN/g's four tone-of-voice dimensions (position table carried by MSG §7) · a Mastodon instance for graphics programming · FOSS4G / an OSGeo-adjacent venue for the MapLibre community · a vis.gl / OpenVisualization Slack · a PixiJS Discord.
