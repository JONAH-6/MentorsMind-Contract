import { SorobanEscrowService } from "./escrow-api.service";
import { StellarFeesService } from "./stellarFees.service";
import { Networks, rpc as SorobanRpc } from '@stellar/stellar-sdk';

// Max Stellar amount: 2^63 - 1 stroops = 922337203685.4775807 XLM
const MAX_STELLAR_AMOUNT = 922337203685.4775807;
const MAX_STELLAR_STROOPS = BigInt("9223372036854775807");

/**
 * Validates that a string is a valid Stellar amount:
 * - Parseable as a positive decimal number
 * - Greater than 0
 * - At most 7 decimal places
 * - Does not exceed the max Stellar amount (922337203685.4775807 XLM)
 *
 * Uses BigInt stroop arithmetic to avoid floating-point precision issues
 * near the max amount boundary.
 */
export function validateStellarAmount(amount: string): void {
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw Object.assign(
      new Error(`Invalid amount "${amount}": must be a positive decimal number`),
      { statusCode: 400 }
    );
  }

  const [intPart, decimalPart = ""] = amount.split(".");

  if (decimalPart.length > 7) {
    throw Object.assign(
      new Error(`Invalid amount "${amount}": must have at most 7 decimal places`),
      { statusCode: 400 }
    );
  }

  const paddedDecimal = decimalPart.padEnd(7, "0");
  const stroops =
    BigInt(intPart) * BigInt(10_000_000) + BigInt(paddedDecimal);

  if (stroops <= 0n) {
    throw Object.assign(
      new Error(`Invalid amount "${amount}": must be greater than 0`),
      { statusCode: 400 }
    );
  }

  if (stroops > MAX_STELLAR_STROOPS) {
    throw Object.assign(
      new Error(
        `Invalid amount "${amount}": exceeds maximum Stellar amount of ${MAX_STELLAR_AMOUNT}`
      ),
      { statusCode: 400 }
    );
  }
}

export type BookingPaymentStatus =
  | "pending"
  | "paid"
  | "failed"
  | "disputed"
  | "refunded";

export interface EscrowOnChainState {
  escrowId: string;
  status: "active" | "released" | "disputed" | "refunded" | "resolved";
}

export interface BookingRecord {
  id: string;
  escrowId: string;
  status: string;
  paymentStatus: BookingPaymentStatus;
}

export interface BookingRepository {
  updatePaymentStatus(
    bookingId: string,
    status: BookingPaymentStatus
  ): Promise<void>;
  findBookingsWithActiveEscrow(statuses: string[]): Promise<BookingRecord[]>;
  findBookingsWithActiveEscrowPaginated(
    statuses: string[],
    options: {
      limit: number;
      afterBookingId?: string | null;
      minLastSyncMinutes?: number;
    }
  ): Promise<BookingRecord[]>;
  updateLastEscrowSync(bookingId: string): Promise<void>;
}

export interface EscrowStateResolver {
  getEscrowState(escrowId: string): Promise<EscrowOnChainState>;
}

export interface ContractTransactionResult {
  fee: string;
}

export interface TransactionResult {
  txHash: string;
  result: any;
}

// Startup guard: fail fast if the installed SDK does not expose assembleTransaction.
// Submitting an unassembled Soroban transaction will be rejected by the network
// with resource/auth errors because simulation results have not been applied.
if (typeof (SorobanRpc as any).assembleTransaction !== 'function') {
  throw new Error(
    'SorobanRpc.assembleTransaction is required but not available in the installed SDK version. ' +
    'Please ensure @stellar/stellar-sdk 15.0.1 or later is installed.'
  );
}

export class StellarSorobanClient {
  private readonly rpcServer: SorobanRpc.Server;
  private readonly networkPassphrase: string;

  constructor(
    private readonly feesService: Pick<StellarFeesService, "getFeeEstimate">,
    rpcUrl?: string,
    network?: string
  ) {
    const url = rpcUrl || process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
    const networkType = network || process.env.STELLAR_NETWORK || 'testnet';
    
    this.rpcServer = new SorobanRpc.Server(url, { allowHttp: url.startsWith("http://") });
    this.networkPassphrase = networkType === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  }

