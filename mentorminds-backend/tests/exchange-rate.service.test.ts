import { ExchangeRateService } from '../src/services/exchange-rate.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function makeOrderbook(askPrice: string, bidPrice: string) {
  return {
    asks: [{ price: askPrice, amount: '1000' }],
    bids: [{ price: bidPrice, amount: '1000' }],
  };
}

describe('ExchangeRateService — rate direction (#201)', () => {
  let service: ExchangeRateService;

  beforeEach(() => {
    service = new ExchangeRateService('https://horizon.stellar.org');
    mockFetch.mockReset();
  });

  it('uses mid-price (ask + bid) / 2 when both sides exist', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeOrderbook('0.10', '0.08'),
    });

    const rate = await service.fetchExchangeRate('XLM', 'USDC');
    expect(rate).toBeCloseTo(0.09); // (0.10 + 0.08) / 2
  });

  it('falls back to ask-only when no bids', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ asks: [{ price: '0.10', amount: '500' }], bids: [] }),
    });

    const rate = await service.fetchExchangeRate('XLM', 'USDC');
    expect(rate).toBeCloseTo(0.10);
  });

  it('falls back to bid-only when no asks', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ asks: [], bids: [{ price: '0.08', amount: '500' }] }),
    });

    const rate = await service.fetchExchangeRate('XLM', 'USDC');
    expect(rate).toBeCloseTo(0.08);
  });

  it('throws when orderbook is empty', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ asks: [], bids: [] }),
    });

    await expect(service.fetchExchangeRate('XLM', 'USDC')).rejects.toThrow(
      'No trading path available'
    );
  });

  it('reverse direction (USDC → XLM) uses its own orderbook mid-price', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeOrderbook('11.0', '10.0'),
    });

    const rate = await service.fetchExchangeRate('USDC', 'XLM');
    expect(rate).toBeCloseTo(10.5); // (11.0 + 10.0) / 2
  });
});
