import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { enforceOrigin } from '../server/security/session.js';

function check(origin: string, middleware = enforceOrigin('https://ordertracker.pro', ['https://www.ordertracker.pro'])) {
  const request = { method: 'POST', get: vi.fn(() => origin) } as unknown as Request;
  const response = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  middleware(request, response, next);
  return { response, next };
}

describe('request origin guard', () => {
  it('accepts the canonical site origin and its www alias', () => {
    expect(check('https://ordertracker.pro').next).toHaveBeenCalledOnce();
    expect(check('https://www.ordertracker.pro').next).toHaveBeenCalledOnce();
  });

  it('rejects unrelated and insecure origins with a canonical-site hint', () => {
    const unrelated = check('https://attacker.example');
    expect(unrelated.response.status).toHaveBeenCalledWith(403);
    expect(unrelated.response.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'INVALID_ORIGIN',
      message: 'This request origin is not allowed. Open https://ordertracker.pro and try again.',
    }));

    expect(check('http://ordertracker.pro').response.status).toHaveBeenCalledWith(403);
    expect(check('https://ordertracker.pro/unexpected-path').response.status).toHaveBeenCalledWith(403);
  });
});
