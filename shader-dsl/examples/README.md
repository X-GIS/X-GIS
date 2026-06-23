# `@xgis/shader-dsl` examples

Self-contained shaders authored with the DSL. Each one builds a module, emits WGSL,
and prints the `reflect()` pipeline metadata — with **no dependency on the X-GIS
runtime**. They import only from the package's own source (`../src/index.ts`), so
they run straight from a checkout.

| File | What it shows |
|---|---|
| `gradient-pass.ts` | A fullscreen render pass (oversized triangle VS + gradient FS) with a std140 uniform block. |
| `compute-reduction.ts` | A `@workgroup_size` compute kernel doing a segmented sum over two storage buffers, folded with `reduce()`. |

## Run

```bash
npx tsx examples/gradient-pass.ts
npx tsx examples/compute-reduction.ts
```

(or `bunx tsx …`). Each prints the emitted WGSL followed by the JSON `Reflection`
(bind groups, std140/std430 struct layouts, and entry-point signatures).
