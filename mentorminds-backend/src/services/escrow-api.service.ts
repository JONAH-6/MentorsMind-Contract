import { verifyHorizonTransaction } from '../utils/horizon-tx-verifier';

export type EscrowStatus =
  | "pending"
  | "funded"
  | "released"
  | "disputed"
  | "refunded"
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
  updateStatus(id: string, status: EscrowStatus): Promise<EscrowRecord>;
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
    /** Stellar public key of the admin resolving the dispute */
    resolvedBy: string;
  }): Promise<{ txHash: string }>;
}

export interface AdminWalletRepository {
  getStellarPublicKey(adminUserId: string): Promise<string | null>;
}

const SUPPORTED_ASSETS = ['XLM', 'USDC', 'PYUSD'] as const;

export class EscrowApiService {
  constructor(
    private readonly escrowRepository: EscrowRepository,
    private readonly sorobanEscrowService: SorobanEscrowService,
    private readonly adminWalletRepository?: AdminWalletRepository
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
      disputed: ["resolved"],   // refunded and released are intentionally excluded
      released: [],
      refunded: [],
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

  async refundEscrow(escrowId: string): Promise<EscrowRecord> {
    const escrow = await this.escrowRepository.findById(escrowId);
    if (!escrow) {
      throw new Error(`Escrow ${escrowId} not found`);
    }
    if (!EscrowApiService.validateStateTransition(escrow.status, "refunded")) {
      throw new Error(
        `Cannot refund escrow in ${escrow.status} status`
      );
    }
    return this.escrowRepository.updateStatus(escrowId, "refunded");
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
    resolution?: string,
    notes?: string,
    stellarTxHash?: string,
    adminUserId?: string
  ): Promise<EscrowRecord> {
    const escrow = await this.escrowRepository.findById(escrowId);
    if (!escrow) {
      throw new Error(`Escrow ${escrowId} not found`);
    }
    if (!EscrowApiService.validateStateTransition(escrow.status, "resolved")) {
      throw new Error(
        `Cannot resolve dispute for escrow in ${escrow.status} status`
      );
    }

    // Fix #375: resolve the admin's Stellar public key so the on-chain audit
    // trail records the actual admin identity rather than the hardcoded string 'admin'.
    let resolvedBy = 'admin';
    if (adminUserId) {
      if (this.adminWalletRepository) {
        const stellarKey = await this.adminWalletRepository.getStellarPublicKey(adminUserId);
        resolvedBy = stellarKey ?? adminUserId;
      } else {
        resolvedBy = adminUserId;
      }
    }

    await this.sorobanEscrowService.resolveDispute({ escrowId, resolvedBy });

    return this.escrowRepository.updateStatus(escrowId, "resolved");
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
