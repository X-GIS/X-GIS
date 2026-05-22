<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# web

## Purpose
The `<xgis-map>` custom element — the zero-JS, HTML-native entry point to the runtime. It lets a page drop `.xgis` source straight into markup; the element creates a canvas, instantiates `XGISMap`, and runs the source on connect.

## Key Files
| File | Description |
|------|-------------|
| `component.ts` | `XGISMapElement extends HTMLElement` (+ `registerXGISElement`) — owns the canvas, instantiates `XGISMap`, runs the embedded/attribute-referenced `.xgis` source, cleans up on disconnect. |

## For AI Agents

### Working In This Directory
- This is a thin DOM wrapper over `engine/map.XGISMap`. Keep all real logic in `engine/`; the element only handles lifecycle (connect/disconnect), canvas creation, and reading source from markup/attributes.
- It is the public embedding surface — preserve attribute/slot semantics on changes (it's exported from `index.ts` as `XGISMapElement`/`registerXGISElement`).

### Testing Requirements
- No colocated test (DOM custom-element behavior is exercised via the `playground`). Verify visually in the playground when changing element lifecycle.

### Common Patterns
- Standard custom-element lifecycle (`connectedCallback` → create canvas + run; `disconnectedCallback` → dispose).

## Dependencies

### Internal
- `engine/map` (`XGISMap`).

### External
- DOM (`HTMLElement`); no npm deps.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
