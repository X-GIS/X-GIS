# Audit ⑧ — Error handling, device-loss recovery & observability

_Deep-research synthesis, 2026-06-08. File:line audit of X-GIS error/device-loss/observability merged with WebGPU error-handling + device-loss research (W3C/MDN/toji). Part of the 10-audit series. Claims cited inline._

---

## TL;DR

This is the audit with the **most serious production gaps** so far — and they are concentrated, not diffuse. X-GIS **detects** device loss but has **no recovery path** (the render loop halts permanently); it **swallows** WebGPU validation-error-scope rejections (`.catch(() => {})`); and it exposes **no `'error'` event** on the map API, so an embedding app has no declarative way to observe a GPU fault. The good news: the WebGPU spec makes recovery a well-defined, mechanical contract, and two of the three critical fixes are small. The device-loss-recovery rebuild is the one genuinely large piece of work.

---

## A. Architecture (as audited)

A multi-layer scheme exists: validation errors via frame/pass `pushErrorScope('validation')` + a global `uncapturederror` listener; device-loss detection via `device.lost.then(...)` → a `deviceLost` guard flag; worker errors via `error` events + message-based failure reporting; user affordances via optional `onDeviceLost`/`onWebGPUUnavailable` callbacks; observability via `xlog` + a test-only validation-error queue. The pieces are present — but several are **detect-but-don't-act**.

## B. Findings (file:line, severity)

### B1 — No device-loss recovery — CRITICAL

`gpu.ts:214-223` sets `ctx.deviceLost = true` and calls `onDeviceLost?.(info)`, and `render-loop.ts:126` then `return`s — the loop **halts with no reschedule and no rebuild** of pipelines/textures/bind groups. Any transient GPU fault (driver reset, tab-backgrounding watchdog, GPU-process crash, eGPU disconnect) **permanently kills the map**; the embedding app must destroy and recreate it.
**The spec gives the exact recovery contract** [W3C/MDN/toji, high]: `device.lost` is a promise that **resolves (never rejects)** with `{reason, message}` — `reason==='destroyed'` only for an intentional `destroy()`, else `'unknown'`; on any non-`destroyed` loss, **re-request a fresh adapter then a new device** (the adapter is single-use — call `requestAdapter()` again before each `requestDevice()`, "never give up"), **rebuild every GPU resource** (all are permanently invalid), and **`context.configure({device:newDevice,...})`** to rebind the canvas — there is **no `contextlost` event** in WebGPU because the canvas context is decoupled from the device [Explainer, high]. **Fix:** implement that loop; large but well-specified. (Note `render-targets.ts:85-150` recreates only on resize, not on device loss, so even a hypothetical recovery would leave stale RT views.)

### B2 — Swallowed validation-error-scope rejections — HIGH (cheap fix)

`render-loop.ts:291-294` and `:542-544` `popErrorScope().then(err => err && xlog.error(...)).catch(() => {})` — the `.catch(() => {})` **silently drops** a rejected pop (scope-stack mismatch, device lost). Validation errors that _resolve_ are logged; rejections vanish. **Fix:** remove the silencers, log rejections. (Also: error scopes must wrap **synchronous** code only — wrapping an `await` misattributes later errors [toji, med]; worth auditing the frame-scope span.)

### B3 — No `'error'` event on the map API — CRITICAL (medium fix)

`layer.ts:437-441` `XGISMapEventType` is `'load'|'idle'|'move*'|'zoom*'` — **no `'error'`/`'rendererror'`**. Device loss, validation errors, worker crashes, and OOM reach `console.error`/the test queue but **never surface as an observable event**, so apps can't show a "render error — reload" UI or wire telemetry. The reference is MapLibre/Mapbox's `map.on('error')` event, the standard surface for exactly this. **Fix:** add `'error'` to the event type + a typed payload, fire it from the device-loss/OOM/validation critical paths. (`onDeviceLost` is a one-shot callback that must be registered before load — not an event.)

### B4 — Unbounded `uncapturederror` queue in production — MEDIUM (leak)

`gpu.ts:234-239` pushes every uncaptured error into `ctx._validationErrors`, which **tests drain but production never does** — a slow memory leak on a long session with a per-frame validation error, and `xlog.error` fires **60×/s with no dedup/rate-limit** for a persistent shader bug. (Note `uncapturederror` is main-thread-only and "may" fire — use it for telemetry, not correctness [W3C, high].) **Fix:** bound/drain the queue; rate-limit/dedup the log.

