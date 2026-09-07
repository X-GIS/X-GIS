# Shader DSL — standalone product line and monetization strategy (2026-09-07)

**Status:** strategy (owner asked, 2026-09-07: spin the DSL out of X-GIS as its own product
line, release it, and find a way for it to earn money; benchmark the fame/landing/promotion
side against PixiJS and Tailwind CSS) · **Scope:** `shader-dsl/`, its site section, and the
commercial layer AROUND them — not the language roadmap, which
`2026-09-01-shader-dsl-improvement-direction.md` owns · **Horizon:** 5+ years ·
**Discipline:** every number below carries its source (a fetched page, an issue, or a
measurement on this tree); a number with no citation is not in this document. Market
figures were fetched on 2026-09-07 and go stale — re-fetch before quoting them in a pitch.

This is the durable record (CLAUDE.md §9.5). It is not a work order: each item in §8
becomes its own issue before it starts. Decisions the owner already made are stated as
facts in §1 and are not re-opened here.

---

## 0. Where it stands — measured on this tree, not remembered

| Quantity                     | Value                                                                                                                                                                                                                                                                                            | Source                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Package                      | `@xgis/shader-dsl` `0.0.1`, MIT, zero runtime dependencies, ESM, `exports` → `./src/*.ts` (ships TypeScript source)                                                                                                                                                                              | `shader-dsl/package.json`                                     |
| Size                         | ~27.7k non-test LOC under `shader-dsl/src`; 135 test files; 36 runnable examples (19 generic effects, 13 fp64, 3 cartographic, 1 compute)                                                                                                                                                        | `wc -l`, `find`, `shader-dsl/README.md`                       |
| Distribution                 | **Not on npm.** A read-only git-subtree mirror is the designed channel; `.github/workflows/mirror-shader-dsl.yml` exists and exits green because the mirror repository has not been created yet                                                                                                  | `shader-dsl/README.md`, the workflow's preflight              |
| Release mechanics            | None — no tag, no version policy, no publish workflow (#1681 increment C is open; A and B landed)                                                                                                                                                                                                | #1681, direction doc §0                                       |
| API stability                | Not frozen: two `BREAKING` entries in the 2026-09 changelog alone (#2481, #2467); `api-surface.test.ts` is the freeze mechanism once a tag exists                                                                                                                                                | `shader-dsl/CHANGELOG.md`                                     |
| Audience                     | `X-GIS/X-GIS` is public: **3 stars, 0 forks**, 4,274 commits                                                                                                                                                                                                                                     | github.com/X-GIS/X-GIS, fetched 2026-09-07                    |
| Public docs                  | `x-gis.github.io/X-GIS/shader-dsl/` — Overview · Getting started · Concepts · Compute on WebGL2 · Shipping · Gallery · API reference · df64 probe. No install instructions (there is nothing to install). Examples render build-time strings; the DSL does not run in the browser                | fetched 2026-09-07; `site/src/layouts/ShaderDsl.astro`        |
| Consumers                    | In-repo: `map/src/shaders/dsl` (56 files / 13.7k LOC), `compiler/`, `rhi-webgpu`. External: **dc4i.js** — 41 portable entries, 4 `variantFamily` families, 0 raw GLSL files — pulled by a source-copying script                                                                                  | direction doc §0; #1806; #1681                                |
| Distinctive assets           | CPU f64 oracle; emulated fp64 with unchanged authoring syntax; `semanticDiff`; the declared portable compute tier (runs on WebGL2); host-boundary APIs (`hostBlock`, `externVar`, `variantFamily`); the fail-closed capability profile; production emit plugins (`inline` / `mangle` / `minify`) | direction doc §1                                              |
| Gaps a general audience hits | No `vecN<bool>` / `!` / `~`; square matrices only (`mat4x4fT` plus f64 mat2/mat3); textures `2d` / `2d-array` / `2d-ms` only (no cube / 3d / depth / storage); no `var<workgroup>`, atomics or barriers; bundler-only consumption in practice (`exports → dist` still undecided, #1686 step 5)   | direction doc D3, D7.2; `shader-dsl/src/core/ir/types.ts:208` |

Two things follow. The engineering asset is real and unusual — the verification story (Tint
compile gates, byte-stable goldens, an oracle that proves two backends agree) is something no
comparable library advertises. And the AUDIENCE is zero: every fame mechanism in §6 starts
from nothing, which is why §3 ranks the revenue lines by how much audience each needs first.

---

## 1. Settled decisions that shape the product (facts, per §9.5)

| Decision                                                                                                                                                | Where                                     | Consequence for this document                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publish **from the monorepo**; a separate repository was rejected because the real-driver gates live in `playground/e2e` and are driven by X-GIS scenes | #1681, direction doc §5                   | "Independent product line" means an independent **brand, package name, docs site, GitHub org and release cadence** — not an independent source tree. The mirror is the public face; PRs land in X-GIS. This is exactly the Symfony model: every Symfony component is a read-only subtree split whose README redirects contributions to the monorepo |
| No JS-syntax transpiler / bundler plugin (TypeGPU's approach)                                                                                           | direction doc §5                          | Positioning must not promise "write plain JS/GLSL and we translate it"; the pitch is typed authoring plus proof                                                                                                                                                                                                                                     |
| No third hand-written backend (MSL / HLSL / SPIR-V) — reach native through naga / Tint                                                                  | direction doc §5                          | The multi-target story on the landing page is "WGSL is canonical; naga/Tint take it everywhere", not a fourth logo                                                                                                                                                                                                                                  |
| Tag `0.1.0` after Wave 1, once D4.1's breaking type changes are in                                                                                      | direction doc §7, decision 6 (2026-09-02) | The marketing clock and the API-freeze clock are different clocks — see §10 Q4                                                                                                                                                                                                                                                                      |
| Compute tier is declared, never inferred; no house binary formats                                                                                       | #1903; CLAUDE.md §12                      | Both are selling points ("fail-closed, honest") and both constrain any Pro/hosted layer                                                                                                                                                                                                                                                             |

---

## 2. The market, as measured 2026-09-07

The owner named Tailwind CSS and PixiJS as the models. Both were fetched; the first one has
just demonstrated the failure mode of the model it invented.

| Project (model)                                                                                | Measured                                                                                                                                                                                                                                                                                                                                                                          | Lesson for a shader compiler                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tailwind CSS** — MIT core + Tailwind Plus (one-time ~$299 components/templates)              | Tailwind UI passed **$2M/yr by 2020** (Wathan). **2026-01:** revenue down **~80%**, docs traffic down **40% in two years**, **75% of engineering laid off**; Wathan's stated cause: AI tools and agents answer the questions developers used to bring to the docs, where the paid products were discovered. Vercel and Google AI Studio stepped in as sponsors                    | The "free docs are the funnel to paid templates" model is the one that just broke. Whatever is sold must be discoverable without doc traffic, and must be something an agent cannot generate |
| **PixiJS** — MIT, Open Collective + bug bounties                                               | Lifetime raised **$118.9k**; estimated annual budget **$40.3k**; tiers $2 → $2,000/mo; largest single backer an anonymous $47.5k                                                                                                                                                                                                                                                  | One of the most-used web engines runs on ~$40k/yr of donations. Sponsorship is a supplement, never the plan                                                                                  |
| **three.js + Three.js Journey** — sponsored library; the money is the course                   | Course **$95**, 91 h of video, Discord **28,665+** members                                                                                                                                                                                                                                                                                                                        | Shader education is a proven product; the library markets the course and the course markets the library                                                                                      |
| **Motion** (ex Framer Motion) — MIT lib + **Motion+**                                          | Independent since 2024-11; Motion+ **£299 one-time** (personal) / per-seat annual (business): 430+ examples, premium components, a visual editor, an **AI kit**, private Discord/repo; "2,000+ indie devs"                                                                                                                                                                        | A solo maintainer's one-time "Plus" tier is alive in 2026, and it survived the Tailwind shock by adding agent-facing content                                                                 |
| **Aceternity UI** — free components + one-time Pro (templates/blocks incl. shader backgrounds) | Self-reported "120,000+ users"                                                                                                                                                                                                                                                                                                                                                    | Shader EFFECTS for websites are an existing purchase category for frontend developers                                                                                                        |
| **Unicorn Studio** — no-code WebGL SaaS for designers                                          | Free (10 scenes, watermark, no commercial use) / **$14/mo annual, $20/mo monthly**; 70 effects                                                                                                                                                                                                                                                                                    | Designers pay monthly for shader effects they do not have to write                                                                                                                           |
| **Paper Shaders** (paper.design) — Apache-2.0 shader components, open-sourced 2026-07          | 30+ effects, `@paper-design/shaders` + `-react`, zero dependencies; the paid product is the Paper visual editor                                                                                                                                                                                                                                                                   | The library is the funnel to a TOOL, not to templates                                                                                                                                        |
| **Rive** — open-source runtimes + paid editor                                                  | Free / $9 / $32 / $120 per month                                                                                                                                                                                                                                                                                                                                                  | Same shape, larger scale                                                                                                                                                                     |
| **GSAP** — dual license (Club GreenSock plugins)                                               | Acquired by Webflow 2024-10; made 100% free 2025-04                                                                                                                                                                                                                                                                                                                               | The paid-plugin model's end states are acquisition or free                                                                                                                                   |
| **Material for MkDocs Insiders** — sponsorware ($15 / $50 per month)                           | Discontinued 2025-11-11; everything free                                                                                                                                                                                                                                                                                                                                          | Sponsorware has a shelf life                                                                                                                                                                 |
| **Caleb Porzio** — sponsorware + screencasts on GitHub Sponsors                                | $100k/yr within months; $1M cumulative                                                                                                                                                                                                                                                                                                                                            | It worked on top of an EXISTING Laravel audience; it is not a cold-start model                                                                                                               |
| **TypeGPU** (Software Mansion) — consultancy-funded; the closest competitor                    | `typegpu` 0.12.x on npm; `@typegpu/gl` is an **experimental** WebGL2 backend for a subset (vertex/fragment, uniforms, some 2D textures — no compute, storage or bind groups); WESL interop shipped                                                                                                                                                                                | OSS as lead generation for services; a corporate team behind it. Do not compete on syntax (§1); compete on the complete GLSL backend and on proof                                            |
| **three.js TSL**, **p5.strands**, **WESL**, **Slang**                                          | TSL: WGSL + GLSL, but compiled by three's own renderer. p5.strands: JS → GLSL inside p5.js 2.x. WESL: community WGSL superset with `import`, conditional compilation, npm/cargo shader libraries. Slang: Khronos-hosted multi-target compiler                                                                                                                                     | The free incumbents. The DSL's room is "engine-agnostic + both backends + proof"; WESL is a module standard to interoperate with (direction doc D7.4), not a rival                           |
| **Grants / platforms**                                                                         | NLnet NGI Zero funds WebGPU work (WgMath received an NGI Zero Core grant). GitHub Sponsors supports maintainers in South Korea (Stripe payouts, after a community fix). Merchant-of-record platforms: Polar (5% + $0.50 since 2026-05), Lemon Squeezy (Stripe-owned since 2024), Paddle (same rate, volume discounts) — each is the legal seller and handles global VAT/sales tax | Zero-cost to set up on day one; none of it is payroll                                                                                                                                        |

---

## 3. What is actually sellable here — ranked

Ranked by fit with the assets in §0, by how much audience each line needs before it earns
anything, and by whether an AI agent can substitute for it (the Tailwind lesson). Each line
names the precedent it copies.

### A — Migration and integration services (B2B; opens on day 0)

The one line that needs no audience, because the pain is concrete and already measured on
the other side:

- **PixiJS v8** requires a GLSL program AND a WGSL program per shader, or the shader does
  not run on the omitted renderer (v8 migration guide; discussion #11027 asks how to make
  the GLSL porting easier).
- **MapLibre GL JS** is building a WebGPU backend beside its WebGL2 renderer ("Graphics
  Modernization" roadmap); v6.0.0 (2026-07-22) made WebGL2 mandatory. Every shader in that
  effort is authored twice or generated once.
- deck.gl / luma.gl, CesiumJS, Phaser, and any studio with a WebGL codebase looking at
  WebGPU carry the same twin-shader tax.

The offer: "one typed source, both backends, and a CPU oracle that proves they agree" —
with X-GIS (56 shader modules on both backends) and dc4i.js (41 entries, 0 raw GLSL) as the
evidence. Precedent: Software Mansion, whose TypeGPU exists to bring in exactly this work.
Risk: time-for-money does not compound. It funds everything below.

### B — Pro toolchain: verification and shipping as a product (B2B; needs `0.1.0`)

Sell the layer X-GIS built for itself and nobody else advertises:

- a **shader CI** — compile both targets on a real WGSL validator (Tint / naga) and a GLSL ES
  validator on every PR, byte-golden diffs, `semanticDiff` reports as PR comments (direction
  doc D6.2 is the same work, done once for X-GIS and once for customers);
- **production emit** beyond the free `inline` / `mangle` / `minify` — a license-keyed
  anti-lift tier and a `decodeShaderLog` service for driver logs;
- **support contracts** with response times, the thing a company buying a compiler asks
  for first.

Keep the core MIT. `mangle` and `minify` alone are not sellable (free alternatives exist);
the proof workflow is. Precondition: a frozen public surface (`api-surface.test.ts` plus a
tag) and at least two external consumers, so a paying customer is not the API's first test.

### C — Effects Pro (the Tailwind Plus / Motion+ / Aceternity shape; needs an audience)

A one-time-purchase catalog of production-ready effects authored in the DSL — backgrounds,
image filters, transitions, map and geo effects — shipped for React / Vue / Svelte / vanilla
and for three.js / PixiJS hosts, on both backends. The 36 examples (plasma, voronoi, fBm
clouds, raymarching, ocean, metaballs, the fp64 deep zooms) are the seed catalog. Tailwind
sold into an existing following; Aceternity reports 120k users; Motion+ reports 2,000+
buyers. Cold, this line earns nothing — and it is the exact funnel AI just broke for
Tailwind, so its storefront must not depend on doc traffic (§5).

### D — Education (Three.js Journey / Book of Shaders shape; solo-creator fit)

"Shaders in TypeScript" as a course or interactive book: the fp64 deep-zoom fractals, the
compute-on-WebGL2 tier and the oracle-parity chapters are content nobody else can write.
Sells at $50–$100 per seat (Three.js Journey: $95); the marketing and the product are the
same artifact. Precondition: the DSL running in the browser (§6.1) — a course whose
exercises need `bun run build` does not sell.

### E — Sponsorship and grants (day 0; never payroll)

GitHub Sponsors (Korea is supported), Open Collective, an NLnet NGI Zero application (WebGPU
work is in scope; eligibility to confirm), and outreach to the Chrome WebGPU team, whose
"What's New in WebGPU" posts list ecosystem libraries. Expect PixiJS-scale money
(~$40k/yr) only at PixiJS-scale adoption, and near zero in year one.

### F — Hosted editor / SaaS (Unicorn / Paper / Rive shape; not year one)

A code-or-node editor on top of the DSL for designers at $10–20/month has the highest
ceiling and the highest cost, and competes with funded companies already in the market.
Revisit only if C sells and the playground (§6.1) shows designers, not just developers,
making things.

### Explicitly NOT — with the reason, so it is not re-proposed

| Not doing                                          | Why                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Dual-licensing the core (GPL / commercial)         | Kills adoption against free TSL / TypeGPU / WESL; GSAP shows the end state of paid-core models (acquired, then free)     |
| Source-available (BSL / FSL) for a library         | Same adoption cost, with none of the SaaS-defence benefit those licences were written for                                |
| A Unity-style asset marketplace for web shaders    | No such marketplace exists at scale to sell into; building one is line F under another name                              |
| Leading with C (templates) or E (sponsorship)      | Both need an audience of thousands first (§2); the audience is 3 stars                                                   |
| A separate source repository for the DSL           | Settled in #1681 (§1). The mirror is the public face                                                                     |
| Publishing the product under the `@xgis` npm scope | The product needs its own name (§4); `@xgis/shader-dsl` stays as an alias for existing consumers (dc4i.js) for one major |

---

## 4. Positioning

**The sentence:** _the engine-agnostic shader compiler for TypeScript — one typed source
emits WGSL and GLSL ES 3.00 that are proven to agree._

**The three proofs behind it,** each already measured on this tree rather than promised:
the CPU oracle (no comparable library has one), real-compiler gates (every emitted variant
compiles on Tint and WebGL2 in CI; goldens are byte-stable), and emulated fp64 with
unchanged syntax (the deep-zoom demos). Plus zero dependencies and reflection that removes
hand-derived std140 offsets.

**Against each incumbent, in one line each:**

- three.js TSL — not tied to a renderer: the same module drives a raw WebGPU app, a Pixi
  host, a MapLibre custom layer.
- TypeGPU — a complete GLSL ES 3.00 backend (std140 UBO, MRT, storage → data-texture
  lowering, a compute tier that runs on WebGL2) against their experimental subset; and the
  proof story. Do not fight on authoring syntax — that question is settled (§1).
- WESL — complementary. Emitting WESL-compatible modules (direction doc D7.4) puts the DSL
  INSIDE the emerging WGSL library ecosystem instead of beside it.
- Hand-written WGSL + GLSL — the twin-shader tax, quoted from the Pixi migration guide.

**Naming.** "ShaderDSL" is descriptive: weak as a trademark and unsearchable. The product
needs a coined name, checked in this order: npm unscoped name free (on 2026-09-07:
`shader-dsl`, `shaderdsl`, `wgsl-dsl`, `shaderlang`, `gpulang` return 404 on the registry;
`tsl`, `typegpu`, `wesl` are taken), domain, GitHub org, then a KIPO / USPTO / EUIPO
trademark search before the name is used publicly. The name is the product's one
non-copyable asset; file the trademark before the launch post (§9).

---

## 5. What Tailwind's collapse means for a library launched in 2026

Developers increasingly get their answers from agents, not from documentation (Tailwind:
−40% doc traffic in two years while usage grew faster than ever). For a NEW library this
changes both discovery and what can be sold:

- **Discovery is agent-native from day one.** Ship `llms.txt` plus per-page markdown; an
  `AGENTS.md` / skills package for authoring in the DSL (this repository already writes
  `AGENTS.md` for its own agents; a "webgpu-threejs-tsl" skill is already published in public
  skill registries, which is how TSL is being distributed to agents); a Context7 listing;
  and an **MCP server that compiles and validates DSL source to WGSL and GLSL and returns the
  coded `SD####` diagnostics** — an agent that can round-trip through the real compiler will
  recommend the library and use it correctly. This is cheap: the compiler is zero-dependency
  TypeScript that runs under Node (#1686).
- **Sell what an agent cannot substitute** — verification, services, support (lines A and
  B) — before selling what an agent can generate (templates, line C). Motion+ is the
  precedent for adapting the Plus model itself: it now sells "AI-ready examples" and an AI
  kit, i.e. content shaped for the agent rather than for the reader.

---

## 6. Fame playbook — what the comparables actually did, adapted

### 6.1 The shareable artifact comes first

Shaders are visual; Shadertoy's loop (write → see → share a URL) is the growth loop, and
every successful comparable has one (PixiJS's examples, TSL's playground, Paper's editor).
Today the site renders build-time strings and the DSL never reaches the browser; direction
doc D7.6 deferred a live playground "until external demand". **This document is that
demand**: a browser playground — author in one pane, WGSL and GLSL side by side, rendered
on both backends, one URL per sketch — is the single highest-leverage item in §8. The
package is zero-dependency TypeScript, so a pre-bundled compiler build or esbuild-wasm gets
it there.

### 6.2 Meet users where they already are

Adapters, each its own small repository in the product org (they are not in the monorepo,
so they can accept PRs directly and each one is a landing page of its own):

- **three.js** — a `ShaderMaterial` / node from a DSL module;
- **PixiJS v8** — emit the `GlProgram` + `GpuProgram` pair the API demands from one module
  ("write it once for Pixi" is a one-paragraph pitch with a measured claim);
- **raw WebGPU / WebGL2** starters, and a **MapLibre custom layer** example;
- the Vite / Webpack plugin for build-time baking (direction doc D1 exists in-repo already).

One flagship case study each for X-GIS (a globe on both backends) and dc4i.js.

### 6.3 Launch sequence

`0.1.0` on npm, the landing page and the playground ship on the same day. Then, in order:
Show HN; JavaScript Weekly / Frontend Focus / Graphics Programming Weekly; the WebGPU
community channels (the WebGPU Discord, three.js discourse, r/webgpu,
r/GraphicsProgramming); Bluesky/X graphics-programming circles; the Chrome WebGPU team's
ecosystem round-up. One launch post, each claim measured (byte-stable, verified on Tint,
oracle parity, fp64), one visual per claim. Product Hunt is low-value for a compiler; skip
it.

### 6.4 Cadence and governance

Monthly release with a changelog post (the generator exists: `bun run changelog`); a
"shader of the week" from playground submissions; two conference talks in year one
(JSNation / JSConf / FOSDEM's JS devroom / Web3D); a public roadmap (the direction doc
already is one). Contributor hygiene that unlocks outside PRs on the adapter repos and
issues on the mirror: CoC, a product `CONTRIBUTING.md`, issue templates, Discussions or a
Discord, npm provenance, the existing `SECURITY.md`.

### 6.5 The KPI ladder that switches the revenue lines on

| Signal                                       | Switches on                                       |
| -------------------------------------------- | ------------------------------------------------- |
| Day 0                                        | A (services page + two outbound conversations), E |
| Two external consumers on a tagged release   | B (Pro toolchain / support)                       |
| Playground submissions show what people make | the choice between C (effects) and D (course)     |
| Thousands of stars or weekly downloads       | C at scale; F is reconsidered                     |

---

## 7. Landing page — the structure

A synthesis of what Tailwind, PixiJS, Motion and TypeGPU put above the fold, adapted to a
compiler whose proof IS the demo:

1. **Hero** — name, the sentence from §4, and a live, editable example that emits WGSL and
   GLSL side by side and renders both; `npm i <name>` and "Open playground" as the CTAs.
2. **Write once** — the twin-shader tax, with the Pixi migration-guide requirement quoted.
3. **Proof** — oracle, Tint gates, goldens: the numbers, not adjectives.
4. **Typed** — a wrong field is a TypeScript error (an IDE recording).
5. **Reflection** — std140 offsets you never hand-derive (the existing README example).
6. **fp64 deep zoom** — the demo nobody else has.
7. **Shipping** — the existing `inline` / `mangle` / `minify` page, promoted.
8. **Ecosystem** — the adapters from §6.2.
9. **Comparison** — TSL / TypeGPU / WESL / hand-written, one honest row each.
10. **Used by** — X-GIS, dc4i.js.
11. **Pricing / Sponsor / Pro** — whichever of §3 is live.
12. **Docs · GitHub · Discord · llms.txt**.

Mechanics: the site is already Astro + Tailwind + Shiki + React with an `en` / `ko` route
pair, so the product site is a second Astro project on its own domain, seeded from
`site/src/pages/shader-dsl/*` — with its own design system. The X-GIS site's `DESIGN.md`
is an xAI-inspired near-black system; a developer-tool landing page should be judged
against Tailwind's and Motion's, and needs its own decision.

---

## 8. Sequencing

| Phase                                   | Items                                                                                                                                                                                                                                                                                                                                                                                                                                  | Gate to the next phase                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **0 — product foundations** (now → tag) | Name, trademark search, domain, GitHub org; create the mirror repository and turn `mirror-shader-dsl.yml` on; #1681 C (version policy, publish workflow, `exports → dist`); `llms.txt` + agent skill + the MCP compile tool (§5); the browser playground (§6.1); the three.js and PixiJS adapters; the landing page (§7); a services page. Line A opens: two outbound conversations (MapLibre graphics modernization; one Pixi studio) | `0.1.0` tagged with `api-surface.test.ts` as the freeze (owner decision 6); playground live; services page live |
| **1 — launch and audience** (0–6 mo)    | The §6.3 sequence; monthly cadence; GitHub Sponsors / Open Collective on; the NLnet application; the KPI ladder instrumented (npm downloads, playground shares, Discord)                                                                                                                                                                                                                                                               | Two external consumers on a tagged release                                                                      |
| **2 — the compounding line** (6–18 mo)  | B (shader CI + support contracts); then whichever of C / D the playground evidence picks                                                                                                                                                                                                                                                                                                                                               | Revenue from B or C/D exceeds A's monthly average                                                               |
| **3 — the ceiling**                     | F, only on evidence from C                                                                                                                                                                                                                                                                                                                                                                                                             | —                                                                                                               |

Rules: each item becomes an issue before it starts (§9.5); the language roadmap (direction
doc §3) is not re-sequenced by this table — Wave 1 gates the tag, and nothing here moves
an emitted byte.

---

## 9. Money and legal plumbing for a Korea-based seller

Checklist, not advice — confirm each with a professional before acting:

- **Trademark first.** Search (KIPO; USPTO / EUIPO for the markets that pay) and file before
  the launch post; a coined name that is free on npm is not thereby free as a mark.
- **Entity.** A sole proprietorship (개인사업자) is enough to start; a corporation later if
  B's support contracts want one. Selling online directly needs the 통신판매업 notification.
- **Merchant of record.** Polar, Paddle or Lemon Squeezy is the legal seller to the customer
  and remits VAT / sales tax worldwide; the business invoices the platform. This is the
  simplest cross-border path for one-time licences (C, D) and subscriptions (B). Polar's
  rate is 5% + $0.50 per transaction since 2026-05; Paddle matches it with volume discounts.
- **Licences.** Core stays MIT (adoption is the bottleneck, §3). Pro / Effects ship under a
  commercial EULA — per seat or per company, one-time with an optional updates year
  (Tailwind Plus and Motion+ both use lifetime or one-time terms). A DCO is enough for the
  MIT core; no CLA.
- **GitHub Sponsors** is available to maintainers in South Korea (payouts via Stripe, after
  the community-reported blocker was fixed).

---

## 10. Open questions for the owner

1. **The name** — and whether "by X-GIS" stays as the maker brand. Everything in §4 and §9
   waits on this.
2. **Lead with services (A)?** It is the recommendation and the only line that earns before
   there is an audience; it also costs the owner's time. Confirm the appetite.
3. **The playground runs the DSL in the browser** — a pre-bundled compiler build or
   esbuild-wasm. This overrides direction doc D7.6's "wait for external demand": the growth
   loop in §6.1 does not exist without it.
4. **Two clocks.** Decision 6 tags `0.1.0` after Wave 1 (D4.1's breaking type changes). The
   launch could instead ship earlier on a documented `0.x` breaking-change policy. The
   recommendation is to keep decision 6 — a public breaking release in month two costs more
   audience than a later launch — and to spend the wait on Phase 0's non-code items.
5. **Repository topology** — the mirror as the public face with issues enabled there and
   PRs redirected to the monorepo (Symfony), versus issues only on X-GIS. The adapters are
   separate repositories either way.

---

## 11. Rejected during this study — with reasons

| Rejected                                                  | Why                                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Copying the Tailwind funnel as-is (docs → paid templates) | Its inventor reported it 80% gone in 2026-01, for a reason (agents) that applies MORE to a compiler whose users are developers with agents                   |
| Planning on sponsorship                                   | PixiJS's ~$40k/yr at PixiJS scale; MkDocs Insiders discontinued; Porzio's numbers rest on a prior audience                                                   |
| A paid core or paid plugins (GSAP shape)                  | Acquired-then-free is the observed end state; and a new library with three stars cannot afford the adoption tax                                              |
| Competing with TypeGPU on JS-syntax authoring             | Settled in the direction doc §5; and it is Software Mansion's home ground                                                                                    |
| A hosted editor in year one                               | Unicorn, Paper and Rive are funded and shipping; line F needs C's evidence first                                                                             |
| Keeping the DSL inside the X-GIS site and brand           | A GIS engine's sub-page cannot be found by a Pixi or three.js developer; the product needs its own name, domain and org (the source tree does not move — §1) |

---

## Sources (fetched 2026-09-07)

- Tailwind Labs layoffs and revenue: devclass.com/2026/01/08/tailwind-labs-lays-off-75-percent-of-its-engineers-thanks-to-brutal-impact-of-ai/;
  adamwathan.me/tailwindcss-from-side-project-byproduct-to-multi-mullion-dollar-business/
- PixiJS finances: opencollective.com/pixijs; pixijs.com/sponsor; pixijs.com/bug-bounty
- Three.js Journey: threejs-journey.com
- Motion+: motion.dev/plus; motion.dev/blog/framer-motion-is-now-independent-introducing-motion
- Aceternity UI Pro: ui.aceternity.com/pro
- Unicorn Studio pricing: uithings.com/what-is-unicorn-studio; abduzeedo.com/webgl-design-tool-unicorn-studio-shaders
- Paper Shaders: github.com/paper-design/shaders; shaders.paper.design
- Rive pricing: rive.app/pricing
- GSAP / Webflow: webflow.com/blog/webflow-acquires-gsap
- Material for MkDocs Insiders: squidfunk.github.io/mkdocs-material/blog/2025/11/11/insiders-now-free-for-everyone/
- Caleb Porzio: calebporzio.com/sponsorware; calebporzio.com/i-just-cracked-1-million-on-github-sponsors-heres-my-playbook
- TypeGPU: github.com/software-mansion/TypeGPU; docs.swmansion.com/TypeGPU/ecosystem/typegpu-gl/; docs.swmansion.com/TypeGPU/integration/wesl-interoperability/
- three.js TSL: threejs.org/docs/TSL.html
- p5.strands: davepagurek.com/blog/writing-shaders-in-js/
- WESL: wesl-lang.dev; github.com/wgsl-tooling-wg/wesl-spec
- PixiJS v8 dual programs: pixijs.com/8.x/guides/migrations/v8; github.com/pixijs/pixijs/discussions/11027
- MapLibre WebGPU: maplibre.org/roadmap/maplibre-gl-js/graphics-modernization/; MapLibre GL JS v6.0.0 (2026-07-22)
- NLnet NGI Zero (WgMath grant): nlnet.nl/news/2025/20250321-call-announcement-core.html
- GitHub Sponsors in South Korea: github.blog/changelog/2022-07-28-github-sponsors-available-in-30-new-regions/; github.com/orgs/community/discussions/27547
- Merchant of record pricing: fungies.io/polar-sh-review-2026/; buildmvpfast.com/blog/lemon-squeezy-vs-polar-paddle-merchant-of-record-2026
- Context7 / llms.txt: github.com/upstash/context7
- npm name availability: `registry.npmjs.org/<name>` probed from this session
- Repository and site state: github.com/X-GIS/X-GIS; x-gis.github.io/X-GIS/shader-dsl/
