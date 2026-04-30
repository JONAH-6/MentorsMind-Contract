import { verifyHorizonTransaction } from '../utils/horizon-tx-verifier';

export type EscrowStatus =
  | "pending"
  | "funded"
  | "released"
  | "disputed"
  | "refunded"
  | "partial_refund"
  | "resolved";

export interface EscrowRecord {
  id: string;
  mentorId: string;
  learnerId: string;
  amount: string;
  status: EscrowStatus;
  createdAt: Date;
  stellarTxHash: string | null;
  sorobanContractVersion: string | null;
  mentorPayoutAmount: string | null;
  learnerRefundAmount: string | null;
}

export interface TransactionRecord {
  escrowId: string;
  type: "mentor_payout" | "refund";
  amount: string;
}

export interface EscrowRepository {
  create(input: Omit<EscrowRecord, "createdAt">): Promise<EscrowRecord>;
  deleteById(id: string): Promise<void>;
  markFunded(
    id: string,
    stellarTxHash: string,
    sorobanContractVersion: string | null
  ): Promise<EscrowRecord>;
  findPendingOlderThan(cutoff: Date): Promise<EscrowRecord[]>;
  findByUserId(
    userId: string,
    role: "mentor" | "learner",
    limit: number,
    offset: number,
    status?: string
  ): Promise<{ escrows: EscrowRecord[]; total: number }>;
  findById(id: string): Promise<EscrowRecord | null>;
  updateStatus(id: string, status: EscrowStatus, splits?: { mentorPayoutAmount: string; learnerRefundAmount: string }): Promise<EscrowRecord>;
  createTransaction(record: TransactionRecord): Promise<void>;
}

export interface SorobanEscrowService {
    createEscrow(input: {
        escrowId: string;
        mentorId: string;
        learnerId: string;
        amount: string;
    }): Promise<{ txHash: string; contractVersion: string | null }>;
    
    openDispute(input: {
        escrowId: string;
        raisedBy: string;
        reason: string;
    }): Promise<{ txHash: string }>;
    
    resolveDispute(input: {
        escrowId: string;
    }): Promise<{ txHash: string }>;
    
    releaseFunds(input: {
        escrowId: string;
        releasedBy: string;
    }): Promise<string>;
}

const SUPPORTED_ASSETS = ['XLM', 'USDC', 'PYUSD'] as const;

export class EscrowApiService {
  constructor(
    private readonly escrowRepository: EscrowRepository,
    private readonly sorobanEscrowService: SorobanEscrowService
  ) {}

  /**
   * Returns true when transitioning from currentStatus to newStatus is
   * a valid escrow state machine step.
   *
   * Disputed escrows may only be resolved by an admin via resolveDispute.
   * refundEscrow and releaseEscrow are both blocked from disputed status.
   */
  static validateStateTransition(
    currentStatus: EscrowStatus,
    newStatus: EscrowStatus
  ): boolean {
    const validTransitions: Record<EscrowStatus, EscrowStatus[]> = {
      pending: ["funded"],
      funded: ["released", "disputed", "refunded"],
      disputed: ["resolved", "partial_refund"],   // partial_refund is a valid dispute resolution
      released: [],
      refunded: [],
      partial_refund: [],
      resolved: [],
    };
    return validTransitions[currentStatus]?.includes(newStatus) ?? false;
  }

  async createEscrow(input: {
    id: string;
    mentorId: string;
    learnerId: string;
    amount: string;
    currency?: string;
  }): Promise<EscrowRecord> {
    // FIX #291: Normalize currency to uppercase and validate before passing to
    // SorobanEscrowService. Soroban contracts are case-sensitive — 'xlm' != 'XLM'.
    if (input.currency !== undefined) {
      const currency = input.currency.toUpperCase();
      if (!(SUPPORTED_ASSETS as readonly string[]).includes(currency)) {
        throw new Error(`Unsupported currency "${currency}". Supported: ${SUPPORTED_ASSETS.join(', ')}`);
      }
    }

    const created = await this.escrowRepository.create({
      id: input.id,
      mentorId: input.mentorId,
      learnerId: input.learnerId,
      amount: input.amount,
      status: "pending",
      stellarTxHash: null,
      sorobanContractVersion: null,
    });

    try {
      const chainResult = await this.sorobanEscrowService.createEscrow({
        escrowId: created.id,
        mentorId: created.mentorId,
        learnerId: created.learnerId,
        amount: created.amount,
      });

      // Verify the transaction actually landed on Horizon before marking funded.
      // This prevents fake or unrelated txHashes from being accepted.
      await verifyHorizonTransaction(chainResult.txHash, {
        expectedSourceAccount: created.learnerId,
      });

      return this.escrowRepository.markFunded(
        created.id,
        chainResult.txHash,
        chainResult.contractVersion
      );
    } catch (error) {
      await this.escrowRepository.deleteById(created.id);
      throw error;
    }
  }

  async releaseEscrow(escrowId: string): Promise<EscrowRecord> {
    const escrow = await this.escrowRepository.findById(escrowId);
    if (!escrow) {
      throw new Error(`Escrow ${escrowId} not found`);
    }
    if (escrow.status !== "funded") {
      throw new Error(
        `Cannot release escrow in ${escrow.status} status. Escrow must be funded.`
      );
    }
    return this.escrowRepository.updateStatus(escrowId, "released");
  }

