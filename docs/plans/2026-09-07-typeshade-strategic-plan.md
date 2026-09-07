# TypeShade — strategic plan: survival, driving force, meaning (2026-09-07)

**Status:** strategy (owner brief: "the strategy for this library — how it SURVIVES, the DRIVING FORCE that makes other people use it, and the MEANING that justifies it being maintained") · **Scope:** the 5+ year life of TypeShade independent of the X-GIS monorepo · **Method:** named strategy frameworks, each rendered as an explicit artifact · **Companions:** `2026-09-07-shader-dsl-standalone-product-strategy.md` (**PS §n**) and `2026-09-01-shader-dsl-improvement-direction.md` (**DD §n**) — cited, not restated. **Discipline:** every number carries a source. Measurements ran on this tree (branch `claude/shaderdsl-monetization-strategy-sr64wo`, HEAD `c2ba38cb`) on 2026-09-07; web figures were fetched 2026-09-07 and go stale. Where this disagrees with PS it says so and shows the evidence.

---

## 0. Executive summary

> **Corrections and joins (2026-09-07).** Two moat claims first printed here were refuted in-corpus and are corrected in place: the "94%" type-error figure (§1.1, §4.2) and the oracle's uniqueness (§1.3 S1). The refutations, the measured `naga` refund of the twin-shader tax (~77%) and the checker re-centring live in `2026-09-07-typeshade-agent-era-strategy.md`; the credibility audit of this document is `2026-09-07-typeshade-credibility-and-value-assessment.md` §1. The host ranking in §6.4 is superseded by `2026-09-07-typeshade-ecosystem-embedding.md` §4 pending D13.

TypeShade must exist because the twin-shader tax is now a **measured** cost: 64% of >400 shader developers spend effort adapting shaders across platforms, APIs or tools and ~10% call it one of their largest engineering costs (Khronos 2026 Shader Ecosystem Survey), while PixiJS demands a `gl` **and** a `gpu` program, MapLibre's phase 4 is literally "port GLSL shaders to WGSL", and deck.gl's entire extension ecosystem is stuck on WebGL because it injects GLSL — and nobody else emits both targets _and_ proves they agree with a CPU oracle. It survives on two legs: an **anchor tenant** (X-GIS — 144 importing files, 58 DSL modules, 878,943 bytes of emitted shader text) that funds a ~12 h/month maintenance floor regardless of adoption, and **ecosystem embedding** (§6) that moves the reason-to-exist out of X-GIS and into hosts that will outlive it. The driving force is not "two backends" — that is a real option with a ~5-year expiry (§7) — it is _typed authoring an agent can get right and a compiler can prove_, which strengthens as agents write more shaders (94% of LLM compilation errors are type-check failures). "Maintained" means a zero-dependency core whose real-compiler gates, byte goldens and oracle parity run on every commit, a published compatibility promise and SLA (§11), and an EOL protocol written **before** it is needed — because the honest horizon for a one-person compiler is not "forever", it is "until it is embedded somewhere that outlives me".

---

## 1. Situation analysis

### 1.1 PESTEL — only the factors that move a decision here

| Factor                             | Finding                                                                                                                                                                                                                                                                                                       | Source                                                                                                                  | So what                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **T — WebGPU availability**        | 87.35% of global users                                                                                                                                                                                                                                                                                        | caniuse.com/webgpu, fetched 2026-09-07                                                                                  | Availability ≠ the tail; see 1.4                                           |
| **T — WebGPU residual gaps**       | Firefox Linux unshipped ("expects to ship on Linux in 2026"); Chrome Linux Intel Gen12+ only in 144, NVIDIA/Wayland in 147; Android needs 12+; Safari needs OS 26                                                                                                                                             | gpuweb wiki Implementation-Status, fetched 2026-09-07                                                                   | WebGL2 stays a shipping target well past 2030 (1.4)                        |
| **T — host migration in flight**   | MapLibre phase 4 pending; deck.gl WebGPU "not production ready"; three.js already auto-falls back                                                                                                                                                                                                             | maplibre.org roadmap; deck.gl/docs/developer-guide/webgpu; threejs.org/manual/en/webgpurenderer.html                    | The window is _now_, and it closes (§8)                                    |
| **T — AI-authored code**           | type-constrained decoding cuts LLM compilation errors by more than half (arXiv 2504.09246, abstract; the "94%" figure previously printed here does not appear in the paper — corrected 2026-09-07 per the agent-era strategy §2); TypeScript is GitHub's most-used language (Aug 2025), +66% YoY contributors | github.blog "Why AI is pushing developers toward typed languages", 2026-01-08 (citing arXiv 2504.09246, Octoverse 2025) | The durable half of the pitch (§4 VPC)                                     |
| **E — economics of dev-tool docs** | Tailwind: docs traffic −40% since early 2023, revenue −80%, 75% of engineering laid off 2026-01-06                                                                                                                                                                                                            | devclass.com 2026-01-08; PS §5                                                                                          | Never build a funnel on doc traffic                                        |
| **L — trademark**                  | KR/US/EU/WO clear for TYPESHADE; one identical JP mark in classes 14+25                                                                                                                                                                                                                                       | PS App. B.1                                                                                                             | File KR 09+42 **before** the launch post (§13 D7)                          |
| **L — licence**                    | Core MIT; zero dependencies (measured: `shader-dsl/package.json` — 0 deps / 0 peerDeps / 0 devDeps)                                                                                                                                                                                                           | measured 2026-09-07                                                                                                     | No licence-compatibility surface; keeps acquisition-in-place cheap (§8 S3) |

### 1.2 Porter's Five Forces — market: "web shader authoring tooling"

| Force              | Strength        | Evidence                                                                                                                                                                                                                                      | Implication                                                                                                      |
| ------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Rivalry**        | **High**        | three.js TSL (`three` 14,025,392 wk); TypeGPU 0.12.4, 142,702 wk; WESL 0.2 with imports + `@if/@elif/@else` + package-manager shader libraries; hand-written twins (all measured / fetched 2026-09-07)                                        | Do not fight on syntax (PS §1). Differentiate on the complete GLSL backend + proof                               |
| **Supplier power** | **Very high**   | The GPU API, WGSL spec and the only real validators (Tint, naga — naga develops inside the `wgpu` repo; Mozilla is its CVE numbering authority) are all browser-vendor property                                                               | Never fork a validator. Depend on them _as gates_, never as runtime (zero deps holds)                            |
| **Buyer power**    | **High**        | Buyers are engineers with a free alternative (hand-write both) and a strong OSS free-rider norm; the closest comparables monetise at ~$40k/yr (PixiJS: $118,918.03 lifetime, est. $40,250.02/yr, 168 contributors, opencollective.com/pixijs) | Sell to _organisations_ (services, CI, support — PS §3A/B), not to individuals                                   |
| **Substitutes**    | **High**        | Raw WGSL/GLSL; three.js's automatic WebGL2 fallback (removes the pain for the largest audience); visual node editors (Unicorn Studio, Paper — PS §2); Slang at 34% adoption, Khronos-hosted                                                   | The dual-target wedge is narrower than PS §4 implies (1.3 W-row, §8 S3)                                          |
| **New entrants**   | **Medium-high** | A browser vendor or Khronos shipping a JS-native multi-target toolchain; AI code generation writing both shaders directly                                                                                                                     | Entry barrier is not the emitter — it is the _oracle + gate corpus_ (146 test files, measured). Deepen that moat |

### 1.3 SWOT — every cell tied to a measured fact

