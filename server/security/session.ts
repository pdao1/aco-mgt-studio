import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const COOKIE_NAME = 'aco_session';
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

interface SessionPayload {
  workspaceId: string;
  sessionVersion?: number;
  expiresAt: number;
}

declare global {
  namespace Express {
    interface Request {
      workspaceId?: string;
      sessionVersion?: number;
    }
  }
}

export function operatorPasswordMatches(candidate: string, expected: string): boolean {
  const candidateHash = createHash('sha256').update(candidate).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

export function issueSession(
  response: Response,
  workspaceId: string,
  secret: string,
  secure: boolean,
  sessionVersion = 0,
) {
  const payload: SessionPayload = { workspaceId, sessionVersion, expiresAt: Date.now() + SESSION_DURATION_MS };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(encoded, secret);
  response.cookie(COOKIE_NAME, `${encoded}.${signature}`, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_DURATION_MS,
  });
}

export function clearSession(response: Response, secure: boolean) {
  response.clearCookie(COOKIE_NAME, { httpOnly: true, secure, sameSite: 'strict', path: '/' });
}

export function requireSession(secret: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    const raw = request.cookies?.[COOKIE_NAME];
    if (typeof raw !== 'string') {
      response.status(401).json({ error: 'AUTH_REQUIRED', message: 'Sign in to continue.' });
      return;
    }
    const [encoded, signature, ...rest] = raw.split('.');
    if (!encoded || !signature || rest.length > 0 || !safeSignatureMatch(signature, sign(encoded, secret))) {
      response.status(401).json({ error: 'INVALID_SESSION', message: 'Your session has expired. Sign in again.' });
      return;
    }
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
      if (!payload.workspaceId || !payload.expiresAt || payload.expiresAt <= Date.now()) throw new Error('Expired');
      request.workspaceId = payload.workspaceId;
      request.sessionVersion = payload.sessionVersion ?? 0;
      next();
    } catch {
      response.status(401).json({ error: 'INVALID_SESSION', message: 'Your session has expired. Sign in again.' });
    }
  };
}

export function enforceOrigin(appOrigin: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      next();
      return;
    }
    const origin = request.get('origin');
    if (origin && origin.replace(/\/$/, '') !== appOrigin) {
      response.status(403).json({ error: 'INVALID_ORIGIN', message: 'This request origin is not allowed.' });
      return;
    }
    next();
  };
}

export function loginRateLimit() {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return (request: Request, response: Response, next: NextFunction) => {
    const key = request.ip || 'unknown';
    const now = Date.now();
    const existing = attempts.get(key);
    const state = !existing || existing.resetAt <= now ? { count: 0, resetAt: now + 15 * 60_000 } : existing;
    state.count += 1;
    attempts.set(key, state);
    if (state.count > 8) {
      response.status(429).json({ error: 'TOO_MANY_ATTEMPTS', message: 'Too many sign-in attempts. Try again later.' });
      return;
    }
    next();
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
