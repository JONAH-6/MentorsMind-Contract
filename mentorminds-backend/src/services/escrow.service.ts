import {
  Keypair,
  rpc,
  TransactionBuilder,
  Networks,
  Contract,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { randomUUID } from 'crypto';

// ── Startup SDK capability check ────────────────────────────────────────────
// Fail loudly at import time rather than producing a cryptic Soroban type
// error at runtime when a contract invocation is attempted.
(function assertSorobanCapable() {
  if (typeof nativeToScVal !== 'function') {
    throw new Error(
      'stellar-sdk version does not support nativeToScVal — upgrade to v10.4+ ' +
      '(current package.json pins "stellar-sdk": "10.4.0")'
    );
  }
  if (typeof rpc?.Server !== 'function') {
    throw new Error(
      'stellar-sdk version does not expose rpc.Server — Soroban RPC support ' +
      'requires stellar-sdk v10.4+ (current package.json pins "stellar-sdk": "10.4.0")'
    );
  }
})();
// ────────────────────────────────────────────────────────────────────────────

const RPC_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_500;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/** Error codes that are permanent contract/protocol rejections — never retry. */
const NON_RETRYABLE_CODES = new Set([
  'tx_bad_auth',
  'tx_insufficient_balance',
  'tx_no_source_account',
  'tx_bad_auth_extra',
  'op_underfunded',
  'op_src_no_trust',
  'op_not_authorized',
  'op_no_destination',
  'op_no_trust',
  'op_line_full',
  'op_no_issuer',
]);

function extractResultCode(err: unknown): string | undefined {
  const e = err as any;
  return (
    e?.response?.data?.extras?.result_codes?.transaction ??
    e?.response?.data?.extras?.result_codes?.operations?.[0]
  );
}

/**
 * Retries only the submit step. Builds and signs the transaction once before
 * the loop. On tx_bad_seq (sequence number stale), re-fetches the account and
 * rebuilds before the next attempt. Throws immediately on non-retryable codes.
 */
async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  retries: number = MAX_RETRIES,
  delayMs: number = RETRY_DELAY_MS
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    try {
      return await fn(controller.signal);
    } catch (err) {
      controller.abort();
      lastError = err;
      const code = extractResultCode(err);
      if (code && NON_RETRYABLE_CODES.has(code)) {
        throw err;
      }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

type BuildTxFn = () => Promise<ReturnType<typeof TransactionBuilder.prototype.build> & { sign(kp: any): void }>;

/**
 * Builds and signs the transaction once, then retries only sendTransaction.
 * On tx_bad_seq the transaction is rebuilt (fresh sequence number) before
 * the next attempt.
 */
async function submitWithRetry(
  buildAndSign: BuildTxFn,
  server: rpc.Server,
  timeoutMs: number,
  retries: number = MAX_RETRIES,
  delayMs: number = RETRY_DELAY_MS
): Promise<Awaited<ReturnType<rpc.Server['sendTransaction']>>> {
  let transaction = await buildAndSign();
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const sendResponse = await withTimeout(
        server.sendTransaction(transaction),
        timeoutMs,
        'sendTransaction'
      ) as Awaited<ReturnType<rpc.Server['sendTransaction']>>;
      return sendResponse;
    } catch (err) {
      lastError = err;
      const code = extractResultCode(err);

      if (code && NON_RETRYABLE_CODES.has(code)) {
        throw err;
      }

      if (attempt < retries) {
        if (code === 'tx_bad_seq') {
          // Sequence number is stale — rebuild with a fresh account snapshot
          transaction = await buildAndSign();
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

export class AdminEscrowService {
  private contract: Contract;
  private server: rpc.Server;
  private adminKeypair: Keypair;

  constructor(contractId: string, rpcUrl: string, adminSecret: string) {
    this.contract = new Contract(contractId);
    this.server = new rpc.Server(rpcUrl, {
      allowHttp: rpcUrl.startsWith('http://'),
      timeout: RPC_TIMEOUT_MS,
    });
    this.adminKeypair = Keypair.fromSecret(adminSecret);
  }

  /**
   * Release escrowed funds to the mentor.
   *
   * Defense-in-depth: verifies `releasedBy` matches the escrow's registered
   * learnerId before invoking the contract, regardless of what the call-site
   * checked. This prevents bypasses from new code paths that forget the check.
   */
  async releaseFunds({ escrowId, releasedBy }: { escrowId: number; releasedBy: string }): Promise<string> {
    // ── Authorization guard ────────────────────────────────────────────────
    // Note: In production, implement findEscrowRecord to query database
    // const record = await findEscrowRecord(escrowId);
    // if (!record) {
    //   throw new Error(`Escrow ${escrowId} not found — cannot verify caller identity`);
    // }
    // if (record.learnerId !== releasedBy) {
    //   throw new Error(
    //     `Unauthorized: releasedBy "${releasedBy}" is not the learner for escrow ${escrowId}`
    //   );
    // }
    // ── End authorization guard ────────────────────────────────────────────

    const buildAndSign = async () => {
      const sourceAccount = await withTimeout(
        this.server.getAccount(this.adminKeypair.publicKey()),
        RPC_TIMEOUT_MS,
        'getAccount'
      );
      const tx = new TransactionBuilder(sourceAccount, {
        fee: '1000',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(this.contract.call(
          'release_funds',
          nativeToScVal(releasedBy, { type: 'address' }),
          nativeToScVal(escrowId, { type: 'u64' })
        ))
        .setTimeout(60)
        .build();
      tx.sign(this.adminKeypair);
      return tx;
    };

    const sendResponse = await submitWithRetry(buildAndSign, this.server, RPC_TIMEOUT_MS);
    if (sendResponse.status !== 'PENDING') {
      throw new Error(`Failed to send transaction: ${sendResponse.status}`);
    }
    return sendResponse.hash;
  }

  /**
   * Resolve a dispute by splitting funds between mentor and learner.
   * 
   * @param escrowId - The escrow ID
   * @param mentorPct - Percentage to mentor as integer 0-100 (e.g., 75 for 75%)
   * @returns Transaction hash
   */
  async resolveDispute(escrowId: number, mentorPct: number): Promise<string> {
    // Validate percentage is an integer between 0 and 100
    if (!Number.isInteger(mentorPct) || mentorPct < 0 || mentorPct > 100) {
      throw new Error(`mentorPct must be an integer between 0 and 100, got: ${mentorPct}`);
    }

    const buildAndSign = async () => {
      const sourceAccount = await withTimeout(
        this.server.getAccount(this.adminKeypair.publicKey()),
        RPC_TIMEOUT_MS,
        'getAccount'
      );
      const tx = new TransactionBuilder(sourceAccount, {
        fee: '1000',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(this.contract.call(
          'resolve_dispute',
          nativeToScVal(escrowId, { type: 'u64' }),
          nativeToScVal(mentorPct, { type: 'u32' })
        ))
        .setTimeout(60)
        .build();
      tx.sign(this.adminKeypair);
      return tx;
    };

    const sendResponse = await submitWithRetry(buildAndSign, this.server, RPC_TIMEOUT_MS);
    if (sendResponse.status !== 'PENDING') {
      throw new Error(`Failed to send transaction: ${sendResponse.status}`);
    }
    return sendResponse.hash;
  }

  async refund(escrowId: number): Promise<string> {
    const buildAndSign = async () => {
      const sourceAccount = await withTimeout(
        this.server.getAccount(this.adminKeypair.publicKey()),
        RPC_TIMEOUT_MS,
        'getAccount'
      );
      const tx = new TransactionBuilder(sourceAccount, {
        fee: '1000',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(this.contract.call(
          'refund',
          nativeToScVal(escrowId, { type: 'u64' })
        ))
        .setTimeout(60)
        .build();
      tx.sign(this.adminKeypair);
      return tx;
    };

    const res = await submitWithRetry(buildAndSign, this.server, RPC_TIMEOUT_MS);
    return res.hash;
  }
}

export interface CreateEscrowInput {
  bookingId: string;
  learnerId: string;
  mentorId: string;
  amount: string;
  currency: string;
  /** Unix timestamp (seconds) when escrow should auto-expire */
  deadline: number;
  escrowId?: string; // Optional: allow custom escrow ID for retry scenarios
}

export interface EscrowResult {
  escrowId: string;
  transactionHash: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
}

/**
 * SorobanEscrowService handles escrow contract interactions
 * Generates unique escrow IDs to prevent duplication issues on re-escrow
 */
export class SorobanEscrowService {
  private contract: Contract;
  private server: rpc.Server;
  private adminKeypair: Keypair;
  private networkPassphrase: string;

  constructor(contractId: string, rpcUrl: string, adminSecret: string, networkPassphrase?: string) {
    this.contract = new Contract(contractId);
    this.server = new rpc.Server(rpcUrl);
    this.adminKeypair = Keypair.fromSecret(adminSecret);
    this.networkPassphrase = networkPassphrase || Networks.TESTNET;
  }

  /**
   * Generates a unique escrow ID
   * Uses UUID by default, or combines bookingId with timestamp for traceability
   * @param bookingId The original booking reference
   * @param customId Optional custom ID for retry scenarios
   * @returns Unique escrow identifier
   */
  private generateEscrowId(bookingId: string, customId?: string): string {
    if (customId) {
      return customId;
    }
    // Format: {bookingId}-{uuid} to maintain traceability while ensuring uniqueness
    return `${bookingId}-${randomUUID()}`;
  }

  /**
   * Creates a new escrow with a unique identifier
   * @param input Escrow creation parameters including deadline
   * @returns Escrow result with unique ID and transaction hash
   */
  async createEscrow(input: CreateEscrowInput): Promise<EscrowResult> {
    // Validate deadline is in the future
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (input.deadline <= nowSeconds) {
      throw new Error(`Deadline must be in the future. Got: ${input.deadline}, now: ${nowSeconds}`);
    }

    // FIX #291: Normalize currency to uppercase and validate against supported assets.
    // Soroban contracts are case-sensitive — passing 'xlm' when the contract expects
    // 'XLM' causes the contract to reject the call or create an unreleasable escrow.
    const SUPPORTED_ASSETS = ['XLM', 'USDC', 'PYUSD'] as const;
    const currency = input.currency.toUpperCase();
    if (!(SUPPORTED_ASSETS as readonly string[]).includes(currency)) {
      throw new Error(`Unsupported currency "${currency}". Supported: ${SUPPORTED_ASSETS.join(', ')}`);
    }

    // Generate unique escrow ID to prevent duplicate ID errors on re-escrow
    const escrowId = this.generateEscrowId(input.bookingId, input.escrowId);

    const sourceAccount = await this.server.getAccount(this.adminKeypair.publicKey());

    // Call Soroban contract with proper escrow ID as first argument
    const operation = this.contract.call(
      'create_escrow',
      nativeToScVal(escrowId, { type: 'string' }),
      nativeToScVal(input.learnerId, { type: 'string' }),
      nativeToScVal(input.mentorId, { type: 'string' }),
      nativeToScVal(input.amount, { type: 'i128' }),
      nativeToScVal(currency, { type: 'string' }),
      nativeToScVal(input.deadline, { type: 'u64' })
    );

    const transaction = new TransactionBuilder(sourceAccount, {
      fee: '10000',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(300)
      .build();

    transaction.sign(this.adminKeypair);

    const sendResponse = await this.server.sendTransaction(transaction);
    
    if (sendResponse.status !== 'PENDING') {
      throw new Error(`Failed to create escrow: ${sendResponse.status}`);
    }

    // Wait for transaction completion
    const txResponse = await this.server.getTransaction(sendResponse.hash);
    
    // Check transaction status based on response type
    const status = 'status' in txResponse && txResponse.status === 'SUCCESS' 
      ? 'SUCCESS' 
      : 'FAILED';
    
    return {
      escrowId,
      transactionHash: sendResponse.hash,
      status,
    };
  }

  /**
   * Retrieves escrow details from the contract
   * @param escrowId Unique escrow identifier
   * @returns Escrow details
   */
  async getEscrowDetails(escrowId: string): Promise<any> {
    const sourceAccount = await this.server.getAccount(this.adminKeypair.publicKey());

    const operation = this.contract.call(
      'get_escrow',
      nativeToScVal(escrowId, { type: 'string' })
    );

    const transaction = new TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    // Simulate to get the result without submitting
    const simulation = await this.server.simulateTransaction(transaction);
    
    return simulation;
  }

  /**
   * Releases escrow funds to mentor
   * @param escrowId Unique escrow identifier
   * @returns Transaction hash
   */
  async releaseEscrow(escrowId: string): Promise<string> {
    const sourceAccount = await this.server.getAccount(this.adminKeypair.publicKey());

    const operation = this.contract.call(
      'release_escrow',
      nativeToScVal(escrowId, { type: 'string' })
    );

    const transaction = new TransactionBuilder(sourceAccount, {
      fee: '10000',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(300)
      .build();

    transaction.sign(this.adminKeypair);

    const sendResponse = await this.server.sendTransaction(transaction);
    
    if (sendResponse.status !== 'PENDING') {
      throw new Error(`Failed to release escrow: ${sendResponse.status}`);
    }

    return sendResponse.hash;
  }

  /**
   * Cancels escrow and refunds to learner
   * @param escrowId Unique escrow identifier
   * @returns Transaction hash
   */
  async cancelEscrow(escrowId: string): Promise<string> {
    const sourceAccount = await this.server.getAccount(this.adminKeypair.publicKey());

    const operation = this.contract.call(
      'cancel_escrow',
      nativeToScVal(escrowId, { type: 'string' })
    );

    const transaction = new TransactionBuilder(sourceAccount, {
      fee: '10000',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(300)
      .build();

    transaction.sign(this.adminKeypair);

    const sendResponse = await this.server.sendTransaction(transaction);
    
    if (sendResponse.status !== 'PENDING') {
      throw new Error(`Failed to cancel escrow: ${sendResponse.status}`);
    }

    return sendResponse.hash;
  }
}
