const mockNativeToScVal = jest.fn((value: unknown) => value);
const mockContractCall = jest.fn();
const mockContractCtor = jest.fn(() => ({
  call: mockContractCall,
}));

const mockSign = jest.fn();
const mockBuild = jest.fn(() => ({
  sign: mockSign,
}));
const mockSetTimeout = jest.fn(() => ({
  build: mockBuild,
}));
const mockAddOperation = jest.fn(() => ({
  setTimeout: mockSetTimeout,
}));
const mockTransactionBuilderCtor = jest.fn(() => ({
  addOperation: mockAddOperation,
}));

const mockGetLatestLedger = jest.fn();
const mockGetAccount = jest.fn();
const mockSendTransaction = jest.fn();
const mockServerCtor = jest.fn(() => ({
  getLatestLedger: mockGetLatestLedger,
  getAccount: mockGetAccount,
  sendTransaction: mockSendTransaction,
}));

const mockPublicKey = jest.fn(() => 'GADMINPUBLICKEY');
const mockFromSecret = jest.fn(() => ({
  publicKey: mockPublicKey,
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Keypair: {
    fromSecret: mockFromSecret,
  },
  rpc: {
    Server: mockServerCtor,
  },
  TransactionBuilder: mockTransactionBuilderCtor,
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
  },
  Contract: mockContractCtor,
  nativeToScVal: mockNativeToScVal,
}));

import { AdminEscrowService } from '../src/services/escrow.service';

describe('AdminEscrowService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLatestLedger.mockResolvedValue({ sequence: 123 });
    mockGetAccount.mockResolvedValue({ accountId: 'source' });
    mockContractCall.mockReturnValue({ op: 'mock-operation' });
  });

  test('resolveDispute sends a signed transaction and returns tx hash', async () => {
    mockSendTransaction.mockResolvedValue({
      status: 'PENDING',
      hash: 'tx-resolve-123',
    });

    const service = new AdminEscrowService('contract-id', 'https://rpc.test', 'SADMINSECRET');
    const hash = await service.resolveDispute(42, 100);

    expect(hash).toBe('tx-resolve-123');
    expect(mockFromSecret).toHaveBeenCalledWith('SADMINSECRET');
    expect(mockContractCtor).toHaveBeenCalledWith('contract-id');
    expect(mockServerCtor).toHaveBeenCalledWith('https://rpc.test', expect.objectContaining({ timeout: 10000 }));
    expect(mockGetAccount).toHaveBeenCalledWith('GADMINPUBLICKEY');
    expect(mockContractCall).toHaveBeenCalledWith('resolve_dispute', 42, 100);
    expect(mockTransactionBuilderCtor).toHaveBeenCalledWith(
      { accountId: 'source' },
      {
        fee: '1000',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }
    );
    expect(mockAddOperation).toHaveBeenCalledWith({ op: 'mock-operation' });
    expect(mockBuild).toHaveBeenCalledTimes(1);
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  test('resolveDispute throws when transaction submission is not pending', async () => {
    mockSendTransaction.mockResolvedValue({
      status: 'ERROR',
      hash: 'tx-failed',
    });

    const service = new AdminEscrowService('contract-id', 'https://rpc.test', 'SADMINSECRET');

    await expect(service.resolveDispute(7, 0)).rejects.toThrow('Failed to send transaction: ERROR');
    // Non-PENDING status is checked after submitWithRetry returns — throws immediately, no retry
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  test('resolveDispute validates percentage is integer between 0-100', async () => {
    const service = new AdminEscrowService('contract-id', 'https://rpc.test', 'SADMINSECRET');

    await expect(service.resolveDispute(42, 75.5)).rejects.toThrow(
      'mentorPct must be an integer between 0 and 100'
    );

    await expect(service.resolveDispute(42, -1)).rejects.toThrow(
      'mentorPct must be an integer between 0 and 100'
    );

    await expect(service.resolveDispute(42, 101)).rejects.toThrow(
      'mentorPct must be an integer between 0 and 100'
    );
  });

  test('refund submits refund call and returns tx hash', async () => {
    mockSendTransaction.mockResolvedValue({
      status: 'PENDING',
      hash: 'tx-refund-456',
    });

    const service = new AdminEscrowService('contract-id', 'https://rpc.test', 'SADMINSECRET');
    const hash = await service.refund(1001);

    expect(hash).toBe('tx-refund-456');
    expect(mockContractCall).toHaveBeenCalledWith('refund', 1001);
    expect(mockGetAccount).toHaveBeenCalledWith('GADMINPUBLICKEY');
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });
});
