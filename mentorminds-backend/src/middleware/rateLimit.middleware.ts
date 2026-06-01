import { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

function makeRateLimiter(maxRequests: number, windowMs: number, keyFn: (req: Request) => string) {
  const store = new Map<string, RateLimitEntry>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || now >= entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      res.status(429).json({
        error: 'Too many requests',
        retryAfter,
      });
      return;
    }

    entry.count++;
    next();
  };
}

/** Extracts the authenticated user ID from the request (set by JWT middleware). */
function userKey(req: Request): string {
  return (req as any).user?.id ?? req.ip ?? 'anonymous';
}

/**
 * sensitiveLimiter — max 3 requests per hour per user.
 * Applied to sensitive on-chain operations like wallet activation.
 */
export const sensitiveLimiter = makeRateLimiter(3, 60 * 60 * 1000, userKey);

/**
 * paymentLimiter — max 10 requests per 15 minutes per user.
 * Applied to any endpoint that triggers an on-chain payment transaction.
 */
export const paymentLimiter = makeRateLimiter(10, 15 * 60 * 1000, userKey);

/** In-memory store for idempotency keys: key → { resolvedAt } */
const idempotencyStore = new Map<string, { resolvedAt: number }>();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * requireIdempotencyKey — enforces that the client sends an `Idempotency-Key`
 * header and rejects duplicate activation attempts within 24 hours.
 *
 * The key is scoped per user so different users cannot collide.
 */
export function requireIdempotencyKey(req: Request, res: Response, next: NextFunction): void {
  const rawKey = req.headers['idempotency-key'];
  if (!rawKey || typeof rawKey !== 'string' || !rawKey.trim()) {
    res.status(400).json({ error: 'Idempotency-Key header is required' });
    return;
  }

  const userId = (req as any).user?.id ?? 'anonymous';
  const scopedKey = `${userId}:${rawKey.trim()}`;
  const now = Date.now();
  const existing = idempotencyStore.get(scopedKey);

  if (existing && now < existing.resolvedAt + IDEMPOTENCY_TTL_MS) {
    res.status(409).json({
      error: 'Duplicate request: this Idempotency-Key was already used within the last 24 hours',
    });
    return;
  }

  // Record the key before forwarding so concurrent requests are also blocked
  idempotencyStore.set(scopedKey, { resolvedAt: now });
  next();
}