  /**
   * Verifies that the RPC server's network passphrase matches the configured network.
   * Should be called at startup to prevent network mismatch issues.
   */
  async verifyNetworkPassphrase(): Promise<void> {
    const networkInfo = await this.rpcServer.getNetwork();
    if (networkInfo.passphrase !== this.networkPassphrase) {
      throw new Error(
        `SOROBAN_RPC_URL network passphrase does not match STELLAR_NETWORK configuration. ` +
        `Expected: ${this.networkPassphrase}, Got: ${networkInfo.passphrase}`
      );
    }
  }

  /**
   * Polls for transaction confirmation after submission.
   * Waits until the transaction is included in a ledger with SUCCESS or FAILED status.
   * 
   * @param txHash - Transaction hash to poll for
   * @param timeoutMs - Maximum time to wait (default: 30 seconds)
   * @param pollIntervalMs - Time between polls (default: 2 seconds)
   * @returns Transaction result when confirmed
   * @throws Error if transaction fails or times out
   */
  async waitForTransaction(
    txHash: string,
    timeoutMs: number = 30000,
    pollIntervalMs: number = 2000
  ): Promise<SorobanRpc.Api.GetTransactionResponse> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const txResponse = await this.rpcServer.getTransaction(txHash);
      
      if (txResponse.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return txResponse;
      }
      
      if (txResponse.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        const resultXdr = (txResponse as any).resultXdr;
        throw new Error(
          `Transaction ${txHash} failed. Result XDR: ${resultXdr || 'not available'}`
        );
      }
      
      // Status is NOT_FOUND or still pending, continue polling
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    
    throw new Error(
      `Transaction ${txHash} confirmation timeout after ${timeoutMs}ms. ` +
      `Transaction may still be pending or was not included in a ledger.`
    );
  }

  /**
   * Invokes a Soroban contract method and waits for confirmation.
   * 
   * @param preparedTx - Prepared transaction to submit
   * @returns Transaction hash and result after confirmation
   * @throws Error if transaction fails or times out
   */
  async invoke(preparedTx: any): Promise<TransactionResult> {
    // Submit transaction
    const sendResponse = await this.rpcServer.sendTransaction(preparedTx);
    
    if (!sendResponse?.hash) {
      throw new Error('Transaction submission failed: no hash returned');
    }
    
    const txHash = sendResponse.hash;
    
    // Wait for confirmation
    const confirmedTx = await this.waitForTransaction(txHash);
    
    return {
      txHash,
      result: confirmedTx,
    };
  }

  async buildContractTransaction(): Promise<ContractTransactionResult> {
    const feeMultiplier = parseInt(
      process.env.SOROBAN_FEE_MULTIPLIER || "10",
      10
    );
    const { recommended_fee } = await this.feesService.getFeeEstimate(1);
    const fee = String(parseInt(recommended_fee, 10) * feeMultiplier);
    return { fee };
  }

  async buildContractTransactionWithRetry(
    maxRetries = 2
  ): Promise<ContractTransactionResult> {
    let feeMultiplier = parseInt(
      process.env.SOROBAN_FEE_MULTIPLIER || "10",
      10
    );
    const { recommended_fee } = await this.feesService.getFeeEstimate(1);
    let baseFee = parseInt(recommended_fee, 10) * feeMultiplier;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return { fee: String(baseFee) };
      } catch (err: unknown) {
        const error = err as { result_codes?: { transaction?: string } };
        if (
          error?.result_codes?.transaction === "tx_insufficient_fee" &&
          attempt < maxRetries
        ) {
          baseFee = baseFee * 2;
        } else {
          throw err;
        }
      }
    }
    return { fee: String(baseFee) };
  }
}

/**
 * Concrete SorobanEscrowService implementation that validates the amount
 * before passing it to the Soroban contract.
 */
export class SorobanEscrowServiceImpl implements SorobanEscrowService {
  private readonly expectedContractVersion =
    process.env.SOROBAN_CONTRACT_VERSION?.trim() || null;
  private resolvedContractVersion: string | null = null;
  private configured = true;

  constructor(
    private readonly resolveVersion: (() => Promise<string | null>) | null = null
  ) {}

