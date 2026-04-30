import { validateQuote } from '../src/services/assetExchange.service';
import { cacheService } from '../src/services/cache.service';

describe('validateQuote (fix #295)', () => {
  const quoteId = 'test-quote-id';
  const quoteKey = `mm:quote:${quoteId}`;
  const mockQuote = { id: quoteId, rate: 1.5, amount: '100' };

  beforeEach(() => {
    cacheService.set(quoteKey, mockQuote, 120_000);
  });

  it('returns the quote on first use', () => {
    const result = validateQuote(quoteId);
    expect(result).toEqual(mockQuote);
  });

  it('deletes the quote after validation — second use throws', () => {
    validateQuote(quoteId);
    expect(() => validateQuote(quoteId)).toThrow('Quote expired or not found');
  });

  it('throws immediately if quote does not exist', () => {
    expect(() => validateQuote('nonexistent-id')).toThrow('Quote expired or not found');
  });
});
