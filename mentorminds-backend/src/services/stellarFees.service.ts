import { Server } from "stellar-sdk";
import { horizonConfig } from "../config/horizon.config";
import { cacheService } from "./cache.service";

const CACHE_KEY = "stellar:fee_estimate";
const CACHE_TTL_MS = 30_000; // 30s fee freshness vs Horizon load
const FALLBACK_BASE_FEE = 100;

export class StellarFeesService {
  private server: Server;

  constructor(rpcUrl: string = horizonConfig.primary) {
    this.server = new Server(rpcUrl);
  }

  /**
   * Fetches the recommended fee estimate from Horizon.
   * @param operationCount Number of operations in the transaction.
   * @returns An object containing the recommended_fee as a string.
   */
  async getFeeEstimate(
    operationCount: number = 1,
  ): Promise<{ recommended_fee: string }> {
    const safeOperationCount = Math.max(operationCount, 1);

    const cachedBaseFee = cacheService.get<number>(CACHE_KEY);

    if (cachedBaseFee !== null) {
      return {
        recommended_fee: (cachedBaseFee * safeOperationCount).toString(),
      };
    }

    try {
      const feeStats = await this.server.feeStats();

      const parsedFee = parseInt(feeStats.fee_charged.mode, 10);

      const baseFee =
        Number.isFinite(parsedFee) && parsedFee > 0
          ? parsedFee
          : FALLBACK_BASE_FEE;

      if (baseFee === FALLBACK_BASE_FEE) {
        console.warn(
          "[StellarFeesService] Invalid fee mode received, using fallback base fee",
        );
      }

      cacheService.set(CACHE_KEY, baseFee, CACHE_TTL_MS);

      return {
        recommended_fee: (baseFee * safeOperationCount).toString(),
      };
    } catch (error) {
      console.warn(
        "[StellarFeesService] Failed to fetch fee stats from Horizon, using fallback:",
        error,
      );

      return {
          recommended_fee: (
          FALLBACK_BASE_FEE * safeOperationCount
        ).toString(),
      };
    }
  }
}

export const stellarFeesService = new StellarFeesService();

// .
