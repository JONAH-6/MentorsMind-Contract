import { Pool } from 'pg';
import { Queue, UnrecoverableError } from 'bullmq';
import { StellarTxWorker, StellarTxSubmitter, enqueueStellarTx, txHashFromXdr } from '../src/jobs/stellarTx.worker';
import { TransactionBuilder, Networks, Keypair, Account, Operation, Asset } from 'stellar-sdk';

function makePool(spy: jest.Mock): Pool {
  return { query: spy } as unknown as Pool;
}

/** Build a minimal signed XDR for testing. */
function makeSignedXdr(): string {
  const keypair = Keypair.random();
  const account = new Account(keypair.publicKey(), '100');
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
      })
    )
    .setTimeout(30)
    .build();
  tx.sign(keypair);
  return tx.toEnvelope().toXDR('base64');
}

describe('txHashFromXdr', () => {
  it('returns the same hash for the same XDR', () => {
    const xdr = makeSignedXdr();
    expect(txHashFromXdr(xdr)).toBe(txHashFromXdr(xdr));
  });

  it('returns different hashes for different XDRs', () => {
    expect(txHashFromXdr(makeSignedXdr())).not.toBe(txHashFromXdr(makeSignedXdr()));
  });
});

describe('enqueueStellarTx', () => {
  it('uses tx hash as jobId when no jobId is provided', async () => {
    const queue = { add: jest.fn() } as unknown as Queue;
    const xdr = makeSignedXdr();
    const expectedHash = txHashFromXdr(xdr);

    await enqueueStellarTx(queue, { txEnvelopeXdr: xdr });

    expect(queue.add).toHaveBeenCalledWith(
      'stellar-tx',
      { txEnvelopeXdr: xdr },
      expect.objectContaining({ jobId: `stellar-tx:${expectedHash}` })
    );
  });

  it('uses the same jobId for the same XDR regardless of paymentId', async () => {
    const queue = { add: jest.fn() } as unknown as Queue;
    const xdr = makeSignedXdr();
    const expectedHash = txHashFromXdr(xdr);

    await enqueueStellarTx(queue, { txEnvelopeXdr: xdr, paymentId: 'pay-1' });
    await enqueueStellarTx(queue, { txEnvelopeXdr: xdr, paymentId: 'pay-2' });

    const [, , opts1] = (queue.add as jest.Mock).mock.calls[0];
    const [, , opts2] = (queue.add as jest.Mock).mock.calls[1];
    expect(opts1.jobId).toBe(`stellar-tx:${expectedHash}`);
    expect(opts2.jobId).toBe(`stellar-tx:${expectedHash}`);
  });

  it('respects an explicit jobId override', async () => {
    const queue = { add: jest.fn() } as unknown as Queue;
    const xdr = makeSignedXdr();

    await enqueueStellarTx(queue, { txEnvelopeXdr: xdr }, 'custom-job-id');

    expect(queue.add).toHaveBeenCalledWith(
      'stellar-tx',
      expect.anything(),
      expect.objectContaining({ jobId: 'custom-job-id' })
    );
  });
});

describe('StellarTxWorker', () => {
  let querySpy: jest.Mock;
  let submitter: StellarTxSubmitter;
  let worker: StellarTxWorker;
  let signedXdr: string;

  beforeEach(() => {
    querySpy = jest.fn().mockResolvedValue({ rowCount: 1 });
    submitter = { submit: jest.fn(), getTransaction: jest.fn().mockResolvedValue(null) };
    worker = new StellarTxWorker(makePool(querySpy), submitter);
    signedXdr = makeSignedXdr();
  });

  it('success path — updates transactions table with completed status and hash', async () => {
    (submitter.submit as jest.Mock).mockResolvedValue({ hash: 'tx-abc' });

    await worker.process('pay-1', signedXdr);

    const [sql, values] = querySpy.mock.calls[0];
    expect(sql).toContain('UPDATE transactions');
    expect(sql).toContain("status = 'completed'");
    expect(sql).toContain('transaction_hash = $1');
    expect(values).toEqual(['tx-abc', 'pay-1']);
  });

  it('checks Horizon by hash before submitting — skips submit if already confirmed', async () => {
    (submitter.getTransaction as jest.Mock).mockResolvedValue({ hash: 'tx-already', successful: true });

    await worker.process('pay-1', signedXdr);

    expect(submitter.submit).not.toHaveBeenCalled();
    const [sql, values] = querySpy.mock.calls[0];
    expect(sql).toContain("status = 'completed'");
    expect(values).toEqual(['tx-already', 'pay-1']);
  });

  it('checks Horizon using the hash derived from XDR, not a separate parameter', async () => {
    const expectedHash = txHashFromXdr(signedXdr);
    (submitter.submit as jest.Mock).mockResolvedValue({ hash: expectedHash });

    await worker.process('pay-1', signedXdr);

    expect(submitter.getTransaction).toHaveBeenCalledWith(expectedHash);
  });

  it('failure path — updates transactions table with failed status', async () => {
    (submitter.submit as jest.Mock).mockRejectedValue(new Error('network error'));

    await expect(worker.process('pay-2', signedXdr)).rejects.toThrow('network error');

    const [sql, values] = querySpy.mock.calls[0];
    expect(sql).toContain('UPDATE transactions');
    expect(sql).toContain("status = 'failed'");
    expect(values).toEqual(['pay-2']);
  });

  it('neither path ever references the payments table', async () => {
    (submitter.submit as jest.Mock).mockResolvedValue({ hash: 'tx-xyz' });
    await worker.process('pay-3', signedXdr);
    const [successSql] = querySpy.mock.calls[0];
    expect(successSql).not.toMatch(/payments/);

    querySpy.mockClear();
    (submitter.submit as jest.Mock).mockRejectedValue(new Error('fail'));
    await expect(worker.process('pay-4', signedXdr)).rejects.toThrow();
    const [failSql] = querySpy.mock.calls[0];
    expect(failSql).not.toMatch(/payments/);
  });

  it('protocol error — throws BullMQ UnrecoverableError so job is not retried', async () => {
    const horizonError = {
      response: {
        data: {
          extras: {
            result_codes: { transaction: 'tx_bad_seq' },
          },
        },
      },
    };
    (submitter.submit as jest.Mock).mockRejectedValue(horizonError);

    await expect(worker.process('pay-5', signedXdr)).rejects.toBeInstanceOf(UnrecoverableError);

    const [sql, values] = querySpy.mock.calls[0];
    expect(sql).toContain("status = 'failed'");
    expect(values).toEqual(['pay-5']);
  });
});