|              | Helpful                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Harmful                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Internal** | **S1** CPU f64 oracle over the SAME typed source both emitters read, fp64 included — not unique as an oracle (`wgsl_reflect` ships a WGSL CPU executor, 277,311 weekly downloads, measured 2026-09-07; corrected per the agent-era strategy §2), distinctive as a proof of agreement between two emitted targets. **S2** Complete GLSL ES 3.00 render backend (std140 UBO, MRT, storage→data-texture) vs TypeGPU's experimental subset that has "no compute shaders, storage buffers, bind groups" (docs.swmansion.com/TypeGPU/ecosystem/typegpu-gl/). **S3** Zero dependencies (measured: 0/0/0). **S4** 146 test files / 27,727 non-test LOC over 108 src files (measured). **S5** Emulated fp64 with unchanged syntax, fail-closed on `SD0041` (README). **S6** Byte-stable emit + Tint/WebGL2 compile gates in CI (DD D6) | **W1** Audience ≈ 0: X-GIS 3 stars (PS §0), mirror `typeshade/typeshade` 0 stars / 464 commits (fetched 2026-09-07), `typeshade` on npm has no download record (measured). **W2** API not frozen — two `⚠ BREAKING CHANGES` in the 2026-09 changelog alone. **W3** Bus factor 1. **W4** Not on npm as a real release; ships TypeScript source (README). **W5** No browser playground — the DSL never reaches the client (PS §6.1)                   |
| **External** | **O1** 64% pay the porting tax; ~10% call it a top engineering cost (Khronos 2026). **O2** deck.gl extensions "all remain WebGL-only today because they rely on GLSL shader injections" — an ecosystem blocked, by a host that cannot unblock it. **O3** MapLibre phase 4 = "port GLSL shaders to WGSL" — a _dated_ pain. **O4** MCP is now a governed standard (donated to the Agentic AI Foundation under the Linux Foundation, Dec 2025; >10,000 public servers). **O5** Vendor absorption is the modal good outcome for web tooling (Cloudflare×Astro 2026-01-16, Cloudflare×VoidZero 2026-06-04)                                                                                                                                                                                                                         | **T1** three.js `WebGPURenderer` already falls back to WebGL2 with the same TSL source — the largest single audience feels no pain. **T2** WGSL is only 14.9% (n=60) of the Khronos respondents — a thin end. **T3** TypeGPU completing `@typegpu/gl`. **T4** Slang (34%, Khronos-hosted) reaching the web. **T5** Sponsorship cannot fund a person: PixiJS ~$40k/yr, Zod ~$2,600/mo, "far from replacing a full-time salary" (zod.dev, 2024-06-11) |

**Disagreement with PS, recorded.** PS §4 positions against three.js as "not tied to a renderer". True, but incomplete: three's automatic fallback means the _twin-shader tax does not exist_ for three.js users. Ranking three.js as a wedge overstates the addressable pain (§5.2, §6.4).

### 1.4 The relevance window of a dual-target compiler — precise and honest

WebGL2 was broadly available years before serious consumers dropped WebGL1: **MapLibre GL JS made WebGL2 mandatory only in v6.0.0, 2026-07-22** (PS §3A). Applying that lag to a WebGPU baseline of ~2026:

| Milestone                                       | Estimated horizon              | Signpost to watch                                                |
| ----------------------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| Migration window (dual-target is a _headline_)  | **now → 2029–2031**            | Hosts finishing ports (MapLibre phase 4; deck.gl layer-by-layer) |
| Dual-target becomes a _legacy fallback feature_ | **2029–2031**                  | A top-5 web engine ships WebGPU-only defaults                    |
| WebGL2 stops being a shipping target            | **2033–2035**; not before 2031 | A top-5 web engine deletes its WebGL2 path                       |

**Consequence — the most important judgement in this document.** The dual-backend story has a ~5-year half-life. It buys attention now; it cannot be why the project exists in 2033. The durable half is **typed authoring + machine-checkable proof**, which survives any one target dying. PS §4's sentence leads with the perishable half (§13 D1).

---

## 2. Wardley Map — the value chain

### 2.1 Components and evolution

| #   | Component                                                   | Stage today         | Movement                     | Play                                                      |
| --- | ----------------------------------------------------------- | ------------------- | ---------------------------- | --------------------------------------------------------- |
| 1   | User need: _custom visuals in a browser_                    | Commodity           | stable                       | —                                                         |
| 2   | Engines / hosts (three, Pixi, deck.gl, MapLibre, Babylon)   | Product             | consolidating                | **Partner** (§6)                                          |
| 3   | Shader **authoring** surface (TSL, TypeGPU, WESL, raw text) | Custom → Product    | evolving fast                | **Do not build a rival syntax** (PS §1)                   |
| 4   | Shader **compile / emit** (one source → WGSL + GLSL)        | Custom              | → Product                    | **BUILD — this is the position**                          |
| 5   | **Proof** (CPU oracle, real-compiler gates, byte goldens)   | **Genesis**         | → Custom                     | **BUILD — the moat; nobody else is here**                 |
| 6   | Shader **module distribution** (imports, packages)          | Genesis → Custom    | WESL 0.2 is standardising it | **Partner / adopt; never build a rival registry**         |
| 7   | Host adapters (`@typeshade/<host>`)                         | Genesis             | → Custom                     | **BUILD, cheaply, one per host**                          |
| 8   | GPU API — **WebGL2**                                        | Commodity           | **sunsetting** (1.4)         | Harvest; never invest in a WebGL1 path (DD §5)            |
| 9   | GPU API — **WebGPU**                                        | Product             | hardening → commodity        | Track the spec; never fork                                |
| 10  | Validators / translators (Tint, naga)                       | Product → Commodity | vendor-owned                 | **Commoditise-and-consume**: use as CI gates, not runtime |
| 11  | Browser runtime, GPU hardware                               | Commodity           | stable                       | —                                                         |

### 2.2 The map

```
 visible │ (1) user need: custom visuals in a browser ··························[■]
         │ (2) hosts: three · Pixi · deck.gl · MapLibre · Babylon ········[■]   PARTNER
         │ (3) shader AUTHORING     TSL · TypeGPU · WESL ··········[■]   (TypeShade too)
         │ (4) shader COMPILE/EMIT — both targets         [■]──────►      ◄ BUILD
         │ (5) PROOF: oracle · Tint/GLSL gates · goldens  [■]──►          ◄ BUILD (moat)
         │ (6) module distribution (WESL packages)     [■]──►             ◄ PARTNER
         │ (7) host adapters @typeshade/*           [■]──►                ◄ BUILD (cheap)
         │ (8) GPU API WebGL2 ·································[■]──►  sunset / harvest
         │ (9) GPU API WebGPU ······················[■]───────────►
         │ (10) Tint / naga validators ·············[■]──────────►        ◄ CONSUME
 hidden  │ (11) browser runtime · GPU hardware ·················[■]
         └──────────────────────────────────────────────────────────────────────────
           GENESIS         CUSTOM-BUILT          PRODUCT          COMMODITY
```

### 2.3 The plays that follow

| Play                        | Where                    | Why                                                                                                           |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Build**                   | (4) emit **+** (5) proof | Alone, (4) is copyable in a quarter; (4)+(5) is not — the barrier is the gate corpus, not the emitter         |
| **Commoditise-and-consume** | (10) Tint / naga         | Let vendors own validation; consume them as CI gates so their improvements are free and their bugs are theirs |
| **Partner**                 | (2) hosts, (6) WESL      | Adapters into hosts (§6); emit WESL rather than build a rival registry                                        |
| **Harvest, don't invest**   | (8) WebGL2               | It is why people arrive, not why they stay (§1.4)                                                             |
| **Accept the inertia**      | (3) authoring syntax     | Every competitor fights there and users have opinions. Staying out is a positional decision, not a concession |

---

## 3. Reason to exist (the meaning) — the measured case

