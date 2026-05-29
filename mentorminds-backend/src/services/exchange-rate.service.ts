import { getRedisClient, acquireDistributedLock, releaseDistributedLock } from './redis.service';

declare const process: {
  env: Record<string, string | undefined>;
};

const HORIZON_URL = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const REFRESH_INTERVAL_MS = 60_000; // 60 seconds
const LOCK_TTL_SECONDS = 55; // Slightly less than refresh interval for failover
const LOCK_KEY = 'mm:exchange:refresh:lock';
const CACHE_PREFIX = 'mm:exchange:rate:';

export interface ExchangeRate {
  baseAsset: string;
  counterAsset: string;
  rate: number;
  lastUpdated: Date;
}

// Asset pairs to monitor (6 pairs in both directions)
const ASSET_PAIRS = [
  { base: 'native', counter: 'USDC' },
  { base: 'USDC', counter: 'native' },
  { base: 'native', counter: 'PYUSD' },
  { base: 'PYUSD', counter: 'native' },
  { base: 'USDC', counter: 'PYUSD' },
  { base: 'PYUSD', counter: 'USDC' },
];

async function fetchOrderbook(baseAsset: string, counterAsset: string): Promise<number | null> {
  try {
    let baseParam = 'native';
    let baseIssuer = undefined;
    
    if (baseAsset !== 'native') {
      baseParam = baseAsset;
      // In production, you'd need the actual issuer address for non-native assets
      baseIssuer = process.env[`${baseAsset}_ISSUER`];
    }

    let counterParam = 'native';
    let counterIssuer = undefined;
    
    if (counterAsset !== 'native') {
      counterParam = counterAsset;
      counterIssuer = process.env[`${counterAsset}_ISSUER`];
    }

    let url = `${HORIZON_URL}/order_book?selling_asset_type=${baseParam}`;
    if (baseIssuer) {
      url += `&selling_asset_issuer=${baseIssuer}`;
    }
    if (baseAsset !== 'native') {
      url += `&selling_asset_code=${baseAsset}`;
    }

    url += `&buying_asset_type=${counterParam}`;
    if (counterIssuer) {
      url += `&buying_asset_issuer=${counterIssuer}`;
    }
    if (counterAsset !== 'native') {
      url += `&buying_asset_code=${counterAsset}`;
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Horizon API error: ${response.status}`);
    }

    const data = await response.json();
    
    // Calculate mid-price from bids and asks
    const bids = data.bids || [];
    const asks = data.asks || [];

    if (bids.length > 0 && asks.length > 0) {
      const bestBid = parseFloat(bids[0].price_r.n.toString()) / parseFloat(bids[0].price_r.d.toString());
      const bestAsk = parseFloat(asks[0].price_r.n.toString()) / parseFloat(asks[0].price_r.d.toString());
      return (bestBid + bestAsk) / 2; // Mid-price
    } else if (asks.length > 0) {
      return parseFloat(asks[0].price_r.n.toString()) / parseFloat(asks[0].price_r.d.toString());
    } else if (bids.length > 0) {
      return parseFloat(bids[0].price_r.n.toString()) / parseFloat(bids[0].price_r.d.toString());
    }

    return null;
  } catch (error) {
    console.error(`Failed to fetch orderbook for ${baseAsset}/${counterAsset}:`, error);
    return null;
  }
}

async function cacheExchangeRate(pair: string, rate: number): Promise<void> {
  const client = getRedisClient();
  const cacheKey = `${CACHE_PREFIX}${pair}`;
  const cacheData = JSON.stringify({
    rate,
    lastUpdated: new Date().toISOString(),
  });
  
  // Cache for 120 seconds (2 minutes) - longer than refresh interval
  await client.setex(cacheKey, 120, cacheData);
}

async function getCachedExchangeRate(pair: string): Promise<ExchangeRate | null> {
  const client = getRedisClient();
  const cacheKey = `${CACHE_PREFIX}${pair}`;
  
  const cacheData = await client.get(cacheKey);
  if (!cacheData) return null;

  try {
    const parsed = JSON.parse(cacheData);
    return {
      baseAsset: pair.split('/')[0],
      counterAsset: pair.split('/')[1],
      rate: parsed.rate,
      lastUpdated: new Date(parsed.lastUpdated),
    };
  } catch {
    return null;
  }
}

async function refreshAllRates(): Promise<void> {
  console.log('Refreshing exchange rates from Stellar DEX...');
  
  const refreshPromises = ASSET_PAIRS.map(async (pair) => {
    const rate = await fetchOrderbook(pair.base, pair.counter);
    
    if (rate !== null) {
      const pairKey = `${pair.base}/${pair.counter}`;
      await cacheExchangeRate(pairKey, rate);
      console.log(`Updated rate for ${pairKey}: ${rate}`);
    }
  });

  await Promise.allSettled(refreshPromises);
  console.log('Exchange rate refresh completed');
}

export async function getExchangeRate(baseAsset: string, counterAsset: string): Promise<ExchangeRate | null> {
  const pairKey = `${baseAsset}/${counterAsset}`;
  return await getCachedExchangeRate(pairKey);
}

export async function startRateRefresh(): Promise<void> {
  console.log('Starting exchange rate refresh service with distributed lock...');

  setInterval(async () => {
    try {
      // Try to acquire distributed lock
      const lockAcquired = await acquireDistributedLock(LOCK_KEY, LOCK_TTL_SECONDS);
      
      if (!lockAcquired) {
        // Another instance is handling the refresh
        console.log('Another instance is refreshing rates, skipping...');
        return;
      }

      // This instance has the lock - perform the refresh
      await refreshAllRates();
    } catch (error) {
      console.error('Error during rate refresh:', error);
    } finally {
      // Release the lock
      await releaseDistributedLock(LOCK_KEY);
    }
  }, REFRESH_INTERVAL_MS);

  // Run initial refresh immediately
  try {
    const lockAcquired = await acquireDistributedLock(LOCK_KEY, LOCK_TTL_SECONDS);
    
    if (lockAcquired) {
      await refreshAllRates();
      await releaseDistributedLock(LOCK_KEY);
    }
  } catch (error) {
    console.error('Error during initial rate refresh:', error);
  }
}
/**
 * Exchange Rate Service
 * Fetches and caches exchange rates from the Stellar DEX via Horizon API.
 * Provides methods to query rates for asset pairs with automatic caching
 * and TTL-based invalidation.
 */

import { AssetCode } from '../types/asset.types';

/**
 * Represents a cached exchange rate entry with timestamp and TTL.
 * Used internally to track cache validity.
 *
 * @property rate - The exchange rate as a decimal number
 * @property timestamp - Unix timestamp (milliseconds) when the rate was fetched
 * @property ttl - Time-to-live in milliseconds (60 seconds = 60000ms)
 */
interface CacheEntry {
  rate: number;
  availableLiquidity?: number;
  timestamp: number;
  ttl: number;
}

/**
 * Represents the status of the exchange rate cache.
 * Used for monitoring and debugging cache state.
 *
 * @property entries - Total number of cached entries
 * @property rates - Array of cached rate information with expiration times
 */
interface CacheStatus {
  entries: number;
  rates: Array<{
    pair: string;
    rate: number;
    expiresIn: number; // seconds remaining
  }>;
}

/**
 * Asset issuer addresses on the Stellar network.
 * Used to construct order book queries for non-native assets.
 * Automatically uses correct issuers based on STELLAR_NETWORK env var.
 */
import { getAssetIssuer } from '../config/asset.config';

const ASSET_ISSUERS: Record<Exclude<AssetCode, 'XLM'>, string> = {
  USDC: getAssetIssuer('USDC') as string,
  PYUSD: getAssetIssuer('PYUSD') as string,
};

/**
 * ExchangeRateService class
 * Manages fetching and caching of exchange rates from the Stellar DEX.
 * Implements 60-second TTL caching to reduce API calls.
 */
class ExchangeRateService {
  private cache: Map<string, CacheEntry> = new Map();
  private horizonUrl: string;

  /**
   * Initialize the ExchangeRateService with a Horizon API endpoint.
   * @param horizonUrl - The Horizon API base URL (default: Stellar public network)
   */
  constructor(horizonUrl: string = 'https://horizon.stellar.org') {
    this.horizonUrl = horizonUrl;
  }

  /**
   * Generate a cache key for an asset pair.
   * @param fromAsset - The source asset code
   * @param toAsset - The destination asset code
   * @returns A string key in format "FROM/TO"
   */
  private getCacheKey(fromAsset: AssetCode, toAsset: AssetCode): string {
    return `${fromAsset}/${toAsset}`;
  }

  /**
   * Check if a cache entry is still valid (within TTL).
   * @param entry - The cache entry to validate
   * @returns true if the entry is within its TTL, false if expired
   */
  private isCacheValid(entry: CacheEntry): boolean {
    const now = Date.now();
    const age = now - entry.timestamp;
    return age < entry.ttl;
  }

  /**
   * Query the Stellar Horizon API for an order book and calculate a
   * volume-weighted average price (VWAP) for the given send amount.
   * Fetches up to 10 levels of depth to account for order book liquidity.
   *
   * @param fromAsset - The source asset code
   * @param toAsset - The destination asset code
   * @param sendAmount - The amount being sent (used for VWAP calculation)
   * @returns Object with VWAP rate and total available liquidity
   * @throws Error if the API request fails or no trading path exists
   */
  private async _fetchRateFromDex(
    fromAsset: AssetCode,
    toAsset: AssetCode,
    sendAmount: number
  ): Promise<{ rate: number; availableLiquidity: number }> {
    // Build order book query parameters with depth of 10
    const params = new URLSearchParams();

    if (fromAsset === 'XLM') {
      params.append('selling_asset_type', 'native');
    } else {
      params.append('selling_asset_type', 'credit_alphanum12');
      params.append('selling_asset_code', fromAsset);
      params.append('selling_asset_issuer', ASSET_ISSUERS[fromAsset as Exclude<AssetCode, 'XLM'>]);
    }

    if (toAsset === 'XLM') {
      params.append('buying_asset_type', 'native');
    } else {
      params.append('buying_asset_type', 'credit_alphanum12');
      params.append('buying_asset_code', toAsset);
      params.append('buying_asset_issuer', ASSET_ISSUERS[toAsset as Exclude<AssetCode, 'XLM'>]);
    }

    params.append('limit', '10');

    const url = `${this.horizonUrl}/order_book?${params.toString()}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Horizon API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const asks: Array<{ price: string; amount: string }> = data.asks ?? [];

    if (asks.length === 0) {
      throw new Error(`No trading path available for ${fromAsset}/${toAsset}`);
    }

    // Calculate VWAP: walk the order book filling `sendAmount` units
    let remainingAmount = sendAmount;
    let weightedPriceSum = 0;
    let availableLiquidity = 0;

    for (const ask of asks) {
      const askPrice = parseFloat(ask.price);
      const askAmount = parseFloat(ask.amount);

      if (isNaN(askPrice) || askPrice <= 0 || isNaN(askAmount)) continue;

      availableLiquidity += askAmount;
      const filled = Math.min(remainingAmount, askAmount);
      weightedPriceSum += filled * askPrice;
      remainingAmount -= filled;

      if (remainingAmount <= 0) break;
    }

    if (weightedPriceSum <= 0) {
      throw new Error(`Invalid exchange rate received from order book for ${fromAsset}/${toAsset}`);
    }

    // If order book depth was insufficient, VWAP covers only what was available
    const filledAmount = sendAmount - Math.max(remainingAmount, 0);
    const rate = weightedPriceSum / filledAmount;

    return { rate, availableLiquidity };
  }

  /**
   * Query the Stellar Horizon API for an order book to determine exchange rate.
   * Uses VWAP over 10 levels of order book depth for the given send amount.
   *
   * @param fromAsset - The source asset code
   * @param toAsset - The destination asset code
   * @param sendAmount - The amount being sent (used for VWAP; defaults to 1)
   * @returns Object with VWAP rate and available liquidity
   * @throws Error if the API request fails or no trading path exists
   */
  private async queryHorizonAPI(
    fromAsset: AssetCode,
    toAsset: AssetCode,
    sendAmount: number = 1
  ): Promise<{ rate: number; availableLiquidity: number }> {
    try {
      return await this._fetchRateFromDex(fromAsset, toAsset, sendAmount);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to fetch exchange rate: ${String(error)}`);
    }
  }

  /**
   * Fetch the exchange rate for an asset pair with caching.
   * Returns cached rate if available and valid, otherwise queries Horizon API.
   * Uses VWAP over order book depth for the given send amount.
   *
   * @param fromAsset - The source asset code
   * @param toAsset - The destination asset code
   * @param sendAmount - The amount being sent (used for VWAP calculation; defaults to 1)
   * @returns Object with rate and availableLiquidity
   * @throws Error if the API request fails or no trading path exists
   */
  async fetchExchangeRate(
    fromAsset: AssetCode,
    toAsset: AssetCode,
    sendAmount: number = 1
  ): Promise<{ rate: number; availableLiquidity: number }> {
    // Same asset always has rate of 1
    if (fromAsset === toAsset) {
      return { rate: 1, availableLiquidity: Infinity };
    }

    const cacheKey = this.getCacheKey(fromAsset, toAsset);
    const cached = this.cache.get(cacheKey);

    // Return cached rate if valid (cache stores the top-of-book rate for warm-up)
    if (cached && this.isCacheValid(cached)) {
      return { rate: cached.rate, availableLiquidity: cached.availableLiquidity ?? 0 };
    }

    // Fetch fresh rate from API using VWAP for the given send amount
    const { rate, availableLiquidity } = await this.queryHorizonAPI(fromAsset, toAsset, sendAmount);

    // Store in cache with 60-second TTL
    this.cache.set(cacheKey, {
      rate,
      availableLiquidity,
      timestamp: Date.now(),
      ttl: 60000, // 60 seconds
    });

    return { rate, availableLiquidity };
  }

  /**
   * Invalidate the cache entry for a specific asset pair.
   * Forces the next fetch to query the API.
   *
   * @param fromAsset - The source asset code
   * @param toAsset - The destination asset code
   */
  invalidateCache(fromAsset: AssetCode, toAsset: AssetCode): void {
    const cacheKey = this.getCacheKey(fromAsset, toAsset);
    this.cache.delete(cacheKey);
  }

  /**
   * Get the current status of the exchange rate cache.
   * Useful for monitoring and debugging cache state.
   *
   * @returns CacheStatus object with entry count and rate information
   */
  getCacheStatus(): CacheStatus {
    const rates: CacheStatus['rates'] = [];
    const now = Date.now();

    for (const [pair, entry] of this.cache.entries()) {
      const expiresIn = Math.max(
        0,
        Math.ceil((entry.ttl - (now - entry.timestamp)) / 1000)
      );
      rates.push({
        pair,
        rate: entry.rate,
        expiresIn,
      });
    }

    return {
      entries: this.cache.size,
      rates,
    };
  }

  /**
   * Fetch multiple exchange rates in parallel.
   * More efficient than calling fetchExchangeRate multiple times.
   *
   * @param pairs - Array of [fromAsset, toAsset] tuples to fetch
   * @param sendAmount - The amount being sent (used for VWAP; defaults to 1)
   * @returns Map with cache keys as keys and rate objects as values
   * @throws Error if any API request fails
   */
  async fetchMultipleRates(
    pairs: Array<[AssetCode, AssetCode]>,
    sendAmount: number = 1
  ): Promise<Map<string, { rate: number; availableLiquidity: number }>> {
    const promises = pairs.map(([from, to]) =>
      this.fetchExchangeRate(from, to, sendAmount).then((result) => ({
        key: this.getCacheKey(from, to),
        result,
      }))
    );

    const results = await Promise.all(promises);
    const ratesMap = new Map<string, { rate: number; availableLiquidity: number }>();

    for (const { key, result } of results) {
      ratesMap.set(key, result);
    }

    return ratesMap;
  }
}

/**
 * Singleton instance of ExchangeRateService for use across the application.
 * Ensures consistent caching and API usage throughout the app.
 */
const exchangeRateService = new ExchangeRateService();

export { ExchangeRateService, exchangeRateService, CacheEntry, CacheStatus };
