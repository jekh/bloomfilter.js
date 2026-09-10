const MAX_BITS = 0x100000000;
const MAX_BUCKETS = MAX_BITS / 32;
const SERIALISATION_VERSION = 1;
const BLOOM_BINARY_VERSION = 1;
const BLOOM_BINARY_HEADER_LENGTH = 24;
const HASH_ID_FNV1A64 = 1;
const DEFAULT_HASH_NAME = "fnv1a64";
const DEFAULT_HASH_ID = HASH_ID_FNV1A64;

type LocationArray = Uint8Array | Uint16Array | Uint32Array;
type LocationArrayConstructor =
	| Uint8ArrayConstructor
	| Uint16ArrayConstructor
	| Uint32ArrayConstructor;

export interface BloomFilterOptions {
	/**
	 * Storage rounding policy when constructing from a bit count.
	 *
	 * "tight" rounds to the next 32-bit word. "pow2" rounds to a power of 2 so
	 * the hot path can use bitmask reduction, at up to ~2x storage.
	 */
	storage?: "tight" | "pow2";
}

export interface BloomFilterJSONOptions {
	/**
	 * "array" preserves the legacy decimal bucket array. "base64" stores
	 * little-endian bucket bytes in a string when the runtime supports it.
	 */
	encoding?: "array" | "base64";
}

export interface BloomFilterJSON {
	version: number;
	m: number;
	k: number;
	encoding?: "array" | "base64";
	buckets: number[] | string;
	hash?: string;
}

interface SerialisedFilterInput {
	version?: number;
	m?: number;
	k: number;
	encoding?: string;
	buckets: unknown;
	hash?: string;
}

type Uint8ArrayWithBase64 = Uint8Array & { toBase64(): string };
type Uint8ArrayConstructorWithBase64 = Uint8ArrayConstructor & {
	fromBase64(source: string): Uint8Array;
};

const Uint8ArrayBase64 = Uint8Array as Uint8ArrayConstructorWithBase64;

const HASH_NAME_BY_ID: Readonly<Record<number, string>> = Object.freeze({
	[HASH_ID_FNV1A64]: DEFAULT_HASH_NAME,
});
const HASH_ID_BY_NAME: Readonly<Record<string, number>> = Object.freeze({
	[DEFAULT_HASH_NAME]: HASH_ID_FNV1A64,
});

const HOST_IS_LITTLE_ENDIAN = (() => {
	const probe = new Uint16Array([1]);
	return new Uint8Array(probe.buffer)[0] === 1;
})();

const HAS_UINT8_TO_BASE64 =
	typeof (Uint8Array.prototype as Partial<Uint8ArrayWithBase64>).toBase64 ===
	"function";
const HAS_UINT8_FROM_BASE64 = typeof Uint8ArrayBase64.fromBase64 === "function";

// Hash and location generation are inlined into add() and test() to avoid a
// scratch-buffer round-trip per bit and to let test() return on the first
// missing bit.
//
// The hot path uses a bitmask when m is a power of 2, and otherwise uses the
// existing signed modulo reduction. The public locations() method is retained
// for compatibility.

export class BloomFilter {
	m: number;
	k: number;
	buckets: Uint32Array;
	_locationsCache: LocationArray | null = null;
	_useMask: boolean;
	_hashId: number;

	/**
	 * Lazily-allocated scratch for the legacy locations() API. add(), test(),
	 * construction, and deserialisation never touch it, so attacker- or
	 * caller-controlled k causes no allocation until locations() is called.
	 * The guard rebuilds when k changes or the cached element width no longer
	 * fits m, so direct .m mutations within the same width class behave
	 * exactly as before. (.m/.k are effectively read-only after construction:
	 * mutating them already leaves _useMask stale.)
	 */
	get _locations(): LocationArray {
		// NB: `_locationsCache` may be undefined (not null) on instances built
		// via Object.create, which skips class-field initializers.
		const cached = this._locationsCache;
		if (
			cached === null ||
			cached === undefined ||
			cached.length !== this.k ||
			cached.BYTES_PER_ELEMENT !== locationWidth(this.m)
		) {
			const r = makeLocationArray(this.m, this.k);
			this._locationsCache = r;
			return r;
		}
		return cached;
	}

