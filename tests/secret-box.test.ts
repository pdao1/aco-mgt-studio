import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../server/security/secret-box.js';

describe('SecretBox', () => {
  it('round-trips a Gmail app password without exposing plaintext in the envelope', () => {
    const box = new SecretBox(randomBytes(32).toString('base64'));
    const plaintext = 'abcdabcdabcdabcd';
    const encrypted = box.encrypt(plaintext);

    expect(encrypted).not.toContain(plaintext);
    expect(box.decrypt(encrypted)).toBe(plaintext);
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => new SecretBox(Buffer.from('short').toString('base64'))).toThrow(/32-byte key/);
  });

  it('rejects a tampered encrypted envelope', () => {
    const box = new SecretBox(randomBytes(32).toString('base64'));
    const encrypted = box.encrypt('abcdabcdabcdabcd');
    const parts = encrypted.split(':');
    parts[3] = `${parts[3].startsWith('A') ? 'B' : 'A'}${parts[3].slice(1)}`;
    const tampered = parts.join(':');
    expect(() => box.decrypt(tampered)).toThrow();
  });
});
