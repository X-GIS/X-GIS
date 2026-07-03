---
name: shader-dsl-node-builder-stmtsink
description: add a Node method that emits a statement (x.assign(v)) without a node↔builder import cycle — inject a StmtSink from builder.ts into node.ts
triggers:
  - 'Node method emit statement'
  - 'x.assign'
  - 'node builder import cycle'
  - 'installStmtSink'
  - 'StmtSink'
  - 'currentBuilder from node.ts'
---

# Adding a Node lvalue method without a node↔builder import cycle

## The Insight

In `@xgis/shader-dsl`, `builder.ts` imports `Node` from `node.ts` (one-way). So a Node METHOD that needs to
PUSH a Stmt to the current scope (e.g. `x.assign(v)` → `currentBuilder().assign(x, v)`) cannot import
`currentBuilder` from builder.ts — that would create a cycle. The fix is dependency INJECTION: node.ts
declares a sink interface + a module-level slot + an `installStmtSink()` setter; builder.ts calls
`installStmtSink({ assign: (t, v) => currentBuilder().assign(t, v) })` at module load. The Node method calls
the injected sink. The cycle is broken because node.ts never imports builder.ts.

## Why This Matters

The "obvious" approach (import currentBuilder into node.ts) compiles but creates a runtime circular import
whose initialization order is fragile — `currentBuilder` may be undefined when a Node method runs at module
load. Injection makes the dependency explicit and load-order-safe (the sink throws a clear error if a deep
import path loaded node.ts without builder.ts).

## Recognition Pattern

- You want a method on the value/expression class that produces a side-effect statement in the current scope.
- The statement-collecting class (Builder) already imports the value class (Node), so a back-import cycles.

## The Approach

1. In the LEAF module (node.ts): `type StmtSink = { assign(target: Node, value: Node): void }`; a
   `let _sink: StmtSink | undefined`; `export const installStmtSink = (s) => { _sink = s }`; a `stmtSink()`
   getter that throws if unset.
2. The method routes through it: `assign(value) { stmtSink().assign(this, this.liftArg(value)) }` (pre-lift
   the value to THIS lvalue's scalar so `count.assign(count.add(1))` on a u32 emits `1u`).
3. In builder.ts (which imports node + has currentBuilder): `installStmtSink({ assign: (t, v) =>
currentBuilder().assign(t, v) })` once at module top level.
4. Keep the Builder's OWN `.assign`/`.assignOp` methods — the combinators (SwitchChain/ifExpr) use them
   directly; only the FREE ambient `assign()`/`assignOp()` functions become removable.
