import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';

export const SOLO_COOKIE = 'solo_session';
export interface SoloSession { accountId: string; version: number; expiresAt: number }
export function signValue(value: object, purpose: string, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(`${purpose}:${encoded}`).digest('base64url')}`;
}
export function readValue<T extends { expiresAt: number }>(raw: unknown, purpose: string, secret: string): T | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  const parts = raw.split('.');
  const [encoded, signature] = parts;
  if (!encoded || !signature || parts.length !== 2) return null;
  const expected = createHmac('sha256', secret).update(`${purpose}:${encoded}`).digest('base64url');
  const suppliedBytes = Buffer.from(signature), expectedBytes = Buffer.from(expected);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded,'base64url').toString()) as T;
    return typeof value.expiresAt === 'number' && value.expiresAt > Date.now() ? value : null;
  } catch { return null; }
}
export function issueSoloSession(response: Response, accountId: string, version: number, secret: string, secure: boolean) {
  const duration = 12 * 60 * 60 * 1000;
  response.cookie(SOLO_COOKIE, signValue({accountId, version, expiresAt: Date.now()+duration}, 'solo-session', secret), {
    httpOnly:true, secure, sameSite:'strict', path:'/', maxAge:duration,
  });
}
export function clearSoloSession(response: Response, secure: boolean) {
  response.clearCookie(SOLO_COOKIE,{httpOnly:true,secure,sameSite:'strict',path:'/'});
}