	set _locations(v: LocationArray) {
		this._locationsCache = v;
	}

	/**
	 * @param m - Number of bits, or an array of integers to load.
	 * @param k - Number of hashing functions.
	 * @param options
	 * @param options.storage - Storage rounding policy
	 *     when m is a number. "tight" rounds to the next 32-bit word; "pow2"
	 *     rounds to a power of 2 for bitmask reduction, at up to ~2x storage.
	 *     Ignored when m is an array of buckets.
	 */
	constructor(
		m: number | ArrayLike<number>,
		k: number,
		options: BloomFilterOptions = {},
	) {
		let a: ArrayLike<number> | undefined;
		let bitSize: number;
		if (typeof m !== "number") {
			assertBucketArrayLike(m);
			a = m;
			bitSize = a.length * 32;
		} else {
			assertBitSize(m);
			bitSize = m;
		}
		assertHashCount(k);

		const storage = options.storage ?? "tight";
		if (storage !== "tight" && storage !== "pow2") {
			throw new RangeError('options.storage must be "tight" or "pow2".');
		}

		if (a === undefined && storage === "pow2") {
			// nextPowerOf2 is monotonic and exact on this domain, so rounding a
			// bitSize already bounded by MAX_BITS cannot exceed MAX_BITS.
			bitSize = nextPowerOf2(Math.max(32, bitSize));
		} else {
			const n = Math.ceil(bitSize / 32);
			bitSize = n * 32;
		}

		const n = bitSize / 32;
		this.m = bitSize;
		this.k = k;
		this._useMask = isPowerOf2(bitSize);
		this._hashId = DEFAULT_HASH_ID;

		let buckets: Uint32Array;
		if (a instanceof Uint32Array) {
			// Uint32Array already guarantees uint32 bucket values; the native
			// typed-array copy avoids validation overhead without aliasing input.
			buckets = new Uint32Array(a);
		} else if (a) {
			// Validate before allocating: a sparse array-like such as
			// { length: 134217728 } must throw on its first hole instead of
			// triggering a large transient backing allocation.
			const inputLen = Math.min(a.length, n);
			for (let i = 0; i < inputLen; ++i) {
				assertBucketValue(a[i]);
			}
			buckets = new Uint32Array(n);
			for (let i = 0; i < inputLen; ++i) {
				const value = a[i];
				assertBucketValue(value);
				buckets[i] = value;
			}
		} else {
			buckets = new Uint32Array(n);
		}

		this.buckets = buckets;
	}

	// Retained for compatibility; add() and test() inline this loop to avoid
	// scratch-buffer writes and to allow early exits.
	// See http://willwhim.wpengine.com/2011/09/03/producing-n-hash-functions-by-hashing-only-once/
	/**
	 * @deprecated Legacy compatibility API. Prefer add()/test(), which compute
	 * the same positions without touching this buffer. Returns a reused
	 * scratch array — copy the result if you need to keep it.
	 */
	locations(v: string): LocationArray {
		const k = this.k;
		const m = this.m;
		const r = this._locations;
		let a: number;
		let b: number;

		// FNV-1a hash (64-bit).
		{
			const fnv64PrimeX = 0x01b3;
			const l = v.length;
			let t0 = 0,
				t1 = 0,
				t2 = 0,
				t3 = 0;
			let v0 = 0x2325,
				v1 = 0x8422,
				v2 = 0x9ce4,
				v3 = 0xcbf2;

			for (let i = 0; i < l; ++i) {
				v0 ^= v.charCodeAt(i);
				t0 = v0 * fnv64PrimeX;
				t1 = v1 * fnv64PrimeX;
				t2 = v2 * fnv64PrimeX;
				t3 = v3 * fnv64PrimeX;
				t2 += v0 << 8;
				t3 += v1 << 8;
				t1 += t0 >>> 16;
				v0 = t0 & 0xffff;
				t2 += t1 >>> 16;
				v1 = t1 & 0xffff;
				v3 = (t3 + (t2 >>> 16)) & 0xffff;
				v2 = t2 & 0xffff;
			}

			a = (v3 << 16) | v2;
			b = (v1 << 16) | v0;
		}

		if (this._useMask) {
			const mask = m - 1;
			a &= mask;
			b &= mask;
			r[0] = a;
			for (let i = 1; i < k; ++i) {
				a = (a + b) & mask;
				b = (b + i) & mask;
				r[i] = a;
			}
		} else {
			a = a % m;
			if (a < 0) a += m;
			b = b % m;
			if (b < 0) b += m;
			r[0] = a;
			for (let i = 1; i < k; ++i) {
				// a and b are already reduced, so one subtract is equivalent to
				// (a + b) % m in the common case and avoids a modulo operation.
				a = a + b;
				if (a >= m) a -= m;
				b = b + i;
				if (b >= m) b %= m;
				r[i] = a;
			}
		}
		return r;
	}

