import {
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  rpc,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { EscrowService } from './escrow.service';

export interface ReleaseFundsParams {
  escrowId: number;
  /** The caller's address — must match the escrow's learner field. */
  releasedBy: string;
}

export interface RefundParams {
  escrowId: number;
  /** The caller's address — must match the escrow's mentor field. */
  refundedBy: string;
}

/**
 * SorobanEscrowService wraps on-chain escrow interactions that require
 * a signed transaction (e.g. release_funds).
 *
 * Defense-in-depth: releaseFunds always fetches the escrow record from the
 * chain and verifies that `releasedBy` is the escrow's learner before
 * submitting the transaction.  This prevents bypasses when the method is
 * called from a new code path that omits the caller-identity check.
 */
export class SorobanEscrowService {
  private contract: Contract;
  private server: rpc.Server;
  private escrowService: EscrowService;
  private readonly signerSecret: string;
  private networkPassphrase: string;

  constructor(
    contractId: string,
    rpcUrl: string,
    signerSecret: string,
    networkPassphrase: string = Networks.TESTNET,
  ) {
    this.contract = new Contract(contractId);
    this.server = new rpc.Server(rpcUrl);
    this.escrowService = new EscrowService(contractId, rpcUrl);
    // Do not store the keypair object — load it fresh per signing operation
    // so the secret key bytes are not held in memory for the process lifetime.
    this.signerSecret = signerSecret;
    this.networkPassphrase = networkPassphrase;
  }

  /**
   * Returns true when the service has been configured with a contract ID and
   * RPC URL (mirrors the pattern used by callers such as BookingsService).
   */
  static isConfigured(): boolean {
    return !!(process.env.ESCROW_CONTRACT_ID && process.env.SOROBAN_RPC_URL);
  }

  /**
   * Release escrow funds to the mentor.
   *
   * Before invoking the contract this method fetches the escrow record from
   * the chain and asserts that `releasedBy` matches `escrow.learner`.
   * This is the primary authorization guard — callers must not skip it.
   *
   * @throws {Error} if the escrow is not found, or if `releasedBy` is not
   *   the escrow's learner.
   */
  async releaseFunds({ escrowId, releasedBy }: ReleaseFundsParams): Promise<string> {
    // --- Defense-in-depth: verify caller is the escrow's learner ---
    const escrow = await this.escrowService.getEscrow(escrowId);

    if (escrow.learner !== releasedBy) {
      throw new Error(
        `Unauthorized: releasedBy (${releasedBy}) does not match escrow learner (${escrow.learner})`,
      );
    }
    // ----------------------------------------------------------------

    const sourceAccount = await this.server.getAccount(Keypair.fromSecret(this.signerSecret).publicKey());

    const operation = this.contract.call(
      'release_funds',
      nativeToScVal(escrowId, { type: 'u64' }),
      nativeToScVal(releasedBy, { type: 'address' }),
    );

    const transaction = new TransactionBuilder(sourceAccount, {
      fee: '1000',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    // Load keypair fresh for signing — discarded immediately after use
    // so the secret key bytes are not held in memory beyond this scope.
    const keypair = Keypair.fromSecret(this.signerSecret);
    transaction.sign(keypair);

    const sendResponse = await this.server.sendTransaction(transaction);
    if (sendResponse.status !== 'PENDING') {
      throw new Error(`Failed to send release_funds transaction: ${sendResponse.status}`);
    }

    return sendResponse.hash;
  }

  /**
   * Refund escrow funds back to the learner.
   *
   * Before invoking the contract this method fetches the escrow record from
   * the chain and asserts that `refundedBy` matches `escrow.mentor`.
   * This is the primary authorization guard — it prevents unauthorized users
   * (like a mentee cancelling their own booking) from triggering a refund
   * without mentor approval.
   *
   * @throws {Error} if the escrow is not found, or if `refundedBy` is not
   *   the escrow's mentor.
   */
  async refund({ escrowId, refundedBy }: RefundParams): Promise<string> {
    // --- Defense-in-depth: verify caller is the escrow's mentor ---
    const escrow = await this.escrowService.getEscrow(escrowId);

    if (escrow.mentor !== refundedBy) {
      throw new Error(
        `Unauthorized: refundedBy (${refundedBy}) does not match escrow mentor (${escrow.mentor})`,
      );
    }
    // ----------------------------------------------------------------

    const sourceAccount = await this.server.getAccount(this.signerKeypair.publicKey());

    const operation = this.contract.call(
      'refund',
      nativeToScVal(escrowId, { type: 'u64' }),
    );

    const transaction = new TransactionBuilder(sourceAccount, {
      fee: '1000',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    transaction.sign(this.signerKeypair);

    const sendResponse = await this.server.sendTransaction(transaction);
    if (sendResponse.status !== 'PENDING') {
      throw new Error(`Failed to send refund transaction: ${sendResponse.status}`);
    }

    return sendResponse.hash;
  }
}
