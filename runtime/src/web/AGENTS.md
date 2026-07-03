<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# web

## Purpose

The `<xgis-map>` custom element — the zero-JS, HTML-native entry point to the runtime. It creates a Shadow DOM with a canvas and an error overlay, instantiates `XGISMap`, and runs `.xgis` source via one of three modes: a `src` attribute (file URL, auto-detects `.xgis`/`.xgb`), inline text content inside the tag, or a `script` attribute referencing a `<script>` element by ID. Errors surface in an in-shadow overlay rather than throwing. Teardown calls `map.stop()` on disconnect.

## Key Files

| File           | Description                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `component.ts` | `XGISMapElement extends HTMLElement` — Shadow DOM setup (canvas + `.error` overlay), three-mode source dispatch in `connectedCallback`, `map.stop()` in `disconnectedCallback`, and a programmatic `run(source, baseUrl)` method. Also exports `registerXGISElement()` which calls `customElements.define('xgis-map', …)` guarded by a get-check. |

## For AI Agents

### Working In This Directory

- This is a thin DOM wrapper over `engine/map.XGISMap`. Keep all real logic in `engine/`; the element only handles lifecycle (connect/disconnect), canvas creation, error display, and source dispatch.
- Uses Shadow DOM (`mode: 'open'`). The canvas and error div live inside `shadowRoot` — direct `querySelector` on the host element will not find them.
- Teardown is `map.stop()`, not `map.destroy()` — align with the `XGISMap` API when that changes.
- This is the public embedding surface exported from `index.ts`; preserve the `src`, `script` attribute names and the inline-text-content slot semantics across changes.
- `registerXGISElement()` is idempotent (guarded by `customElements.get`). Safe to call multiple times.

### Testing Requirements

- No colocated unit tests. DOM/custom-element behavior is exercised visually via the `playground`. Verify connect/disconnect lifecycle and all three source modes in the playground when changing this file.

### Common Patterns

- Standard custom-element lifecycle: `connectedCallback` (async) → instantiate canvas + dispatch source → catch errors to overlay; `disconnectedCallback` → `map.stop()`.
- Programmatic use: call `element.run(source, baseUrl)` after the element is already in the DOM.

## Dependencies

### Internal

- `engine/map` (`XGISMap`).
- `engine/log` (`xlog` — error logging).

### External

- DOM (`HTMLElement`, `customElements`, Shadow DOM); no npm deps.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
