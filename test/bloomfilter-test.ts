import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BloomFilter } from "../bloomfilter.js";

const hasUint8Base64 =
	typeof (Uint8Array.prototype as Partial<{ toBase64(): string }>).toBase64 ===
		"function" &&
	typeof (
		Uint8Array as Uint8ArrayConstructor & {
			fromBase64?: (source: string) => Uint8Array;
		}
	).fromBase64 === "function";

const jabberwocky =
	'`Twas brillig, and the slithy toves\n  Did gyre and gimble in the wabe:\nAll mimsy were the borogoves,\n  And the mome raths outgrabe.\n\n"Beware the Jabberwock, my son!\n  The jaws that bite, the claws that catch!\nBeware the Jubjub bird, and shun\n  The frumious Bandersnatch!"\n\nHe took his vorpal sword in hand:\n  Long time the manxome foe he sought --\nSo rested he by the Tumtum tree,\n  And stood awhile in thought.\n\nAnd, as in uffish thought he stood,\n  The Jabberwock, with eyes of flame,\nCame whiffling through the tulgey wood,\n  And burbled as it came!\n\nOne, two! One, two! And through and through\n  The vorpal blade went snicker-snack!\nHe left it dead, and with its head\n  He went galumphing back.\n\n"And, has thou slain the Jabberwock?\n  Come to my arms, my beamish boy!\nO frabjous day! Callooh! Callay!\'\n  He chortled in his joy.\n\n`Twas brillig, and the slithy toves\n  Did gyre and gimble in the wabe;\nAll mimsy were the borogoves,\n  And the mome raths outgrabe.';