	add(v: unknown): void {
		const k = this.k;
		const m = this.m;
		const buckets = this.buckets;
		// biome-ignore lint/style/useTemplate: Preserve legacy string coercion, which rejects Symbols.
		const s = v + "";
		let a: number;
		let b: number;

		// FNV-1a hash (64-bit).
		{
			const fnv64PrimeX = 0x01b3;
			const l = s.length;
			let t0 = 0,
				t1 = 0,
				t2 = 0,
				t3 = 0;
			let v0 = 0x2325,
				v1 = 0x8422,
				v2 = 0x9ce4,
				v3 = 0xcbf2;

			for (let i = 0; i < l; ++i) {
				v0 ^= s.charCodeAt(i);
				t0 = v0 * fnv64PrimeX;
				t1 = v1 * fnv64PrimeX;
				t2 = v2 * fnv64PrimeX;
				t3 = v3 * fnv64PrimeX;
				t2 += v0 << 8;
				t3 += v1 << 8;
				t1 += t0 >>> 16;
				v0 = t0 & 0xffff;
				t2 += t1 >>> 16;
				v1 = t1 & 0xffff;
				v3 = (t3 + (t2 >>> 16)) & 0xffff;
				v2 = t2 & 0xffff;
			}

			a = (v3 << 16) | v2;
			b = (v1 << 16) | v0;
		}

		if (this._useMask) {
			const mask = m - 1;
			a &= mask;
			b &= mask;
			buckets[a >>> 5] |= 1 << (a & 0x1f);
			for (let i = 1; i < k; ++i) {
				a = (a + b) & mask;
				b = (b + i) & mask;
				buckets[a >>> 5] |= 1 << (a & 0x1f);
			}
		} else {
			a = a % m;
			if (a < 0) a += m;
			b = b % m;
			if (b < 0) b += m;

			buckets[a >>> 5] |= 1 << (a & 0x1f);
			for (let i = 1; i < k; ++i) {
				a = a + b;
				if (a >= m) a -= m;
				b = b + i;
				if (b >= m) b %= m;
				buckets[a >>> 5] |= 1 << (a & 0x1f);
			}
		}
	}

