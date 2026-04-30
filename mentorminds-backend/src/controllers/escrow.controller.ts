import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { EscrowApiService } from '../services/escrow-api.service';

interface CreateEscrowBody {
  bookingId?: string;
  mentorId?: string;
  learnerId?: string;
  amount?: string;
  currency?: string;
}

interface ResolveDisputeBody {
  resolution?: string;
  notes?: string;
  stellarTxHash?: string;
}

export class EscrowController {
  constructor(private readonly escrowApiService: EscrowApiService) {}

  /**
   * POST /api/v1/escrows
   * Creates a new escrow linked to a booking.
   *
   * Fix #368: bookingId is now required and passed through to SorobanEscrowService
   * so the on-chain escrow is linked to the correct booking reference.
   */
  async createEscrow(req: Request, res: Response): Promise<void> {
    const { bookingId, mentorId, learnerId, amount, currency } =
      req.body as CreateEscrowBody;

    if (!bookingId) {
      res.status(400).json({ error: 'bookingId is required' });
      return;
    }
    if (!mentorId) {
      res.status(400).json({ error: 'mentorId is required' });
      return;
    }
    if (!learnerId) {
      res.status(400).json({ error: 'learnerId is required' });
      return;
    }
    if (!amount) {
      res.status(400).json({ error: 'amount is required' });
      return;
    }

    // Validate the authenticated learner owns this booking
    const authenticatedUserId = (req as any).user?.id;
    if (authenticatedUserId && authenticatedUserId !== learnerId) {
      res.status(403).json({ error: 'Forbidden: learnerId does not match authenticated user' });
      return;
    }

    try {
      const escrow = await this.escrowApiService.createEscrow({
        id: randomUUID(),
        bookingId,
        mentorId,
        learnerId,
        amount,
        currency,
      });
      res.status(201).json(escrow);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = (error as any).statusCode ?? 500;
      res.status(statusCode).json({ error: message });
    }
  }

  /**
   * POST /api/v1/escrows/:id/resolve-dispute
   * Resolves a dispute for the given escrow.
   *
   * Fix #375: adminUserId is read from req.user!.id and passed through.
   */
  async resolveDispute(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const { resolution, notes, stellarTxHash } = req.body as ResolveDisputeBody;
    const adminUserId = (req as any).user?.id as string | undefined;

    if (!adminUserId) {
      res.status(401).json({ error: 'Unauthorized: admin identity required' });
      return;
    }

    try {
      const escrow = await this.escrowApiService.resolveDispute(
        id,
        resolution,
        notes,
        stellarTxHash,
        adminUserId
      );
      res.json(escrow);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = (error as any).statusCode ?? 500;
      res.status(statusCode).json({ error: message });
    }
  }
}
