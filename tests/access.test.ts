import { describe, expect, it } from 'vitest';
import { serialMatches } from '../server/security/access.js';

describe('service serial gate', () => {
  it('compares serials without treating near matches as valid', () => {
    expect(serialMatches('aco-beta-serial-1234', 'aco-beta-serial-1234')).toBe(true);
    expect(serialMatches('aco-beta-serial-1234', 'aco-beta-serial-1235')).toBe(false);
  });
});
