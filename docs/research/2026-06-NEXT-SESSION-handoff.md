# Next-session handoff — continue on desktop (real GPU)

*2026-06-08. Read this first. The previous session ran in a GPU-less container; the next one runs on the user's desktop with a real GPU. This note is the single entry point: what's done, what real-GPU unlocks, and the recommended starting order. All work is committed + pushed to `claude/invalidation-perf-phase-HWrOU` (PR #223); the working tree is clean.*

## State of PR #223
- **Shipped code:** invalidation-perf phase (`post_change` oracle, S14 granular dirty bitset, S16 label-collision skip) + the **S16 staleness fix** (async glyph/sprite landing + time-driven labels). Build clean · runtime vitest green · CI (`test` + `render-gate`) green.
- **Diagnosed, no code change:** `#3 gamma` — sRGB-space blending is deliberate (matches MapLibre), documented at `gpu.ts:185`.
- **Research/analysis (docs only):** the rendering audit, the Blender-grounded "why hard" + shader-pipeline docs, and a **10-audit series** (`2026-06-audit-*.md`) with a master fix list in `2026-06-audit-series-index.md`. Plus the desktop execution plans in `2026-06-desktop-rendering-fixes.md`.

## Why the desktop matters (what this container could NOT do)
Measured here: flat synthetic fills render 56.75% under SwiftShader, but **extrusions render 0.00%** — the 3D extrude/depth pipeline does not rasterize under software GPU. So the real GPU unlocks the things CI can't validate (see Audit ③): **the real-GPU matrix gate** (`XGIS_MATRIX=1 bun precheck:matrix`), 3D extrude depth ordering, OIT, non-Mercator deep-zoom visuals, high-pitch, and pixel baselines. Run the matrix gate early to establish a green baseline before changing renderer code.

## Recommended starting order

### Step 0 — establish the real-GPU baseline
`XGIS_MATRIX=1 bun precheck:matrix` (real GPU, local/pre-push). Confirm current green/`expected_red`/`candidate` cells match the manifest. This is your safety net for everything below.

### Step 1 — Tier-1 quick wins (GPU-free, minutes-to-lines; do these first)
From `2026-06-audit-series-index.md` master list — high signal, low risk, mostly deterministic tests:
1. **Un-swallow validation-error rejections** — delete `.catch(()=>{})` at `render-loop.ts:291-294,542-544` (Audit ⑧).
2. **Glyph-PBF `onLanded` → re-arm `_needsRender`** at `text-stage.ts:812` (Audit ① B1) — fixes the visible label-freeze; the S16 follow-on.
3. **Pick pass visibility filter** — `interaction-controller.ts` vs `bucket-scheduler.ts:217` (Audit ⑩ B1).
4. **Layout-cache text-identity check** at `text-stage.ts:1359-1381` (Audit ④ B1) — kills the "일부만" scatter corruption.
5. **`expected_red`-flip alert** in the matrix manifest (Audit ③).
6. **Center-round pick coords** at `interaction-controller.ts:118-119` (Audit ⑩ B2).
Each should land with a unit/e2e test; verify the matrix gate stays green.

### Step 2 — the desktop-gated rendering items (need real-GPU eyes)
Full file:line plans already written in `2026-06-desktop-rendering-fixes.md`:
- **#2 azi/stereo `flatViewHeightCapM` cap** — pick the constant by headed-render framing review (candidate values in the plan). Quick visual.
- **#4b depth-ordering oracle** — build the synthetic-extrusion cell + `depth_order` detector (design in the plan + Audit ⑦). This gates #4. **Note:** the extrude pipeline rasterizes on real GPU, so the spike that failed under SwiftShader will now work — validate it renders + occludes before trusting it.
- **#4 correct WebGPU `[0,1]` depth + reversed-Z** — atomic change across the depth sites (`perspectiveMatrix` currently emits GL `[-1,1]`); gated by #4b. The depth/clip-space convention is spread across `camera.ts` + 3 `polygon.ts` paths (Audit ⑨/shader-pipeline), so consider adding the **depth round-trip CPU oracle** (Audit ⑥ recommendation) first to de-risk.

### Step 3 — decide OIT's fate (Audit ⑦, the biggest single finding)
OIT is **hardcoded off** (`bucket-scheduler.ts:284 isOitExtrude=false`) and the `ClassifiedShow→VTR` routing doesn't exist — so translucent extrusions composite order-*dependently* today. On real GPU you can finally see this. **Decide:** complete + test the routing (pairs naturally with #4b/#4 and a 3+-overlap test), or delete the dead code. Don't leave it half-wired.

### Step 4 — larger structural items (as priorities dictate)
Device-loss recovery (⑧ B1, fully specified), share the compiler↔runtime type / schema-validate (⑤), mobile `buildLineSegments` worker + compile worker pool (⑨), cross-tile symbol index + pauseable placement (④/⑨), glyph-atlas page reclaim + cache sizing (②).

## Pointers
- Master fix list with tiers + file:line: **`2026-06-audit-series-index.md`**.
- Each subsystem's detail: the ten `2026-06-audit-*.md` docs (each: TL;DR → findings file:line/severity → fixes → cited sources).
- Desktop rendering execution plans: **`2026-06-desktop-rendering-fixes.md`**.
- Branch: `claude/invalidation-perf-phase-HWrOU`. PR #223 (draft). Keep landing changes here unless told otherwise.
- Discipline that worked: every fix lands with a test (unit/compute where possible — GPU-free; matrix cell where it needs pixels); keep the matrix gate green; commit small, push often.
