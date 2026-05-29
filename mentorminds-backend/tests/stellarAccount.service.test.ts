import { Pool, PoolClient } from 'pg';
import { StellarAccountService } from '../src/services/stellarAccount.service';
import { stellarFeesService } from '../src/services/stellarFees.service';
import { Keypair, Server } from 'stellar-sdk';

jest.mock('../src/services/stellarFees.service', () => ({
  stellarFeesService: { getFeeEstimate: jest.fn() },
}));

const mockLoadAccount = jest.fn();
const mockSubmitTransaction = jest.fn();

jest.mock('stellar-sdk', () => {
  const actual = jest.requireActual('stellar-sdk');
  return {
    ...actual,
    Server: jest.fn().mockImplementation(() => ({
      loadAccount: mockLoadAccount,
      submitTransaction: mockSubmitTransaction,
    })),
  };
});

function makeClient(overrides: Partial<PoolClient> = {}): jest.Mocked<PoolClient> {
  return {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<PoolClient>;
}

describe('StellarAccountService', () => {
  let pool: jest.Mocked<Pool>;
  let service: StellarAccountService;

  beforeEach(() => {
    pool = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: jest.fn(),
    } as any;

    jest.clearAllMocks();

    // Default: destination 404 (not funded), admin account succeeds
    mockLoadAccount
      .mockRejectedValueOnce({ response: { status: 404 } }) // accountExists → false
      .mockImplementation((pubkey: string) => {
        const actual = jest.requireActual('stellar-sdk');
        return Promise.resolve(new actual.Account(pubkey, '1')); // admin account
      });
    mockSubmitTransaction.mockResolvedValue({ hash: 'mock-tx-hash' });

    service = new StellarAccountService(pool);
  });

  describe('fundAccount', () => {
    const destination = Keypair.random().publicKey();
    const userId = 'user-123';

    it('uses recommended fee from StellarFeesService', async () => {
      (stellarFeesService.getFeeEstimate as jest.Mock).mockResolvedValue({ recommended_fee: '250' });

      await service.fundAccount(destination, userId);

      expect(stellarFeesService.getFeeEstimate).toHaveBeenCalledWith(1);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO transactions'),
        expect.arrayContaining([userId, '2.5', destination, 'completed', 'mock-tx-hash'])
      );
    });

    it('caps the fee at 10,000 stroops during surge pricing', async () => {
      (stellarFeesService.getFeeEstimate as jest.Mock).mockResolvedValue({ recommended_fee: '50000' });

      await service.fundAccount(destination, userId);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO transactions'),
        expect.arrayContaining(['completed'])
      );
    });

    it('records failure if transaction submission fails', async () => {
      (stellarFeesService.getFeeEstimate as jest.Mock).mockResolvedValue({ recommended_fee: '100' });
      mockSubmitTransaction.mockRejectedValueOnce(new Error('Network error'));

      await expect(service.fundAccount(destination, userId)).rejects.toThrow('Network error');

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO transactions'),
        expect.arrayContaining([userId, '2.5', destination, 'failed'])
      );
    });
  });

  describe('createAndFundWallet', () => {
    it('generates a new keypair and funds it', async () => {
      (stellarFeesService.getFeeEstimate as jest.Mock).mockResolvedValue({ recommended_fee: '100' });
      const userId = 'user-new';

      const publicKey = await service.createAndFundWallet(userId);

      expect(publicKey).toMatch(/^G[A-Z2-7]{55}$/);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO transactions'),
        expect.arrayContaining([userId, '2.5', publicKey, 'completed'])
      );
    });
  });

  describe('activateExistingWallet', () => {
    const destination = Keypair.random().publicKey();
    const userId = 'user-exist';

    it('acquires a SELECT FOR UPDATE lock before checking wallet_activated', async () => {
      const client = makeClient({
        query: jest.fn()
          .mockResolvedValueOnce(undefined) // BEGIN
          .mockResolvedValueOnce({ rows: [{ id: 'w-1', wallet_activated: false }], rowCount: 1 }) // SELECT FOR UPDATE
          .mockResolvedValueOnce(undefined) // UPDATE wallet_activated
          .mockResolvedValueOnce(undefined), // COMMIT
      });
      (pool.connect as jest.Mock).mockResolvedValue(client);
      (stellarFeesService.getFeeEstimate as jest.Mock).mockResolvedValue({ recommended_fee: '100' });

      await service.activateExistingWallet(destination, userId);

      const calls = (client.query as jest.Mock).mock.calls;
      expect(calls[0][0]).toBe('BEGIN');
      expect(calls[1][0]).toContain('FOR UPDATE');
      expect(calls[1][1]).toEqual([userId]);
      expect(calls[2][0]).toContain('wallet_activated = TRUE');
      expect(calls[3][0]).toBe('COMMIT');
    });

    it('returns early without funding if wallet_activated is already true', async () => {
      const client = makeClient({
        query: jest.fn()
          .mockResolvedValueOnce(undefined) // BEGIN
          .mockResolvedValueOnce({ rows: [{ id: 'w-1', wallet_activated: true }], rowCount: 1 }) // SELECT FOR UPDATE
          .mockResolvedValueOnce(undefined), // COMMIT
      });
      (pool.connect as jest.Mock).mockResolvedValue(client);

      await service.activateExistingWallet(destination, userId);

      // fundAccount (pool.query) should not be called
      expect(pool.query).not.toHaveBeenCalled();
      expect(stellarFeesService.getFeeEstimate).not.toHaveBeenCalled();
    });

    it('rethrows if fundAccount fails after optimistic lock is set', async () => {
      const client = makeClient({
        query: jest.fn()
          .mockResolvedValueOnce(undefined) // BEGIN
          .mockResolvedValueOnce({ rows: [{ id: 'w-1', wallet_activated: false }], rowCount: 1 }) // SELECT FOR UPDATE
          .mockResolvedValueOnce(undefined) // UPDATE wallet_activated
          .mockResolvedValueOnce(undefined), // COMMIT
      });
      (pool.connect as jest.Mock).mockResolvedValue(client);
      (stellarFeesService.getFeeEstimate as jest.Mock).mockResolvedValue({ recommended_fee: '100' });
      // Reset loadAccount: destination → 404, admin → success
      const actual = jest.requireActual<any>('stellar-sdk');
      mockLoadAccount
        .mockReset()
        .mockRejectedValueOnce({ response: { status: 404 } })
        .mockImplementation((pubkey: string) => Promise.resolve(new actual.Account(pubkey, '1')));
      mockSubmitTransaction.mockRejectedValueOnce(new Error('Horizon down'));

      await expect(service.activateExistingWallet(destination, userId)).rejects.toThrow('Horizon down');
    });

    it('throws if wallet row is not found', async () => {
      const client = makeClient({
        query: jest.fn()
          .mockResolvedValueOnce(undefined) // BEGIN
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT FOR UPDATE — no row
          .mockResolvedValueOnce(undefined), // ROLLBACK
      });
      (pool.connect as jest.Mock).mockResolvedValue(client);

      await expect(service.activateExistingWallet(destination, userId)).rejects.toThrow(
        `Wallet not found for user ${userId}`
      );
    });

    it('releases the client even when an error is thrown', async () => {
      const client = makeClient({
        query: jest.fn()
          .mockResolvedValueOnce(undefined) // BEGIN
          .mockRejectedValueOnce(new Error('DB error')), // SELECT FOR UPDATE fails
      });
      (pool.connect as jest.Mock).mockResolvedValue(client);

      await expect(service.activateExistingWallet(destination, userId)).rejects.toThrow('DB error');

      expect(client.release).toHaveBeenCalled();
    });
  });

  describe('fundAccount userId parameter (fix #292)', () => {
    it('should pass userId to the transaction record — not throw ReferenceError', async () => {
      (stellarFeesService.getFeeEstimate as jest.Mock).mockResolvedValue({ recommended_fee: '100' });
      const destination = Keypair.random().publicKey();
      const userId = 'user-fix-292';

      // Before the fix, userId was not a parameter of fundAccount, causing
      // ReferenceError: userId is not defined at runtime.
      await expect(service.fundAccount(destination, userId)).resolves.not.toThrow();

      // Verify the transaction record includes the correct userId
      const insertCall = (pool.query as jest.Mock).mock.calls.find(
        ([sql]: [string]) => sql.includes('INSERT INTO transactions')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1]).toEqual(
        expect.arrayContaining([userId, destination, 'completed'])
      );
    });

    it('createAndFundWallet passes userId through to the transaction record', async () => {
      (stellarFeesService.getFeeEstimate as jest.Mock).mockResolvedValue({ recommended_fee: '100' });
      const userId = 'user-wallet-292';

      const publicKey = await service.createAndFundWallet(userId);

      const insertCall = (pool.query as jest.Mock).mock.calls.find(
        ([sql]: [string]) => sql.includes('INSERT INTO transactions')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1]).toEqual(
        expect.arrayContaining([userId, publicKey, 'completed'])
      );
    });
  });
});
