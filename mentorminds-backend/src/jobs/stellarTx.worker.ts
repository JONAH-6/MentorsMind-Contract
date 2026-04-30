import { Pool } from 'pg';
import { UnrecoverableError } from 'bullmq';
import { QUEUE_NAMES } from '../config/queue';

export { UnrecoverableError };

if (!QUEUE_NAMES.STELLAR_TX) {
  throw new Error('STELLAR_TX queue name is undefined');
}

/**
 * Stellar protocol-level error codes that are permanent failures.
 * Retrying these will never succeed — the transaction must be rebuilt.
 */
const STELLAR_PROTOCOL_ERRORS = new Set([
  'tx_bad_seq',
  'tx_bad_auth',
  'tx_insufficient_balance',
  'tx_no_source_account',
  'tx_bad_auth_extra',
  'tx_internal_error',
  'op_underfunded',
  'op_src_no_trust',
  'op_not_authorized',
  'op_no_destination',
  'op_no_trust',
  'op_line_full',
  'op_no_issuer',
  'op_too_many_subentries',
  'op_exceeded_work_limit',
]);

export interface StellarTxSubmitter {
  submit(signedXdr: string): Promise<{ hash: string }>;
  /** Look up a transaction by hash on Horizon. Throws a 404-shaped error if not found. */
  getTransaction(hash: string): Promise<{ hash: string; successful: boolean } | null>;
}

export class StellarTxWorker {
  constructor(
    private readonly pool: Pool,
    private readonly submitter: StellarTxSubmitter
  ) {}

  async process(paymentId: string, signedXdr: string): Promise<void> {
    // Always derive the hash from the XDR and check Horizon first.
    // This prevents re-submitting a transaction that was already included in a
    // ledger — even if the job was retried or enqueued with a different paymentId.
    const txHash = txHashFromXdr(signedXdr);
    const existing = await this.submitter.getTransaction(txHash).catch(() => null);
    if (existing) {
      await this.pool.query(
        "UPDATE transactions SET status = 'completed', transaction_hash = $1, updated_at = NOW() WHERE id = $2",
        [existing.hash, paymentId]
      );
      return;
    }

    try {
      const result = await this.submitter.submit(signedXdr);
      await this.pool.query(
        "UPDATE transactions SET status = 'completed', transaction_hash = $1, updated_at = NOW() WHERE id = $2",
        [result.hash, paymentId]
      );
    } catch (err: any) {
      // Extract Stellar result codes from the Horizon error response
      const resultCodes: string[] =
        err?.response?.data?.extras?.result_codes?.transaction
          ? [err.response.data.extras.result_codes.transaction]
          : err?.response?.data?.extras?.result_codes?.operations ?? [];

      const isProtocolError =
        resultCodes.some((code) => STELLAR_PROTOCOL_ERRORS.has(code)) ||
        (err?.response?.data?.extras?.result_codes?.transaction &&
          STELLAR_PROTOCOL_ERRORS.has(err.response.data.extras.result_codes.transaction));

      if (isProtocolError) {
        // Mark as failed immediately — retrying the same XDR will never work
        await this.pool.query(
          "UPDATE transactions SET status = 'failed', updated_at = NOW() WHERE id = $1",
          [paymentId]
        );
        throw new UnrecoverableError(
          `Stellar protocol rejection for payment ${paymentId}: ${resultCodes.join(', ')}`
        );
      }

      // Transient error (timeout, 503, network blip) — mark failed and rethrow
      // so the queue can retry with the same XDR after checking Horizon first.
      await this.pool.query(
        "UPDATE transactions SET status = 'failed', updated_at = NOW() WHERE id = $1",
        [paymentId]
      );
      throw err;
    }
  }
}
