// src/lib/money.ts: Indian rupee formatting (lakh and crore), per-100 g prices, typed amounts, amounts in words.
import { describe, expect, it } from 'vitest';
import { amountInWords, formatINR, groupIndian, numberInWords, parseRupees, perHundredGrams } from '../../../src/lib/money';

const intl = (paise: number) => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR',
  minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: paise % 100 ? 2 : 0,
}).format(paise / 100);

describe('formatINR', () => {
  it('prints whole rupees without decimals', () => {
    expect(formatINR(0)).toBe('₹0');
    expect(formatINR(700)).toBe('₹7');
    expect(formatINR(31000)).toBe('₹310');
    expect(formatINR(69000)).toBe('₹690');
    expect(formatINR(105000)).toBe('₹1,050');
  });
  it('groups lakh and crore the Indian way', () => {
    expect(formatINR(10500000)).toBe('₹1,05,000');
    expect(formatINR(1234567800)).toBe('₹1,23,45,678');
    expect(formatINR(100000000)).toBe('₹10,00,000');
    expect(formatINR(1000000000)).toBe('₹1,00,00,000');
    expect(formatINR(123456789012300)).toBe('₹12,34,56,78,90,123');
  });
  it('shows paise only when there are some', () => {
    expect(formatINR(105050)).toBe('₹1,050.50');
    expect(formatINR(105005)).toBe('₹1,050.05');
    expect(formatINR(1)).toBe('₹0.01');
    expect(formatINR(11980)).toBe('₹119.80');
  });
  it('puts the minus sign in front for refunds', () => {
    expect(formatINR(-50000)).toBe('-₹500');
    expect(formatINR(-10500050)).toBe('-₹1,05,000.50');
  });
  it('matches Intl.NumberFormat en-IN for many amounts', () => {
    const values = [0, 1, 99, 100, 101, 999, 1000, 9999, 10000, 99999, 100000, 1234567, 9999999, 10000000, 12345678, 99999999,
      100000000, 123456789, 999999999, 1000000000, 31000, 7000, 59900, 180000, 1050050, 4999999999];
    for (const v of values) {
      expect(formatINR(v)).toBe(intl(v));
      expect(formatINR(-v || 0)).toBe(v ? intl(-v) : intl(0));
    }
    let x = 1;
    for (let i = 0; i < 300; i++) { x = (x * 48271) % 2147483647; expect(formatINR(x)).toBe(intl(x)); }
  });
  it('refuses anything that is not whole paise', () => {
    expect(() => formatINR(1.5)).toThrow(RangeError);
    expect(() => formatINR(Number.NaN)).toThrow(RangeError);
    expect(() => formatINR(Infinity)).toThrow(RangeError);
    expect(() => formatINR('310' as unknown as number)).toThrow(RangeError);
  });
  it('groupIndian', () => {
    expect(groupIndian(0)).toBe('0');
    expect(groupIndian(999)).toBe('999');
    expect(groupIndian(1000)).toBe('1,000');
    expect(groupIndian(100000)).toBe('1,00,000');
    expect(() => groupIndian(-1)).toThrow(RangeError);
  });
});

describe('perHundredGrams', () => {
  it('works out the price per 100 g in paise', () => {
    expect(perHundredGrams(31000, 250)).toBe(12400);
    expect(perHundredGrams(14000, 100)).toBe(14000);
    expect(perHundredGrams(65000, 500)).toBe(13000);
    expect(perHundredGrams(59900, 500)).toBe(11980);
    expect(perHundredGrams(700, 10)).toBe(7000);
    expect(perHundredGrams(100, 3)).toBe(3333);
  });
  it('is null without a price or a weight', () => {
    expect(perHundredGrams(null, 250)).toBeNull();
    expect(perHundredGrams(31000, null)).toBeNull();
    expect(perHundredGrams(31000, 0)).toBeNull();
    expect(perHundredGrams(undefined, 250)).toBeNull();
  });
});

describe('parseRupees', () => {
  it('reads what people type', () => {
    expect(parseRupees('₹1,050.50')).toBe(105050);
    expect(parseRupees('1050')).toBe(105000);
    expect(parseRupees('1050.5')).toBe(105050);
    expect(parseRupees(' ₹ 310 ')).toBe(31000);
    expect(parseRupees('Rs. 1,05,000')).toBe(10500000);
    expect(parseRupees('rs 500')).toBe(50000);
    expect(parseRupees('INR 70')).toBe(7000);
    expect(parseRupees('₹500/-')).toBe(50000);
    expect(parseRupees('1,00,00,000')).toBe(1000000000);
    expect(parseRupees('10,000,000')).toBe(1000000000);
    expect(parseRupees('0')).toBe(0);
    expect(parseRupees('0.05')).toBe(5);
  });
  it('reads refunds with a minus sign', () => {
    expect(parseRupees('-₹50')).toBe(-5000);
    expect(parseRupees('₹-50')).toBe(-5000);
    expect(parseRupees('−50')).toBe(-5000);
    expect(parseRupees('-0')).toBe(0);
  });
  it('says null for anything unclear', () => {
    for (const bad of ['', ' ', 'abc', '₹', '1.234', '1,0', '10,00', '1,,000', '12a', '1 000', '.5', '5.', '₹1,050.505', 'Rs', '--5', '1e3']) {
      expect(parseRupees(bad), bad).toBeNull();
    }
    expect(parseRupees(null)).toBeNull();
    expect(parseRupees(undefined)).toBeNull();
  });
  it('accepts plain numbers of rupees', () => {
    expect(parseRupees(310)).toBe(31000);
    expect(parseRupees(10.15)).toBe(1015);
    expect(parseRupees(Number.NaN)).toBeNull();
  });
  it('round-trips with formatINR', () => {
    for (const v of [0, 1, 99, 31000, 105050, 10500000, 1234567805, 999999999999]) expect(parseRupees(formatINR(v))).toBe(v);
  });
});

describe('amountInWords', () => {
  it('uses lakh and crore', () => {
    expect(amountInWords(10500000)).toBe('Rupees One Lakh Five Thousand Only');
    expect(amountInWords(69000)).toBe('Rupees Six Hundred Ninety Only');
    expect(amountInWords(31000)).toBe('Rupees Three Hundred Ten Only');
    expect(amountInWords(1200000000)).toBe('Rupees One Crore Twenty Lakh Only');
    expect(amountInWords(1234567800)).toBe('Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only');
    expect(amountInWords(100000000000)).toBe('Rupees One Hundred Crore Only');
    expect(amountInWords(1000000000000)).toBe('Rupees One Thousand Crore Only');
  });
  it('adds paise', () => {
    expect(amountInWords(105050)).toBe('Rupees One Thousand Fifty and Fifty Paise Only');
    expect(amountInWords(50)).toBe('Fifty Paise Only');
    expect(amountInWords(1)).toBe('One Paise Only');
    expect(amountInWords(1101)).toBe('Rupees Eleven and One Paise Only');
  });
  it('handles zero, teens and negatives', () => {
    expect(amountInWords(0)).toBe('Rupees Zero Only');
    expect(amountInWords(1900)).toBe('Rupees Nineteen Only');
    expect(amountInWords(-50000)).toBe('Minus Rupees Five Hundred Only');
    expect(numberInWords(100100)).toBe('One Lakh One Hundred');
    expect(numberInWords(99999)).toBe('Ninety Nine Thousand Nine Hundred Ninety Nine');
    expect(() => amountInWords(1.5)).toThrow(RangeError);
  });
});
