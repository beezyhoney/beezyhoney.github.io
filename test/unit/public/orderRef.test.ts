// src/lib/orderRef.ts: order code alphabet, random codes and keys, and the admin's partial search.
import { describe, expect, it } from 'vitest';
import { ALPHABET, isKey, isRef, newKey, newRef, normaliseRefQuery, refMatches } from '../../../src/lib/orderRef';

describe('alphabet', () => {
  it('has 26 different characters and none that look alike', () => {
    expect(ALPHABET).toHaveLength(26);
    expect(new Set(ALPHABET).size).toBe(26);
    for (const c of '0O1IL2Z5SB') expect(ALPHABET).not.toContain(c);
    expect(ALPHABET).toBe('346789ACDEFGHJKMNPQRTUVWXY');
  });
});

describe('newRef', () => {
  it('makes BZ- plus 5 alphabet characters', () => {
    for (let i = 0; i < 2000; i++) {
      const r = newRef();
      expect(r).toMatch(/^BZ-[346789ACDEFGHJKMNPQRTUVWXY]{5}$/);
      expect(isRef(r)).toBe(true);
    }
  });
  it('uses every character about equally (no modulo bias)', () => {
    const counts = new Map<string, number>();
    const N = 20000;
    for (let i = 0; i < N; i++) for (const c of newRef().slice(3)) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(26);
    const expected = (N * 5) / 26;
    for (const n of counts.values()) expect(Math.abs(n - expected) / expected).toBeLessThan(0.1);
  });
  it('rarely repeats', () => {
    const seen = new Set(Array.from({ length: 5000 }, newRef));
    expect(seen.size).toBeGreaterThan(4990);
  });
});

describe('newKey / isKey', () => {
  it('makes 32 lower-case hex characters', () => {
    for (let i = 0; i < 200; i++) expect(newKey()).toMatch(/^[0-9a-f]{32}$/);
    expect(isKey(newKey())).toBe(true);
    expect(new Set(Array.from({ length: 500 }, newKey)).size).toBe(500);
  });
  it('rejects anything else', () => {
    expect(isKey('A'.repeat(32))).toBe(false);
    expect(isKey('a'.repeat(31))).toBe(false);
    expect(isKey(null)).toBe(false);
  });
});

describe('isRef', () => {
  it('accepts only exact codes', () => {
    expect(isRef('BZ-7K3QD')).toBe(true);
    for (const bad of ['bz-7k3qd', 'BZ7K3QD', 'BZ-7K3Q', 'BZ-7K3QDD', 'BZ-7K3Q0', 'BZ-OK3QD', 'XX-7K3QD', ' BZ-7K3QD', '', null, 42]) {
      expect(isRef(bad), String(bad)).toBe(false);
    }
  });
});

describe('normaliseRefQuery (admin find box)', () => {
  it('reads full codes however they are typed', () => {
    for (const q of ['BZ-7K3QD', 'bz-7k3qd', 'BZ 7K3QD', 'bz7k3qd', 'Order BZ-7K3QD', '#BZ-7K3QD', ' 7k3qd ', 'BZ–7K3QD']) {
      expect(normaliseRefQuery(q), q).toBe('7K3QD');
    }
  });
  it('keeps the last 3 or 4 characters for a partial search', () => {
    expect(normaliseRefQuery('3qd')).toBe('3QD');
    expect(normaliseRefQuery('K3QD')).toBe('K3QD');
    expect(normaliseRefQuery('bz-3qd')).toBe('3QD');
  });
  it('says null when it cannot be a code', () => {
    for (const q of ['', 'QD', 'BZ', 'BZ-', '7K3QDX9', 'O0O', 'ISL', '12345', 'hello world', null, undefined]) {
      expect(normaliseRefQuery(q as string), String(q)).toBeNull();
    }
  });
  it('refMatches: exact for full codes, the end for partial ones', () => {
    expect(refMatches('BZ-7K3QD', 'bz-7k3qd')).toBe(true);
    expect(refMatches('BZ-7K3QD', '3QD')).toBe(true);
    expect(refMatches('BZ-7K3QD', 'K3QD')).toBe(true);
    expect(refMatches('BZ-7K3QD', '7K3')).toBe(false);
    expect(refMatches('BZ-7K3QD', 'BZ-7K3QE')).toBe(false);
    expect(refMatches('not a ref', '3QD')).toBe(false);
    expect(refMatches('BZ-7K3QD', 'xx')).toBe(false);
  });
});
