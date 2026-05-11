const MAX_BITS = 0x100000000;
const MAX_BUCKETS = MAX_BITS / 32;
const SERIALISATION_VERSION = 1;

// Hash and location generation are inlined into add() and test() to avoid a
// scratch-buffer round-trip per bit and to let test() return on the first
// missing bit.
//
// The hot path uses a bitmask when m is a power of 2, and otherwise uses the
// existing signed modulo reduction. The public locations() method is retained
// for compatibility.

export class BloomFilter {

  /**
   * @param {number|ArrayLike} m - Number of bits, or an array of integers to load.
   * @param {number} k - Number of hashing functions.
   * @param {object} [options]
   * @param {"tight"|"pow2"} [options.storage="tight"] - Storage rounding policy
   *     when m is a number. "tight" rounds to the next 32-bit word; "pow2"
   *     rounds to a power of 2 for bitmask reduction, at up to ~2x storage.
   *     Ignored when m is an array of buckets.
   */
  constructor(m, k, options = {}) {
    let a;
    if (typeof m !== "number") {
      assertBucketArrayLike(m);
      a = m;
      m = a.length * 32;
    } else {
      assertBitSize(m);
    }
    assertHashCount(k);

    const storage = options.storage ?? "tight";
    if (storage !== "tight" && storage !== "pow2") {
      throw new RangeError('options.storage must be "tight" or "pow2".');
    }

    if (a === undefined && storage === "pow2") {
      m = nextPowerOf2(Math.max(32, m));
      if (m > MAX_BITS) {
        throw new RangeError(`Rounded m exceeds maximum bits ${MAX_BITS}.`);
      }
    } else {
      const n = Math.ceil(m / 32);
      m = n * 32;
    }

    const n = m / 32;
    this.m = m;
    this.k = k;
    this._useMask = isPowerOf2(m);

    const kbytes = 1 << Math.ceil(Math.log2(Math.ceil(Math.log2(m) / 8)));
    const ArrayType = kbytes === 1 ? Uint8Array : kbytes === 2 ? Uint16Array : Uint32Array;
    const kbuffer = new ArrayBuffer(kbytes * k);

    let buckets;
    if (a instanceof Uint32Array) {
      // Uint32Array already guarantees uint32 bucket values; the native
      // typed-array copy avoids validation overhead without aliasing input.
      buckets = new Uint32Array(a);
    } else {
      buckets = new Uint32Array(n);
      if (a) {
        const inputLen = Math.min(a.length, n);
        for (let i = 0; i < inputLen; ++i) {
          const value = a[i];
          assertBucketValue(value);
          buckets[i] = value;
        }
      }
    }

    this.buckets = buckets;
    this._locations = new ArrayType(kbuffer);
  }