### B5 — Worker & OOM errors logged, not surfaced — MEDIUM

GeoJSON/PMTiles worker compile errors go to `console.error`/`xlog.error` and the tile **silently fails to compile** (`geojson-compile-pool.ts:148`, `pmtiles-backend.ts:413`); on a worker crash, `mvt-worker-pool.ts:161-169` rejects all in-flight compiles with **no restart**. `GPUArena.alloc()` throws detailed OOM diagnostics (`gpu-arena.ts:246-252`) but **tile-upload callers don't catch it** → crash on OOM rather than the spec's fallible-allocation pattern (`pushErrorScope('out-of-memory')`). **Fix:** route worker/OOM failures into the new `'error'` event (B3); wrap large allocations in an OOM scope.

### B6 — Zero-size canvas spins silently — LOW

`render-loop.ts:171-172` early-returns on a 0×0 canvas and re-`requestAnimationFrame`s forever with no log/event — a hidden/removed container leaves the loop spinning. Low impact, but worth a one-time warning.

## C. What's robust

Canvas resize is correct and idempotent (`gpu.ts:244-258` re-`configure` each frame, called early in the loop); `WebGPUUnavailableError` is caught specifically and fires `onWebGPUUnavailable` (no browser crash); the test-side validation-capture (`uncapturederror` → queue → `getValidationErrors`) is solid infra that lets tests assert zero WebGPU errors; worker-crash rejection prevents hangs; OOM diagnostics are detailed. The detection machinery is good — it's the _act-on-it_ half that's missing.

## D. Top fixes (ranked)

1. **Un-swallow validation rejections** (B2) — delete `.catch(() => {})`, log them. Minutes; immediate debugging win.
2. **Add a map `'error'` event** (B3) — the single highest-leverage observability change; unlocks B5 (route worker/OOM into it) and telemetry. Medium.
3. **Device-loss recovery loop** (B1) — implement the spec contract (fresh adapter → new device → rebuild all → `context.configure`). Large but mechanical and fully specified; pairs with a "reconnecting" UI state.
4. **Bound the `uncapturederror` queue + rate-limit logs** (B4) — small; stops the long-session leak/log-flood.

> Cross-link: B1/B5 interact with Audit ②'s OOM note (no GPU memory-budget API; `pushErrorScope('out-of-memory')` is the only signal) and Audit ①'s "completion must reach the frame loop" principle (here it's _failure_ that must reach the app).

---

## Sources

**Codebase audit (file:line):** `gpu.ts:95-98,112-114,214-223,233-258` (device.lost, uncapturederror queue, resize), `render-loop.ts:126,171-172,276,291-294,542-544` (halt, zero-size, error scopes), `render-targets.ts:85-150`, `gpu-arena.ts:246-252` (OOM throw), `vector-tile-renderer.ts:1695`, `layer.ts:437-441` (event types — no 'error'), `map.ts:782-784,794-805` (onDeviceLost/onWebGPUUnavailable), `data/workers/{mvt-worker-pool.ts:156-169, geojson-compile-pool.ts:148, pmtiles-backend.ts:413}`.
**WebGPU error/device-loss research:** W3C ErrorHandling.md (async errors, 3 filter types, uncapturederror "may" fire, main-thread only) https://github.com/gpuweb/gpuweb/blob/main/design/ErrorHandling.md [high]; MDN GPUDevice.lost / GPUDeviceLostInfo (resolves-never-rejects, reason enum) [high]; MDN GPUInternalError (3rd filter type — Explainer is stale at 2) [high]; W3C Explainer (canvas decoupled from device → re-configure, no contextlost) [high]; toji webgpu-best-practices error-handling + device-loss (recovery contract, fresh-adapter-each-attempt, rebuild-all, sync-only scopes, loss causes) https://toji.dev/webgpu-best-practices/device-loss.html [med, authoritative practitioner].

_Confidence: the codebase audit (direct read) and W3C/MDN device-loss spec are load-bearing; the recovery-contract steps are spec-grounded. The map-`'error'`-event reference (MapLibre) and observability/telemetry recommendations draw on well-established practice; the dedicated observability web angle was still completing at synthesis time, so those recommendations lean on the codebase gap + general practice rather than a fresh fetch._
