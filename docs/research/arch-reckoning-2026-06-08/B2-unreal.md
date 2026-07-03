# B2 — Unreal Engine: Module/Subsystem Architecture & 25-Year Codebase Longevity

**Research question:** What keeps Unreal Engine's 25+ year C++ codebase extensible, and what — if anything — is worth stealing for a small WebGPU + TypeScript web-map renderer (X-GIS) aiming at 3D-tiles and 4D-city rendering?

**Stance:** Skeptical. Unreal is a native desktop/console C++ engine with a custom build tool, a reflection/GC runtime, and an editor that all co-evolved. Most of its machinery exists to solve problems X-GIS does not have (binary plugin compatibility, Blueprint/Python exposure, multiplayer replication, console certification). The transferable value is in the _principles_ (dependency direction, lifetime scoping, composition, registration over reference), almost never in the _mechanism_. Each section below ends with an explicit TRANSFERS / DOESN'T verdict.

---

## 1. The Module System

### What it is

> "Modules are the basic building block of Unreal Engine's (UE) software architecture." They "encapsulate specific functionality like editor tools, runtime features, or libraries into standalone code units." ([Epic — Unreal Engine Modules](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-modules))

Every project/plugin has a primary module; additional modules exist purely for code organization and build isolation.

### How boundaries are enforced