  // Retained for compatibility; add() and test() inline this loop to avoid
  // scratch-buffer writes and to allow early exits.
  // See http://willwhim.wpengine.com/2011/09/03/producing-n-hash-functions-by-hashing-only-once/
  locations(v) {
    const k = this.k;
    const m = this.m;
    const r = this._locations;
    let a;
    let b;

    // FNV-1a hash (64-bit).
    {
      const fnv64PrimeX = 0x01b3;
      const l = v.length;
      let t0 = 0, t1 = 0, t2 = 0, t3 = 0;
      let v0 = 0x2325, v1 = 0x8422, v2 = 0x9ce4, v3 = 0xcbf2;

      for (let i = 0; i < l; ++i) {
        v0 ^= v.charCodeAt(i);
        t0 = v0 * fnv64PrimeX; t1 = v1 * fnv64PrimeX; t2 = v2 * fnv64PrimeX; t3 = v3 * fnv64PrimeX;
        t2 += v0 << 8; t3 += v1 << 8;
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
      a = (a % m);
      if (a < 0) a += m;
      b = (b % m);
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

  add(v) {
    const k = this.k;
    const m = this.m;
    const buckets = this.buckets;
    const s = v + "";
    let a;
    let b;

    // FNV-1a hash (64-bit).
    {
      const fnv64PrimeX = 0x01b3;
      const l = s.length;
      let t0 = 0, t1 = 0, t2 = 0, t3 = 0;
      let v0 = 0x2325, v1 = 0x8422, v2 = 0x9ce4, v3 = 0xcbf2;

      for (let i = 0; i < l; ++i) {
        v0 ^= s.charCodeAt(i);
        t0 = v0 * fnv64PrimeX; t1 = v1 * fnv64PrimeX; t2 = v2 * fnv64PrimeX; t3 = v3 * fnv64PrimeX;
        t2 += v0 << 8; t3 += v1 << 8;
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
      a = (a % m);
      if (a < 0) a += m;
      b = (b % m);
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

  test(v) {
    const k = this.k;
    const m = this.m;
    const buckets = this.buckets;
    const s = v + "";
    let a;
    let b;

    // FNV-1a hash (64-bit).
    {
      const fnv64PrimeX = 0x01b3;
      const l = s.length;
      let t0 = 0, t1 = 0, t2 = 0, t3 = 0;
      let v0 = 0x2325, v1 = 0x8422, v2 = 0x9ce4, v3 = 0xcbf2;

      for (let i = 0; i < l; ++i) {
        v0 ^= s.charCodeAt(i);
        t0 = v0 * fnv64PrimeX; t1 = v1 * fnv64PrimeX; t2 = v2 * fnv64PrimeX; t3 = v3 * fnv64PrimeX;
        t2 += v0 << 8; t3 += v1 << 8;
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
      a = (a % m);
      if (a < 0) a += m;
      b = (b % m);
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
  size() {
    return -this.m * Math.log(1 - this.countBits() / this.m) / this.k;
  }

  countBits() {
    const buckets = this.buckets;
    let bits = 0;
    for (let i = 0; i < buckets.length; ++i) {
      bits += popcnt(buckets[i]);
    }
    return bits;
  }

  error() {
    return Math.pow(this.countBits() / this.m, this.k);
  }

  toJSON() {
    return {
      version: SERIALISATION_VERSION,
      m: this.m,
      k: this.k,
      buckets: Array.from(this.buckets)
    };
  }

  // Static methods.

  static fromJSON(value) {
    const data = typeof value === "string" ? JSON.parse(value) : value;
    assertSerialisedFilter(data);

    if (data.version !== undefined && data.version !== SERIALISATION_VERSION) {
      throw new RangeError(`Unsupported BloomFilter serialisation format version: ${data.version}.`);
    }

    const expectedM = data.buckets.length * 32;
    if (data.m !== undefined && data.m !== expectedM) {
      throw new RangeError("Serialised BloomFilter has inconsistent m and buckets.");
    }

    return new BloomFilter(data.buckets, data.k);
  }

  // Internal factory: takes ownership of a freshly-created Uint32Array without
  // copying or validating it. Callers must only pass buckets produced inside
  // this module, not untrusted external input.
  static _fromTrustedBuckets(buckets, k) {
    const m = buckets.length * 32;
    const filter = Object.create(BloomFilter.prototype);
    filter.m = m;
    filter.k = k;
    filter.buckets = buckets;
    filter._useMask = isPowerOf2(m);

    const kbytes = 1 << Math.ceil(Math.log2(Math.ceil(Math.log2(m) / 8)));
    const ArrayType = kbytes === 1 ? Uint8Array : kbytes === 2 ? Uint16Array : Uint32Array;
    const kbuffer = new ArrayBuffer(kbytes * k);
    filter._locations = new ArrayType(kbuffer);

    return filter;
  }

  static union(a, b) {
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

  static intersection(a, b) {
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
   */
  static withTargetError (n, error, options) {
    assertExpectedSize(n);
    assertTargetError(error);
    const m = Math.ceil(-n * Math.log2(error) / Math.LN2);
    const k = Math.ceil(Math.LN2 * m / n);
    return new BloomFilter(m, k, options);
  }
};

// http://graphics.stanford.edu/~seander/bithacks.html#CountBitsSetParallel
function popcnt(v) {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return ((v + (v >>> 4) & 0xf0f0f0f) * 0x1010101) >>> 24;
}

function nextPowerOf2(n) {
  if (n <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(n));
}

function isPowerOf2(n) {
  // Bit trick is valid for our m range [1, 2^32]; MAX_BITS enforces the upper bound.
  return n > 0 && (n & (n - 1)) === 0;
}

function assertBitSize(m) {
  if (typeof m !== "number" || !Number.isFinite(m) || m <= 0 || m > MAX_BITS) {
    throw new RangeError(`m must be a positive finite number of bits no greater than ${MAX_BITS}.`);
  }
}

function assertBucketArrayLike(a) {
  if (a == null || !Number.isInteger(a.length) || a.length <= 0 || a.length > MAX_BUCKETS) {
    throw new RangeError(`m must be a positive number of bits or a non-empty array-like of up to ${MAX_BUCKETS} 32-bit buckets.`);
  }
}

function assertBucketValue(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError("Bucket values must be unsigned 32-bit integers.");
  }
}

function assertHashCount(k) {
  if (!Number.isInteger(k) || k <= 0) {
    throw new RangeError("k must be a positive integer.");
  }
}

function assertExpectedSize(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    throw new RangeError("n must be a positive finite number.");
  }
}

function assertTargetError(error) {
  if (typeof error !== "number" || !Number.isFinite(error) || error <= 0 || error >= 1) {
    throw new RangeError("error must be a finite number between 0 and 1, exclusive.");
  }
}

function assertSerialisedFilter(data) {
  if (data == null || typeof data !== "object") {
    throw new RangeError("Serialised BloomFilter must be an object or JSON string.");
  }
  if (!("k" in data)) {
    throw new RangeError("Serialised BloomFilter must include k.");
  }
  if (!("buckets" in data)) {
    throw new RangeError("Serialised BloomFilter must include buckets.");
  }
}
