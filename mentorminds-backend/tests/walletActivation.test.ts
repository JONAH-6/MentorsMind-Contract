import { Request, Response, NextFunction } from 'express';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    body: {},
    ip: '127.0.0.1',
    ...overrides,
  } as unknown as Request;
}

function makeRes(): jest.Mocked<Response> {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  return res as jest.Mocked<Response>;
}

// ─── sensitiveLimiter ────────────────────────────────────────────────────────

describe('sensitiveLimiter', () => {
  // Re-import fresh module for each test suite to reset in-memory store
  let sensitiveLimiter: (req: Request, res: Response, next: NextFunction) => void;

  beforeEach(() => {
    jest.resetModules();
    ({ sensitiveLimiter } = require('../src/middleware/rateLimit.middleware'));
  });

  it('allows the first 3 requests and blocks the 4th', () => {
    const req = makeReq({ ip: '10.0.0.1' });
    const next = jest.fn();

    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      sensitiveLimiter(req, res, next);
      expect(next).toHaveBeenCalledTimes(i + 1);
      expect(res.status).not.toHaveBeenCalled();
    }

    const res4 = makeRes();
    sensitiveLimiter(req, res4, next);
    expect(res4.status).toHaveBeenCalledWith(429);
    expect(res4.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Too many requests' }));
    expect(next).toHaveBeenCalledTimes(3); // still 3, not 4
  });

  it('keys by user ID when req.user.id is present', () => {
    const reqA = makeReq({ ip: '1.1.1.1' } as any);
    (reqA as any).user = { id: 'user-A' };
    const reqB = makeReq({ ip: '1.1.1.1' } as any);
    (reqB as any).user = { id: 'user-B' };
    const next = jest.fn();

    // Exhaust user-A's quota
    for (let i = 0; i < 3; i++) sensitiveLimiter(reqA, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(3);

    // user-B should still be allowed
    const resB = makeRes();
    sensitiveLimiter(reqB, resB, next);
    expect(next).toHaveBeenCalledTimes(4);
    expect(resB.status).not.toHaveBeenCalled();
  });

  it('sets Retry-After header when rate limited', () => {
    const req = makeReq({ ip: '2.2.2.2' });
    const next = jest.fn();
    for (let i = 0; i < 3; i++) sensitiveLimiter(req, makeRes(), next);

    const res = makeRes();
    sensitiveLimiter(req, res, next);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
  });
});

// ─── paymentLimiter ──────────────────────────────────────────────────────────

describe('paymentLimiter', () => {
  let paymentLimiter: (req: Request, res: Response, next: NextFunction) => void;

  beforeEach(() => {
    jest.resetModules();
    ({ paymentLimiter } = require('../src/middleware/rateLimit.middleware'));
  });

  it('allows up to 10 requests and blocks the 11th', () => {
    const req = makeReq({ ip: '3.3.3.3' });
    const next = jest.fn();

    for (let i = 0; i < 10; i++) {
      paymentLimiter(req, makeRes(), next);
    }
    expect(next).toHaveBeenCalledTimes(10);

    const res11 = makeRes();
    paymentLimiter(req, res11, next);
    expect(res11.status).toHaveBeenCalledWith(429);
    expect(next).toHaveBeenCalledTimes(10);
  });
});

// ─── requireIdempotencyKey ───────────────────────────────────────────────────

describe('requireIdempotencyKey', () => {
  let requireIdempotencyKey: (req: Request, res: Response, next: NextFunction) => void;

  beforeEach(() => {
    jest.resetModules();
    ({ requireIdempotencyKey } = require('../src/middleware/rateLimit.middleware'));
  });

  it('rejects requests missing the Idempotency-Key header', () => {
    const req = makeReq({ headers: {} });
    const res = makeRes();
    const next = jest.fn();

    requireIdempotencyKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Idempotency-Key') })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a request with a fresh Idempotency-Key', () => {
    const req = makeReq({ headers: { 'idempotency-key': 'key-fresh-001' } });
    const res = makeRes();
    const next = jest.fn();

    requireIdempotencyKey(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a duplicate Idempotency-Key within 24 hours', () => {
    const key = 'key-dup-001';
    const req1 = makeReq({ headers: { 'idempotency-key': key } });
    const req2 = makeReq({ headers: { 'idempotency-key': key } });
    const next = jest.fn();

    requireIdempotencyKey(req1, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);

    const res2 = makeRes();
    requireIdempotencyKey(req2, res2, next);
    expect(res2.status).toHaveBeenCalledWith(409);
    expect(res2.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Duplicate request') })
    );
    expect(next).toHaveBeenCalledTimes(1); // not called again
  });

  it('scopes the key per user — same key for different users is allowed', () => {
    const key = 'shared-key';
    const reqA = makeReq({ headers: { 'idempotency-key': key } });
    (reqA as any).user = { id: 'user-A' };
    const reqB = makeReq({ headers: { 'idempotency-key': key } });
    (reqB as any).user = { id: 'user-B' };
    const next = jest.fn();

    requireIdempotencyKey(reqA, makeRes(), next);
    requireIdempotencyKey(reqB, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty Idempotency-Key header', () => {
    const req = makeReq({ headers: { 'idempotency-key': '   ' } });
    const res = makeRes();
    const next = jest.fn();

    requireIdempotencyKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── WalletActivationController ──────────────────────────────────────────────

describe('walletActivation.controller — activate', () => {
  let activate: (req: Request, res: Response) => Promise<void>;
  let _setService: (svc: any) => void;

  beforeEach(() => {
    jest.resetModules();
    ({ activate, _setService } = require('../src/controllers/walletActivation.controller'));
  });

  function makeAuthReq(body: object, userId = 'user-123'): Request {
    const req = makeReq({ body });
    (req as any).user = { id: userId };
    return req;
  }

  it('returns 401 when no authenticated user', async () => {
    const req = makeReq({ body: { stellarPublicKey: 'GABC' } });
    const res = makeRes();

    await activate(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Unauthorized' }));
  });

  it('returns 400 when stellarPublicKey is missing', async () => {
    const req = makeAuthReq({});
    const res = makeRes();

    await activate(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('stellarPublicKey') })
    );
  });

  it('calls activateExistingWallet and returns 200 on success', async () => {
    const mockService = { activateExistingWallet: jest.fn().mockResolvedValue(undefined) };
    _setService(mockService as any);

    const req = makeAuthReq({ stellarPublicKey: 'GABC123' });
    const res = makeRes();

    await activate(req, res);

    expect(mockService.activateExistingWallet).toHaveBeenCalledWith('GABC123', 'user-123');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, stellarPublicKey: 'GABC123' });
  });

  it('returns 404 when wallet is not found', async () => {
    const mockService = {
      activateExistingWallet: jest.fn().mockRejectedValue(new Error('Wallet not found for user user-123')),
    };
    _setService(mockService as any);

    const req = makeAuthReq({ stellarPublicKey: 'GABC123' });
    const res = makeRes();

    await activate(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Wallet not found') })
    );
  });

  it('returns 500 on unexpected service error', async () => {
    const mockService = {
      activateExistingWallet: jest.fn().mockRejectedValue(new Error('Horizon timeout')),
    };
    _setService(mockService as any);

    const req = makeAuthReq({ stellarPublicKey: 'GABC123' });
    const res = makeRes();

    await activate(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Wallet activation failed' })
    );
  });
});
