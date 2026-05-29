/**
 * Quote Service
 * Manages exchange rate quotes with expiry and single-use enforcement.
 * Prevents replay attacks by deleting quotes after validation.
 */

import { getRedisClient } from './redis.service';
import { AssetCode } from '../types/asset.types';
import { exchangeRateService } from './exchange-rate.service';

const QUOTE_TTL_SECONDS = 120; // 2 minutes
const QUOTE_KEY_PREFIX = 'mm:quote:';

export interface Quote {
  id: string;
  fromAsset: AssetCode;
  toAsset: AssetCode;
  rate: number;
  amount: string;
  estimatedOutput: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreateQuoteRequest {
  fromAsset: AssetCode;
  toAsset: AssetCode;
  amount: string;
}

/**
 * Generate a unique quote ID
 */
function generateQuoteId(): string {
  return `quote_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Generate Redis key for a quote
 */
function quoteKey(quoteId: string): string {
  return `${QUOTE_KEY_PREFIX}${quoteId}`;
}

/**
 * Create a new exchange rate quote
 * @param request - Quote creation parameters
 * @returns The created quote with expiry information
 * @throws Error if exchange rate cannot be fetched
 */
export async function createQuote(request: CreateQuoteRequest): Promise<Quote> {
  const { fromAsset, toAsset, amount } = request;

  // Fetch current exchange rate
  const rate = await exchangeRateService.fetchExchangeRate(fromAsset, toAsset);

  // Calculate estimated output
  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    throw new Error('Invalid amount');
  }
  const estimatedOutput = (amountNum * rate).toFixed(7);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_SECONDS * 1000);

  const quote: Quote = {
    id: generateQuoteId(),
    fromAsset,
    toAsset,
    rate,
    amount,
    estimatedOutput,
    expiresAt,
    createdAt: now,
  };

  // Store in Redis with TTL
  const client = getRedisClient();
  await client.setex(
    quoteKey(quote.id),
    QUOTE_TTL_SECONDS,
    JSON.stringify(quote)
  );

  return quote;
}

/**
 * Validate and consume a quote (single-use enforcement)
 * @param quoteId - The quote ID to validate
 * @returns The validated quote
 * @throws Error if quote is expired, not found, or invalid
 */
export async function validateQuote(quoteId: string): Promise<Quote> {
  const client = getRedisClient();
  const key = quoteKey(quoteId);

  // Fetch quote from Redis
  const quoteData = await client.get(key);
  
  if (!quoteData) {
    throw new Error('Quote expired or not found');
  }

  let quote: Quote;
  try {
    quote = JSON.parse(quoteData);
    // Ensure dates are properly deserialized
    quote.expiresAt = new Date(quote.expiresAt);
    quote.createdAt = new Date(quote.createdAt);
  } catch (error) {
    throw new Error('Invalid quote data');
  }

  // Check expiry
  if (new Date() > new Date(quote.expiresAt)) {
    // Delete expired quote
    await client.del(key);
    throw new Error('Quote expired or not found');
  }

  // CRITICAL: Delete the quote immediately after validation to prevent replay attacks
  // This makes quotes single-use only
  await client.del(key);

  return quote;
}

/**
 * Get a quote without consuming it (for display purposes only)
 * @param quoteId - The quote ID to retrieve
 * @returns The quote if found and valid, null otherwise
 */
export async function getQuote(quoteId: string): Promise<Quote | null> {
  const client = getRedisClient();
  const key = quoteKey(quoteId);

  const quoteData = await client.get(key);
  
  if (!quoteData) {
    return null;
  }

  try {
    const quote: Quote = JSON.parse(quoteData);
    quote.expiresAt = new Date(quote.expiresAt);
    quote.createdAt = new Date(quote.createdAt);

    // Check if expired
    if (new Date() > new Date(quote.expiresAt)) {
      await client.del(key);
      return null;
    }

    return quote;
  } catch (error) {
    return null;
  }
}

export const quoteService = {
  createQuote,
  validateQuote,
  getQuote,
};