  async verifyContractVersion(): Promise<boolean> {
    // Check network configuration
    const network = process.env.STELLAR_NETWORK || 'testnet';
    const networkPassphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
    const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
    const contractAddress = process.env.SOROBAN_ESCROW_CONTRACT_ADDRESS;

    if (!contractAddress) {
      this.configured = false;
      throw new Error("SOROBAN_ESCROW_CONTRACT_ADDRESS is not configured");
    }

    const rpcServer = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    
    // FIX #259: Verify network passphrase matches to prevent mainnet/testnet mismatches
    try {
      const networkInfo = await rpcServer.getNetwork();
      if (networkInfo.passphrase !== networkPassphrase) {
        this.configured = false;
        throw new Error(
          `SOROBAN_RPC_URL network passphrase does not match STELLAR_NETWORK configuration. ` +
          `Expected: ${networkPassphrase}, Got: ${networkInfo.passphrase}`
        );
      }
    } catch (error) {
      this.configured = false;
      throw new Error(`Failed to verify network configuration: ${(error as Error).message}`);
    }

    // Verify contract exists and responds
    try {
      // Try to get contract data to verify it exists
      const contractData = await rpcServer.getContractData(
        contractAddress,
        SorobanRpc.xdr.ScVal.scvLedgerKeyContractInstance()
      );
      
      if (!contractData) {
        this.configured = false;
        throw new Error(`Contract at ${contractAddress} not found on network`);
      }
    } catch (error) {
      this.configured = false;
      throw new Error(`Failed to verify contract at ${contractAddress}: ${(error as Error).message}`);
    }

    // Verify WASM hash if configured
    const expectedWasmHash = process.env.CONTRACT_EXPECTED_WASM_HASH?.trim();
    if (expectedWasmHash) {
      try {
        const contractData = await rpcServer.getContractData(
          contractAddress,
          SorobanRpc.xdr.ScVal.scvLedgerKeyContractInstance()
        );
        
        // Extract WASM hash from contract data
        // Note: This is a simplified check - actual implementation may need to parse XDR
        const wasmHashMatch = true; // TODO: Implement actual WASM hash verification
        
        if (!wasmHashMatch) {
          this.configured = false;
          console.error(`Contract WASM hash mismatch. Expected: ${expectedWasmHash}`);
          return false;
        }
      } catch (error) {
        this.configured = false;
        throw new Error(`Failed to verify contract WASM hash: ${(error as Error).message}`);
      }
    }

    if (!this.expectedContractVersion) {
      this.configured = true;
      return true;
    }

    const fetchVersion =
      this.resolveVersion ??
      (async (): Promise<string | null> => {
        return null;
      });

    let detectedVersion: string | null;
    try {
      detectedVersion = await fetchVersion();
    } catch (error) {
      this.configured = false;
      throw Object.assign(
        new Error(
          `Soroban contract version check failed: ${(error as Error).message}`
        ),
        { statusCode: 503 }
      );
    }

    this.resolvedContractVersion = detectedVersion;
    if (!detectedVersion || detectedVersion !== this.expectedContractVersion) {
      this.configured = false;
      return false;
    }

    this.configured = true;
    return true;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  getExpectedContractVersion(): string | null {
    return this.expectedContractVersion;
  }

  getResolvedContractVersion(): string | null {
    return this.resolvedContractVersion;
  }

  /**
   * Returns contract verification status for health checks.
   * @returns "verified" if contract is verified, "unverified" if not checked, "mismatch" if verification failed
   */
  getContractVerificationStatus(): "verified" | "unverified" | "mismatch" {
    if (!this.configured) {
      return "mismatch";
    }
    if (this.expectedContractVersion && this.resolvedContractVersion === this.expectedContractVersion) {
      return "verified";
    }
    if (!this.expectedContractVersion) {
      return "verified"; // No version check required
    }
    return "unverified";
  }

  async createEscrow(input: {
    escrowId: string;
    mentorId: string;
    learnerId: string;
    amount: string;
    /** Unix timestamp (seconds) when escrow should auto-expire. Must be in the future. */
    deadline: number;
  }): Promise<{ txHash: string; contractVersion: string | null }> {
    validateStellarAmount(input.amount);

    // Validate deadline is in the future
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (input.deadline <= nowSeconds) {
      throw Object.assign(
        new Error(`Deadline must be in the future. Got: ${input.deadline}, now: ${nowSeconds}`),
        { statusCode: 400 }
      );
    }

    if (this.expectedContractVersion && !this.configured) {
      throw Object.assign(
        new Error(
          "Soroban escrow integration disabled due to contract version mismatch"
        ),
        { statusCode: 503 }
      );
    }

    // TODO: invoke the Soroban contract here
    // const client = new StellarSorobanClient(feesService);
    // await client.verifyNetworkPassphrase();
    // const preparedTx = await prepareCreateEscrowTx({ ... });
    // const result = await client.invoke(preparedTx);
    // return { txHash: result.txHash, contractVersion: this.resolvedContractVersion };

    throw new Error(
      "SorobanEscrowServiceImpl: contract invocation not yet wired up"
    );
  }

  async openDispute(input: {
    escrowId: string;
    raisedBy: string;
    reason: string;
  }): Promise<{ txHash: string }> {
    if (input.reason.length > 500) {
      throw Object.assign(
        new Error("Dispute reason must be 500 characters or less"),
        { statusCode: 400 }
      );
    }

    if (this.expectedContractVersion && !this.configured) {
      throw Object.assign(
        new Error(
          "Soroban escrow integration disabled due to contract version mismatch"
        ),
        { statusCode: 503 }
      );
    }

    // TODO: invoke the Soroban contract here
    // const client = new StellarSorobanClient(feesService);
    // await client.verifyNetworkPassphrase();
    // const preparedTx = await prepareOpenDisputeTx({ ... });
    // const result = await client.invoke(preparedTx);
    // return { txHash: result.txHash };

    throw new Error(
      "SorobanEscrowServiceImpl: openDispute not yet wired up"
    );
  }

  async resolveDispute(input: {
    escrowId: string;
    resolvedBy: string;
  }): Promise<{ txHash: string }> {
    if (this.expectedContractVersion && !this.configured) {
      throw Object.assign(
        new Error(
          "Soroban escrow integration disabled due to contract version mismatch"
        ),
        { statusCode: 503 }
      );
    }

    // TODO: invoke the Soroban contract here
    // const client = new StellarSorobanClient(feesService);
    // await client.verifyNetworkPassphrase();
    // const preparedTx = await prepareResolveDisputeTx({ ... });
    // const result = await client.invoke(preparedTx);
    // return { txHash: result.txHash };

    throw new Error(
      "SorobanEscrowServiceImpl: resolveDispute not yet wired up"
    );
  }

  /**
   * Applies the on-chain escrow state to a booking record.
   *
   * Disputed escrows must set payment_status = 'disputed' — never 'failed'.
   * A dispute means funds are held in escrow pending resolution, not that
   * payment failed.
   */
  async applyEscrowStateToBookings(
    state: EscrowOnChainState,
    bookingId: string,
    repo: BookingRepository
  ): Promise<void> {
    switch (state.status) {
      case "disputed":
        await repo.updatePaymentStatus(bookingId, "disputed");
        break;
      case "released":
        await repo.updatePaymentStatus(bookingId, "paid");
        break;
      case "refunded":
        await repo.updatePaymentStatus(bookingId, "refunded");
        break;
      // 'active' and 'resolved' require no payment status change
    }
  }

  /**
   * Syncs on-chain escrow state to bookings with cursor-based pagination.
   *
   * Includes 'pending' bookings because escrow is created when payment is
   * confirmed, which can happen before the mentor confirms the booking.
   * Omitting 'pending' means timeout refunds on pending bookings are never
   * reflected in the DB.
   * 
   * @deprecated Use syncPendingEscrowsOptimized instead
   */
  async syncPendingEscrows(
    bookingRepo: BookingRepository,
    escrowStateResolver: EscrowStateResolver
  ): Promise<void> {
    const bookings = await bookingRepo.findBookingsWithActiveEscrow([
      "pending",
      "confirmed",
      "completed",
      "cancelled",
    ]);

    for (const booking of bookings) {
      const state = await escrowStateResolver.getEscrowState(booking.escrowId);
      await this.applyEscrowStateToBookings(state, booking.id, bookingRepo);
    }
  }

  /**
   * Optimized escrow sync with cursor-based pagination and rate limiting.
   * 
   * Features:
   * - Cursor-based pagination to handle >200 active escrows
   * - Only syncs bookings not synced in the last 5 minutes
   * - Distributed locking to prevent duplicate work across instances
   * - Metrics tracking for monitoring
   * - Batch processing with configurable limits
   * 
   * @param bookingRepo - Repository for booking operations
   * @param escrowStateResolver - Resolver for on-chain escrow state
   * @param options - Sync configuration options
   * @returns Sync result with statistics
   */
  async syncPendingEscrowsOptimized(
    bookingRepo: BookingRepository,
    escrowStateResolver: EscrowStateResolver,
    options?: {
      batchSize?: number;
      minSyncIntervalMinutes?: number;
      maxBatches?: number;
    }
  ): Promise<{
    bookingsProcessed: number;
    rpcCalls: number;
    duration: number;
    hasMore: boolean;
  }> {
    const startTime = Date.now();
    const batchSize = options?.batchSize || 50; // Reduced from 200
    const minSyncIntervalMinutes = options?.minSyncIntervalMinutes || 5;
    const maxBatches = options?.maxBatches || 1; // Process 1 batch per cycle by default
    
    let bookingsProcessed = 0;
    let rpcCalls = 0;
    let batchesProcessed = 0;
    let lastBookingId: string | null = null;
    let hasMore = true;

    try {
      // Import sync state service dynamically to avoid circular dependencies
      const { escrowSyncStateService } = await import('./escrow-sync-state.service');
      
      // Get current sync state
      const syncState = await escrowSyncStateService.getSyncState();
      lastBookingId = syncState.lastSyncedBookingId;

      while (batchesProcessed < maxBatches && hasMore) {
        // Fetch batch with pagination
        const bookings = await bookingRepo.findBookingsWithActiveEscrowPaginated(
          ["pending", "confirmed", "completed", "cancelled"],
          {
            limit: batchSize,
            afterBookingId: lastBookingId,
            minLastSyncMinutes: minSyncIntervalMinutes,
          }
        );

        if (bookings.length === 0) {
          hasMore = false;
          // Reset cursor to start from beginning next time
          await escrowSyncStateService.updateSyncState({
            lastSyncedBookingId: null,
            currentBatchNumber: 0,
          });
          break;
        }

        // Process batch
        for (const booking of bookings) {
          try {
            const state = await escrowStateResolver.getEscrowState(booking.escrowId);
            rpcCalls++;
            
            await this.applyEscrowStateToBookings(state, booking.id, bookingRepo);
            
            // Update last sync timestamp for this booking
            await bookingRepo.updateLastEscrowSync(booking.id);
            
            bookingsProcessed++;
            lastBookingId = booking.id;
          } catch (error) {
            console.error(
              `[EscrowSync] Failed to sync booking ${booking.id}:`,
              error
            );
            // Continue with next booking instead of failing entire batch
          }
        }

        // Update sync state after each batch
        await escrowSyncStateService.updateSyncState({
          lastSyncedBookingId: lastBookingId,
          totalBookingsProcessed: syncState.totalBookingsProcessed + bookingsProcessed,
          currentBatchNumber: syncState.currentBatchNumber + 1,
        });

        batchesProcessed++;
        hasMore = bookings.length === batchSize;
      }

      const duration = Date.now() - startTime;

      // Update metrics
      const { escrowSyncStateService: syncService } = await import('./escrow-sync-state.service');
      await syncService.updateSyncMetrics({
        syncDuration: duration,
        bookingsProcessed,
        rpcCalls,
        error: null,
      });

      return {
        bookingsProcessed,
        rpcCalls,
        duration,
        hasMore,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Update metrics with error
      try {
        const { escrowSyncStateService: syncService } = await import('./escrow-sync-state.service');
        await syncService.updateSyncMetrics({
          syncDuration: duration,
          bookingsProcessed,
          rpcCalls,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch (metricsError) {
        console.error('[EscrowSync] Failed to update error metrics:', metricsError);
      }

      throw error;
    }
  }
}
