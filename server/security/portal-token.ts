import { createHmac, timingSafeEqual } from 'node:crypto';

const PORTAL_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PortalTokenClaims {
  workspaceId: string;
  customerId: string;
  expiresAt: number;
}

export function issuePortalToken(
  workspaceId: string,
  customerId: string,
  secret: string,
  now = Date.now(),
): { token: string; expiresAt: number } {
  const expiresAt = now + PORTAL_LINK_TTL_MS;
  const encoded = Buffer.from(JSON.stringify({ workspaceId, customerId, expiresAt }), 'utf8').toString('base64url');
  return { token: `${encoded}.${sign(encoded, secret)}`, expiresAt };
}

export function verifyPortalToken(token: string, secret: string, now = Date.now()): PortalTokenClaims | null {
  const [encoded, signature, ...rest] = token.split('.');
  if (!encoded || !signature || rest.length > 0 || !safeSignatureMatch(signature, sign(encoded, secret))) return null;
  try {
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<PortalTokenClaims>;
    if (!claims.workspaceId || !claims.customerId || typeof claims.expiresAt !== 'number' || claims.expiresAt <= now) return null;
    return {
      workspaceId: claims.workspaceId,
      customerId: claims.customerId,
      expiresAt: claims.expiresAt,
    };
  } catch {
    return null;
  }
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeSignatureMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