	test(v: unknown): boolean {
		const k = this.k;
		const m = this.m;
		const buckets = this.buckets;
		// biome-ignore lint/style/useTemplate: Preserve legacy string coercion, which rejects Symbols.
		const s = v + "";
		let a: number;
		let b: number;

		// FNV-1a hash (64-bit).
		{
			const fnv64PrimeX = 0x01b3;
			const l = s.length;
			let t0 = 0,
				t1 = 0,
				t2 = 0,
				t3 = 0;
			let v0 = 0x2325,
				v1 = 0x8422,
				v2 = 0x9ce4,
				v3 = 0xcbf2;

			for (let i = 0; i < l; ++i) {
				v0 ^= s.charCodeAt(i);
				t0 = v0 * fnv64PrimeX;
				t1 = v1 * fnv64PrimeX;
				t2 = v2 * fnv64PrimeX;
				t3 = v3 * fnv64PrimeX;
				t2 += v0 << 8;
				t3 += v1 << 8;
				t1 += t0 >>> 16;
				v0 = t0 & 0xffff;
				t2 += t1 >>> 16;
				v1 = t1 & 0xffff;
				v3 = (t3 + (t2 >>> 16)) & 0xffff;
				v2 = t2 & 0xffff;
			}

			a = (v3 << 16) | v2;
			b = (v1 << 16) | v0;
		}

		if (this._useMask) {
			const mask = m - 1;
			a &= mask;
			b &= mask;
			if ((buckets[a >>> 5] & (1 << (a & 0x1f))) === 0) return false;
			for (let i = 1; i < k; ++i) {
				a = (a + b) & mask;
				b = (b + i) & mask;
				if ((buckets[a >>> 5] & (1 << (a & 0x1f))) === 0) return false;
			}
		} else {
			a = a % m;
			if (a < 0) a += m;
			b = b % m;
			if (b < 0) b += m;

			if ((buckets[a >>> 5] & (1 << (a & 0x1f))) === 0) return false;
			for (let i = 1; i < k; ++i) {
				a = a + b;
				if (a >= m) a -= m;
				b = b + i;
				if (b >= m) b %= m;
				if ((buckets[a >>> 5] & (1 << (a & 0x1f))) === 0) return false;
			}
		}
		return true;
	}

	// Estimated cardinality.
	size(): number {
		return (-this.m * Math.log(1 - this.countBits() / this.m)) / this.k;
	}

	countBits(): number {
		const buckets = this.buckets;
		let bits = 0;
		for (let i = 0; i < buckets.length; ++i) {
			bits += popcnt(buckets[i]);
		}
		return bits;
	}

	/**
	 * True if and only if every bit in the filter is set. Saturated filters
	 * return true for every membership test, and size() returns Infinity.
	 *
	 * Early-exits on the first non-full word instead of counting all bits.
	 * This is exact because m is always a multiple of 32, so there are no
	 * partial words to mask.
	 */
	isSaturated(): boolean {
		const buckets = this.buckets;
		for (let i = 0; i < buckets.length; ++i) {
			if (buckets[i] !== 0xffffffff) return false;
		}
		return true;
	}

	error(): number {
		return (this.countBits() / this.m) ** this.k;
	}

	/**
	 * Serialize as a JSON-compatible object.
	 * @param {object} [options]
	 * @param {"array"|"base64"} [options.encoding="array"] - "array" preserves
	 *     the legacy decimal bucket array. "base64" stores little-endian bucket
	 *     bytes in a string when the runtime supports typed-array base64 APIs.
	 */
	toJSON(options?: BloomFilterJSONOptions): BloomFilterJSON {
		const hashName = HASH_NAME_BY_ID[this._hashId ?? DEFAULT_HASH_ID];
		const hashField =
			(this._hashId ?? DEFAULT_HASH_ID) === DEFAULT_HASH_ID ? null : hashName;

		if (options && options.encoding === "base64") {
			if (!HAS_UINT8_TO_BASE64) {
				throw new Error(
					"BloomFilter.toJSON({encoding:'base64'}) requires Uint8Array.prototype.toBase64. " +
						"This runtime does not support it; use the default array encoding or call toBytes().",
				);
			}
			const out: BloomFilterJSON = {
				version: SERIALISATION_VERSION,
				m: this.m,
				k: this.k,
				encoding: "base64",
				buckets: bucketsToLEBase64(this.buckets),
			};
			if (hashField) out.hash = hashField;
			return out;
		}
		if (
			options &&
			options.encoding !== undefined &&
			options.encoding !== "array"
		) {
			throw new RangeError(
				`Unsupported BloomFilter serialisation encoding: ${options.encoding}.`,
			);
		}

		const out: BloomFilterJSON = {
			version: SERIALISATION_VERSION,
			m: this.m,
			k: this.k,
			buckets: Array.from(this.buckets),
		};
		if (hashField) out.hash = hashField;
		return out;
	}

