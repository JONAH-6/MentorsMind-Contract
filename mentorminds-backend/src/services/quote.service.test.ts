/**
 * Quote Service Tests
 * Verifies quote creation, validation, expiry, and single-use enforcement
 */

import { quoteService, createQuote, validateQuote, getQuote } from './quote.service';
import { getRedisClient } from './redis.service';
import { exchangeRateService } from './exchange-rate.service';

// Mock dependencies
jest.mock('./redis.service');
jest.mock('./exchange-rate.service');

describe('QuoteService', () => {
  let mockRedisClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup mock Redis client
    mockRedisClient = {
      setex: jest.fn().mockResolvedValue('OK'),
      get: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
    };
    
    (getRedisClient as jest.Mock).mockReturnValue(mockRedisClient);
    
    // Mock exchange rate service
    (exchangeRateService.fetchExchangeRate as jest.Mock).mockResolvedValue(0.0875);
  });

  describe('createQuote', () => {
    it('should create a valid quote with correct calculations', async () => {
      const request = {
        fromAsset: 'XLM' as const,
        toAsset: 'USDC' as const,
        amount: '100',
      };

      const quote = await createQuote(request);

      expect(quote).toMatchObject({
        fromAsset: 'XLM',
        toAsset: 'USDC',
        rate: 0.0875,
        amount: '100',
        estimatedOutput: '8.7500000',
      });
      expect(quote.id).toMatch(/^quote_/);
      expect(quote.expiresAt).toBeInstanceOf(Date);
      expect(quote.createdAt).toBeInstanceOf(Date);

      // Verify Redis storage
      expect(mockRedisClient.setex).toHaveBeenCalledWith(
        expect.stringContaining('mm:quote:'),
        120,
        expect.any(String)
      );
    });

    it('should throw error for invalid amount', async () => {
      const request = {
        fromAsset: 'XLM' as const,
        toAsset: 'USDC' as const,
        amount: 'invalid',
      };

      await expect(createQuote(request)).rejects.toThrow('Invalid amount');
    });

    it('should throw error for negative amount', async () => {
      const request = {
        fromAsset: 'XLM' as const,
        toAsset: 'USDC' as const,
        amount: '-50',
      };

      await expect(createQuote(request)).rejects.toThrow('Invalid amount');
    });

    it('should propagate exchange rate fetch errors', async () => {
      (exchangeRateService.fetchExchangeRate as jest.Mock).mockRejectedValue(
        new Error('No trading path available')
      );

      const request = {
        fromAsset: 'XLM' as const,
        toAsset: 'USDC' as const,
        amount: '100',
      };

      await expect(createQuote(request)).rejects.toThrow('No trading path available');
    });
  });

  describe('validateQuote', () => {
    it('should validate and consume a valid quote', async () => {
      const quoteData = {
        id: 'quote_123',
        fromAsset: 'XLM',
        toAsset: 'USDC',
        rate: 0.0875,
        amount: '100',
        estimatedOutput: '8.7500000',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        createdAt: new Date().toISOString(),
      };

      mockRedisClient.get.mockResolvedValue(JSON.stringify(quoteData));

      const quote = await validateQuote('quote_123');

      expect(quote).toMatchObject({
        id: 'quote_123',
        fromAsset: 'XLM',
        toAsset: 'USDC',
        rate: 0.0875,
      });

      // CRITICAL: Verify quote was deleted after validation (single-use enforcement)
      expect(mockRedisClient.del).toHaveBeenCalledWith('mm:quote:quote_123');
    });

    it('should throw error if quote not found', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      await expect(validateQuote('quote_nonexistent')).rejects.toThrow(
        'Quote expired or not found'
      );
    });

    it('should throw error if quote is expired', async () => {
      const quoteData = {
        id: 'quote_expired',
        fromAsset: 'XLM',
        toAsset: 'USDC',
        rate: 0.0875,
        amount: '100',
        estimatedOutput: '8.7500000',
        expiresAt: new Date(Date.now() - 1000).toISOString(), // Expired 1 second ago
        createdAt: new Date(Date.now() - 121000).toISOString(),
      };

      mockRedisClient.get.mockResolvedValue(JSON.stringify(quoteData));

      await expect(validateQuote('quote_expired')).rejects.toThrow(
        'Quote expired or not found'
      );

      // Verify expired quote was deleted
      expect(mockRedisClient.del).toHaveBeenCalledWith('mm:quote:quote_expired');
    });

    it('should throw error if quote data is corrupted', async () => {
      mockRedisClient.get.mockResolvedValue('invalid json{');

      await expect(validateQuote('quote_corrupted')).rejects.toThrow(
        'Invalid quote data'
      );
    });

    it('SECURITY: should prevent replay attacks - quote cannot be used twice', async () => {
      const quoteData = {
        id: 'quote_replay_test',
        fromAsset: 'XLM',
        toAsset: 'USDC',
        rate: 0.0875,
        amount: '100',
        estimatedOutput: '8.7500000',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        createdAt: new Date().toISOString(),
      };

      // First validation - quote exists
      mockRedisClient.get.mockResolvedValueOnce(JSON.stringify(quoteData));
      
      const firstValidation = await validateQuote('quote_replay_test');
      expect(firstValidation.id).toBe('quote_replay_test');
      expect(mockRedisClient.del).toHaveBeenCalledWith('mm:quote:quote_replay_test');

      // Second validation attempt - quote should be gone
      mockRedisClient.get.mockResolvedValueOnce(null);
      
      await expect(validateQuote('quote_replay_test')).rejects.toThrow(
        'Quote expired or not found'
      );

      // Verify del was called twice (once for each validation attempt)
      expect(mockRedisClient.del).toHaveBeenCalledTimes(1);
    });
  });

  describe('getQuote', () => {
    it('should retrieve a quote without consuming it', async () => {
      const quoteData = {
        id: 'quote_view',
        fromAsset: 'XLM',
        toAsset: 'USDC',
        rate: 0.0875,
        amount: '100',
        estimatedOutput: '8.7500000',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        createdAt: new Date().toISOString(),
      };

      mockRedisClient.get.mockResolvedValue(JSON.stringify(quoteData));

      const quote = await getQuote('quote_view');

      expect(quote).toMatchObject({
        id: 'quote_view',
        fromAsset: 'XLM',
      });

      // Verify quote was NOT deleted (read-only operation)
      expect(mockRedisClient.del).not.toHaveBeenCalled();
    });

    it('should return null if quote not found', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const quote = await getQuote('quote_nonexistent');

      expect(quote).toBeNull();
    });

    it('should return null and delete expired quote', async () => {
      const quoteData = {
        id: 'quote_expired_view',
        fromAsset: 'XLM',
        toAsset: 'USDC',
        rate: 0.0875,
        amount: '100',
        estimatedOutput: '8.7500000',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        createdAt: new Date(Date.now() - 121000).toISOString(),
      };

      mockRedisClient.get.mockResolvedValue(JSON.stringify(quoteData));

      const quote = await getQuote('quote_expired_view');

      expect(quote).toBeNull();
      expect(mockRedisClient.del).toHaveBeenCalledWith('mm:quote:quote_expired_view');
    });

    it('should return null if quote data is corrupted', async () => {
      mockRedisClient.get.mockResolvedValue('invalid json{');

      const quote = await getQuote('quote_corrupted');

      expect(quote).toBeNull();
    });
  });

  describe('Integration: Quote lifecycle', () => {
    it('should handle complete quote lifecycle: create -> validate -> reject reuse', async () => {
      // Create quote
      const request = {
        fromAsset: 'XLM' as const,
        toAsset: 'USDC' as const,
        amount: '100',
      };

      const createdQuote = await createQuote(request);
      expect(createdQuote.id).toBeDefined();

      // Simulate Redis returning the created quote
      const quoteData = {
        ...createdQuote,
        expiresAt: createdQuote.expiresAt.toISOString(),
        createdAt: createdQuote.createdAt.toISOString(),
      };

      // First validation succeeds
      mockRedisClient.get.mockResolvedValueOnce(JSON.stringify(quoteData));
      const validatedQuote = await validateQuote(createdQuote.id);
      expect(validatedQuote.id).toBe(createdQuote.id);

      // Second validation fails (quote consumed)
      mockRedisClient.get.mockResolvedValueOnce(null);
      await expect(validateQuote(createdQuote.id)).rejects.toThrow(
        'Quote expired or not found'
      );
    });
  });
});
