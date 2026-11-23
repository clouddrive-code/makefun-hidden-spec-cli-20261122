# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/clouddrive-code/makefun-hidden-spec-cli-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/clouddrive-code/makefun-hidden-spec-cli-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Entry for the [hidden-spec-cli-01-run-20261122 bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122): one patch tool for every AI edit format. `mend` reads a patch from a file
or standard input and applies it to the files in the current directory,
all or nothing: either every change in the patch lands, or no file is
modified at all.

## Usage

```
node main.ts [--format=unified|search-replace|v4a|json] [--check] [patch-file]
node main.ts --format=json - < edits.json
```

With no patch file, or with `-`, the patch is read from standard input.
With no `--format`, the format is detected from the patch itself.
`--check` validates the patch and reports what would change without
writing anything. `--help` prints usage.

Exit codes: `0` applied (or, with `--check`, applicable), `1` the patch
does not apply, `2` usage error or an unparseable patch. On exit `1` the
first failing edit is reported as `error: <kind> <path>` followed by
`failed: 1 of N edits`; on exit `2` an `error: parse <line>` or
`error: usage` line is printed. Nothing is written on failure.

## Formats

- **Unified diff** — `diff --git` sections with `---`/`+++` headers and
  `@@` hunks. Hunk line numbers are advisory: a hunk is matched at its
  stated position first, then at the nearest occurrence of its old
  lines, then after trailing-whitespace-insensitive and indentation-
  insensitive matching. Creates (`--- /dev/null`), deletes
  (`+++ /dev/null`), renames and mode-only changes are supported.
- **SEARCH/REPLACE** — fenced blocks with `<<<<<<< SEARCH`, `=======`,
  `>>>>>>> REPLACE`, preceded by the target path. Multiple blocks may
  target one file; each block must match exactly once, or match after
  the same trailing-whitespace and indentation-insensitive fallbacks.
- **V4A** — `*** Begin Patch` / `*** End Patch` with `*** Add File:`,
  `*** Delete File:`, `*** Update File:` and `*** Move to:` operations
  and `@@` chunks with optional anchor text.
- **JSON** — an array (or one object per line) of `create`, `delete`,
  `insert`, `str_replace` and `rename` commands.

## Output

One line per changed file — `M` modified, `A` added, `D` deleted,
`R` renamed — followed by `ok: N file(s)` (or `ok: N edit(s)` for JSON
patches), sorted by path in byte order. Output is deterministic: the
same patch applied to the same tree always produces the same files and
the same output. The entry uses only the Node.js standard library, and
performs no network access, no clock reads and no randomness.

## Files

- `main.ts` — the patch tool (Node 22+; runs under `node main.ts`).
- `runner.ts` — the trial harness entry point, kept as provided in the
  competition kit.
- `LICENSE` — MIT licence.

## Licence

MIT. See `LICENSE`.
