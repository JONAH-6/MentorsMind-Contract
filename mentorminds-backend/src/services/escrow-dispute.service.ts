export interface SorobanDisputeService {
  resolveDispute(input: {
    escrowId: string;
    /** Percentage to mentor as integer 0-100 (e.g., 75 for 75%) */
    mentorPercentage: number;
    resolvedBy: string;
  }): Promise<{ txHash: string }>;
}

export interface AdminIdentityResolver {
  toStellarPublicKey(adminUserId: string): Promise<string>;
}

export class EscrowDisputeService {
  constructor(
    private readonly sorobanDisputeService: SorobanDisputeService,
    private readonly adminIdentityResolver: AdminIdentityResolver
  ) {}

  async resolveDispute(input: {
    escrowId: string;
    /** Percentage to mentor as integer 0-100 (e.g., 75 for 75%) */
    mentorPercentage: number;
    adminUserId: string;
  }): Promise<{ txHash: string }> {
    // Validate and normalize percentage to integer
    const mentorPct = Math.round(input.mentorPercentage);
    if (mentorPct < 0 || mentorPct > 100) {
      throw new Error(`mentorPercentage must be between 0 and 100, got: ${input.mentorPercentage}`);
    }

    const adminPublicKey = await this.adminIdentityResolver.toStellarPublicKey(
      input.adminUserId
    );

    return this.sorobanDisputeService.resolveDispute({
      escrowId: input.escrowId,
      mentorPercentage: mentorPct,
      resolvedBy: adminPublicKey,
    });
  }
}
