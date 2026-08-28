import { describe, expect, it } from 'vitest';
import { issuePortalToken, verifyPortalToken } from '../server/security/portal-token.js';

describe('customer portal links', () => {
  const secret = 'a-portal-secret-that-is-long-enough';
  const now = 1_700_000_000_000;

  it('round-trips scoped claims and an expiry', () => {
    const issued = issuePortalToken('workspace-1', 'customer-1', secret, now);
    expect(verifyPortalToken(issued.token, secret, now + 1)).toEqual({
      workspaceId: 'workspace-1',
      customerId: 'customer-1',
      expiresAt: issued.expiresAt,
    });
  });

  it('rejects tampered or expired links', () => {
    const issued = issuePortalToken('workspace-1', 'customer-1', secret, now);
    expect(verifyPortalToken(`${issued.token}x`, secret, now + 1)).toBeNull();
    expect(verifyPortalToken(issued.token, secret, issued.expiresAt + 1)).toBeNull();
  });
});
