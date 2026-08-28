import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const COOKIE_NAME = 'aco_access';
const ACCESS_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export function serialMatches(candidate: string, expected: string): boolean {
  const left = createHash('sha256').update(candidate).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

export function issueServiceAccess(response: Response, serial: string, secret: string, secure: boolean) {
  const payload = {
    serialHash: createHash('sha256').update(serial).digest('base64url'),
    expiresAt: Date.now() + ACCESS_DURATION_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  response.cookie(COOKIE_NAME, `${encoded}.${sign(encoded, secret)}`, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: ACCESS_DURATION_MS,
  });
}

export function requireServiceAccess(secret: string, serial: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    const raw = request.cookies?.[COOKIE_NAME];
    if (!raw) {
      response.status(402).json({ error: 'SERVICE_ACCESS_REQUIRED', message: 'Enter a valid service serial to continue.' });
      return;
    }
    const [encoded, signature, ...rest] = raw.split('.');
    if (!encoded || !signature || rest.length > 0 || !safeSignatureMatch(signature, sign(encoded, secret))) {
      response.status(402).json({ error: 'SERVICE_ACCESS_REQUIRED', message: 'Enter a valid service serial to continue.' });
      return;
    }
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { serialHash?: unknown; expiresAt?: unknown };
      const expectedHash = createHash('sha256').update(serial).digest('base64url');
      if (payload.serialHash !== expectedHash || typeof payload.expiresAt !== 'number' || payload.expiresAt <= Date.now()) throw new Error('Invalid access');
      next();
    } catch {
      response.status(402).json({ error: 'SERVICE_ACCESS_REQUIRED', message: 'Enter a valid service serial to continue.' });
    }
  };
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeSignatureMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
