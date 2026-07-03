import type { LintRule } from '../engine'

/** Two bindings sharing a (group, binding) slot. */
export const bindingCollision: LintRule = {
  id: 'binding-collision',
  description: '(group, binding) slot uniqueness',
  severity: 'error',
  category: 'correctness',
  create: (ctx) => ({
    Module(m) {
      const slots = new Map<string, string>()
      for (const b of m.bindings) {
        const key = `${b.group}:${b.binding}`
        const prev = slots.get(key)
        if (prev !== undefined) {
          ctx.report(
            `binding collision @group(${b.group}) @binding(${b.binding}) — '${b.name}' vs '${prev}'`,
          )
        }
        slots.set(key, b.name)
      }
    },
  }),
}