| Claim                                                         | Number                                                                               | Source                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Devs adapting shaders across platforms/APIs/tools             | **64%** of >400 respondents (fielded 2026-06-16→07-10)                               | khronos.org/blog/shader-ecosystem-survey-results-2026 |
| …calling it one of their largest engineering costs            | **~10%**                                                                             | same                                                  |
| Top pain: shader debugging/profiling                          | top-3 for **53%**                                                                    | same                                                  |
| Language use                                                  | GLSL 60% · HLSL 41% · SPIR-V 39% · Slang 34% · **WGSL 14.9% (n=60)**                 | same (WGSL row via the gamedev.net summary)           |
| PixiJS: both programs or the omitted renderer will not run it | `Shader.from({ gl: {...}, gpu: {...} })`                                             | pixijs.com/8.x/guides/migrations/v8                   |
| MapLibre phase 4                                              | "Add the WebGPU code path, **port GLSL shaders to WGSL**"                            | maplibre.org roadmap                                  |
| deck.gl extensions blocked                                    | "Extensions all remain WebGL-only today because they rely on GLSL shader injections" | deck.gl/docs/developer-guide/webgpu                   |

**PS §3A argued this tax from the Pixi migration guide alone. The Khronos survey is the first population-level measurement of it and should replace the anecdote in every pitch.**

**The cost of it NOT existing, for X-GIS — measured, not estimated:**

| Quantity                                     | Value                                                                        | Command                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| DSL shader modules                           | **58** files                                                                 | `find map/src/shaders/dsl -name '*.ts' ! -name '*.test.ts' \| wc -l` |
| Their size                                   | **14,063** non-test LOC                                                      | `find … -exec cat {} + \| wc -l`                                     |
| Files importing the package (map + compiler) | **144**                                                                      | `grep -rl "shader-dsl" map/src compiler/src --include=*.ts \| wc -l` |
| Spread                                       | map 125 · site 24 · compiler 19 · rhi-webgl2 6 · rhi-webgpu 3 · playground 1 | `… \| cut -d/ -f1 \| sort \| uniq -c`                                |
| Emitted shader text shipped                  | **878,943 bytes** in 6 baked artifacts                                       | `cat map/src/shaders/baked/*.generated.ts \| wc -c`                  |

Without TypeShade, X-GIS hand-writes and hand-syncs ~0.88 MB of WGSL **and** GLSL, with no oracle and no byte-stability gate. That is the anchor-tenant argument (§11.4) in one table.

---

## 4. Business Model Canvas · Value Proposition Canvas

### 4.1 Business Model Canvas

| Block                      | Content                                                                                                                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Customer segments**      | (a) engine/library maintainers mid-WebGPU-migration; (b) custom-layer / extension / filter authors on MapLibre · deck.gl · Pixi; (c) studios with a WebGL codebase facing a port; (d) creative coders wanting types; (e) AI agents authoring shaders |
| **Value propositions**     | One typed source → WGSL + GLSL ES 3.00, **proven to agree**; forward compatibility across a host's backend change (§6.2); a verification loop an agent can close                                                                                     |
| **Channels**               | The playground URL (PS §6.1); host adapters and their docs listings (§6.3); MCP tool + `llms.txt`; launch sequence (PS §6.3); the compatibility matrix page (§6.2)                                                                                   |
| **Customer relationships** | Self-serve OSS core; issues on the mirror; monthly release train; paid support/SLA for line B (PS §3B)                                                                                                                                               |
| **Revenue streams**        | A services · G anchor-tenant · H fellowship · B pro toolchain · I absorption · J grants · E sponsorship (ranked, §11.3)                                                                                                                              |
| **Key resources**          | The oracle; the gate corpus (146 test files, measured); the GLSL ES 3.00 backend; the TypeShade name + domains + org (PS App. B); the owner's time                                                                                                   |
| **Key activities**         | Compile-gate maintenance; golden/oracle stewardship; adapter + matrix CI; spec tracking; release train                                                                                                                                               |
| **Key partners**           | Host communities (MapLibre, deck.gl, Pixi); WESL WG; Tint/naga (as consumed gates); merchant-of-record + attorney (PS §9)                                                                                                                            |
| **Cost structure**         | ~**12 h/month** maintenance floor (§11.2, proposed budget); trademark + domains (PS §9); CI minutes; 0 licence cost (MIT, zero deps)                                                                                                                 |

### 4.2 Value Proposition Canvas — primary segment: _host custom-layer / extension author_

| Customer side                                                               |     | TypeShade side                                                                                                                                     |
| --------------------------------------------------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Job:** ship a custom visual inside a host engine, and keep it working     | ↔   | **Product:** `@typeshade/<host>` + a TypeShade module                                                                                              |
| **Job:** survive the host's backend change without a rewrite                | ↔   | **Gain creator:** forward-compat contract + the host×adapter×backend matrix (§6.2)                                                                 |
| **Pain:** must author the shader twice (Pixi `{gl, gpu}`; MapLibre phase 4) | ↔   | **Pain reliever:** one source, both emits                                                                                                          |
| **Pain:** GLSL injections block the WebGPU future (deck.gl, quoted §3)      | ↔   | **Pain reliever:** emit the GLSL chunk today, get the WGSL one free                                                                                |
| **Pain:** silent shader bugs; debugging is the #1 pain (53%, Khronos)       | ↔   | **Pain reliever:** type errors at author time; oracle parity; coded `SD####` diagnostics                                                           |
| **Pain:** hand-derived std140/std430 offsets break on upgrade               | ↔   | **Pain reliever:** `reflect()` derives them (49 inbound callers, DD §0)                                                                            |
| **Gain:** trust a dependency will still be there                            | ↔   | **Gain creator:** zero deps (measured 0/0/0), published SLA + EOL protocol (§11)                                                                   |
| **Gain:** an agent can write it correctly                                   | ↔   | **Gain creator:** typed surface + MCP compile/validate tool (type-constrained decoding more than halves LLM compilation errors — arXiv 2504.09246) |

---

## 5. Adoption — Crossing the Chasm

### 5.1 Where the market is

| Stage                            | Who, today                                                                                 | Evidence                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| **Innovators**                   | The owner + dc4i.js (41 portable entries, 0 raw GLSL files)                                | PS §0                                             |
| **Early adopters** (visionaries) | Custom-layer / extension authors who can _see_ the host's backend flip coming              | MapLibre phase 4; deck.gl blocked extensions (§3) |
| **THE CHASM**                    | Pragmatists will not adopt a 0-star, 0-download, unfrozen-API compiler from one maintainer | W1–W5 (§1.3)                                      |
| **Early majority** (pragmatists) | Teams that adopt what their _host ecosystem_ endorses — hence §6                           | —                                                 |

### 5.2 Bowling alley — first pin and the pins it knocks down

**First pin: MapLibre custom layers.** Then deck.gl extensions (adjacent problem, adjacent people), then PixiJS filters (same emit pair, different host), then generic WebGPU/WebGL2 apps. three.js is a _reach_ play, not a pain play (§1.3 T1) and comes last.

| Beachhead criterion (Moore)                     | MapLibre custom layers                               | Verdict |
| ----------------------------------------------- | ---------------------------------------------------- | ------- |
| A compelling reason to buy                      | Their GLSL has a dated expiry (phase 4)              | ✅      |
| Whole product achievable by one maintainer      | Adapter + example + matrix ≈ 1–2 weeks (§6.3 rung 1) | ✅      |
| Reachable word-of-mouth community               | One project, one docs site, one issue tracker        | ✅      |
| No entrenched competitor                        | No MapLibre-specific shader compiler exists          | ✅      |
| Size big enough to matter, small enough to lead | `maplibre-gl` 4,366,094 weekly (measured)            | ✅      |
| The owner has domain credibility                | X-GIS _is_ a globe engine on both backends           | ✅      |

### 5.3 Whole product — what must surround the compiler before a pragmatist buys

| Layer     | Item                                                     | State                                              |
| --------- | -------------------------------------------------------- | -------------------------------------------------- |
| Generic   | The compiler                                             | exists                                             |
| Expected  | npm release, semver, changelog, docs, examples           | changelog ✅; release ⛔ (PS §1: tag after Wave 1) |
| Expected  | It runs in the browser (playground)                      | ⛔ (PS §6.1, DD D7.6) — the single biggest gap     |
| Augmented | Host adapter + one working example per host              | ⛔ (§6)                                            |
| Augmented | Host × adapter × backend compatibility matrix, CI-gated  | ⛔ — **the differentiator nobody publishes**       |
| Augmented | MCP tool + `llms.txt` + agent skill                      | ⛔ (§13 D4)                                        |
| Potential | Shader CI as a service, support SLA                      | line B (PS §3B)                                    |
| Trust     | `GOVERNANCE.md` with bus factor stated + dead-man switch | ⛔ (§13 D3)                                        |

