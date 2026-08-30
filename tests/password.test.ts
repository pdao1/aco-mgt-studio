import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../server/security/password.js';

describe('workspace passwords', () => {
  it('salts identical passwords independently and verifies only the correct password', async () => {
    const one = await hashPassword('workspace-test-password');
    const two = await hashPassword('workspace-test-password');
    expect(one).not.toBe(two);
    expect(one).not.toContain('workspace-test-password');
    expect(await verifyPassword('workspace-test-password', one)).toBe(true);
    expect(await verifyPassword('different-password', one)).toBe(false);
  });
  it('fails closed for unknown workspaces and malformed credentials', async () => {
    expect(await verifyPassword('anything', null)).toBe(false);
    expect(await verifyPassword('anything', 'scrypt-v1$bad$bad')).toBe(false);
  });
});