  async refundEscrow(escrowId: string, userId: string): Promise<EscrowRecord> {
    const escrow = await this.escrowRepository.findById(escrowId);
    if (!escrow) {
      throw new Error(`Escrow ${escrowId} not found`);
    }

    // Auth check: only the mentor can trigger a refund via the API
    if (escrow.mentorId !== userId) {
      throw new Error(`Unauthorized: only the mentor can trigger a refund`);
    }

    if (!EscrowApiService.validateStateTransition(escrow.status, "refunded")) {
      throw new Error(
        `Cannot refund escrow in ${escrow.status} status`
      );
    }

    // Update DB status to refunded first
    const updatedEscrow = await this.escrowRepository.updateStatus(escrowId, "refunded");

    try {
      await this.sorobanEscrowService.refund({
        escrowId,
        refundedBy: userId,
      });
    } catch (error) {
      // On-chain call failed, rollback DB status
      await this.escrowRepository.updateStatus(escrowId, escrow.status);
      throw new Error(
        `Failed to refund escrow on-chain for ${escrowId}: ${(error as Error).message}`
      );
    }

    return updatedEscrow;
  }

  async openDispute(
    escrowId: string,
    raisedBy: string,
    reason: string
  ): Promise<EscrowRecord> {
    if (reason.length > 500) {
      throw new Error("Dispute reason must be 500 characters or less");
    }

    const escrow = await this.escrowRepository.findById(escrowId);
    if (!escrow) {
      throw new Error(`Escrow ${escrowId} not found`);
    }
    if (!EscrowApiService.validateStateTransition(escrow.status, "disputed")) {
      throw new Error(
        `Cannot open dispute for escrow in ${escrow.status} status`
      );
    }
    
    // Update DB status to disputed first
    const updatedEscrow = await this.escrowRepository.updateStatus(escrowId, "disputed");
    
    // Then attempt on-chain call
    try {
      await this.sorobanEscrowService.openDispute({
        escrowId,
        raisedBy,
        reason,
      });
    } catch (error) {
      // On-chain call failed, rollback DB status to previous state
      await this.escrowRepository.updateStatus(escrowId, escrow.status);
      throw new Error(
        `Failed to open dispute on-chain for escrow ${escrowId}: ${(error as Error).message}`
      );
    }
    
    return updatedEscrow;
  }

  async resolveDispute(
    escrowId: string,
    adminUserId: string,
    options?: {
      resolution?: "release_to_mentor" | "refund_to_learner";
      splitPercentage?: number;
    }
  ): Promise<EscrowRecord> {
    const escrow = await this.escrowRepository.findById(escrowId);
    if (!escrow) {
      throw new Error(`Escrow ${escrowId} not found`);
    }
    if (escrow.status !== "disputed") {
      throw new Error(
        `Cannot resolve dispute for escrow in ${escrow.status} status`
      );
    }

    // Determine mentor's share percentage (0–100)
    const splitPct =
      options?.splitPercentage !== undefined
        ? options.splitPercentage
        : options?.resolution === "release_to_mentor"
        ? 100
        : 0;

    if (splitPct < 0 || splitPct > 100) {
      throw new Error("splitPercentage must be between 0 and 100");
    }

    // A split between 1–99 is a partial refund; 0 or 100 is a full resolution
    const newStatus: EscrowStatus =
      splitPct > 0 && splitPct < 100 ? "partial_refund" : "resolved";

    // Calculate split amounts using integer arithmetic to avoid float dust
    const totalStroops = Math.round(parseFloat(escrow.amount) * 1e7);
    const mentorStroops = Math.floor((totalStroops * splitPct) / 100);
    const learnerStroops = totalStroops - mentorStroops;
    const mentorPayoutAmount = (mentorStroops / 1e7).toFixed(7);
    const learnerRefundAmount = (learnerStroops / 1e7).toFixed(7);

    const updatedEscrow = await this.escrowRepository.updateStatus(escrowId, newStatus, {
      mentorPayoutAmount,
      learnerRefundAmount,
    });

    // Record both sides of the split as separate transaction entries
    if (mentorStroops > 0) {
      await this.escrowRepository.createTransaction({
        escrowId,
        type: "mentor_payout",
        amount: mentorPayoutAmount,
      });
    }
    if (learnerStroops > 0) {
      await this.escrowRepository.createTransaction({
        escrowId,
        type: "refund",
        amount: learnerRefundAmount,
      });
    }

    return updatedEscrow;
  }

  async findUnreconciledEscrows(
    now: Date = new Date(),
    staleAfterMs: number = 10 * 60 * 1000
  ): Promise<EscrowRecord[]> {
    const cutoff = new Date(now.getTime() - staleAfterMs);
    return this.escrowRepository.findPendingOlderThan(cutoff);
  }

  async listUserEscrows(
    userId: string,
    options: { status?: string; role: "mentor" | "learner" },
    limit: number,
    offset: number
  ): Promise<{ escrows: EscrowRecord[]; total: number }> {
    return this.escrowRepository.findByUserId(
      userId,
      options.role,
      limit,
      offset,
      options.status
    );
  }
}