Leading indicators for adoption and for embedding share one instrument panel — **§6.5**.

---

## 6. Ecosystem embedding — survival independent of X-GIS

Owner's framing: _"If I stop maintaining X-GIS, TypeShade loses its reason to exist. So we need a way to INJECT the reason TypeShade is needed into OTHER libraries."_ This is risk R1 (§9) and the highest-leverage move in this document.

> A parallel deep-dive is being produced at
> `/home/user/X-GIS/docs/plans/2026-09-07-typeshade-ecosystem-embedding.md` — absent when this
> was written (verified `ls`, 2026-09-07). When it lands, **its** executive summary and host
> ranking are authoritative; this section is the frame and the standing decisions.

### 6.1 The concept and its proper names

| Name                                     | Meaning here                                                                                            | Literature                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Ingredient branding** ("Intel Inside") | Branded _inside_ the host so host users ask for it                                                      | Kotler & Pfoertsch, _Ingredient Branding_ (2010) (from memory); Intel Inside launched 1991 (from memory) |
| **Complementor**                         | A player who makes the host more valuable, so the host rationally helps back                            | Brandenburger & Nalebuff, _Co-opetition_ (1996), the Value Net (from memory)                             |
| **Upstreaming**                          | Become a dependency of a project that outlives you; out-of-tree rots, in-tree is maintained by the host | Linux "upstream first" norm (from memory)                                                                |
| **Anti-corruption / insulation layer**   | The adapter absorbs host churn so user code never names host internals                                  | Evans, _Domain-Driven Design_ (2003) (from memory)                                                       |
| **Switching costs**                      | Once shaders are authored here, leaving costs a rewrite                                                 | Shapiro & Varian, _Information Rules_ (1999) (from memory)                                               |
| **Real option**                          | Each module is a paid-for option on the host's future backend, exercised free (§7)                      | Baldwin & Clark, _Design Rules_ (2000) (from memory)                                                     |

**Upstreaming is the strongest of these and it is checkable.** `maplibre-gl@6.7.0` depends on `earcut ^3.2.3`, `pbf ^5.1.2` and `gl-matrix ^3.4.4` (measured: `registry.npmjs.org`, 2026-09-07). `gl-matrix`'s newest publish is **2025-08-08** — 13 months stale — and it still ships inside every one of MapLibre's **4,366,094** weekly installs. _A library that is a dependency of a longer-lived project keeps living after its author stops._ That is exactly the property the owner is asking for.

### 6.2 The mechanism

| #   | Element                                                        | Detail                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **One adapter package per host**, versioned independently      | `@typeshade/maplibre` · `@typeshade/deck` · `@typeshade/pixi` · `@typeshade/three` · `@typeshade/babylon` — each a thin insulation layer returning exactly the artifact the host demands (a `CustomLayerInterface`, a deck shader-module chunk, a `{ gl, gpu }` pair, a `ShaderMaterial`/node) |
| 2   | **Bindings from `reflect()`, never hand-written**              | Bind groups, std140/std430 offsets and entry signatures derived the way X-GIS derives them (49 inbound callers, DD §0). Hand-derived offsets are how adapters break silently on a host upgrade                                                                                                 |
| 3   | **A compatibility matrix, generated and CI-gated**             | _host version × adapter version × backend (WebGPU/WebGL2) → pass/fail_, produced by compiling and running one canonical example against every supported host version on every commit; published on the site                                                                                    |
| 4   | **The forward-compatibility contract**, in each adapter README | Quoted below. Claim only what the matrix proves — an unverifiable promise is a liability                                                                                                                                                                                                       |

> For every host major listed as supported, the same TypeShade module compiles to the artifact
> that host requires, on every backend that host supports. When the host adds a backend, your
> module gains it without an edit. When the host breaks something, the adapter absorbs it in a
> minor release; if it cannot, the matrix says so and the changelog gives the migration.

### 6.3 The upstreaming ladder

| Rung                                               | What                                       | Cost                      | What it buys                                                         |
| -------------------------------------------------- | ------------------------------------------ | ------------------------- | -------------------------------------------------------------------- |
| 1 — Adapter exists                                 | `@typeshade/<host>` + one example + matrix | 1–2 weeks/host            | Usable; nothing more                                                 |
| 2 — Listed in the host's docs / ecosystem page     | a PR or a request                          | days + a relationship     | Discovery inside the host's funnel                                   |
| 3 — The host's official example uses it            | contribute an example the host maintains   | weeks + review cycles     | The host now _tests_ your integration                                |
| 4 — A dependency of the host or an official plugin | upstream a piece the host needs            | months; needs host buy-in | Survival independent of the author — the `gl-matrix` property (§6.1) |

Rungs 1–2 are code and can be done alone. **Rungs 3–4 are relationship work, not code** — the honest cost the owner must accept or decline (§13 D2).

### 6.4 Host ranking

| Host                  | WebGPU status (fetched 2026-09-07)                                                                | Pain now                                                            | Weekly npm (measured) | Rank               |
| --------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------- | ------------------ |
| **MapLibre GL JS**    | Phase 4 pending: "port GLSL shaders to WGSL"; backends share all non-GPU code                     | **Highest** — custom-layer GLSL has a dated expiry                  | 4,366,094             | **1**              |
| **deck.gl / luma.gl** | WebGPU "still a work in progress and is not production ready"; extensions "all remain WebGL-only" | **Highest** — an ecosystem blocked by a host that cannot unblock it | 202,573               | **2**              |
| **PixiJS**            | Ships both; `Shader.from({gl, gpu})`                                                              | High — the tax is in the API signature                              | 920,303               | **3**              |
| **three.js**          | `WebGPURenderer` auto-falls back to WebGL2, same TSL source                                       | **Low — already solved**                                            | 14,025,392            | **4 (reach only)** |
| **Babylon.js**        | Microsoft-sponsored, Apache-2.0, WebGPU engine mature (`@babylonjs/core` 9.25.0, 2026-09-03)      | Low                                                                 | 272,819               | 5                  |

**MapLibre first:** the owner's own domain (X-GIS is a globe engine, so the reference implementation exists), a narrow stable seam, a _dated_ pain, and a one-sentence pitch — _"your layer keeps working when phase 4 lands."_ deck.gl second: their own docs contain the sharpest existing statement of the problem TypeShade solves.

### 6.5 Leading indicators — adoption (§5) and embedding, one panel

| Signal                                                                                      | Threshold                  | Reads                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Playground sketches shared by non-owners / month                                            | ≥ 20 by month 6            | Adoption — the only real pre-adoption signal                                                                                               |
| External repos importing `typeshade`                                                        | ≥ 10 by month 9            | Adoption — use, not installs                                                                                                               |
| Non-owner issues / month                                                                    | ≥ 5 by month 9             | Adoption — someone depends on it enough to complain                                                                                        |
| Inbound line-A enquiries                                                                    | ≥ 2 in 12 months           | Revenue leg                                                                                                                                |
| Published host×adapter×backend matrix, green in CI                                          | month 4                    | Embedding, rung 1                                                                                                                          |
| Host-adapter weekly installs                                                                | ≥ 100 by month 12          | Embedding, not curiosity                                                                                                                   |
| TypeShade named on a host's docs / ecosystem / awesome list                                 | ≥ 1 by month 9             | Embedding, rung 2                                                                                                                          |
| A host issue/PR _not authored by the owner_ mentions TypeShade                              | ≥ 3 by month 12            | Embedding, rung 2–3                                                                                                                        |
| A named third-party production case study                                                   | ≥ 1 by month 12            | Embedding, rung 2–3                                                                                                                        |
| A host repo contains an example importing an adapter                                        | ≥ 1 by month 15            | Embedding, rung 3                                                                                                                          |
| **The promise honoured in public:** a host ships a backend and adapter users change nothing | first host backend release | Embedding, rung 3–4 — the whole strategy in one event                                                                                      |
| **Banned: raw npm downloads as health**                                                     | —                          | `glslify` last published 2020-09-02 → 565,493/wk; `regl` 2024-11-12 → 776,433/wk (measured). Downloads measure installed history, not life |

