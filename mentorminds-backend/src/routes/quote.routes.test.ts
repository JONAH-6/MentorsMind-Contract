/**
 * Quote Routes Integration Tests
 * Tests the API endpoints for quote creation and validation
 */

import request from 'supertest';
import express, { Express } from 'express';
import quoteRoutes from './quote.routes';
import { quoteService } from '../services/quote.service';

// Mock the quote service
jest.mock('../services/quote.service');

describe('Quote Routes', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup Express app with quote routes
    app = express();
    app.use(express.json());
    app.use('/api/v1/quotes', quoteRoutes);
  });

  describe('POST /api/v1/quotes', () => {
    it('should create a new quote successfully', async () => {
      const mockQuote = {
        id: 'quote_123',
        fromAsset: 'XLM',
        toAsset: 'USDC',
        rate: 0.0875,
        amount: '100',
        estimatedOutput: '8.7500000',
        expiresAt: new Date('2024-01-01T12:02:00.000Z'),
        createdAt: new Date('2024-01-01T12:00:00.000Z'),
      };

      (quoteService.createQuote as jest.Mock).mockResolvedValue(mockQuote);

      const response = await request(app)
        .post('/api/v1/quotes')
        .send({
          fromAsset: 'XLM',
          toAsset: 'USDC',
          amount: '100',
        })
        .expect(201);

      expect(response.body).toMatchObject({
        id: 'quote_123',
        fromAsset: 'XLM',
        toAsset: 'USDC',
        rate: 0.0875,
        amount: '100',
      });

      expect(quoteService.createQuote).toHaveBeenCalledWith({
        fromAsset: 'XLM',
        toAsset: 'USDC',
        amount: '100',
      });
    });

    it('should return 400 for missing required fields', async () => {
      const response = await request(app)
        .post('/api/v1/quotes')
        .send({
          fromAsset: 'XLM',
          // Missing toAsset and amount
        })
        .expect(400);

      expect(response.body.error).toContain('Missing required fields');
    });

    it('should return 400 for invalid asset codes', async () => {
      const response = await request(app)
        .post('/api/v1/quotes')
        .send({
          fromAsset: 'INVALID',
          toAsset: 'USDC',
          amount: '100',
        })
        .expect(400);

      expect(response.body.error).toContain('Invalid asset code');
    });

    it('should return 500 for service errors', async () => {
      (quoteService.createQuote as jest.Mock).mockRejectedValue(
        new Error('Exchange rate unavailable')
      );

      const response = await request(app)
        .post('/api/v1/quotes')
        .send({
          fromAsset: 'XLM',
          toAsset: 'USDC',
          amount: '100',
        })
        .expect(500);

      expect(response.body.error).toBe('Exchange rate unavailable');
    });
  });

  describe('GET /api/v1/quotes/:quoteId', () => {
    it('should retrieve an existing quote', async () => {
      const mockQuote = {
        id: 'quote_456',
        fromAsset: 'USDC',
        toAsset: 'XLM',
        rate: 11.4286,
        amount: '50',
        estimatedOutput: '571.4300000',
        expiresAt: new Date('2024-01-01T12:02:00.000Z'),
        createdAt: new Date('2024-01-01T12:00:00.000Z'),
      };

      (quoteService.getQuote as jest.Mock).mockResolvedValue(mockQuote);

      const response = await request(app)
        .get('/api/v1/quotes/quote_456')
        .expect(200);

      expect(response.body).toMatchObject({
        id: 'quote_456',
        fromAsset: 'USDC',
        toAsset: 'XLM',
      });

      expect(quoteService.getQuote).toHaveBeenCalledWith('quote_456');
    });

    it('should return 404 for non-existent quote', async () => {
      (quoteService.getQuote as jest.Mock).mockResolvedValue(null);

      const response = await request(app)
        .get('/api/v1/quotes/quote_nonexistent')
        .expect(404);

      expect(response.body.error).toContain('not found or expired');
    });

    it('should return 500 for service errors', async () => {
      (quoteService.getQuote as jest.Mock).mockRejectedValue(
        new Error('Redis connection failed')
      );

      await request(app)
        .get('/api/v1/quotes/quote_error')
        .expect(500);
    });
  });

  describe('POST /api/v1/quotes/:quoteId/validate', () => {
    it('should validate and consume a quote successfully', async () => {
      const mockQuote = {
        id: 'quote_789',
        fromAsset: 'XLM',
        toAsset: 'PYUSD',
        rate: 0.0880,
        amount: '200',
        estimatedOutput: '17.6000000',
        expiresAt: new Date('2024-01-01T12:02:00.000Z'),
        createdAt: new Date('2024-01-01T12:00:00.000Z'),
      };

      (quoteService.validateQuote as jest.Mock).mockResolvedValue(mockQuote);

      const response = await request(app)
        .post('/api/v1/quotes/quote_789/validate')
        .expect(200);

      expect(response.body).toEqual({
        valid: true,
        quote: expect.objectContaining({
          id: 'quote_789',
          fromAsset: 'XLM',
          toAsset: 'PYUSD',
        }),
      });

      expect(quoteService.validateQuote).toHaveBeenCalledWith('quote_789');
    });

    it('should return 404 for expired quote', async () => {
      (quoteService.validateQuote as jest.Mock).mockRejectedValue(
        new Error('Quote expired or not found')
      );

      const response = await request(app)
        .post('/api/v1/quotes/quote_expired/validate')
        .expect(404);

      expect(response.body).toEqual({
        valid: false,
        error: 'Quote expired or not found',
      });
    });

    it('should return 400 for invalid quote data', async () => {
      (quoteService.validateQuote as jest.Mock).mockRejectedValue(
        new Error('Invalid quote data')
      );

      const response = await request(app)
        .post('/api/v1/quotes/quote_invalid/validate')
        .expect(400);

      expect(response.body).toEqual({
        valid: false,
        error: 'Invalid quote data',
      });
    });

    it('SECURITY: should prevent replay attacks - second validation fails', async () => {
      const mockQuote = {
        id: 'quote_replay',
        fromAsset: 'XLM',
        toAsset: 'USDC',
        rate: 0.0875,
        amount: '100',
        estimatedOutput: '8.7500000',
        expiresAt: new Date('2024-01-01T12:02:00.000Z'),
        createdAt: new Date('2024-01-01T12:00:00.000Z'),
      };

      // First validation succeeds
      (quoteService.validateQuote as jest.Mock).mockResolvedValueOnce(mockQuote);

      const firstResponse = await request(app)
        .post('/api/v1/quotes/quote_replay/validate')
        .expect(200);

      expect(firstResponse.body.valid).toBe(true);

      // Second validation fails (quote consumed)
      (quoteService.validateQuote as jest.Mock).mockRejectedValueOnce(
        new Error('Quote expired or not found')
      );

      const secondResponse = await request(app)
        .post('/api/v1/quotes/quote_replay/validate')
        .expect(404);

      expect(secondResponse.body.valid).toBe(false);
      expect(secondResponse.body.error).toContain('expired or not found');

      // Verify validateQuote was called twice
      expect(quoteService.validateQuote).toHaveBeenCalledTimes(2);
    });
  });
});