	/**
	 * Serialize as a self-contained Uint8Array:
	 * "BLMF" magic, format version, hash id, m, k, bucket count, then buckets.
	 */
	toBytes(): Uint8Array {
		const buckets = this.buckets;
		// The binary header stores m and k in 32 bits each; DataView would
		// silently wrap larger values mod 2^32, so reject them explicitly.
		// Note m = 2^32 is constructible via the public constructor.
		if (this.m > 0xffffffff) {
			throw new RangeError(
				`BloomFilter.toBytes() cannot serialize a filter with m=${this.m}: ` +
					"the binary header stores m in 32 bits. Use toJSON() for this filter size.",
			);
		}
		if (!Number.isInteger(this.k) || this.k > 0xffffffff) {
			throw new RangeError(
				`BloomFilter.toBytes() cannot serialize a filter with k=${this.k}: ` +
					"the binary header stores k in 32 bits.",
			);
		}
		const bucketByteCount = buckets.length * 4;
		const buf = new ArrayBuffer(BLOOM_BINARY_HEADER_LENGTH + bucketByteCount);
		const header = new Uint8Array(buf, 0, 8);
		header[0] = 0x42;
		header[1] = 0x4c;
		header[2] = 0x4d;
		header[3] = 0x46; // "BLMF"
		header[4] = BLOOM_BINARY_VERSION;
		header[5] = this._hashId ?? DEFAULT_HASH_ID;
		header[6] = 0;
		header[7] = BLOOM_BINARY_HEADER_LENGTH;

		const view = new DataView(buf);
		view.setUint32(8, this.m, true);
		view.setUint32(12, this.k, true);
		view.setUint32(16, buckets.length, true);
		view.setUint32(20, 0, true);

		if (HOST_IS_LITTLE_ENDIAN) {
			new Uint8Array(buf, BLOOM_BINARY_HEADER_LENGTH, bucketByteCount).set(
				new Uint8Array(buckets.buffer, buckets.byteOffset, bucketByteCount),
			);
		} else {
			for (let i = 0; i < buckets.length; ++i) {
				view.setUint32(BLOOM_BINARY_HEADER_LENGTH + i * 4, buckets[i], true);
			}
		}

		return new Uint8Array(buf);
	}

	toArrayBuffer(): ArrayBuffer {
		return this.toBytes().buffer as ArrayBuffer;
	}

	toBase64(): string {
		if (!HAS_UINT8_TO_BASE64) {
			throw new Error(
				"BloomFilter.toBase64() requires Uint8Array.prototype.toBase64. " +
					"This runtime does not support it; use toBytes() with an external base64 codec.",
			);
		}
		return (this.toBytes() as Uint8ArrayWithBase64).toBase64();
	}

	// Static methods.

	static fromJSON(value: unknown): BloomFilter {
		const data = typeof value === "string" ? JSON.parse(value) : value;
		assertSerialisedFilter(data);

		if (data.version !== undefined && data.version !== SERIALISATION_VERSION) {
			throw new RangeError(
				`Unsupported BloomFilter serialisation format version: ${data.version}.`,
			);
		}

		const hashName = data.hash ?? DEFAULT_HASH_NAME;
		// Object.hasOwn (not `in`): the allowlist must not match inherited
		// Object.prototype names such as "toString" or "constructor".
		if (!Object.hasOwn(HASH_ID_BY_NAME, hashName)) {
			throw new RangeError(
				`Unsupported BloomFilter hash: ${hashName}. Known: ${Object.keys(HASH_ID_BY_NAME).join(", ")}.`,
			);
		}

		if (data.encoding === "base64") {
			if (!HAS_UINT8_FROM_BASE64) {
				throw new Error(
					"BloomFilter.fromJSON received a base64-encoded payload but this runtime " +
						"does not support Uint8Array.fromBase64. Use toJSON() (default encoding) " +
						"to produce array-form payloads, or upgrade your runtime.",
				);
			}
			if (typeof data.buckets !== "string") {
				throw new RangeError(
					"Serialised BloomFilter with encoding='base64' must have a string buckets field.",
				);
			}
			const bytes = Uint8ArrayBase64.fromBase64(data.buckets);
			if ((bytes.byteLength & 3) !== 0) {
				throw new RangeError(
					"Serialised BloomFilter buckets length must be a multiple of 4 bytes.",
				);
			}
			const expectedM = (bytes.byteLength >>> 2) * 32;
			if (data.m !== undefined && data.m !== expectedM) {
				throw new RangeError(
					"Serialised BloomFilter has inconsistent m and buckets.",
				);
			}
			return new BloomFilter(leBytesToBuckets(bytes), data.k);
		}

		if (data.encoding !== undefined && data.encoding !== "array") {
			throw new RangeError(
				`Unsupported BloomFilter serialisation encoding: ${data.encoding}.`,
			);
		}

		const buckets = data.buckets as ArrayLike<number>;
		const expectedM = buckets.length * 32;
		if (data.m !== undefined && data.m !== expectedM) {
			throw new RangeError(
				"Serialised BloomFilter has inconsistent m and buckets.",
			);
		}

		return new BloomFilter(buckets, data.k);
	}

