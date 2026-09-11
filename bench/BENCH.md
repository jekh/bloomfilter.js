# Bench: fork vs stock upstream

Compares the working-tree fork against stock upstream
(`jasondavies/bloomfilter.js`) on one machine, one runtime.

## Prerequisites

`pnpm install`, which also installs the baseline: stock upstream is
a devDependency (`bloomfilter-upstream`, an exact-pinned
`npm:bloomfilter@1.1.0` alias), imported by its bare specifier. No
git remote, no network at bench time.

## Commands

- `pnpm bench` — quick matrix (~10s): item-count small and
  medium-50k rounds in full shape, medium-100k primaries, micro-op
  configs.
- `pnpm bench:full` — adds the 500k and 1M rounds and full shapes
  everywhere (~15-30s total).
- `node bench/compare.mjs --xlarge` — opts into the 10M round
  (~1 min, single timed pass, noisy by declaration).
- `node bench/compare.mjs --upstream <git-ref|path>` — compare
  against another upstream ref, or point both sides at one file
  (null test: every config must read ~0).
- `node bench/compare.mjs --json results/run.json` — also write a
  small JSON summary (aggregates plus provenance, kilobytes).
- `node bench/compare.mjs --report-only results/run.json` — re-render
  the table from a saved summary without re-running.
- `--gate <pct>` (default 6), `--rounds <n>` override test
  sensitivity and repetition counts.

## Historical baselines

`--upstream` takes a path or a git ref. A ref (sha, tag, branch,
`HEAD~n`) runs the fork's own implementation at that commit as the
baseline arm — the committed replacement for the old throwaway
before/after harnesses. The file is read with `git show` into a temp
dir and compiled with this repo's own toolchain (a config extending
the repo tsconfig, so old sources build under current strictness);
a bare `.js` ref is used as-is. The working tree is never touched and
the temp dir is removed on exit. The ref must contain an ESM-shaped
module exporting `BloomFilter`; `locations()` is compared only when
both sides implement it (older commits skip it with a note), and a
geometry mismatch still throws.

Provenance lands in the report: `pin` reads `baseline@<sha>`,
`baseline` records `{ref, sha}`, rows print against
`base@<short>`, and `forkDirty` flags an uncommitted
`bloomfilter.ts` (`(dirty)` in the header). Quoting rule: a tripped
gate or a dirty fork invalidates citation. Example — isolate R1:
`node bench/compare.mjs --upstream 00a74d8^`.

## Method

1. **Equivalence prelude.** Identical key streams (plus edge keys)
   must produce identical buckets, `test()`, and `locations()` on
   the common surface before any timing runs. Micro configs plus the
   small round only — same code paths as larger sizes. Throws on
   disagreement.
2. **Warmup plus interleaved best-of-N.** Each side runs once
   untimed, then sides alternate; the best of N wins. Repetitions
   scale down with round size (7 small, 5 medium, chunked best-of-3
   at 1M+, single pass at 10M). Pure-call rows (`test`, `countBits`)
   fold every result into an opaque accumulator so the timed loop is
   never legally dead; `add` rows need no fold (bucket writes are
   observable).
3. **Controls gate.** Every run opens with A/A calibration rows
   (same side on both arms), which must read ~0 in any mode and form
   the run's own noise floor. In null mode (both sides the same file)
   the mask configs join as controls. Fork-vs-upstream, mask rows are
   measurements, not controls — upstream has no bitmask path, so the
   pow2 win lives there. If any control exceeds the gate (default 6%,
   `--gate`), the run prints INVALID and exits non-zero.

## Matrix

Item-count rounds hold constant load (~19 bits/item at p=1e-4) with
explicit `(m,k)` — never `withTargetError`, which the fork tightened
(a93a245), so the two sides would size differently. Constant load
makes the ladder span cache regimes (~24KB, ~120KB, ~240KB,
~1.2MB, ~2.4MB, ~24MB buckets): small-10k (191712, 13),
medium-50k (958528, 13), medium-100k (1917024, 13),
large-500k (9585088, 13), large-1M (19170144, 13),
xlarge-10M (191701152, 13). Each round times
add plus test-hit plus test-miss with capped query counts, so
read-heavy (query serving) and write-heavy (ingest) mixes read off
directly. Two density-bracket rows at the small geometry
(test-miss-empty on a fresh filter, test-miss-full on a saturated
one) bracket miss cost, which is density-dependent via early exit.

Micro-op configs at tiny explicit m use deliberately overloaded
filters — they measure rates, not realism: tight k1/k4/k16
(reduction- and recurrence-dominated shapes), two mask controls,
one long-key control (hash-dominated), fork-side batch APIs versus
per-key loops (upstream lacks them), `countBits`, per-side
`fromJSON` round-trips (formats may differ). `locations()` timing is
omitted: legacy path, same front half as `add()`, covered by
equivalence.

## How to read the numbers

- Positive delta means the fork (or batch API) is faster.
- Same machine, same runtime only. The JSON summary records node
  version, platform, arch, upstream pin, and fork ref; cross-machine
  comparison is not supported.
- Treat anything inside the printed noise floor as zero.
- A tripped gate invalidates the run; re-run when the machine is idle.

## Null test

`node bench/compare.mjs --upstream ./bloomfilter.js` points both
sides at the built fork. Every row must read ~0 and the gate must
pass. If it doesn't, the harness is broken — do not quote numbers
from it.

## Upstream pin

The baseline version is pinned exactly in `package.json`
(`bloomfilter-upstream: npm:bloomfilter@1.1.0`, matching upstream
master's own version) and recorded in every JSON summary. Bump it
deliberately, never silently: first confirm the registry release
still matches upstream master
(`git show upstream/master:bloomfilter.js` versus the tarball
content), re-check the common surface, and re-run the null test.
No git remote is needed for any of this at bench time.
