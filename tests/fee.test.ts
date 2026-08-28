import { describe, expect, it } from 'vitest';
import { calculateFeeCents, formatPercent } from '../src/lib/format.js';

describe('per-order fee calculation', () => {
  it('rounds a percentage against either resolved fee basis', () => {
    expect(calculateFeeCents(15678, 8.5)).toBe(1333);
    expect(calculateFeeCents(999, 2.5)).toBe(25);
    expect(calculateFeeCents(35_000, 10)).toBe(3500);
    expect(calculateFeeCents(null, 8.5)).toBeNull();
  });

  it('formats custom percentages without losing precision', () => {
    expect(formatPercent(8.5)).toBe('8.5%');
    expect(formatPercent(10)).toBe('10%');
  });
});
