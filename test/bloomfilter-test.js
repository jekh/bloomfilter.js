import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BloomFilter } from '../bloomfilter.js';

const jabberwocky = "`Twas brillig, and the slithy toves\n  Did gyre and gimble in the wabe:\nAll mimsy were the borogoves,\n  And the mome raths outgrabe.\n\n\"Beware the Jabberwock, my son!\n  The jaws that bite, the claws that catch!\nBeware the Jubjub bird, and shun\n  The frumious Bandersnatch!\"\n\nHe took his vorpal sword in hand:\n  Long time the manxome foe he sought --\nSo rested he by the Tumtum tree,\n  And stood awhile in thought.\n\nAnd, as in uffish thought he stood,\n  The Jabberwock, with eyes of flame,\nCame whiffling through the tulgey wood,\n  And burbled as it came!\n\nOne, two! One, two! And through and through\n  The vorpal blade went snicker-snack!\nHe left it dead, and with its head\n  He went galumphing back.\n\n\"And, has thou slain the Jabberwock?\n  Come to my arms, my beamish boy!\nO frabjous day! Callooh! Callay!'\n  He chortled in his joy.\n\n`Twas brillig, and the slithy toves\n  Did gyre and gimble in the wabe;\nAll mimsy were the borogoves,\n  And the mome raths outgrabe.";

describe('bloom filter', () => {

  it('basic', () => {
    const f = new BloomFilter(1000, 4);
    const n1 = "Bess";
    const n2 = "Jane";
    f.add(n1);
    assert.equal(f.test(n1), true);
    assert.equal(f.test(n2), false);
  });

  it('jabberwocky', () => {
    const f = new BloomFilter(1000, 4);
    const n1 = jabberwocky;
    const n2 = jabberwocky + "\n";
    f.add(n1);
    assert.equal(f.test(n1), true);
    assert.equal(f.test(n2), false);
  });

  it('basic uint32', () => {
    const f = new BloomFilter(1000, 4);
    const n1 = "\u0100";
    const n2 = "\u0101";
    const n3 = "\u0103";
    f.add(n1);
    assert.equal(f.test(n1), true);
    assert.equal(f.test(n2), false);
    assert.equal(f.test(n3), false);
  });

  it('wtf', () => {
    const f = new BloomFilter(20, 10);
    f.add("abc");
    assert.equal(f.test("wtf"), false);
  });

  it('works with integer types', () => {
    const f = new BloomFilter(1000, 4);
    f.add(1);
    assert.equal(f.test(1), true);
    assert.equal(f.test(2), false);
  });

  it('size', () => {
    const f = new BloomFilter(1024 * 1024, 4);
    for (let i = 0; i < 100; ++i) f.add(i);
    // Vows: assert.inDelta(f.size(), 100, 6);
    assert.ok(Math.abs(f.size() - 100) <= 6, 'Size within delta of 6');
    
    for (let i = 0; i < 1000; ++i) f.add(i);
    // Vows: assert.inDelta(f.size(), 1000, 100);
    assert.ok(Math.abs(f.size() - 1000) <= 100, 'Size within delta of 100');
  });

  it('countBits', () => {
    const f = new BloomFilter(1024, 4);
    f.add(0);
    assert.equal(f.countBits(), 4);
  });

  it('withTargetError/error', () => {
    const f = BloomFilter.withTargetError(100, 1e-5);
    for (let i = 0; i < 100; ++i) {
      f.add(i);
    }
    // Vows: assert.inDelta(f.error(), 1e-5, 1e-5);
    assert.ok(Math.abs(f.error() - 1e-5) <= 1e-5, 'Error within delta');
  });

  it('union', () => {
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

  it('intersection', () => {
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