The last substantive row cannot be manufactured, only prepared for — which is why the adapter and the matrix must exist _before_ MapLibre's phase 4 lands.

---

## 7. Real options analysis — the WebGPU migration bet

| Option element                                  | In TypeShade terms                                                                                                | Value / cost, cited                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Option type**                                 | A call option on the host's future backend: author once, exercise when the host flips                             | —                                                          |
| **Underlying asset**                            | The user's shader codebase                                                                                        | X-GIS's own: 14,063 LOC → 878,943 emitted bytes (measured) |
| **Premium (what it costs to hold)**             | Learning the DSL + a build step + a 0-star dependency                                                             | W1–W5 (§1.3); mitigated by the adapter + matrix (§6.2)     |
| **Strike (what exercising saves)**              | The port the user does not do: "port GLSL shaders to WGSL" (MapLibre phase 4), or the second program Pixi demands | 64% pay this today; ~10% call it a top cost (Khronos 2026) |
| **Volatility (what makes the option valuable)** | Uncertainty about _when_ each host flips: MapLibre undated, deck.gl "not production ready", three.js already done | maplibre.org roadmap; deck.gl docs; threejs.org manual     |
| **Expiry**                                      | When the host completes its port _and_ WebGL2 stops shipping: **2029–2031 / 2033–2035** (§1.4)                    | —                                                          |
| **Option is worthless if**                      | The host never flips, or flips transparently (three.js — T1)                                                      | §1.3                                                       |

**Reading.** The option is most valuable _before_ a host flips and worth nothing after — so the value is highest exactly where the pain is highest (MapLibre, deck.gl) and ~zero where the host solved it (three.js). This is the same ranking §6.4 reaches from a different direction, which is the cross-check. **And an option with an expiry cannot be the permanent thesis** — hence §13 D1: sell the option now, build the durable asset (proof) with the proceeds.

---

## 8. Scenario planning — three worlds in 2028

|                                           | **S1 "WebGL2 lingers"** (base case)                                                                    | **S2 "WebGPU everywhere, fast"**                                                                             | **S3 "The platform ships the DSL"**                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **World**                                 | WebGPU baseline, but WebGL2 still ships everywhere; most hosts still dual                              | Hosts complete ports by 2028; WebGL2 is legacy fallback                                                      | Khronos/Slang or a browser vendor ships a first-class JS multi-target toolchain; or `@typegpu/gl` becomes complete                                                        |
| **Signposts**                             | MapLibre phase 4 slips past 2027; deck.gl still "not production ready"                                 | A top-5 engine ships WebGPU-only defaults; deck.gl extensions ported                                         | Slang gets JS bindings + a WGSL/GLSL web story (34% adoption today); `@typegpu/gl` announces compute or bind groups                                                       |
| **Probability (judgement, not measured)** | ~50%                                                                                                   | ~30%                                                                                                         | ~20%                                                                                                                                                                      |
| **Response**                              | Run the plan as written: embedding (§6) + option selling (§7)                                          | Pivot the headline to typed+proof (D1) immediately; adapters become convenience, oracle+fp64 carry the value | Retreat to what the platform will not do: the oracle, the _complete_ GLSL ES 3.00 backend, fp64, shader CI (line B). Consider absorption (D5). Do **not** fight on syntax |
| **What is robust in all three**           | The oracle + gate corpus; the anchor tenant; the adapters as a distribution channel; zero dependencies |                                                                                                              |                                                                                                                                                                           |

The bottom row is the point of the exercise: **the investments that pay in all three worlds are the proof layer and the embedding layer** — which is why §2.3 says build (4)+(5)+(7) and harvest (8).

---

## 9. Risk register

L/I on 1–5; score = L×I. Trigger = the observable that fires the mitigation.

| ID      | Risk                                                                                             | L   | I   | Score  | Owner            | Trigger                                                              | Mitigation                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------ | --- | --- | ------ | ---------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **R1**  | **Anchor-tenant collapse** — owner stops maintaining X-GIS, funding _and_ reason vanish together | 3   | 5   | **15** | owner            | Any month X-GIS ships no shader change                               | §6 in full: embed the reason in other libraries; reach rung 3+ on ≥1 host                           |
| **R2**  | **Bus factor 1** — maintainer unavailable                                                        | 3   | 5   | **15** | owner            | Two consecutive months below the §11.2 floor                         | Publish BF-1 + 90-day dead-man switch (§11.7); mirror + provenance                                  |
| **R3**  | Never crosses the chasm — stays a 0-star library                                                 | 4   | 3   | **12** | owner            | 0 external playground sketches and 0 adapter installs at month 6     | Whole-product gaps first (playground, matrix, governance — §5.3); stop marketing until fixed        |
| **R4**  | Competitor closes the gap (TypeGPU GLSL backend; Slang on the web)                               | 3   | 4   | **12** | owner            | `@typegpu/gl` announces compute/bind groups; Slang ships JS bindings | Deepen the proof moat; S3 response (§8); do not fight on syntax                                     |
| **R5**  | Dual-target thesis expires while it is still the headline                                        | 3   | 4   | **12** | owner            | A top-5 engine ships WebGPU-only defaults                            | D1: re-order the positioning **now**, not at the signpost                                           |
| **R6**  | Funding never materialises; the floor is unpaid                                                  | 3   | 3   | 9      | owner            | 0 line-A enquiries by month 12                                       | G (anchor tenant) covers the floor by construction; pursue H/I over C/F (§11.3)                     |
| **R7**  | Trademark blocked or opposed in KR/EU                                                            | 2   | 4   | 8      | owner + attorney | KIPRIS or an attorney search returns a conflict                      | Re-name **before** the launch post; PS App. A holds the runner-ups (Twinshade, Bitgil)              |
| **R8**  | API instability burns early adopters                                                             | 3   | 3   | 9      | owner            | A third `⚠ BREAKING` after the tag                                   | Freeze via `api-surface.test.ts` at `0.1.0` (PS §1); publish the `0.x` policy (§11.6)               |
| **R9**  | Supply shock from a validator/spec change (Tint/naga/WGSL)                                       | 2   | 3   | 6      | owner            | A compile gate reds on an unchanged tree                             | Gates are pinned + quarterly spec review (§11.1); zero deps limits blast radius                     |
| **R10** | Security / supply-chain incident on npm                                                          | 2   | 4   | 8      | owner            | Any advisory naming the org                                          | 0 deps (measured), npm provenance + trusted publishing, 2FA on the org (PS App. B.2), `SECURITY.md` |
| **R11** | Doc-traffic-dependent monetisation collapses (the Tailwind failure)                              | 4   | 2   | 8      | owner            | Docs traffic falls while usage grows                                 | Never fund on doc traffic (PS §5); sell what an agent cannot substitute (A, B)                      |
| **R12** | Adapter matrix rots and lies                                                                     | 2   | 4   | 8      | owner            | A matrix cell not re-run in 30 days                                  | Matrix is CI-generated only; a stale cell fails the build rather than rendering green               |

---

## 10. Three Horizons — roadmap and investment split

