import { describe, expect, it } from 'vitest';
import { addDrops, compareDrops, dropsToXrp, xrpToDrops } from '../src/security/money.js';

describe('money', () => {
  it('converts XRP to drops without floating error', () => {
    expect(xrpToDrops('1')).toBe('1000000');
    expect(xrpToDrops('0.5')).toBe('500000');
    expect(xrpToDrops('2.25')).toBe('2250000');
    expect(xrpToDrops('0.000001')).toBe('1');
  });

  it('round-trips drops to XRP', () => {
    expect(dropsToXrp('1000000')).toBe('1');
    expect(dropsToXrp('500000')).toBe('0.5');
    expect(dropsToXrp('1')).toBe('0.000001');
  });

  it('rejects invalid amounts and sub-drop precision', () => {
    expect(() => xrpToDrops('abc')).toThrow();
    expect(() => xrpToDrops('1.1234567')).toThrow();
  });

  it('adds and compares drops', () => {
    expect(addDrops('1000000', '500000')).toBe('1500000');
    expect(compareDrops('1', '2')).toBe(-1);
    expect(compareDrops('2', '2')).toBe(0);
    expect(compareDrops('3', '2')).toBe(1);
  });
});
