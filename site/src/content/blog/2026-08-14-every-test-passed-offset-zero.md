---
title: 'Every test passed offset zero'
description: "A refactor generalised one typed-array read over three element types and, in the same line, quietly dropped the view window. Five new unit tests stayed green because every one of them constructed a whole array — byteOffset 0, the exact case the bug cannot touch. Production never passes whole arrays: it passes frame-arena subarrays, so the upload took a neighbouring renderer's bytes and WebGL2 drew no points at all."
date: 2026-08-14T09:00:00Z
tags: ['verification', 'testing', 'rendering', 'javascript']
lang: en
draft: false
---

The refactor was small and the tests were new. That combination is supposed to be safe. It
produced a backend that rendered nothing, behind five green tests written specifically for the
code that broke.

## The change

A WebGL2 backend has no shader storage buffers, so a storage buffer is emulated as a data
texture: element _i_ lives at texel `(i % W, i / W)` and the shader reads it with `texelFetch`.
The upload path had one job — take the caller's typed array and hand it to `texSubImage2D`.

It was float-only. Adding unsigned and signed integer data textures meant the same path had to
serve three element types, so the pad-and-upload logic was generalised: since all three elements
are 4-byte words, do the copy on a `Uint32Array` word view and let only the _final_ view and the
GL format interpret the bytes.

```js
// before — float only
const f32 = data instanceof Float32Array ? data : new Float32Array(data.buffer)

// after — generalised over the element type
const words = new Uint32Array(srcBuf)
```

The reasoning was right. The line was wrong, and the wrongness is entirely in what it does _not_
say.

## The bug is a missing argument

`new Uint32Array(buffer)` views the **whole** buffer, from byte zero. A typed array handed in by
a caller is usually not a whole buffer — it is a _window_: an offset, a length, and a reference
to something larger.

The pre-refactor line survived this by accident. When `data` was already a `Float32Array` it
passed the object straight through, window intact, and only reconstructed a view in the branch
where it had to convert. The generalised version always reconstructs — and reconstructs the
wrong thing.

In this codebase every real caller allocates from a per-frame arena:

```js
allocF32(count) {
  const u8 = this.alloc(count * 4, 4)
  return new Float32Array(this.buffer, u8.byteOffset, count)   // a WINDOW
}
```

So `data.buffer` is not "this renderer's data". It is one large arena shared by every renderer
drawing that frame. Reading it from offset zero uploads whatever the _first_ renderer happened to
put there. The point renderer's per-feature buffer received the vertex data of something else.

Nothing throws. `texSubImage2D` is handed a correctly-sized, correctly-typed array of perfectly
valid floats. They are simply the wrong floats, so every point computed a nonsense position and
the draw produced no pixels. A render gate caught it with the bluntest possible signal: `0` red
pixels where more than `2000` were expected.

## Why five new tests did not

The refactor shipped with a fresh unit suite — format-per-element, upload-type-per-element,
partial-write padding, exact bit patterns through the integer path. Good tests. All green,
before and after.

Every one of them built its input like this:

```js
device.writeBuffer(buf, 0, new Uint32Array([1, 2, 3, 4]))
```

A whole array. `byteOffset === 0`. And at offset zero, the buggy line and the correct line are
**the same line** — the window starts where the buffer starts, so ignoring the window changes
nothing.

This is the sharp edge. The suite was not thin; it covered three element types, two upload paths
and a padding branch. It was thorough along every axis except the one the bug lived on, and it
was thorough along those axes _because those were the axes the author was thinking about._ The
element type was the feature. The view window was the assumption.

An assertion carries information only if it distinguishes the states of the thing it tests — a
lesson this repo already had written down. The variant here is one step earlier and easier to
miss: the assertions were fine. The **inputs** could not distinguish. You can write a perfect
oracle and still learn nothing, if every case you feed it lands on the same side of the branch.

## The input that discriminates

The fix to the test is smaller than the fix to the code: construct the input the way production
does, and plant something recognisable around it.

```js
const arena = new Float32Array(offWords + len + 8).fill(-999) // the decoy
const view = new Float32Array(arena.buffer, offWords * 4, len) // the window
```

Then assert both that the payload arrives and that `-999` never does. Against the buggy line
that test reports:

```
expected [ -999, -999, -999, -999 ] to deeply equal [ 100, 101, 102, 103 ]
```

which names the failure precisely: we read the arena, not the window. Two cases — an exact-fit
view and a padded one — cover both branches, and both go red before the fix and green after.

The general form: **if production always passes a view and your tests always pass a whole array,
your tests are exercising a different function than production calls.** Ask what shape the real
callers hand in, and make at least one test hand in that shape. For typed arrays specifically,
"whole array" is a special case that hides an entire class of bug, and it is the shape everyone
reaches for when writing a test by hand.

## The second miss: which gates to run

There was a process error stacked on top of the coding one.

The refactor was motivated by a feature — integer data textures — and before merging, the author
ran the gates _for that feature_: the integer texture gate, the GLSL compile gates, the texture
array gate. All green, legitimately. The feature worked.

But the commit had also rewritten a path with **other consumers**: points, lines, icons, picking
— everything that uploads per-feature data. None of those gates were run. They were the ones that
would have caught it, and one of them did, on CI, after the merge.

The rule that falls out is not "run everything" (the full render suite is 17 minutes). It is
narrower and cheap to apply:

> When a change _refactors_ a shared path rather than adding to it, the gates you owe are the
> ones belonging to that path's **consumers** — not the ones belonging to the feature that
> motivated the refactor.

Those are different sets, and the feature's own gates are the ones you will naturally think of,
because they are the ones you have been staring at. On the follow-up merge, eight consumer gates
were run — icons, arrows, draw-call batching, point gradients, fills, data-driven fills, picking,
pan-points — and took ninety seconds.

## What this cost, and what made it cheap

The regression reached the default branch and stayed there for about forty minutes. What kept the
window short was not the unit suite; it was a render gate that asserted a **non-vacuity floor**
before comparing anything:

```js
// Non-vacuity first: the origin view must actually draw points, or the
// assertion below is comparing two zeros.
expect(origin.red, 'the origin view must draw city points').toBeGreaterThan(2000)
```

That line exists because a previous incident taught someone that a comparison between two blank
frames passes. Here it turned "the pan comparison is inconclusive" into "the origin view drew
nothing", which is a diagnosis rather than a symptom, and it pointed straight at the upload path.

Two lessons, then, and only one of them is about typed arrays. The other is that the tests you
write for a change are shaped by what you were thinking about while you made it — which is
precisely why they cannot be the only thing standing behind it.
