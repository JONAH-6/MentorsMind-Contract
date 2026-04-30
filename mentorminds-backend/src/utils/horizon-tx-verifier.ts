import { Server } from 'stellar-sdk';
import { horizonConfig } from '../config/horizon.config';

export interface TxVerificationOptions {
  /** Expected source account (e.g. the learner's Stellar address). */
  expectedSourceAccount?: string;
  /** Expected destination account that must receive funds. */
  expectedDestination?: string;
  /** Expected minimum amount (in stroops or asset units as a string). */
  expectedAmount?: string;
  /** Expected asset code, e.g. 'XLM' or 'USDC'. Defaults to 'XLM'. */
  expectedAssetCode?: string;
}

/**
 * Verifies a Stellar transaction on Horizon before trusting it.
 *
 * Checks:
 *  1. The transaction exists and was successful.
 *  2. (Optional) The source account matches `expectedSourceAccount`.
 *  3. (Optional) At least one payment operation targets `expectedDestination`
 *     for at least `expectedAmount` of `expectedAssetCode`.
 *
 * Throws a descriptive error if any check fails.
 */
export async function verifyHorizonTransaction(
  txHash: string,
  options: TxVerificationOptions = {},
): Promise<void> {
  const server = new Server(horizonConfig.primary);

  let tx: any;
  try {
    tx = await server.transactions().transaction(txHash).call() as any;
  } catch (err: any) {
    throw new Error(`Transaction ${txHash} not found on Horizon: ${err?.message ?? err}`);
  }

  if (!tx.successful) {
    throw new Error(`Transaction ${txHash} was not successful on Horizon`);
  }

  if (options.expectedSourceAccount && tx.source_account !== options.expectedSourceAccount) {
    throw new Error(
      `Transaction ${txHash} source account mismatch: expected ${options.expectedSourceAccount}, got ${tx.source_account}`,
    );
  }

  if (options.expectedDestination || options.expectedAmount) {
    const ops = await server.operations().forTransaction(txHash).call();
    const assetCode = options.expectedAssetCode ?? 'XLM';

    const matchingOp = ops.records.find((op: any) => {
      if (op.type !== 'payment') return false;
      if (options.expectedDestination && op.to !== options.expectedDestination) return false;
      if (assetCode === 'XLM' && op.asset_type !== 'native') return false;
      if (assetCode !== 'XLM' && op.asset_code !== assetCode) return false;
      if (options.expectedAmount) {
        const opAmount = parseFloat(op.amount);
        const required = parseFloat(options.expectedAmount);
        if (opAmount < required) return false;
      }
      return true;
    });

    if (!matchingOp) {
      throw new Error(
        `Transaction ${txHash} does not contain a payment of ${options.expectedAmount ?? 'any'} ${assetCode} to ${options.expectedDestination ?? 'any address'}`,
      );
    }
  }
}
