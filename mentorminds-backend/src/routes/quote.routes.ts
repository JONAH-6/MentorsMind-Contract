/**
 * Quote API Routes
 * Endpoints for creating and validating exchange rate quotes
 */

import { Router, Request, Response } from 'express';
import { quoteService } from '../services/quote.service';
import { AssetCode } from '../types/asset.types';

const router = Router();

/**
 * POST /api/v1/quotes
 * Create a new exchange rate quote
 * 
 * Request body:
 * {
 *   "fromAsset": "XLM",
 *   "toAsset": "USDC",
 *   "amount": "100"
 * }
 * 
 * Response:
 * {
 *   "id": "quote_1234567890_abc123",
 *   "fromAsset": "XLM",
 *   "toAsset": "USDC",
 *   "rate": 0.0875,
 *   "amount": "100",
 *   "estimatedOutput": "8.7500000",
 *   "expiresAt": "2024-01-01T12:02:00.000Z",
 *   "createdAt": "2024-01-01T12:00:00.000Z"
 * }
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { fromAsset, toAsset, amount } = req.body;

    // Validate required fields
    if (!fromAsset || !toAsset || !amount) {
      return res.status(400).json({
        error: 'Missing required fields: fromAsset, toAsset, amount',
      });
    }

    // Validate asset codes
    const validAssets: AssetCode[] = ['XLM', 'USDC', 'PYUSD'];
    if (!validAssets.includes(fromAsset) || !validAssets.includes(toAsset)) {
      return res.status(400).json({
        error: 'Invalid asset code. Supported assets: XLM, USDC, PYUSD',
      });
    }

    const quote = await quoteService.createQuote({
      fromAsset,
      toAsset,
      amount,
    });

    res.status(201).json(quote);
  } catch (error) {
    console.error('Error creating quote:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to create quote',
    });
  }
});

/**
 * GET /api/v1/quotes/:quoteId
 * Retrieve a quote without consuming it (for display purposes)
 * 
 * Response:
 * {
 *   "id": "quote_1234567890_abc123",
 *   "fromAsset": "XLM",
 *   "toAsset": "USDC",
 *   "rate": 0.0875,
 *   "amount": "100",
 *   "estimatedOutput": "8.7500000",
 *   "expiresAt": "2024-01-01T12:02:00.000Z",
 *   "createdAt": "2024-01-01T12:00:00.000Z"
 * }
 */
router.get('/:quoteId', async (req: Request, res: Response) => {
  try {
    const { quoteId } = req.params;

    const quote = await quoteService.getQuote(quoteId);

    if (!quote) {
      return res.status(404).json({
        error: 'Quote not found or expired',
      });
    }

    res.json(quote);
  } catch (error) {
    console.error('Error retrieving quote:', error);
    res.status(500).json({
      error: 'Failed to retrieve quote',
    });
  }
});

/**
 * POST /api/v1/quotes/:quoteId/validate
 * Validate and consume a quote (single-use enforcement)
 * This endpoint should be called when initiating a payment with the quote.
 * After successful validation, the quote is deleted and cannot be reused.
 * 
 * Response:
 * {
 *   "valid": true,
 *   "quote": {
 *     "id": "quote_1234567890_abc123",
 *     "fromAsset": "XLM",
 *     "toAsset": "USDC",
 *     "rate": 0.0875,
 *     "amount": "100",
 *     "estimatedOutput": "8.7500000",
 *     "expiresAt": "2024-01-01T12:02:00.000Z",
 *     "createdAt": "2024-01-01T12:00:00.000Z"
 *   }
 * }
 */
router.post('/:quoteId/validate', async (req: Request, res: Response) => {
  try {
    const { quoteId } = req.params;

    const quote = await quoteService.validateQuote(quoteId);

    res.json({
      valid: true,
      quote,
    });
  } catch (error) {
    console.error('Error validating quote:', error);
    
    // Return 404 for expired/not found quotes
    if (error instanceof Error && error.message.includes('expired or not found')) {
      return res.status(404).json({
        valid: false,
        error: 'Quote expired or not found',
      });
    }

    res.status(400).json({
      valid: false,
      error: error instanceof Error ? error.message : 'Failed to validate quote',
    });
  }
});

export default router;