	static fromBytes(bytes: Uint8Array): BloomFilter {
		if (!(bytes instanceof Uint8Array)) {
			throw new TypeError("BloomFilter.fromBytes requires a Uint8Array.");
		}
		if (bytes.byteLength < BLOOM_BINARY_HEADER_LENGTH) {
			throw new RangeError(
				"Truncated BloomFilter binary payload (header too short).",
			);
		}
		if (
			bytes[0] !== 0x42 ||
			bytes[1] !== 0x4c ||
			bytes[2] !== 0x4d ||
			bytes[3] !== 0x46
		) {
			throw new RangeError(
				"Invalid BloomFilter binary magic - not a recognized payload.",
			);
		}
		const version = bytes[4];
		if (version !== BLOOM_BINARY_VERSION) {
			throw new RangeError(
				`Unsupported BloomFilter binary format version: ${version}.`,
			);
		}
		const hashId = bytes[5];
		const hashName = HASH_NAME_BY_ID[hashId];
		if (hashName === undefined) {
			throw new RangeError(
				`Unsupported BloomFilter hash id: ${hashId}. This filter was serialized ` +
					`with a hash variant this runtime does not recognize. Known ids: ` +
					`${Object.keys(HASH_NAME_BY_ID).join(", ")}.`,
			);
		}
		const headerLen = bytes[7];
		if (headerLen !== BLOOM_BINARY_HEADER_LENGTH) {
			throw new RangeError(
				`Unexpected BloomFilter header length: ${headerLen}.`,
			);
		}

		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const m = view.getUint32(8, true);
		const k = view.getUint32(12, true);
		const bucketCount = view.getUint32(16, true);

		if (m !== bucketCount * 32) {
			throw new RangeError(
				"Serialised BloomFilter has inconsistent m and bucket count.",
			);
		}
		const expectedLength = headerLen + bucketCount * 4;
		if (bytes.byteLength !== expectedLength) {
			throw new RangeError(
				`BloomFilter binary payload length mismatch: expected ${expectedLength}, got ${bytes.byteLength}.`,
			);
		}

		let buckets: Uint32Array;
		if (HOST_IS_LITTLE_ENDIAN) {
			buckets = new Uint32Array(
				bytes.buffer,
				bytes.byteOffset + headerLen,
				bucketCount,
			);
		} else {
			buckets = new Uint32Array(bucketCount);
			for (let i = 0; i < bucketCount; ++i) {
				buckets[i] = view.getUint32(headerLen + i * 4, true);
			}
		}

		return new BloomFilter(buckets, k);
	}

	static fromArrayBuffer(buffer: ArrayBuffer): BloomFilter {
		if (!(buffer instanceof ArrayBuffer)) {
			throw new TypeError(
				"BloomFilter.fromArrayBuffer requires an ArrayBuffer.",
			);
		}
		return BloomFilter.fromBytes(new Uint8Array(buffer));
	}

