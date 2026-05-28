import { Payment, PaymentStatus } from '../types/payment.types';
import { verifyHorizonTransaction } from '../utils/horizon-tx-verifier';

// In-memory store — replace with real DB (Prisma/TypeORM) in production
const payments = new Map<string, Payment>();

const TIMEOUT_MINUTES = 30;

export class PaymentTrackerService {
  async create(data: Omit<Payment, 'status' | 'ledgerSequence' | 'errorCode' | 'errorMessage' | 'createdAt' | 'updatedAt'>): Promise<Payment> {
    const payment: Payment = {
      ...data,
      ledgerSequence: null,
      status: 'pending',
      fee: data.fee ?? null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    payments.set(payment.id, payment);
    return payment;
  }

  async findById(id: string): Promise<Payment | null> {
    return payments.get(id) ?? null;
  }

  async findByTxHash(txHash: string): Promise<Payment | null> {
    for (const p of payments.values()) {
      if (p.txHash === txHash) return p;
    }
    return null;
  }

  async findPending(): Promise<Payment[]> {
    return [...payments.values()].filter(p => p.status === 'pending');
  }

  async updateStatus(
    id: string,
    status: PaymentStatus,
    extra?: { ledgerSequence?: number; fee?: string; errorCode?: string; errorMessage?: string }
  ): Promise<Payment | null> {
    const payment = payments.get(id);
    if (!payment) return null;
    Object.assign(payment, { status, ...extra, updatedAt: new Date() });
    return payment;
  }

  async timeoutStalePending(): Promise<string[]> {
    const cutoff = new Date(Date.now() - TIMEOUT_MINUTES * 60 * 1000);
    const timedOut: string[] = [];

    for (const payment of payments.values()) {
      if (payment.status === 'pending' && payment.createdAt < cutoff) {
        await this.updateStatus(payment.id, 'timeout', {
          errorCode: 'TIMEOUT',
          errorMessage: `Transaction not confirmed within ${TIMEOUT_MINUTES} minutes`,
        });
        timedOut.push(payment.id);
      }
    }
    return timedOut;
  }

  async getAll(): Promise<Payment[]> {
    return [...payments.values()];
  }

  /**
   * Confirms a payment after verifying the transaction on Horizon.
   *
   * Verifies:
   *  1. The transaction exists and was successful on Horizon.
   *  2. The transaction source account matches the payment's senderAddress.
   *  3. At least one payment operation sends the correct amount of the correct
   *     asset to the payment's receiverAddress.
   *
   * Throws if any verification fails — the payment is NOT marked confirmed.
   */
  async confirmPayment(id: string): Promise<Payment | null> {
    const payment = payments.get(id);
    if (!payment) return null;
    if (!payment.txHash) {
      throw new Error(`Payment ${id} has no txHash to verify`);
    }

    await verifyHorizonTransaction(payment.txHash, {
      expectedSourceAccount: payment.senderAddress,
      expectedDestination: payment.receiverAddress,
      expectedAmount: payment.amount,
      expectedAssetCode: payment.assetCode,
    });

    return this.updateStatus(id, 'confirmed');
  }
}

export const paymentTrackerService = new PaymentTrackerService();
