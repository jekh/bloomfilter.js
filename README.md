Bloom Filter
============

This is a fork of [Jason Davies' bloomfilter.js](https://github.com/jasondavies/bloomfilter.js).

It has been converted to **TypeScript** and ships with built-in TypeScript type
definitions. The package is published on [GitHub Releases](https://github.com/jekh/bloomfilter.js/releases)
only (not npm).

Installation
------------

This package is published on [GitHub Releases](https://github.com/jekh/bloomfilter.js/releases)
only (not npm). Install the v1.1.0 tarball directly:

```bash
# npm
npm install https://github.com/jekh/bloomfilter.js/releases/download/v1.1.0/jekh-bloomfilter-1.1.0.tgz

# yarn
yarn add https://github.com/jekh/bloomfilter.js/releases/download/v1.1.0/jekh-bloomfilter-1.1.0.tgz

# pnpm
pnpm add https://github.com/jekh/bloomfilter.js/releases/download/v1.1.0/jekh-bloomfilter-1.1.0.tgz
```

Usage
-----

```typescript
import { BloomFilter } from '@jekh/bloomfilter';

const bloom = new BloomFilter(
  32 * 256, // number of bits to allocate.
  16        // number of hash functions.
);

// Add some elements to the filter.
bloom.add("foo");
bloom.add("bar");

// Test if an item is in our filter.
// Returns true if an item is probably in the set,
// or false if an item is definitely not in the set.
bloom.test("foo");
bloom.test("bar");
bloom.test("blah");

// Serialisation.
const json = JSON.stringify(bloom);

// Deserialisation.
const loadedBloom = BloomFilter.fromJSON(json);

// Automatically pick {m, k} based on number of elements and target false
// positive error rate.
const autoBloom = BloomFilter.withTargetError(1_000_000, 1e-6);

// Use power-of-two storage for faster bitmask-based reduction.
// Note: this trades speed for increased storage.
const fastBloom = BloomFilter.withTargetError(1_000_000, 1e-6, { storage: "pow2" });

// Bulk ingest and queries. Identical to per-key add()/test() calls.
bloom.addAll(["foo", "bar", "baz"]);
const [foo, missing]: boolean[] = bloom.testAll(["foo", "missing"]);
```

Performance improvements
------------------------

- **Fused hash generation in `add()` and `test()`** — The FNV-1a hash and
  location loop are inlined into the hot paths so membership checks avoid
  writing to a scratch location buffer and `test()` can return as soon as a
  missing bit is found.
  - Writing to an intermediate `_locations` typed array forces a memory store
    for every hash position, which puts pressure on the CPU cache and prevents
    the JIT from keeping values in registers. By fusing the hash and bucket
    update into a single loop, the hot path stays entirely in registers and
    avoids the store/load round-trip. For `test()`, this fusion also means the
    function can bail out on the very first unset bit instead of computing all
    `k` locations up front.

- **Power-of-two storage bitmask path** — An optional `storage: "pow2"`
  constructor mode rounds numeric filter sizes to a power of two and replaces
  modulo reduction with fast bitmask operations (`& (m - 1)`) in `locations()`,
  `add()`, and `test()`.
  - Integer modulo (`%`) compiles to a hardware division instruction, which is
    one of the slowest integer operations on modern CPUs (tens of cycles versus
    one for bitwise AND). When `m` is a power of two, the same mathematical
    reduction can be performed with a single `AND` instruction. Additionally,
    the bitmask path removes the need for signed-modulo correction (`if (a <
    0) a += m`), shrinking the generated machine code and improving branch
    prediction.

- **Conditional subtract in the locations loop** — For the default tight
  storage mode the common `(a + b) % m` step is replaced with an add plus a
  conditional subtract, avoiding a full modulo operation in the hot loop.
  - In the tight-storage loop `a` and `b` are already reduced to `[0, m)`, so
    their sum is at most `2m - 2`. That means a single conditional subtract
    (`if (a >= m) a -= m`) is mathematically equivalent to `% m` but avoids
    the expensive division unit entirely. The inner loops of `add()` and
    `test()` execute this step `k - 1` times per call, so eliminating the
    division provides a measurable speed-up for filters with moderate-to-high
    hash counts.

- **Biased-division upfront reduction on the tight path** — For the default
  tight storage mode the two upfront signed-modulo reductions are replaced
  with a biased division that is bit-identical for integer `m` but avoids
  the `fmod` libcall and its unpredictable sign-correction branches.
  - A per-filter bias (the smallest multiple of `m` at or above 2^31) shifts
    each int32 hash half non-negative without changing its residue, so one
    correctly-rounded division plus a practically-never-taken fixup yields
    the exact `[0, m)` position. Measured 10-28% faster add+test on tight
    filters with short keys (up to ~28% at k=1, where reduction dominates);
    the power-of-two bitmask path is unaffected.

- **Fast-path `Uint32Array` bucket construction** — When constructing from a
  `Uint32Array` the library uses the native typed-array copy directly, skipping
  the per-element validation loop while still avoiding aliasing the input.
  - The public constructor validates every incoming bucket value to guarantee
    it fits in an unsigned 32-bit integer. For a `Uint32Array` input this
    validation is redundant because the typed array already enforces the
    bit-width constraint at the engine level. Using the native `new
    Uint32Array(source)` constructor lets the engine perform a bulk `memcpy` in
    C++ rather than iterating in JavaScript, which is dramatically faster for
    large filters and removes a full pass over the data.

- **Avoid recopying trusted union/intersection buckets** — `union()` and
  `intersection()` use an internal fast-path constructor that takes ownership
  of their freshly-computed `Uint32Array` directly instead of copying and
  re-validating it through the public constructor.
  - `union()` and `intersection()` already produce valid `Uint32Array` results
    by applying bitwise OR/AND on the source filters. Passing that array back
    through the public constructor triggers a second memory allocation and a
    second validation loop even though the data is guaranteed correct. The
    internal `_fromTrustedBuckets` path skips both steps, returning a new
    filter with zero extra copies.

- **Tighter `withTargetError` hash counts** — Instead of always rounding the
  continuous optimum up, the helper searches a small set of integer `k` values
  near the optimum and chooses the smallest `m` that keeps the theoretical
  false-positive rate at or below the requested target. This can avoid an
  extra hash round for some target error rates.
  - Each call to `add()` and `test()` is `O(k)` because every hash function
    produces an independent bit position. A lower `k` therefore linearly
    reduces the work done in the hot path. The original implementation rounded
    the continuous-space optimum up, which occasionally overshot by a full
    integer and produced a larger, slower filter. By evaluating a small window
    of candidate `k` values and picking the one that yields the smallest `m`
    while still honouring the error contract, the new logic can drop `k` by
    one in many common configurations without sacrificing correctness.

- **Batch `addAll()` / `testAll()` APIs** — Bulk ingest and queries hoist
  per-filter setup out of the per-key loop and preallocate the result
  array, instead of repeating the full `add()` / `test()` preamble per key.
  - Measured 7–22% faster batched queries (`testAll`) and up to ~12%
    faster mask-mode bulk ingest versus per-key loops; tight-mode `addAll`
    is ~unchanged, where per-round bucket work dominates. Both share one
    private hash helper with the inline paths so the positions cannot drift.
- **64 KiB popcount table in `countBits()`** — Bit counting uses two table
  lookups per word instead of the parallel-bitcount ALU chain.
  - Measured 17–19% faster on sparse and dense filters. The table is built
    once at module load from the same `popcnt()` it replaces, so the two
    cannot drift apart; import time is unchanged.
- **Early-exit `isSaturated()`** — Saturation is detected by scanning words
  for the first non-`0xffffffff` entry instead of running a full population
  count, which is exact because `m` is always a multiple of 32.
  - Constant-time for any non-saturated filter and ~2x cheaper per word
    even fully saturated (measured −100% on fresh/half-full and −90% on
    saturated 1 Mbit filters).
- **Validate buckets once instead of twice on copy** — Deserialisation
  keeps the pre-allocation validation pass (the security property against
  sparse hostile inputs) but no longer re-validates during the copy, with
  the constructor documenting that inputs must be stable across reads.
  - Measured 11–13% faster `fromJSON`. No behaviour change for stable
    inputs, which `JSON.parse` output always is.

New features
------------

- Binary and Base64 serialisation via `toBytes()`, `toArrayBuffer()`,
  `toBase64()`, `fromBytes()`, `fromArrayBuffer()`, and `fromBase64()`.
- `isSaturated()` helper to detect when every bit in the filter is set.
- Bulk `addAll()` / `testAll()` for ingesting and querying many keys with
  per-filter setup hoisted out of the per-key loop.

Safety improvements
-------------------

- **Validate buckets before allocating** — The constructor used to size
  the `Uint32Array` backing store from unvalidated array-like length, so
  a 50-byte sparse payload like `{length: 134217728}` triggered a 512 MB
  transient allocation before validation threw. Elements are now validated
  first, then the backing store is allocated and copied.
  - Deserialisation-path cost only; `add()` / `test()` are untouched, and
    the follow-up single-validation pass keeps this property while copying
    without re-validating stable inputs.
- **Lazily-allocated `locations()` scratch** — Construction, `union()` /
  `intersection()`, and deserialisation no longer allocate `k` scratch
  positions up front; the buffer is built on the first `locations()` call
  and rebuilt only when `k` changes or the cached width no longer fits `m`.
  - This closes the small-input/big-allocation asymmetry where an untrusted
    payload with a huge `k` (e.g. `fromJSON({k: 1e7, ...})`) forced a
    proportional scratch allocation at deserialise time.
- **Prototype-safe hash allowlist in `fromJSON()`** — The `data.hash`
  check used the `in` operator, which also matches inherited
  `Object.prototype` properties, so payloads declaring hash `"toString"`
  or `"constructor"` were accepted. It now uses `Object.hasOwn()`.
  - No behavioural effect today — the name is validated but never
    dispatched on — but this would become a real bug if a second hash
    variant is ever added.
- **Explicit 32-bit guard in `toBytes()`** — The binary header stores `m`
  and `k` in 32 bits each, and `DataView` silently wraps larger values mod
  2^32. Since `m` = 2^32 is constructible, `toBytes()` could emit a corrupt
  header (read back as `m` = 0) that `fromBytes()` only rejects at read
  time. It now throws a `RangeError` at write time and points at `toJSON()`.

Implementation
--------------

Although the bloom filter requires *k* hash functions, we can simulate this
using enhanced double hashing with a single 64-bit FNV-1a hash computation for
performance.  The 64-bit hash is split into two 32-bit halves to obtain the two
independent hash functions required for enhanced double hashing.

Thanks to Will Fitzgerald for his [help and inspiration][2] with the hashing
optimisation.

[1]: http://isthe.com/chongo/tech/comp/fnv/
[2]: http://willwhim.wordpress.com/2011/09/03/producing-n-hash-functions-by-hashing-only-once/