| Horizon                                                            | Content                                                                                                         | Share of discretionary effort                    | Gate to fund the next                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| **H1 — core compiler + adapters + playground**                     | `0.1.0` tag and freeze; playground; `@typeshade/maplibre` + `@typeshade/deck`; the matrix; MCP tool; governance | **70%**                                          | `0.1.0` shipped; matrix green; ≥1 host docs listing (§6.5) |
| **H2 — verification / Pro toolchain (PS §3B) + services (PS §3A)** | Shader CI for customers, `semanticDiff` PR reports, support SLA; line-A engagements                             | **25%**                                          | Two external consumers on a tagged release (PS §6.5)       |
| **H3 — hosted / platform (PS §3C/D/F)**                            | Effects catalog, course, or a hosted editor                                                                     | **5%** (option-keeping only: watch, don't build) | Playground evidence shows _what people make_ (PS §6.5)     |

The maintenance floor (§11.2) sits **outside** this split — it is a fixed cost, not an investment. H3 stays at 5% until PS §6.5's third rung fires; funded comparables already occupy it (Unicorn, Paper, Rive — PS §2).

---

## 11. Governance, maintenance model and funding

### 11.1 What "maintained" means, concretely

| Commitment                            | Mechanism                                                                              | Today                           |
| ------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------- |
| Both targets compile on every commit  | Tint + WebGL2 gates in CI (`_wgsl-compile-gate`, `_glsl-compile-gate`)                 | DD D6 ✅                        |
| Emit does not move without a decision | byte goldens + `baked-sync.test.ts`                                                    | DD §6 ✅                        |
| The two backends still agree          | oracle parity + generated-program differentials                                        | DD D6.1; CHANGELOG #2416 ✅     |
| Public surface grows by decision      | `api-surface.test.ts`                                                                  | PS §1 ✅ (freeze needs the tag) |
| Nothing rots                          | zero dependencies (measured 0/0/0)                                                     | ✅                              |
| Goldens regenerate honestly           | never in a PR that also changes behaviour; a re-bake is its own commit with its reason | DD §6; CLAUDE.md §12 (#2117)    |
| Browser-spec tracking                 | quarterly review: WGSL spec, Tint/naga releases, gpuweb implementation-status          | new                             |

### 11.2 Maintenance SLA — what is guaranteed, at what cadence, at what cost

Hours are a **proposed budget, not a measurement**; each line names what keeps it small.

| Guarantee                            | Cadence                             | h/month | Why it is this small                                  |
| ------------------------------------ | ----------------------------------- | ------- | ----------------------------------------------------- |
| Compile gates green on both backends | every commit                        | 3       | 146 test files run in ~52 s (DD §0: 1544 tests, 52 s) |
| Security fix acknowledged            | 72 h                                | 0.5     | Zero deps ⇒ no transitive-CVE churn                   |
| Issue triaged                        | 7 days                              | 4       | —                                                     |
| Release + changelog                  | monthly                             | 1       | `bun run changelog` generates it                      |
| Spec / validator review              | quarterly                           | 2       | Batched; one page per quarter                         |
| Docs · `llms.txt` · MCP tool         | with each release                   | 2       | Generated from source where possible                  |
| Adapter matrix regenerated           | every commit + on each host release | (in CI) | Machine-generated; a stale cell fails the build (R12) |
| **Floor**                            | —                                   | **≈12** | Below this ⇒ declare reduced maintenance (§11.7)      |

### 11.3 Funding ladder — extending PS §3 A–F, ranked by expected value × timing

| Line                                         | Shape                                                           | EV                           | Earliest             | Precedent, with numbers                                                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------- | ---------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** (PS §3A)                               | Migration / integration services                                | highest, day 0               | now                  | Software Mansion / TypeGPU (PS §2)                                                                                                                                                            |
| **G — anchor-tenant contract**               | X-GIS formally funds the §11.2 floor as a cost of its own build | **high, certain, immediate** | now                  | Internal; §3's 878,943-byte dependence is the justification                                                                                                                                   |
| **H — fellowship / maintainer-in-residence** | Fixed-term, fully funded, one named deliverable                 | high per event, lumpy        | after `0.1.0`        | Zod × Clerk: a **12-week** funded fellowship to ship Zod 4 (zod.dev/blog/clerk-fellowship, 2024-06-11)                                                                                        |
| **B** (PS §3B)                               | Shader CI / verification as a product                           | high, slow                   | 2 external consumers | —                                                                                                                                                                                             |
| **I — absorption-in-place**                  | Acquired or salaried; project stays MIT                         | high, unpredictable          | any                  | Cloudflare×Astro 2026-01-16 (Astro Ecosystem Fund with Webflow, Netlify, Wix, Sentry); Cloudflare×VoidZero 2026-06-04 (MIT retained, team keeps leading); Vercel×Svelte, governance unchanged |
| **J — grants**                               | NLnet NGI Zero and similar                                      | low, non-dilutive            | now                  | PS §3E                                                                                                                                                                                        |
| **E** (PS §3E)                               | Sponsorship                                                     | **low; never payroll**       | now                  | PixiJS **$118,918.03** lifetime / est. **$40,250.02/yr** / 168 contributors (opencollective.com/pixijs); Zod ~**$2,600/mo** (zod.dev)                                                         |
| C/D/F                                        | Effects · course · SaaS                                         | need an audience first       | PS §6.5              | PS §2                                                                                                                                                                                         |

**Disagreement with PS, recorded.** PS §3E lists sponsorship as a day-0 line. It is — but the two best-funded comparables in this class are both _below one salary_ at adoption levels TypeShade will not reach for years. Sponsorship is a credibility signal, not a runway; rank G and H above it. And PS's implicit framing of acquisition as failure is wrong for 2026: for web tooling, **a vendor paying the maintainer is the modal good outcome** (line I).

### 11.4 The anchor-tenant principle

X-GIS is the first customer that keeps TypeShade alive regardless of external adoption; the dependence is measured (§3) and mutual. Three consequences: (1) the maintenance floor is already paid — publishing adds packaging and support, not compiler work; (2) the anchor must not distort the API — every X-GIS-shaped feature is a hostage, and `api-surface.test.ts` plus the private `core/` (DD §5) are the defence; (3) an anchor tenant is a single point of failure (R1), which is precisely what §6 exists to fix.

### 11.5 RACI — recurring duties

Roles: **O** owner/maintainer · **S** named successor · **A** anchor tenant (X-GIS) · **H** host communities & contributors · **E** external professionals (attorney, MoR).

| Duty                                        | O       | S       | A     | H     | E     |
| ------------------------------------------- | ------- | ------- | ----- | ----- | ----- |
| Compile gates + goldens + oracle green      | **A/R** | C       | I     | I     | —     |
| Golden regeneration decision                | **A/R** | C       | C     | I     | —     |
| Release train + changelog                   | **A/R** | C       | I     | I     | —     |
| Browser/validator spec review               | **A/R** | C       | I     | C     | —     |
| Adapter + compatibility matrix              | **A/R** | C       | I     | **C** | —     |
| Upstreaming (rungs 2–4)                     | **A/R** | I       | I     | **C** | —     |
| Security response                           | **A/R** | **C**   | I     | I     | —     |
| Trademark, entity, merchant-of-record       | **A**   | I       | I     | —     | **R** |
| Funding (lines A/G/H)                       | **A/R** | I       | **C** | I     | C     |
| Declaring reduced maintenance / EOL         | **A/R** | **C**   | **C** | I     | —     |
| Taking over after the dead-man switch fires | I       | **A/R** | I     | I     | —     |

### 11.6 Compatibility promise

Semver from `0.1.0`, with `0.x` minors allowed to break and the README saying so · `@deprecated` with a named replacement for one full major before removal · breaking changes under `⚠ BREAKING CHANGES` (the generator already emits that heading — two entries in 2026-09) · previous major gets security + compile-gate fixes for **12 months** after the next major · `@xgis/shader-dsl` stays an alias for one major (PS §3) · adapters version independently and the matrix (§6.2) is their contract.

### 11.7 "The maintainer disappears" protocol

| Step                              | Mechanism                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mirror + provenance**           | X-GIS, the public mirror (`typeshade/typeshade`: 464 commits, 0 stars, fetched 2026-09-07), and npm with provenance                                                                                                                                                                                             |
| **Resume-from-cold is in-tree**   | `AUTHORING.md` (1,608 lines, measured), `AGENTS.md`, `docs/adr/`, and this document                                                                                                                                                                                                                             |
| **Dead-man switch**               | `GOVERNANCE.md` names a successor: no release and no maintainer response for **90 days** ⇒ the successor may take commit and publish rights. Without this written down, an inactive project cannot be rescued, only forked                                                                                      |
| **Reduced maintenance, declared** | Below the §11.2 floor for two months, the README banner becomes "security and compile-gate fixes only". Declaring preserves trust; drifting silently destroys it                                                                                                                                                |
| **EOL that preserves users**      | (a) 6 months' notice in README, changelog and site; (b) a final release with every deprecation resolved; (c) `npm deprecate` naming the successor or fork; (d) a `FROZEN.md` pinning last-verified host, browser and Tint/naga versions; (e) transfer the org, or archive it with the trademark position stated |
| **Why users survive it**          | The emitted artifacts keep working regardless — the output is plain WGSL and GLSL text with no runtime                                                                                                                                                                                                          |

---

## 12. OKRs — next 12 months

Aligned to the PS §6.5 KPI ladder and PS §8 sequencing.

| Objective                                                         | Key results                                                                                                                                                                                                                                                                                                                  | KPI-ladder rung                  |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **O1 — Exist publicly, and be credible on inspection**            | KR1.1 `0.1.0` tagged with `api-surface.test.ts` as the freeze, by end of Q1 · KR1.2 playground live with ≥ 20 non-owner sketches/month by month 6 · KR1.3 `GOVERNANCE.md` (bus factor + dead-man switch) and `SECURITY.md` published at tag · KR1.4 npm release with provenance, monthly train, 0 missed months in Q2–Q4     | Day 0 → "two external consumers" |
| **O2 — Embed in one host ecosystem deep enough to outlive X-GIS** | KR2.1 `@typeshade/maplibre` + `@typeshade/deck` published, each with a runnable example, by month 6 · KR2.2 host×adapter×backend matrix green in CI and published by month 4 · KR2.3 ≥ 1 host docs/ecosystem listing (rung 2) by month 9 · KR2.4 ≥ 3 host issues/PRs not authored by the owner mention TypeShade by month 12 | §6.5                             |
| **O3 — Fund the floor without depending on adoption**             | KR3.1 anchor-tenant contract (line G) written and the ~12 h/month floor explicitly budgeted, by end of Q1 · KR3.2 ≥ 2 line-A outbound conversations by month 6 · KR3.3 ≥ 1 paid engagement **or** a funded fellowship (line H) by month 12 · KR3.4 0 months below the §11.2 floor                                            | PS §6.5 day-0 rung               |

### 12.1 Quarter gates with kill / pivot criteria

| Quarter | Gate                                                                                             | Kill / pivot if                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q1**  | `0.1.0` tagged; playground live; matrix green; governance published; trademark filed             | Trademark blocked in KR 09/42 ⇒ re-name **before** launch, from PS App. A's runner-ups                                                       |
| **Q2**  | ≥ 20 external sketches/month **or** ≥ 1 host docs listing                                        | 0 external sketches **and** 0 adapter installs after 3 months ⇒ the artifact is not shareable: stop marketing, fix the whole product (§5.3)  |
| **Q3**  | Two external consumers on a tagged release ⇒ line B opens                                        | No external consumer by month 9 ⇒ fall back to anchor-tenant + embedding only: cut C/D/F permanently, hold the floor, keep pushing rungs 3–4 |
| **Q4**  | A+B revenue exceeds the floor's opportunity cost; foundation criteria (§11 stage table) reviewed | 0 line-A enquiries in 12 months ⇒ services is not a business here: pursue H/I, not C/F                                                       |

**Invariant across all four:** the §11.2 floor is funded by the anchor tenant and does not depend on any gate above being met. That is what makes this survivable.

---

## 13. Decision log — owner

| #       | Decision                                                                                                                                                                                                                                                         | Options                                                                                                                                                                                                                                                                                             | Recommendation                                                                                                                                                                                                      | Deadline                              | Unblocks                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| **D1**  | The headline claim (PS §4 leads with dual-target)                                                                                                                                                                                                                | (a) keep; (b) lead with _typed + proven_, dual-target as the first proof                                                                                                                                                                                                                            | **(b)** — §1.4/§7: the option expires; the largest audience (three.js) is already served                                                                                                                            | before site copy freezes              | Landing page (§14), launch post, 2030 positioning                                     |
| **D2**  | How far up the upstreaming ladder                                                                                                                                                                                                                                | (a) rungs 1–2 only (solo, code); (b) commit to rungs 3–4 (host relationships, months)                                                                                                                                                                                                               | **(b) for MapLibre only**, (a) elsewhere                                                                                                                                                                            | Q1                                    | The whole §6 programme; the answer to R1                                              |
| **D3**  | Bus factor, publicly                                                                                                                                                                                                                                             | (a) say nothing; (b) publish `GOVERNANCE.md` with BF-1 named + the 90-day switch                                                                                                                                                                                                                    | **(b)** — evaluators check for it; an undisclosed BF-1 discovered later costs more                                                                                                                                  | at `0.1.0`                            | Services/enterprise conversations; foundation path                                    |
| **D4**  | Agent surface scope                                                                                                                                                                                                                                              | (a) `llms.txt` only; (b) `llms.txt` + MCP compile/validate tool + agent skill                                                                                                                                                                                                                       | **(b)** — MCP is a governed standard (Linux Foundation, Dec 2025); `llms.txt` adoption is ~10.13% of 300,000 domains with no provider confirming production use                                                     | Q1                                    | O1, the §4.2 gain creator                                                             |
| **D5**  | Absorption posture                                                                                                                                                                                                                                               | (a) independent forever; (b) _prepare_ to be acquired-in-place without seeking it                                                                                                                                                                                                                   | **(b)** — line I is the modal good outcome (Cloudflare×Astro, ×VoidZero, Vercel×Svelte)                                                                                                                             | before any CLA/licence choice         | Licensing and org structure, expensive to reverse                                     |
| **D6**  | Anchor-tenant consumption model                                                                                                                                                                                                                                  | (a) X-GIS keeps importing by source path; (b) X-GIS consumes a published, versioned TypeShade after `0.1.0`                                                                                                                                                                                         | **(b)** — the only way the §11.6 promise is tested by someone who notices                                                                                                                                           | Q2                                    | Forward-compat contract; matrix credibility                                           |
| **D7**  | Playground timing (PS §10 Q3 asked _whether_; this asks _when_)                                                                                                                                                                                                  | (a) after `0.1.0`; (b) before, as the launch centrepiece                                                                                                                                                                                                                                            | **(b)** — §5.3: no flywheel without a shareable URL; PS §8 already puts it in Phase 0                                                                                                                               | Q1                                    | O1 KR1.2, launch sequencing                                                           |
| **D13** | First adapter and beachhead host — §6.4 here and the go-to-market plan (§1) rank MapLibre first; the ecosystem-embedding deep-dive (`2026-09-07-typeshade-ecosystem-embedding.md` §4, authoritative for hosts per §6) ranks **PixiJS → MapLibre → deck.gl/luma** | (a) MapLibre first, as the GTM beachhead; (b) PixiJS adapter first (M1) — the only host paying the twin-shader tax today by API design (`Shader.from({gl, gpu})`), cheapest high-reach rung (a Skill inside the npm tarball) — with MapLibre carrying the launch narrative and shipping second (M3) | **(b)** — "pain now" is the chasm-crossing criterion; the launch bundle ships no adapter either way, so the GTM's MapLibre narrative is unaffected; re-run GTM §1's targeting matrix and §5's schedule once decided | before the first adapter's spike (M1) | The adapter build order; GTM §1 / §5; §6.4's ranking is superseded by the deep-dive's |

---

## 14. Implications for the website and marketing

The site brief (`docs/design/00-brief.md`, v2, 2026-09-07) fixes the _form_ ("advertise, do not explain"; hero ≤ 6 words; a live compiled shader as the main object). This fixes the _content_. **3 seconds:** _this is real and it already runs_ — a shader TypeShade compiled, rendering live. **10 seconds:** typed TypeScript in, WGSL **and** GLSL ES 3.00 out, proven to agree.

| Credibility signal (evaluators scan for these — brief, Audience 3) | Concrete form                                                                           | Ready?                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------- |
| Changelog with dates                                               | generated `CHANGELOG.md`, already carries `⚠ BREAKING CHANGES`                          | ✅                                            |
| Release cadence                                                    | monthly train, visible release list                                                     | after `0.1.0`                                 |
| CI badges that mean something                                      | "compiles on Tint" · "compiles on WebGL2" · "oracle parity" — not a generic build badge | ✅ (gates exist)                              |
| **Host compatibility matrix** (§6.2)                               | host × adapter × backend, generated                                                     | **the differentiator — nobody publishes one** |
| Used in production                                                 | X-GIS (144 importing files, 878,943 emitted bytes, measured) and dc4i.js (PS §0)        | ✅                                            |
| Governance page                                                    | `GOVERNANCE.md` incl. bus factor + dead-man switch (D3)                                 | pending                                       |
| Zero dependencies                                                  | shown as `0`, `package.json` linked                                                     | ✅ (measured)                                 |

**Do not claim yet** — being caught once costs the proof positioning permanently: ❌ "production-ready" / "1.0" (two BREAKING entries in the 2026-09 changelog alone) · ❌ `npm i typeshade` as the primary CTA (a `0.0.0` placeholder, PS App. B.2; the downloads API returns no record — measured) · ❌ "Used by <host>" for any host (an adapter is not adoption — §6.3) · ❌ any star or download number (0 stars on the mirror, 3 on X-GIS) — show _proof_ numbers, never audience numbers · ❌ "replaces TypeGPU / TSL" (one honest row each, PS §7 item 9, including the row saying three.js users may not need this) · ❌ multi-target MSL/HLSL/SPIR-V as a TypeShade feature — it is "via naga/Tint" (PS §1).

---

## 15. Sources

**Measured on this tree, 2026-09-07** (branch `claude/shaderdsl-monetization-strategy-sr64wo`, HEAD `c2ba38cb`): `find map/src/shaders/dsl -name '*.ts' ! -name '*.test.ts' | wc -l` → 58 · same `-exec cat {} + | wc -l` → 14,063 · `grep -rl "shader-dsl" map/src compiler/src --include=*.ts | wc -l` → 144 (map 125 · site 24 · compiler 19 · rhi-webgl2 6 · rhi-webgpu 3 · playground 1) · `cat map/src/shaders/baked/*.generated.ts | wc -c` → 878,943 · `find shader-dsl/src -name '*.ts' ! -name '*.test.ts'` → 108 files / 27,727 LOC · `find shader-dsl -name '*.test.ts' | wc -l` → 146 · `shader-dsl/package.json` → 0 deps / 0 peerDeps / 0 devDeps · `wc -l shader-dsl/AUTHORING.md` → 1,608.

**Measured against public registries, 2026-09-07** (`registry.npmjs.org/<pkg>`, `api.npmjs.org/downloads/point/last-week/<pkg>`): three 0.185.1 (2026-07-01) 14,025,392/wk · pixi.js 8.20.1 (2026-08-26) 920,303 · @babylonjs/core 9.25.0 (2026-09-03) 272,819 · maplibre-gl 6.7.0 (2026-09-02) 4,366,094 · deck.gl 9.4.0 (2026-09-05) 202,573 · @luma.gl/core 9.4.0 (2026-09-05) · typegpu 0.12.4 (2026-08-28) 142,702 · regl 2.1.1 (2024-11-12) 776,433 · glslify 7.1.1 (2020-09-02) 565,493 · gl-matrix 3.4.4 (2025-08-08) · zod 4.5.4 · esbuild 0.28.2 · vite 8.2.2 · astro 7.3.1 · svelte 5.57.0 · `maplibre-gl@6.7.0` deps include `earcut ^3.2.3`, `pbf ^5.1.2`, `gl-matrix ^3.4.4` · `typeshade` and `@xgis/shader-dsl` return no download record.

**Fetched 2026-09-07:** khronos.org/blog/shader-ecosystem-survey-results-2026 (>400 respondents, 2026-06-16→07-10; 64% / ~10% / 53%; GLSL 60 · HLSL 41 · SPIR-V 39 · Slang 34; WGSL 14.9% n=60 via the gamedev.net summary) · caniuse.com/webgpu (87.35%) · github.com/gpuweb/gpuweb/wiki/Implementation-Status · threejs.org/manual/en/webgpurenderer.html · pixijs.com/8.x/guides/migrations/v8 · maplibre.org/roadmap/maplibre-gl-js/graphics-modernization/ · maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/ · deck.gl/docs/developer-guide/webgpu · luma.gl/docs/api-reference/webgpu · openjsf.org/blog/deckgl-v9 · vis.gl · opencollective.com/pixijs · docs.swmansion.com/TypeGPU/ecosystem/typegpu-gl/ · github.com/wgsl-tooling-wg/wesl-spec (WESL 0.2, May 2026; edition `2026_pre`) · github.com/gfx-rs/wgpu (naga develops inside wgpu; Mozilla is the CVE numbering authority) · cloudflare.com press release "Cloudflare Acquires Astro…" (2026-01-16) · voidzero.dev/posts/voidzero-cloudflare (2026-06-04) · vercel.com/blog/vercel-welcomes-rich-harris-creator-of-svelte · astro.build/blog/goodbye-astro-studio/ · zod.dev/blog/clerk-fellowship (2024-06-11) · github.blog/ai-and-ml/llms/why-ai-is-pushing-developers-toward-typed-languages/ (2026-01-08, citing arXiv 2504.09246 and Octoverse 2025) · devclass.com/2026/01/08/tailwind-labs-lays-off-75-percent-… · blog.modelcontextprotocol.io/posts/2026-07-28/ + MCP ecosystem statistics (donated to the Agentic AI Foundation under the Linux Foundation, Dec 2025; >10,000 public servers) · llms.txt adoption 10.13% of 300,000 domains (SE Ranking, early 2026, via state-of-llms-txt-2026 summaries; no major provider has confirmed production use as of Q1 2026) · github.com/typeshade/typeshade (464 commits, 0 stars) · en.wikipedia.org/wiki/Babylon.js · en.wikipedia.org/wiki/Shadertoy (founded 2013 by Pol Jeremias and Íñigo Quílez; **no public funding or governance data found — recorded as unknown, not zero**).

**From memory (not fetched, flagged per the discipline):** Kotler & Pfoertsch, _Ingredient Branding_ (2010) · Brandenburger & Nalebuff, _Co-opetition_ (1996) · Shapiro & Varian, _Information Rules_ (1999) · Evans, _Domain-Driven Design_ (2003) · Baldwin & Clark, _Design Rules_ (2000) · Moore, _Crossing the Chasm_ (1991) · Porter's Five Forces (1979) · Wardley mapping · McKinsey Three Horizons · Osterwalder's Business Model / Value Proposition Canvas · the Linux "upstream first" norm · "Intel Inside" launched 1991.

**In-repo:** `docs/plans/2026-09-07-shader-dsl-standalone-product-strategy.md` (PS) · `docs/plans/2026-09-01-shader-dsl-improvement-direction.md` (DD) · `shader-dsl/README.md` · `shader-dsl/CHANGELOG.md` · `shader-dsl/package.json` · the site brief at `…/scratchpad/typeshade.github.io/docs/design/00-brief.md` (v2, 2026-09-07) · `docs/plans/2026-09-07-typeshade-ecosystem-embedding.md` (parallel deep-dive; absent at the time of writing — re-check before acting on §6).