- Each module has a `[ModuleName].Build.cs` file (a C# class inheriting `ModuleRules`) that _declares its dependencies explicitly_. The build is driven by `Target.cs` + `Build.cs`, "not according to the solution files for your IDE." ([Epic — Modules](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-modules))
- **Public vs Private dependency lists** are the coupling control: `PublicDependencyModuleNames` is for modules referenced in _public headers_ (transitively exposed to dependents); `PrivateDependencyModuleNames` is for `.cpp`-only use. "Private dependencies are preferred wherever possible, as they can reduce your project's compile times." ([Epic — Modules](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-modules))
- **Public vs Private folders** enforce visibility at the filesystem level: headers in `Private` "will not be exposed to any modules outside its owning module"; headers in `Public` are exposed to any module that declares a dependency. ([Epic — Modules](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-modules))
- Modules are separate compilation units: "only modules that have changed will need to compile," so large-project build times stay bounded. ([Epic — Modules](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-modules))
- Boundary discipline is paired with **Include What You Use (IWYU)**: modules limit "header includes to code that is actually used," which "enforce good code separation, providing a means to encapsulate functionality and hide internal parts of the code." ([Epic — Modules](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-modules))

### Loading

- `IMPLEMENT_MODULE(FDefaultModuleImpl, ModuleName)` registers a module; a custom `IModuleInterface` subclass gives `StartupModule()`/`ShutdownModule()` hooks. ([Epic — Modules](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-modules); [kantandev — UE4 Code Modules](http://kantandev.com/articles/ue4-code-modules))
- Modules load by `LoadingPhase` (`PreDefault`, `Default`, etc.). Critically: **within a phase, load order is non-deterministic** — "if you have multiple modules within a LoadingPhase their loading order is not deterministic. If you need to ensure one module is loaded before another...use `LoadModule` / `LoadModuleChecked`." ([Epic — Modules](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-modules))

### Verdict: PRINCIPLE TRANSFERS, MECHANISM DOESN'T

- **Steal:** the _declared, directional dependency_ idea and the _public/private surface_ split. A small TS lib should have a handful of internal packages/modules each with an explicit public `index.ts` (the "Public folder") and everything else unexported (the "Private folder"). Enforce the dependency DAG with a linter (`eslint-plugin-boundaries`, `dependency-cruiser`, or TS project references) — this is the cheap, native-to-TS equivalent of `Build.cs` public/private dependency lists. X-GIS already has a documented module-DAG ambition (per the architecture docs); UBT validates that instinct.
- **Steal:** the "private dependency is cheaper" rule maps directly to TS — minimizing what each module re-exports keeps your type-check graph and rebuild surface small.
- **Don't steal:** `.Build.cs`, `UnrealBuildTool`, per-module DLLs, hot-reload of native modules, IMPLEMENT_MODULE, loading phases. These exist because UE compiles C++ to platform binaries and supports binary-distributed plugins; TS has the ES-module graph + a bundler that already does tree-shaking and incremental rebuild. Reimplementing a module loader is pure overhead.
- **Anti-pattern UE itself warns about:** non-deterministic intra-phase load order. The lesson for X-GIS: do **not** build a system where initialization order between subsystems is implicit. Make init order explicit and topologically derived from declared dependencies, not from import-evaluation side effects at module top-level (a classic TS footgun).

---

## 2. Subsystems (the most stealable idea)

### What they are

Subsystems are "automatically instanced classes with managed lifetimes." They exist explicitly to solve a longevity problem: **avoiding the complexity of modifying or overriding engine classes.** The stated benefits are "Subsystems save programming time," "Subsystems help you avoid overriding engine classes," and they prevent "cluttering existing classes with excessive functionality." They also auto-expose to Blueprint/Python and let plugins ship functionality "without requiring user integration code." ([Epic — Programming Subsystems](https://dev.epicgames.com/documentation/unreal-engine/programming-subsystems-in-unreal-engine))

### Lifetime scopes (this is the core insight)

Each subsystem type is tied to the lifetime of a host object, and is created/destroyed automatically with it:

| Subsystem    | Base class               | Lifetime / scope                                                               |
| ------------ | ------------------------ | ------------------------------------------------------------------------------ |
| Engine       | `UEngineSubsystem`       | Whole process; init after owning module `Startup()`, deinit after `Shutdown()` |
| Editor       | `UEditorSubsystem`       | Editor session                                                                 |
| GameInstance | `UGameInstanceSubsystem` | The game session; **persists across level/map loads**                          |
| World        | `UWorldSubsystem`        | One per `UWorld`/level; destroyed on level unload                              |
| LocalPlayer  | `ULocalPlayerSubsystem`  | Per local player                                                               |

Sources: ([Epic — Programming Subsystems](https://dev.epicgames.com/documentation/unreal-engine/programming-subsystems-in-unreal-engine); [Flying Rat — UE Subsystems](https://tech.flying-rat.studio/post/ue-subsystems.html); [UhiyamaLab — Choosing the Right Subsystem](https://uhiyama-lab.com/en/notes/ue/subsystem-gameinstance-world-localplayer/))

### Lifecycle & conditional creation

- `Initialize(FSubsystemCollectionBase&)` / `Deinitialize()` are called automatically; the `FSubsystemCollection` parameter lets one subsystem _pull_ references to other subsystems at init time (declared dependency, not global lookup). ([Flying Rat — UE Subsystems](https://tech.flying-rat.studio/post/ue-subsystems.html); [phillipbaxter — Writing Unreal Subsystems](https://phillipbaxter.com/ue4/ue5/unreal/2022/Unreal-Subsystems.html))
- `ShouldCreateSubsystem()` lets a subsystem opt itself out: "you can override it to control if the Subsystem should be created at all. For example you could only have your system created on servers." Called on the CDO before any instance is made. ([phillipbaxter — Writing Unreal Subsystems](https://phillipbaxter.com/ue4/ue5/unreal/2022/Unreal-Subsystems.html); [Epic — USmartObjectSubsystem::ShouldCreateSubsystem](https://docs.unrealengine.com/5.3/en-US/API/Plugins/SmartObjectsModule/USmartObjectSubsystem/ShouldCreateSubsystem/))
- Access is `GetSubsystem<UMySubsystem>()` off the host (`GEngine`, `GameInstance`, `UWorld`, `LocalPlayer`). ([Epic — Programming Subsystems](https://dev.epicgames.com/documentation/unreal-engine/programming-subsystems-in-unreal-engine))

### Why this matters for longevity

Subsystems are the modern UE answer to the singleton/God-object problem. The community framing is explicit: they are "Unreal-style singletons" but with _automatic, scoped lifetimes and dependency-injected access_ instead of a global `Instance` and manual init/teardown. ([unreal-garden — Unreal-style Singletons with Subsystems](https://unreal-garden.com/tutorials/subsystem-singleton/)) The key win is that adding a new engine-wide capability no longer means editing `GEngine` or a core class — you ship a new subsystem and it auto-registers.

### Verdict: PRINCIPLE STRONGLY TRANSFERS — this is the headline takeaway for X-GIS

X-GIS's own memory notes repeatedly diagnose **God-object state ownership** and **scattered singletons** as the #1 structural debt (`map.ts` ~2827 LOC, VTR ~5298 LOC, projection literals pinned across ~12 sites). The subsystem pattern is the direct cure, and it maps cleanly to TS _without_ any UObject/reflection machinery:

- **Steal the lifetime-scope taxonomy.** X-GIS has natural scopes that mirror UE's exactly:
  - _Process/Device scope_ (≈ EngineSubsystem): GPU device, adapter, pipeline cache, glyph atlas — created once with the renderer, survive style/source changes.
  - _Map-instance scope_ (≈ GameInstance/World): the per-`Map` session — camera, projection state, source registry, tile cache. Persists across `setStyle()`/source swaps the way GameInstance persists across level loads.
  - _Frame/View scope_ (≈ WorldSubsystem-ish): per-frame transient state (the `FrameContext` the codebase already has). This is the right place for things rebuilt each draw.
  - Defining these scopes explicitly tells you _where each piece of state lives_ — which is exactly the question the God-file audits keep failing to answer.
- **Steal `Initialize(collection)` dependency-pull.** A subsystem receiving its dependencies at init from a collection — rather than reaching into a global — gives you testable, ordered construction. In TS this is a small registry/container: each subsystem declares the subsystems it needs; the container topo-sorts and constructs. No DI framework required (honor the project's zero-deps rule).
- **Steal `ShouldCreateSubsystem` opt-out.** WebGPU feature detection, projection-specific machinery (globe-only ECEF systems), or dev-only diagnostics can self-gate their own creation instead of being conditionally wired by the `Map` constructor. This directly attacks the projection-blindness root cause noted in the audits.
- **Steal `Deinitialize`.** The ship-readiness audit flags the **missing `map.destroy()`** leaking GPU/workers/listeners as a top blocker. A subsystem contract where every scoped system has a mandatory `deinitialize()` makes teardown _compositional and total_ — `map.destroy()` becomes "deinitialize every map-scoped subsystem in reverse order," not a hand-maintained list that drifts.

### What's overkill / native-only — do NOT copy

- `UObject` derivation, `UCLASS`/reflection auto-exposure, Blueprint/Python binding — all gone in a TS lib; plain classes/interfaces suffice.
- The `GetSubsystem<T>()` template + CDO machinery — replace with a typed `getSystem(Token)` on a small container. TS generics + symbol/class tokens give the same ergonomics with none of the runtime.
- Five _fixed_ lifetimes — X-GIS needs ~2-3 (device, map, frame). Don't import scopes you have no host object for (there is no "LocalPlayer" or "Editor" analogue).

---

## 3. Actor / Component Model (composition over inheritance)

### The history lesson (this is the whole point)

> "In previous generations of the Unreal Engine, the base Actor class was very heavyweight and any Actor-derived subclass inherited all properties regardless of their behavior. Actor Components solve this problem by defining multiple lightweight components that provide an interface for modular extensibility." ([Epic — Component, Community Wiki](https://unrealcommunity.wiki/6100e8119c9d1a89e0c31ab2); [Epic — UActorComponent forums context](https://forums.unrealengine.com/t/unreal-vs-unity-actors-components-inheritance-composition/154249))

Unreal _literally lived through_ the failure mode of a fat base class and deep inheritance, then re-architected around composition. An `Actor` is now a thin "container that holds special types of objects called actor components"; behavior (movement, collision, rendering) lives in `UActorComponent`s — "the base class for components that define reusable behavior that can be added to different types of Actors." ([Epic — Gameplay Framework](https://dev.epicgames.com/documentation/en-us/unreal-engine/gameplay-framework-in-unreal-engine); [Epic — UActorComponent docs](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UActorComponent))

Components specialize by capability, not by type hierarchy: `UActorComponent` (logic/data, no transform) → `USceneComponent` (has a transform) → `UPrimitiveComponent` (renderable/collidable). Developers "pick and choose which elements are right for [their] game." ([Epic — Gameplay Framework](https://dev.epicgames.com/documentation/en-us/unreal-engine/gameplay-framework-in-unreal-engine))

### Verdict: PRINCIPLE TRANSFERS (as a warning + a layering idea), OBJECT MODEL DOESN'T

- **Steal the cautionary tale, hard.** X-GIS's audits already show the fat-base-class smell (`map.ts`, VTR as God-objects). UE's history is direct evidence that inheritance-heavy designs collapse over a multi-year horizon and that composition is the escape. For a 5-year decision this is a strong prior _against_ modeling layer types / source types / projection types as deep class hierarchies.
- **Steal the capability-layering shape** for the renderer's scene/draw model: a "render item" composed of capability pieces (geometry buffer + material/pipeline + transform + pick metadata) is more durable than `PolygonLayer extends Layer`, `LineLayer extends Layer`, … with shared behavior smeared across the base. The line-rendering vs polygon-rendering duplication the codebase fights would shrink under composition.
- **Don't steal** a runtime ECS or `Actor`/`Component` object graph wholesale. A web-map renderer is not an entity simulation; layers and sources are few and mostly static per style. A full component framework (component registration, tick groups, attachment trees, replication) is enormous machinery for a problem X-GIS doesn't have. Use composition _as a design discipline_ (favor "has-a capability" structs over "is-a" inheritance), not as a runtime entity system.
- **Anti-pattern UE rejected:** the heavyweight base class. If X-GIS ever feels tempted to add "just one more field" to `Map` or a base `Layer`, this is the documented road to the fat-Actor problem UE had to undo.

---

## 4. Gameplay Framework / GameInstance (responsibility separation)

The framework's longevity trick is **single-responsibility classes pinned to clear lifetimes**, so state has exactly one correct home:

- **GameInstance** — "instantiated on engine launch and remains active until the engine shuts down," and critically "persists throughout the lifetime of the game" and **maintains state between level loads.** ([Epic — Gameplay Framework](https://dev.epicgames.com/documentation/en-us/unreal-engine/gameplay-framework-in-unreal-engine))
- **GameMode** (server-only) — owns rules and "specifies which classes should be spawned/used by the other systems." ([tomlooman — Gameplay Framework](https://tomlooman.com/unreal-engine-gameplay-framework/) — paraphrased; see also [Epic — Gameplay Framework](https://dev.epicgames.com/documentation/en-us/unreal-engine/gameplay-framework-in-unreal-engine))
- **GameState / PlayerState** — exist specifically to give _replicated/persistent_ data a stable home separate from the transient `Pawn` (destroyed on death) and the not-everywhere `PlayerController`. ([Epic — Gameplay Framework](https://dev.epicgames.com/documentation/en-us/unreal-engine/gameplay-framework-in-unreal-engine))

The durable idea: **"where does this state belong?" is answered by lifetime, not convenience.** Don't put session data in a per-frame object; don't put per-frame data in the session object.

### Verdict: PRINCIPLE TRANSFERS, CLASSES DON'T

- **Steal** the GameInstance concept as the model for X-GIS's **map-session scope**: a single object that survives `setStyle`, source swaps, and projection changes, holding only what must persist across them. This is the missing "session" tier between "the GPU device" and "this frame," and it's exactly where the projection/camera state debates in the audits should be anchored.
- **Don't steal** GameMode/GameState/PlayerController/PlayerState — these are multiplayer-replication and input-possession concepts with zero analogue in a single-process map renderer. Importing them would be cargo-culting.

---

## 5. Plugins & Modular Game Features — _dependency inversion_ (the deepest longevity lesson)

This is the single most important extensibility pattern UE5 added, and the most defensible against a "native-only, doesn't transfer" objection because it's pure architecture, not C++ machinery.

### The one-way dependency rule

Game Feature plugins inject new content/mechanics such that **the core game never references them**:

- "The Modular Game Feature is created in such a way that the core game is completely unaware of its existence, eliminating the need for creating dependencies from the game to the new content." ([core567 — Game Features](https://www.core567.com/blog/unreal-engine-game-features-and-modular-gameplay/); [Unreal Directive — Modular Game Features](https://unrealdirective.com/articles/modular-game-features-what-you-need-to-know/))
- "Game Features should not be referenced by the base game itself." ([Unreal Directive](https://unrealdirective.com/articles/modular-game-features-what-you-need-to-know/); [StraySpark — Game Feature Plugins](https://www.strayspark.studio/blog/game-feature-plugins-ue5-modular-gameplay-architecture))

### How injection works without the core knowing

- Features ship `UGameFeatureAction`s that run on enable (e.g. `UGameFeatureAction_AddComponents` _adds components to existing actor classes_). ([core567 — Game Features](https://www.core567.com/blog/unreal-engine-game-features-and-modular-gameplay/))
- The mechanism is **registration, not reference**: an actor "must register itself with the `UGameFrameworkComponentManager` singleton instance, and pass itself into the `AddReceiver` function." Features then attach via that registry. ([Epic — Game Features & Modular Gameplay](https://dev.epicgames.com/documentation/en-us/unreal-engine/game-features-and-modular-gameplay-in-unreal-engine))
- This explicitly exists to "avoid accidental interactions or dependencies between unrelated features," which the docs call out as "particularly important for live products that change feature sets over time." ([Epic — Game Features & Modular Gameplay](https://dev.epicgames.com/documentation/en-us/unreal-engine/game-features-and-modular-gameplay-in-unreal-engine))

So the dependency arrow points **feature → core**, never core → feature; coupling is mediated by a registry/extension manager that both sides talk to, instead of direct calls.

### Verdict: PRINCIPLE TRANSFERS — highest-leverage idea after Subsystems

For X-GIS's 5-year, 3D-tiles / 4D-city ambition, the things you can't yet name (a 3D-tiles source type, a temporal/4D layer, a new projection, a measurement tool) are exactly the "features that change over time" this pattern is built for.

- **Steal the one-way arrow.** Core renderer must not `import` from feature modules. New capabilities (a source plugin, a layer-type plugin, a projection plugin) register themselves into a core **registry** at startup; the core iterates the registry and never names the concrete feature. The audits already identify the `PROJECTIONS` table as the right SoT but note the _authority is inverted_ (the table is pinned to scattered literals). This pattern is the fix: make the table/registry the authority and have each projection register into it, rather than the core hard-referencing each projection's literals across ~12 sites.
- **Steal "extension by registration"** for the renderer's pass/source/layer extensibility: a `registerSourceType`, `registerLayerType`, `registerProjection` surface lets X-GIS (and eventually third parties) add capabilities without patching core — the npm-library equivalent of plug-'n-play.
- **Don't steal** `UGameFeatureAction`, the GameFeatures plugin asset format, runtime enable/disable of binary plugins, or `/Plugins/GameFeatures/` discovery. That's content-pipeline and binary-plugin infrastructure; in a TS library, a registry object + an `index.ts` that wires built-in features is enough.

---

## 6. What UE itself struggles with — anti-patterns to AVOID (skeptic's section)

UE is not a clean-architecture exemplar; it's an _survived-despite-its-debt_ exemplar. The cautionary signals:

- **Monolithic coupling accrues anyway.** External analysis finds Unreal "demonstrates significant interdependencies between core subsystems" with "circular dependencies and cross-system references that accumulate over development cycles," and that "large commercial engines often prioritize feature velocity over architectural constraints, resulting in tightly coupled systems that become expensive to maintain and refactor." ([Visualising Game Engine Subsystem Coupling, arXiv:2309.06329](https://arxiv.org/pdf/2309.06329)) Lesson: the module/subsystem boundaries only hold if you _enforce_ them (linter, dependency-cruiser). UE's own discipline slips; a small lib that adds the patterns but not the enforcement gets the worst of both.
- **Compile-time / header coupling is a chronic complaint.** UE's large, monolithic-in-places codebase "takes too long to compile," and rearchitecture wishlists center on "modularity, determinism, iteration speed, and clearer boundaries between engine, editor, and game code," plus "stable public APIs" and "a minimal runtime." ([Quora — rearchitecting UE, summarized](https://www.quora.com/If-you-could-modify-rearchitect-Unreal-Engine-what-would-you-change); [A Technical Review of Unreal Engine, arXiv:2507.08142](https://arxiv.org/pdf/2507.08142)) The IWYU initiative exists _because_ header coupling got bad. Lesson for X-GIS: keep public surfaces small and stable from day one; the TS analogue of header bloat is barrel-file re-export sprawl and giant public `index.ts` files.
- **Binary compatibility / certification ossifies the API.** UE's "large existing codebase and many legacy projects mean breaking changes must be incremental, with compatibility paths, and binary compatibility along with platform certifications limit rapid API changes." ([arXiv:2507.08142](https://arxiv.org/pdf/2507.08142)) For X-GIS the analogue is npm semver + the ship-readiness note to **freeze the public API before publish**. The lesson is _favorable_: a pre-1.0 library should aggressively narrow and stabilize its public surface _now_, while it still can, precisely to avoid UE's ossification.
- **Reflection/GC is a cost UE pays for features X-GIS doesn't want.** `UPROPERTY`-driven GC "increases the amount of data the GC must scan," and the historically single-frame mark phase "can produce visible hitches." ([core567 — UObjects & GC notes](https://www.core567.com/blog/unreal-engine-uobjects-and-garbage-collection-notes/); [LordNed — UE4 Garbage Collection](https://gist.github.com/LordNed/650de717daca23aaf8fc2932bf3f9123)) JS already has GC; do **not** reinvent a reflection/lifetime-tracking layer. This is the clearest "native-only, do not transfer" item.
- **Non-deterministic module init order** (Section 1) is a self-admitted sharp edge — make init order explicit in X-GIS, don't rely on import side effects.

---

## 7. Bottom line for X-GIS (the 5-year decision)

**Steal (high confidence, cheap in TS):**

1. **Subsystems with explicit lifetime scopes** (device / map-session / frame) + mandatory `initialize(deps)` / `deinitialize()`. Directly cures the God-object + missing-`destroy()` debts. _Highest-value item._
2. **One-way dependency + registration-over-reference** for extensibility (source/layer/projection registries; core never imports features). Cures the inverted `PROJECTIONS`-table authority and future-proofs 3D-tiles / 4D layers.
3. **Composition over inheritance** as a _design rule_ — thin containers + capability pieces, not deep `Layer`/`Source` hierarchies. Backed by UE's documented fat-Actor failure.
4. **Declared, directional module boundaries** enforced by a linter (dependency-cruiser / TS project references) — the TS-native equivalent of public/private `Build.cs` deps. Boundaries only work if mechanically enforced.
5. **A "GameInstance"-style session tier** as the single home for state that survives style/source swaps.

**Skip (native-only or pure overkill):** UnrealBuildTool / `.Build.cs` / per-module DLLs / IMPLEMENT_MODULE / loading phases; `UObject` reflection, `UCLASS`/`UPROPERTY`, reflection-driven GC; the full Actor/Component runtime entity system; GameMode/GameState/PlayerController/PlayerState multiplayer-replication classes; GameFeatures plugin asset format & runtime binary enable/disable; Blueprint/Python auto-exposure.

**The meta-lesson:** UE's longevity comes less from any one system and more from a repeated move — _when a base class or core file gets fat, extract the capability into a self-registering, lifetime-scoped unit and invert the dependency so the core doesn't know about it._ That move is language-agnostic, costs almost nothing in TypeScript, and is precisely what X-GIS's own audits keep prescribing.

---

## Sources

- [Epic — Unreal Engine Modules](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-modules)
- [Epic — Programming Subsystems in Unreal Engine](https://dev.epicgames.com/documentation/unreal-engine/programming-subsystems-in-unreal-engine)
- [Epic — Gameplay Framework in Unreal Engine](https://dev.epicgames.com/documentation/en-us/unreal-engine/gameplay-framework-in-unreal-engine)
- [Epic — Game Features and Modular Gameplay](https://dev.epicgames.com/documentation/en-us/unreal-engine/game-features-and-modular-gameplay-in-unreal-engine)
- [Epic — USmartObjectSubsystem::ShouldCreateSubsystem](https://docs.unrealengine.com/5.3/en-US/API/Plugins/SmartObjectsModule/USmartObjectSubsystem/ShouldCreateSubsystem/)
- [Epic Community Wiki — Component](https://unrealcommunity.wiki/6100e8119c9d1a89e0c31ab2)
- [Epic Forums — Unreal vs Unity: Actors & Components, Inheritance & Composition](https://forums.unrealengine.com/t/unreal-vs-unity-actors-components-inheritance-composition/154249)
- [Flying Rat — Programming Subsystems](https://tech.flying-rat.studio/post/ue-subsystems.html)
- [phillipbaxter — Writing Unreal Subsystems](https://phillipbaxter.com/ue4/ue5/unreal/2022/Unreal-Subsystems.html)
- [UhiyamaLab — Choosing the Right Subsystem (GameInstance/World/LocalPlayer)](https://uhiyama-lab.com/en/notes/ue/subsystem-gameinstance-world-localplayer/)
- [unreal-garden — Unreal-style Singletons with Subsystems](https://unreal-garden.com/tutorials/subsystem-singleton/)
- [kantandev — UE4 Code Modules](http://kantandev.com/articles/ue4-code-modules)
- [tomlooman — Unreal Gameplay Framework Guide for C++](https://tomlooman.com/unreal-engine-gameplay-framework/)
- [Unreal Directive — Modular Game Features](https://unrealdirective.com/articles/modular-game-features-what-you-need-to-know/)
- [StraySpark — Game Feature Plugins UE5](https://www.strayspark.studio/blog/game-feature-plugins-ue5-modular-gameplay-architecture)
- [core567 — UE Game Features and Modular Gameplay](https://www.core567.com/blog/unreal-engine-game-features-and-modular-gameplay/)
- [core567 — UObjects and Garbage Collection notes](https://www.core567.com/blog/unreal-engine-uobjects-and-garbage-collection-notes/)
- [LordNed — UE4 Garbage Collection (gist)](https://gist.github.com/LordNed/650de717daca23aaf8fc2932bf3f9123)
- [Visualising Game Engine Subsystem Coupling (arXiv:2309.06329)](https://arxiv.org/pdf/2309.06329)
- [Pushing the Boundaries... A Technical Review of Unreal Engine (arXiv:2507.08142)](https://arxiv.org/pdf/2507.08142)
- [Quora — If you could rearchitect Unreal Engine](https://www.quora.com/If-you-could-modify-rearchitect-Unreal-Engine-what-would-you-change)
