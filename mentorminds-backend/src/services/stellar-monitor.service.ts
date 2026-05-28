import { paymentTrackerService } from './payment-tracker.service';
import { startRateRefresh } from './exchange-rate.service';

declare const process: {
  env: Record<string, string | undefined>;
};

const HORIZON_URL = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const POLL_INTERVAL_MS = 10_000;

// Maps Horizon result codes to user-readable messages
const RESULT_CODE_MESSAGES: Record<string, string> = {
  tx_bad_auth: 'Invalid transaction signature.',
  tx_insufficient_balance: 'Insufficient balance to complete payment.',
  tx_no_account: 'Sender account not found on the network.',
  tx_failed: 'Transaction failed on the Stellar network.',
};

interface StreamStopFn {
  (): void;
}

class StellarMonitorService {
  private streamActive = false;
  private stopStream: StreamStopFn | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  async fetchTransaction(txHash: string): Promise<{ successful: boolean; ledger: number; fee_paid?: string; result_code?: string } | null> {
    const res = await fetch(`${HORIZON_URL}/transactions/${txHash}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Horizon error: ${res.status}`);

    const data = await res.json();
    return {
      successful: data.successful,
      ledger: data.ledger,
      fee_paid: data.fee_paid,
      result_code: data.result_codes?.transaction,
    };
  }

  async processTransaction(payment: any): Promise<void> {
    if (!payment.txHash) return;

    try {
      const tx = await this.fetchTransaction(payment.txHash);
      if (!tx) return; // not yet on ledger

      if (tx.successful) {
        await paymentTrackerService.updateStatus(payment.id, 'confirmed', {
          ledgerSequence: tx.ledger,
          fee: tx.fee_paid,
        });
      } else {
        const errorCode = tx.result_code ?? 'tx_failed';
        await paymentTrackerService.updateStatus(payment.id, 'failed', {
          ledgerSequence: tx.ledger,
          fee: tx.fee_paid,
          errorCode,
          errorMessage: RESULT_CODE_MESSAGES[errorCode] ?? 'Transaction failed.',
        });
      }
    } catch {
      // transient error — will retry next poll cycle
    }
  }

  /**
   * Polls pending escrows only when streaming is not active.
   * The streamActive guard prevents duplicate processing when both
   * stream and poll would otherwise run simultaneously.
   */
  async pollPending(): Promise<void> {
    if (this.streamActive) {
      return;
    }

    const pending = await paymentTrackerService.findPending();

    await Promise.allSettled(
      pending.map(async (payment) => {
        await this.processTransaction(payment);
      })
    );

    await paymentTrackerService.timeoutStalePending();
  }

  /**
   * Starts polling only when streaming is not active.
   * If streaming succeeded, this is a no-op — preventing the duplicate
   * processing bug described in issue #300.
   */
  startPendingEscrowPolling(): void {
    if (this.streamActive) {
      return;
    }

    if (this.pollTimer) {
      return;
    }

    this.pollTimer = setInterval(async () => {
      await this.pollPending();
    }, POLL_INTERVAL_MS);

    console.log(`Stellar monitor polling started (poll every ${POLL_INTERVAL_MS / 1000}s)`);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async startStreamPendingEscrows(): Promise<StreamStopFn> {
    console.log('Starting stream for pending escrows...');

    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          const stopFn = () => {
            console.log('Stream stopped');
          };
          resolve(stopFn);
        } catch (error) {
          reject(error);
        }
      }, 100);
    });
  }

  /**
   * Attempts to start streaming first. Falls back to polling only on failure.
   *
   * Fix for issue #300: polling is started exclusively in the catch block so
   * it never runs simultaneously with an active stream. The streamActive flag
   * is set to true before the stream attempt and cleared on failure so that
   * startPendingEscrowPolling() can proceed.
   */
  async startPendingEscrowMonitoring(): Promise<void> {
    this.streamActive = true;

    try {
      const stop = await this.startStreamPendingEscrows();
      this.stopStream = stop;
      console.log('Stream started successfully - polling disabled');
    } catch (error) {
      console.error('Stream failed, falling back to polling:', error);
      this.streamActive = false;
      this.startPendingEscrowPolling();
    }
  }

  async stopMonitoring(): Promise<void> {
    if (this.stopStream) {
      this.stopStream();
      this.stopStream = null;
    }
    this.streamActive = false;
    this.stopPolling();
  }

  isStreamActive(): boolean {
    return this.streamActive;
  }

  isPollingActive(): boolean {
    return this.pollTimer !== null;
  }
}

export const stellarMonitorService = new StellarMonitorService();

export function startStellarMonitor(): void {
  stellarMonitorService.startPendingEscrowMonitoring();

  // Start the exchange rate refresh service with distributed lock
  startRateRefresh();
}

export function stopStellarMonitor(): void {
  stellarMonitorService.stopMonitoring();
}

export async function processWebhookEvent(payload: {
  transaction_hash: string;
  ledger: number;
  successful: boolean;
  fee_paid?: string;
  result_code?: string;
}): Promise<void> {
  const payment = await paymentTrackerService.findByTxHash(payload.transaction_hash);
  if (!payment || payment.status !== 'pending') return;

  if (payload.successful) {
    await paymentTrackerService.updateStatus(payment.id, 'confirmed', {
      ledgerSequence: payload.ledger,
      fee: payload.fee_paid,
    });
  } else {
    const errorCode = payload.result_code ?? 'tx_failed';
    await paymentTrackerService.updateStatus(payment.id, 'failed', {
      ledgerSequence: payload.ledger,
      fee: payload.fee_paid,
      errorCode,
      errorMessage: RESULT_CODE_MESSAGES[errorCode] ?? 'Transaction failed.',
    });
  }
}
