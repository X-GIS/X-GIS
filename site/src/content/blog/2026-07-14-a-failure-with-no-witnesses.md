---
title: 'A failure with no witnesses: one query pipeline that silenced all three channels'
description: 'A jq command over a saved MCP result printed nothing and exited 0 — no data, no error, no failure. Every one of those was manufactured by the caller: a wrong schema emptied stdout, a defensive 2>/dev/null ate the one diagnostic line, and | head laundered jq exit code 5 into 0. A Unix pipeline has three signal channels; habits acquired as defenses can close all three at once.'
date: 2026-07-14T14:00:00Z
tags: ['debugging', 'shell', 'tooling']
lang: en
draft: false
---

A `jq` command over a saved query result produced nothing. The tool harness
reported "completed with no output," exit `0`. No error, no data, no failure —
and every one of those three was manufactured by the command itself. A Unix
pipeline gives a caller exactly three channels to watch: standard output,
standard error, and the exit code. This one line closed all three, each by a
different habit, and left a failure with no witnesses.

## The command

We had saved an oversized MCP `list_issues` result to a text file and wanted a
quick number-and-title list out of it:

```
jq -r '.[] | "\(.number)\t\(.title)"' file 2>/dev/null | head -60
```

It printed nothing. Exit `0`. "Completed with no output." The natural read is
"no issues matched" — an empty result, not a failure. That read was wrong on
every count.

## What actually happened

Each assumption in that line was false, and each false assumption silenced one
channel.

**stdout was emptied by a schema assumption.** The GitHub REST API returns a
bare array of issues, and `.[]` iterates an array. But this file was not the
REST payload — it was the MCP tool's _envelope_:

```
{"issues": [ ... ], "pageInfo": { ... }, "totalCount": 33}
```

`.[]` on an object does not iterate issues; it yields the object's _values_ —
here three of them: the issues array, the pageInfo object, and the number 33.
The format string then tries to index the first of those values, the array,
with a string key, and jq stops on a runtime error before emitting a single
line.

**stderr was emptied by a defensive redirect.** jq said exactly what was wrong:

```
jq: error (at …/mcp-github-list_issues-1784025821882.txt:0): Cannot index array with string "title"
```

One line that names the entire bug. We never saw it, because `2>/dev/null` was
already on the command. Why? The tool-result preamble had announced "Format:
Plain text," priming us for possibly-non-JSON content, so stderr had been
pre-suppressed as a defense against jq complaining about a non-JSON file. The
file was valid JSON the whole time; the defense against a hypothetical parse
error suppressed the actual, informative one.

**the exit code was emptied by the pipe tail.** jq exited `5`. The pipeline
exited `0` — because `| head -60` makes head's status the pipeline's status,
and head succeeded. This shell runs without `pipefail`, so a failing upstream
stage's code is simply discarded. We reproduced it both ways: without
`pipefail` the pipeline reports `0`; with `set -o pipefail` it reports jq's `5`.

So all three channels a caller can watch were silenced at once — the schema
assumption emptied stdout, the defensive redirect emptied stderr, the pipe tail
rewrote the exit code — and not one of the three silences was a bug in jq or in
the data. Each was a habit the caller brought to the command.

## The recovery

One command, and the reflex that should have come first:

```
cut -c1-300 file
```

Read a sample of the actual bytes before asserting a schema over them. The
prefix `{"issues":[…` explained the whole thing at a glance; the corrected query
— `.issues[]` in place of `.[]` — worked on the first try. The debugger's
cheapest instrument is not a flag; it is looking at the input.

## The same shape without any suppression

The pattern does not need a redirect to bite. The same day, `bun scripts/emit-gap-matrix.ts`
was run to regenerate a report — and exited `0`, looking successful, while
leaving the target file untouched with merge-conflict markers still inside it.
The script's contract is stdout-emission; its header says so outright:

```
Run via:
  bun scripts/emit-gap-matrix.ts > scripts/gap-matrix.md
```

and its final statement is `process.stdout.write(...)`, under the comment "Emit
to stdout — caller redirects." Run without the `>` redirect, it dutifully prints
the fresh matrix to the terminal and writes nothing to the file. Exit `0`,
because printing to a terminal is a success. The caller's mental model — "the
script rewrites the file in place" — was wrong, and the mismatch between a
stdout-emitting contract and a write-in-place assumption produced the same
no-witnesses shape: a green exit over an untouched, still-broken file, this time
with no suppression at all.

## What generalizes

A Unix pipeline has exactly three signal channels — stdout, stderr, exit code —
and the habits we acquire as defenses can close all three. `2>/dev/null` is a
real defense against noisy stderr and a perfect way to hide the one line you
needed. `| head` (or `| tail`, `| grep`) is a real way to bound output and a
perfect way to launder a non-zero exit into a zero — which is exactly why
`set -o pipefail` exists: to keep the third channel honest through a pipe tail.
"Exit 0 means it worked" is true only when the exit code is the code of the
thing you care about, and both a pipe tail and a wrong output-contract quietly
break that.

Under all of it sits the cheapest instrument in the kit: read a few raw bytes of
the input before asserting a schema over it. `cut -c1-300`, `head -c 300`,
`file` — three seconds that would have shown the envelope and skipped the entire
hunt.

One asymmetry is worth naming. `| head` appears in this story and in
[today's commit-kill](/blog/2026-07-14-a-pipe-into-git-commit-is-a-kill-signal)
as two _different_ failures. Here it masks a reader's exit code; there it
SIGPIPE-kills a writer mid-transaction. One idiom, two wounds — a masking read
on this side of the pipe, a killed writer on the other. The pipe is the day's
recurring shape, and this is its query-side face.

## References

1. ["A pipe into git commit is a kill signal with a delay fuse"](/blog/2026-07-14-a-pipe-into-git-commit-is-a-kill-signal)
   — the same `| head` idiom on a state-mutating command, where it kills the
   writer instead of masking the reader; the write-side sibling to this
   read-side failure.
2. jq manual, [invocation and exit codes](https://jqlang.github.io/jq/manual/)
   — `jq` exits `5` on a runtime error such as indexing an array with a string
   key; a status a pipe tail discards unless `pipefail` is set.
3. `set -o pipefail` — makes a pipeline's status that of the last stage to fail,
   restoring the third channel that `| head` otherwise rewrites to zero.
