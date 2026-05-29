import { Request, Response } from 'express';
import { Pool } from 'pg';
import { StellarAccountService } from '../services/stellarAccount.service';

let _service: StellarAccountService | null = null;

function getService(): StellarAccountService {
  if (!_service) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    _service = new StellarAccountService(pool);
  }
  return _service;
}

/** Exposed for testing — allows injecting a mock service. */
export function _setService(svc: StellarAccountService): void {
  _service = svc;
}

/**
 * POST /api/wallets/activate
 *
 * Activates the authenticated user's Stellar wallet by funding it from the
 * platform account. Protected by sensitiveLimiter, paymentLimiter, and
 * requireIdempotencyKey middleware (applied in the route).
 *
 * Body: { stellarPublicKey: string }
 */
export async function activate(req: Request, res: Response): Promise<void> {
  const userId: string | undefined = (req as any).user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { stellarPublicKey } = req.body ?? {};
  if (!stellarPublicKey || typeof stellarPublicKey !== 'string') {
    res.status(400).json({ error: 'stellarPublicKey is required' });
    return;
  }

  try {
    await getService().activateExistingWallet(stellarPublicKey, userId);
    res.status(200).json({ success: true, stellarPublicKey });
  } catch (err: any) {
    if (err?.message?.includes('Wallet not found')) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error('[WalletActivation] activate failed:', err);
    res.status(500).json({ error: 'Wallet activation failed' });
  }
}
