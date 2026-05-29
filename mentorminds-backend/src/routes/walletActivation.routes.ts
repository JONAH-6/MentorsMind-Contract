import { Router } from 'express';
import { sensitiveLimiter, paymentLimiter, requireIdempotencyKey } from '../middleware/rateLimit.middleware';
import { activate } from '../controllers/walletActivation.controller';

const router = Router();

/**
 * POST /api/wallets/activate
 *
 * Middleware chain (in order):
 *  1. sensitiveLimiter   — max 3 requests/hour per user
 *  2. paymentLimiter     — max 10 requests/15 min per user (on-chain payment profile)
 *  3. requireIdempotencyKey — client must send Idempotency-Key; deduplicates within 24 h
 */
router.post('/activate', sensitiveLimiter, paymentLimiter, requireIdempotencyKey, activate);

export default router;