describe("bloom filter", () => {
	it("basic", () => {
		const f = new BloomFilter(1000, 4);
		const n1 = "Bess";
		const n2 = "Jane";
		f.add(n1);
		assert.equal(f.test(n1), true);
		assert.equal(f.test(n2), false);
	});

	it("jabberwocky", () => {
		const f = new BloomFilter(1000, 4);
		const n1 = jabberwocky;
		const n2 = `${jabberwocky}\n`;
		f.add(n1);
		assert.equal(f.test(n1), true);
		assert.equal(f.test(n2), false);
	});

	it("basic uint32", () => {
		const f = new BloomFilter(1000, 4);
		const n1 = "\u0100";
		const n2 = "\u0101";
		const n3 = "\u0103";
		f.add(n1);
		assert.equal(f.test(n1), true);
		assert.equal(f.test(n2), false);
		assert.equal(f.test(n3), false);
	});

	it("wtf", () => {
		const f = new BloomFilter(20, 10);
		f.add("abc");
		assert.equal(f.test("wtf"), false);
	});

	it("works with integer types", () => {
		const f = new BloomFilter(1000, 4);
		f.add(1);
		assert.equal(f.test(1), true);
		assert.equal(f.test(2), false);
	});

	it("addAll matches per-key add", () => {
		const keys = ["alpha", "beta", "", 1, 2, "x".repeat(100)];
		for (const [m, k, options] of [
			[1000, 4, undefined],
			[1024, 4, undefined],
			[4096, 16, { storage: "pow2" }],
			[64, 32, undefined],
		] as const) {
			const a = new BloomFilter(m, k, options);
			const b = new BloomFilter(m, k, options);
			for (const key of keys) a.add(key);
			b.addAll(keys);
			assert.deepEqual(Array.from(b.buckets), Array.from(a.buckets));
		}
		assert.deepEqual(new BloomFilter(64, 4).addAll([]), undefined);
	});

	it("testAll matches per-key test", () => {
		const f = new BloomFilter(1000, 4);
		f.addAll(["a", "b", 42]);
		assert.deepEqual(f.testAll(["a", "b", 42, "c", 43]), [
			true,
			true,
			true,
			false,
			false,
		]);
		assert.deepEqual(f.testAll([]), []);
	});

	it("addAll/testAll reject Symbols like add/test", () => {
		const f = new BloomFilter(1000, 4);
		assert.throws(() => f.addAll([Symbol("x")]), TypeError);
		assert.throws(() => f.testAll([Symbol("x")]), TypeError);
	});

	it("serialises and deserialises with JSON", () => {
		const f = new BloomFilter(1000, 4);
		f.add("Bess");
		f.add("Jane");

		const json = JSON.stringify(f);
		const restored = BloomFilter.fromJSON(json);

		assert.notEqual(restored, f);
		assert.deepEqual(restored.toJSON(), JSON.parse(json));
		assert.equal(restored.test("Bess"), true);
		assert.equal(restored.test("Jane"), true);
		assert.equal(restored.test("Emily"), false);
	});

	it("binary serialisation round-trips via toBytes / fromBytes", () => {
		const f = BloomFilter.withTargetError(1000, 1e-4);
		f.add("alpha");
		f.add("beta");
		f.add("gamma");

		const bytes = f.toBytes();
		assert.ok(bytes instanceof Uint8Array);
		assert.equal(bytes[0], 0x42);
		assert.equal(bytes[1], 0x4c);
		assert.equal(bytes[2], 0x4d);
		assert.equal(bytes[3], 0x46);
		assert.equal(bytes[4], 1);
		assert.equal(bytes[5], 1);
		assert.equal(bytes[6], 0);
		assert.equal(bytes[7], 24);

		const restored = BloomFilter.fromBytes(bytes);
		assert.equal(restored.m, f.m);
		assert.equal(restored.k, f.k);
		assert.equal(restored.test("alpha"), true);
		assert.equal(restored.test("beta"), true);
		assert.equal(restored.test("gamma"), true);
		assert.equal(restored.test("delta"), false);
	});

	it("binary serialisation round-trips via toArrayBuffer / fromArrayBuffer", () => {
		const f = BloomFilter.withTargetError(1000, 1e-4);
		f.add("alpha");
		f.add("beta");

		const buffer = f.toArrayBuffer();
		assert.ok(buffer instanceof ArrayBuffer);
		const restored = BloomFilter.fromArrayBuffer(buffer);
		assert.equal(restored.test("alpha"), true);
		assert.equal(restored.test("beta"), true);
		assert.equal(restored.test("gamma"), false);
	});

	it("toBytes rejects filters too large for the 32-bit header", () => {
		// m = 2^32 is constructible via the public constructor but does not
		// fit the binary header's 32-bit m field. Use a fake receiver to avoid
		// allocating a 512MB backing array, as in the bucket-index tests.
		const fake = {
			m: 0x100000000,
			k: 1,
			buckets: new Uint32Array([0]),
			_hashId: 1,
		};
		assert.throws(
			() => BloomFilter.prototype.toBytes.call(fake),
			/cannot serialize a filter with m=4294967296/,
		);
	});

	it("binary serialisation preserves _useMask through round-trip", () => {
		const tight = BloomFilter.withTargetError(60_000, 1e-3);
		const pow2 = BloomFilter.withTargetError(60_000, 1e-3, { storage: "pow2" });
		assert.equal(BloomFilter.fromBytes(tight.toBytes())._useMask, false);
		assert.equal(BloomFilter.fromBytes(pow2.toBytes())._useMask, true);
	});

	it("fromBytes rejects invalid payloads", () => {
		const bytes = new Uint8Array(24);
		bytes[0] = 0x42;
		bytes[1] = 0x41;
		bytes[2] = 0x44;
		bytes[3] = 0x21;
		assert.throws(
			() => BloomFilter.fromBytes(bytes),
			/Invalid BloomFilter binary magic/,
		);

		const f = BloomFilter.withTargetError(100, 1e-4);
		const unsupportedVersion = f.toBytes();
		unsupportedVersion[4] = 99;
		assert.throws(
			() => BloomFilter.fromBytes(unsupportedVersion),
			/Unsupported BloomFilter binary format version/,
		);

		const unknownHash = f.toBytes();
		unknownHash[5] = 99;
		assert.throws(
			() => BloomFilter.fromBytes(unknownHash),
			/Unsupported BloomFilter hash id/,
		);

		assert.throws(
			() => BloomFilter.fromBytes(f.toBytes().slice(0, 8)),
			/header length|payload length|bucket count|header too short/,
		);
		assert.throws(
			() => BloomFilter.fromBytes(new Uint8Array(8)),
			/header too short/,
		);
	});

	it('toJSON / fromJSON support encoding:"base64" round-trip', {
		skip: !hasUint8Base64,
	}, () => {
		const f = BloomFilter.withTargetError(1000, 1e-4);
		f.add("hello");
		f.add("world");

		const compact = f.toJSON({ encoding: "base64" });
		assert.equal(compact.encoding, "base64");
		assert.equal(typeof compact.buckets, "string");
		assert.equal(compact.hash, undefined);
		assert.equal(compact.m, f.m);
		assert.equal(compact.k, f.k);

		const restored = BloomFilter.fromJSON(JSON.stringify(compact));
		assert.equal(restored.test("hello"), true);
		assert.equal(restored.test("world"), true);
		assert.equal(restored.test("xyzzy"), false);
	});

	it("toBase64 / fromBase64 round-trip", {
		skip: !hasUint8Base64,
	}, () => {
		const f = BloomFilter.withTargetError(1000, 1e-4);
		f.add("a");
		f.add("b");

		const text = f.toBase64();
		assert.equal(typeof text, "string");
		const restored = BloomFilter.fromBase64(text);
		assert.equal(restored.test("a"), true);
		assert.equal(restored.test("b"), true);
		assert.equal(restored.test("c"), false);
	});

	it("JSON serialisation omits hash field for default variant", () => {
		const f = new BloomFilter(1024, 4);
		f.add("x");
		assert.equal(f.toJSON().hash, undefined);
	});

	it("JSON deserialisation accepts fnv1a64 hash field", () => {
		const f = new BloomFilter(1024, 4);
		f.add("x");
		const payload = f.toJSON();
		payload.hash = "fnv1a64";
		const restored = BloomFilter.fromJSON(payload);
		assert.equal(restored.test("x"), true);
	});

	it("rejects invalid serialised filters", () => {
		assert.throws(
			() => BloomFilter.fromJSON(null),
			/must be an object or JSON string/,
		);
		assert.throws(
			() => BloomFilter.fromJSON({ version: 1, buckets: [1] }),
			/must include k/,
		);
		assert.throws(
			() => BloomFilter.fromJSON({ version: 1, k: 1 }),
			/must include buckets/,
		);
		assert.throws(
			() => BloomFilter.fromJSON({ version: 2, k: 1, buckets: [1] }),
			/Unsupported BloomFilter serialisation format version/,
		);
		assert.throws(
			() => BloomFilter.fromJSON({ version: 1, m: 64, k: 1, buckets: [1] }),
			/inconsistent m and buckets/,
		);
		assert.throws(
			() =>
				BloomFilter.fromJSON({
					version: 1,
					m: 32,
					k: 1,
					encoding: "wat",
					buckets: "",
				}),
			/Unsupported BloomFilter serialisation encoding/,
		);
		assert.throws(
			() =>
				BloomFilter.fromJSON({
					version: 1,
					m: 1024,
					k: 4,
					hash: "bogus",
					buckets: new Array(32).fill(0),
				}),
			/Unsupported BloomFilter hash/,
		);
		// The hash allowlist must not match inherited Object.prototype names.
		for (const hash of ["toString", "constructor", "hasOwnProperty"]) {
			assert.throws(
				() =>
					BloomFilter.fromJSON({
						version: 1,
						m: 32,
						k: 1,
						hash,
						buckets: [0],
					}),
				/Unsupported BloomFilter hash/,
			);
		}
	});

	it("rejects invalid constructor inputs", () => {
		assert.throws(
			() => new BloomFilter(0, 1),
			/m must be a positive finite number of bits/,
		);
		assert.throws(
			() => new BloomFilter(1000, 0),
			/k must be a positive integer/,
		);
		assert.throws(() => new BloomFilter([], 1), /non-empty array-like/);
		assert.throws(
			() => new BloomFilter([1, -1], 1),
			/Bucket values must be unsigned 32-bit integers/,
		);
	});

	it("rejects invalid target error inputs", () => {
		assert.throws(
			() => BloomFilter.withTargetError(0, 1e-5),
			/n must be a positive finite number/,
		);
		assert.throws(
			() => BloomFilter.withTargetError(100, 1),
			/error must be a finite number between 0 and 1, exclusive/,
		);
	});

	it("uses unsigned bucket indexes for high-bit locations", () => {
		// m = 2^32 lets a corrected location exceed 2^31, which is the range
		// where >>> 5 and >> 5 produce different bucket indexes. The fake
		// bucket object avoids allocating a giant backing array.
		const fake = {
			m: 0x100000000,
			k: 4,
			buckets: Object.create(null),
		};

		BloomFilter.prototype.add.call(fake, "test-key");
		assert.equal(BloomFilter.prototype.test.call(fake, "test-key"), true);
	});

	it("combines filters without signed bucket-length overflow", () => {
		// Force the sign bit in m without allocating a giant backing array.
		const f0 = new BloomFilter([0b01], 1);
		const f1 = new BloomFilter([0b10], 1);
		f0.m = 0x80000000;
		f1.m = 0x80000000;

		const union = BloomFilter.union(f0, f1);
		const intersection = BloomFilter.intersection(f0, f1);

		assert.equal(union.buckets[0], 0b11);
		assert.equal(intersection.buckets[0], 0b00);
	});

	it("size", () => {
		const f = new BloomFilter(1024 * 1024, 4);
		for (let i = 0; i < 100; ++i) f.add(i);
		// Vows: assert.inDelta(f.size(), 100, 6);
		assert.ok(Math.abs(f.size() - 100) <= 6, "Size within delta of 6");

		for (let i = 0; i < 1000; ++i) f.add(i);
		// Vows: assert.inDelta(f.size(), 1000, 100);
		assert.ok(Math.abs(f.size() - 1000) <= 100, "Size within delta of 100");
	});

	it("countBits", () => {
		const f = new BloomFilter(1024, 4);
		f.add(0);
		assert.equal(f.countBits(), 4);
	});

	it("isSaturated", () => {
		const fresh = new BloomFilter(1024, 4);
		assert.equal(fresh.isSaturated(), false);

		const tiny = new BloomFilter(64, 8);
		for (let i = 0; i < 1000; ++i) tiny.add(`x:${i}`);
		assert.equal(tiny.isSaturated(), true);
		assert.equal(tiny.countBits(), tiny.m);
		assert.equal(Number.isFinite(tiny.size()), false);

		const partial = new BloomFilter(1024, 4);
		partial.add("a");
		partial.add("b");
		assert.equal(partial.isSaturated(), false);
	});

	it("withTargetError/error", () => {
		const f = BloomFilter.withTargetError(100, 1e-5);
		for (let i = 0; i < 100; ++i) {
			f.add(i);
		}
		// Vows: assert.inDelta(f.error(), 1e-5, 1e-5);
		assert.ok(Math.abs(f.error() - 1e-5) <= 1e-5, "Error within delta");
	});

	it("withTargetError theoretical FPR is always <= requested target", () => {
		const cases = [
			[1_000, 0.01],
			[1_000, 0.001],
			[1_000, 0.0001],
			[10_000, 0.01],
			[60_000, 0.001],
			[100_000, 1e-4],
			[1_000_000, 1e-6],
			[50, 1e-3],
			[100, 1e-9],
		];
		for (const [n, target] of cases) {
			const f = BloomFilter.withTargetError(n, target);
			const theoreticalFpr = (1 - Math.exp((-f.k * n) / f.m)) ** f.k;
			assert.ok(
				theoreticalFpr <= target,
				`n=${n} target=${target}: m=${f.m} k=${f.k} produced theoretical FPR ${theoreticalFpr}`,
			);
		}
	});

	it("withTargetError defaults storage to tight", () => {
		const f = BloomFilter.withTargetError(100, 1e-5);
		assert.equal(f.m, 2400);
		assert.equal(f._useMask, false);
	});

	it("withTargetError with storage:tight matches default", () => {
		const a = BloomFilter.withTargetError(100, 1e-5);
		const b = BloomFilter.withTargetError(100, 1e-5, { storage: "tight" });
		assert.equal(a.m, b.m);
		assert.equal(a.k, b.k);
		assert.equal(a._useMask, b._useMask);
	});

	it("storage:pow2 rounds sub-word and boundary sizes up", () => {
		assert.equal(new BloomFilter(33, 1, { storage: "pow2" }).m, 64);
		assert.equal(new BloomFilter(64, 1, { storage: "pow2" }).m, 64);
		assert.equal(new BloomFilter(1025, 1, { storage: "pow2" }).m, 2048);
	});

	it("withTargetError with storage:pow2 rounds m up to a power of 2", () => {
		const f = BloomFilter.withTargetError(100, 1e-5, { storage: "pow2" });
		assert.equal(f.m, 4096);
		assert.equal(f._useMask, true);
		f.add("hello");
		assert.equal(f.test("hello"), true);
		assert.equal(f.test("nope"), false);
	});

	it("storage:pow2 and storage:tight produce different bit layouts but compatible behavior", () => {
		const tight = BloomFilter.withTargetError(60_000, 1e-3);
		const pow2 = BloomFilter.withTargetError(60_000, 1e-3, { storage: "pow2" });
		assert.equal(tight.k, pow2.k);
		assert.notEqual(tight.m, pow2.m);
		assert.equal(tight._useMask, false);
		assert.equal(pow2._useMask, true);
		tight.add("x");
		pow2.add("x");
		assert.equal(tight.test("x"), true);
		assert.equal(pow2.test("x"), true);
	});

	it("rejects invalid storage option", () => {
		assert.throws(
			() => new BloomFilter(1024, 4, { storage: "bogus" as never }),
			/storage must be "tight" or "pow2"/,
		);
	});

	it("serialised pow2 filters auto-detect bitmask path on deserialise", () => {
		const f = BloomFilter.withTargetError(60_000, 1e-3, { storage: "pow2" });
		f.add("a");
		f.add("b");
		f.add("c");

		const restored = BloomFilter.fromJSON(JSON.stringify(f));
		assert.equal(restored.m, f.m);
		assert.equal(restored._useMask, true);
		assert.equal(restored.test("a"), true);
		assert.equal(restored.test("b"), true);
		assert.equal(restored.test("c"), true);
	});

	it("union", () => {
		const f0 = BloomFilter.withTargetError(100, 1e-5);
		const f1 = BloomFilter.withTargetError(100, 1e-5);
		for (let i = 0; i < 100; ++i) {
			f0.add(i);
		}
		for (let i = 0; i < 100; ++i) {
			f1.add(100 + i);
		}
		const f2 = BloomFilter.union(f0, f1);
		for (let i = 0; i < 200; ++i) {
			assert.equal(f2.test(i), true);
		}
	});

	it("union and intersection take ownership of trusted bucket arrays", () => {
		const f0 = new BloomFilter([0b01], 1);
		const f1 = new BloomFilter([0b10], 1);

		const union = BloomFilter.union(f0, f1);
		const intersection = BloomFilter.intersection(f0, f1);

		assert.equal(union.buckets[0], 0b11);
		assert.equal(intersection.buckets[0], 0b00);
		assert.ok(union.buckets instanceof Uint32Array);
		assert.ok(intersection.buckets instanceof Uint32Array);
	});

	it("rejects sparse array-like bucket input before allocating", () => {
		// { length } with no elements must fail validation on its first hole
		// instead of triggering a large transient backing allocation.
		const sparse = { length: 134217728 };
		assert.throws(
			() => new BloomFilter(sparse as unknown as number[], 1),
			/Bucket values must be unsigned 32-bit integers/,
		);
		assert.throws(
			() => BloomFilter.fromJSON({ version: 1, k: 1, buckets: sparse }),
			/Bucket values must be unsigned 32-bit integers/,
		);
	});

	it("locations() agrees with add()/test()", () => {
		for (const [m, k] of [
			[1000, 4],
			[1024, 4],
			[2400, 16],
			[33, 16],
		] as const) {
			const f = new BloomFilter(m, k);
			f.add("hello");
			const fromLocations = new Set(f.locations("hello"));
			const fromBuckets = new Set<number>();
			for (let i = 0; i < f.m; ++i) {
				if ((f.buckets[i >>> 5] & (1 << (i & 0x1f))) !== 0) fromBuckets.add(i);
			}
			assert.deepEqual(fromLocations, fromBuckets);
		}
	});

	it("defers _locations allocation until locations() is called", () => {
		const f = new BloomFilter(2400, 16);
		assert.equal(f._locationsCache, null);
		f.add("x");
		assert.equal(f.test("x"), true);
		assert.equal(f._locationsCache, null);

		f.locations("x");
		const cache: unknown = f._locationsCache;
		assert.ok(cache instanceof Uint16Array);
		assert.equal(cache.length, 16);
		// Aliasing preserved: same scratch object across calls.
		assert.equal(f.locations("x"), cache);

		const u = BloomFilter.union(
			new BloomFilter([1], 1),
			new BloomFilter([2], 1),
		);
		assert.equal(u._locationsCache, null);
		u.locations("x");
		const unionCache: unknown = u._locationsCache;
		assert.ok(unionCache instanceof Uint8Array);
	});

	it("deserialisation with huge k allocates no locations scratch", () => {
		const f = BloomFilter.fromJSON({ version: 1, k: 10000000, buckets: [0] });
		assert.equal(f._locationsCache, null);
		assert.equal(f.k, 10000000);
	});

	it("constructor copies Uint32Array input rather than aliasing", () => {
		const source = new Uint32Array([0xdeadbeef, 0xcafebabe, 0, 0xffffffff]);
		const f = new BloomFilter(source, 1);
		source[0] = 0;
		source[1] = 0;
		assert.equal(f.buckets[0], 0xdeadbeef);
		assert.equal(f.buckets[1], 0xcafebabe);
		assert.equal(f.buckets[2], 0);
		assert.equal(f.buckets[3], 0xffffffff);
		assert.notEqual(f.buckets.buffer, source.buffer);
	});

	it("union/intersection propagate _useMask via trusted-buckets factory", () => {
		const tightA = BloomFilter.withTargetError(60_000, 1e-3);
		const tightB = BloomFilter.withTargetError(60_000, 1e-3);
		assert.equal(tightA._useMask, false);
		assert.equal(BloomFilter.union(tightA, tightB)._useMask, false);
		assert.equal(BloomFilter.intersection(tightA, tightB)._useMask, false);

		const pow2A = BloomFilter.withTargetError(60_000, 1e-3, {
			storage: "pow2",
		});
		const pow2B = BloomFilter.withTargetError(60_000, 1e-3, {
			storage: "pow2",
		});
		assert.equal(pow2A._useMask, true);
		assert.equal(BloomFilter.union(pow2A, pow2B)._useMask, true);
		assert.equal(BloomFilter.intersection(pow2A, pow2B)._useMask, true);
	});

	it("intersection", () => {
		const f0 = BloomFilter.withTargetError(100, 1e-5);
		const f1 = BloomFilter.withTargetError(100, 1e-5);
		for (let i = 0; i < 200; ++i) {
			if (i < 100) {
				f0.add(i);
			}
			if (i === 100) {
				f0.add(i);
				f1.add(i);
			}
			if (i > 100) {
				f1.add(i);
			}
		}
		const f2 = BloomFilter.intersection(f0, f1);
		for (let i = 0; i < 200; ++i) {
			assert.equal(f2.test(i), i === 100);
		}
	});
});