	static fromBase64(text: string): BloomFilter {
		if (!HAS_UINT8_FROM_BASE64) {
			throw new Error(
				"BloomFilter.fromBase64() requires Uint8Array.fromBase64. " +
					"This runtime does not support it; decode externally and call fromBytes().",
			);
		}
		if (typeof text !== "string") {
			throw new TypeError("BloomFilter.fromBase64 requires a string.");
		}
		return BloomFilter.fromBytes(Uint8ArrayBase64.fromBase64(text));
	}

	// Internal factory: takes ownership of a freshly-created Uint32Array without
	// copying or validating it. Callers must only pass buckets produced inside
	// this module, not untrusted external input.
	static _fromTrustedBuckets(buckets: Uint32Array, k: number): BloomFilter {
		const m = buckets.length * 32;
		const filter = Object.create(BloomFilter.prototype) as BloomFilter;
		filter.m = m;
		filter.k = k;
		filter.buckets = buckets;
		filter._useMask = isPowerOf2(m);
		filter._hashId = DEFAULT_HASH_ID;

		filter._locationsCache = null;

		return filter;
	}

	static union(a: BloomFilter, b: BloomFilter): BloomFilter {
		if (a.m === b.m && a.k === b.k && a.buckets.length === b.buckets.length) {
			const l = a.buckets.length;
			const c = new Uint32Array(l);
			for (let i = 0; i < l; ++i) {
				c[i] = a.buckets[i] | b.buckets[i];
			}
			return BloomFilter._fromTrustedBuckets(c, a.k);
		}
		throw new Error("Bloom filters must have identical {m, k}.");
	}

	static intersection(a: BloomFilter, b: BloomFilter): BloomFilter {
		if (a.m === b.m && a.k === b.k && a.buckets.length === b.buckets.length) {
			const l = a.buckets.length;
			const c = new Uint32Array(l);
			for (let i = 0; i < l; ++i) {
				c[i] = a.buckets[i] & b.buckets[i];
			}
			return BloomFilter._fromTrustedBuckets(c, a.k);
		}
		throw new Error("Bloom filters must have identical {m, k}.");
	}

	/**
	 * @param {number} n - Expected number of items to be added.
	 * @param {number} error - Target false-positive rate (0 < error < 1).
	 * @param {object} [options] - Forwarded to the constructor.
	 *
	 * Searches integer k values near k* = log2(1 / error), using
	 * m = ceil(-k * n / ln(1 - error^(1 / k))) for each candidate.
	 * Picks the smallest m whose theoretical false-positive rate is <= error.
	 */
	static withTargetError(
		n: number,
		error: number,
		options?: BloomFilterOptions,
	): BloomFilter {
		assertExpectedSize(n);
		assertTargetError(error);

		const idealK = Math.log2(1 / error);
		const candidates = [
			Math.floor(idealK) - 1,
			Math.floor(idealK),
			Math.ceil(idealK),
			Math.ceil(idealK) + 1,
		];

		let bestM = Infinity;
		let bestK = -1;
		for (const k of candidates) {
			if (k < 1) continue;
			const denom = Math.log(1 - error ** (1 / k));
			if (!Number.isFinite(denom) || denom >= 0) continue;
			const m = Math.ceil((-k * n) / denom);
			if (m < bestM) {
				bestM = m;
				bestK = k;
			}
		}

		if (bestK < 1 || !Number.isFinite(bestM)) {
			throw new RangeError(
				`withTargetError could not find a valid (m, k) for n=${n}, error=${error}.`,
			);
		}

		return new BloomFilter(bestM, bestK, options);
	}
}

// http://graphics.stanford.edu/~seander/bithacks.html#CountBitsSetParallel
function popcnt(v: number): number {
	v -= (v >>> 1) & 0x55555555;
	v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
	return (((v + (v >>> 4)) & 0xf0f0f0f) * 0x1010101) >>> 24;
}

function nextPowerOf2(n: number): number {
	if (n <= 1) return 1;
	return 2 ** Math.ceil(Math.log2(n));
}

function isPowerOf2(n: number): boolean {
	// Bit trick is valid for our m range [1, 2^32]; MAX_BITS enforces the upper bound.
	return n > 0 && (n & (n - 1)) === 0;
}

function bucketsToLEBase64(buckets: Uint32Array): string {
	const bytes = HOST_IS_LITTLE_ENDIAN
		? new Uint8Array(buckets.buffer, buckets.byteOffset, buckets.byteLength)
		: (() => {
				const out = new Uint8Array(buckets.byteLength);
				const view = new DataView(out.buffer);
				for (let i = 0; i < buckets.length; ++i)
					view.setUint32(i * 4, buckets[i], true);
				return out;
			})();
	return (bytes as Uint8ArrayWithBase64).toBase64();
}

function leBytesToBuckets(bytes: Uint8Array): Uint32Array {
	if (HOST_IS_LITTLE_ENDIAN) {
		return new Uint32Array(
			bytes.buffer,
			bytes.byteOffset,
			bytes.byteLength >>> 2,
		);
	}
	const count = bytes.byteLength >>> 2;
	const buckets = new Uint32Array(count);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let i = 0; i < count; ++i) buckets[i] = view.getUint32(i * 4, true);
	return buckets;
}

// Element width in bytes for a scratch array holding positions in [0, m).
// Matches makeLocationArray's historical float sizing bit-for-bit on every
// input, including degenerate m (which historically yielded 1-byte elements),
// so the lazy-_locations guard and the allocator cannot drift apart.
function locationWidth(m: number): 1 | 2 | 4 {
	if (!(m > 0) || m === Number.POSITIVE_INFINITY) return 1;
	return m <= 256 ? 1 : m <= 65536 ? 2 : 4;
}

function makeLocationArray(m: number, k: number): LocationArray {
	const kbytes = locationWidth(m);
	const ArrayType: LocationArrayConstructor =
		kbytes === 1 ? Uint8Array : kbytes === 2 ? Uint16Array : Uint32Array;
	return new ArrayType(new ArrayBuffer(kbytes * k));
}

function assertBitSize(m: unknown): asserts m is number {
	if (typeof m !== "number" || !Number.isFinite(m) || m <= 0 || m > MAX_BITS) {
		throw new RangeError(
			`m must be a positive finite number of bits no greater than ${MAX_BITS}.`,
		);
	}
}

function assertBucketArrayLike(a: unknown): asserts a is ArrayLike<number> {
	const maybeArrayLike = a as { length?: unknown } | null | undefined;
	if (
		maybeArrayLike == null ||
		!Number.isInteger(maybeArrayLike.length) ||
		(maybeArrayLike.length as number) <= 0 ||
		(maybeArrayLike.length as number) > MAX_BUCKETS
	) {
		throw new RangeError(
			`m must be a positive number of bits or a non-empty array-like of up to ${MAX_BUCKETS} 32-bit buckets.`,
		);
	}
}

function assertBucketValue(value: unknown): asserts value is number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 0 ||
		value > 0xffffffff
	) {
		throw new RangeError("Bucket values must be unsigned 32-bit integers.");
	}
}

function assertHashCount(k: unknown): asserts k is number {
	if (typeof k !== "number" || !Number.isInteger(k) || k <= 0) {
		throw new RangeError("k must be a positive integer.");
	}
}

function assertExpectedSize(n: unknown): asserts n is number {
	if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
		throw new RangeError("n must be a positive finite number.");
	}
}

function assertTargetError(error: unknown): asserts error is number {
	if (
		typeof error !== "number" ||
		!Number.isFinite(error) ||
		error <= 0 ||
		error >= 1
	) {
		throw new RangeError(
			"error must be a finite number between 0 and 1, exclusive.",
		);
	}
}

function assertSerialisedFilter(
	data: unknown,
): asserts data is SerialisedFilterInput {
	if (data == null || typeof data !== "object") {
		throw new RangeError(
			"Serialised BloomFilter must be an object or JSON string.",
		);
	}
	if (!("k" in data)) {
		throw new RangeError("Serialised BloomFilter must include k.");
	}
	if (!("buckets" in data)) {
		throw new RangeError("Serialised BloomFilter must include buckets.");
	}
}
