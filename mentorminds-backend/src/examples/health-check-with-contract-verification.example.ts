/**
 * Example: Health Check Endpoint with Soroban Contract Verification
 * 
 * This example shows how to expose contract verification status in a health endpoint.
 * Addresses issue #253: verify contract address is legitimate.
 */

import { SorobanEscrowServiceImpl } from '../services/sorobanEscrow.service';

interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  services: {
    database: 'up' | 'down';
    soroban_contract: 'verified' | 'unverified' | 'mismatch' | 'not_configured';
  };
  details?: {
    soroban?: {
      contractAddress?: string;
      expectedVersion?: string | null;
      resolvedVersion?: string | null;
      network?: string;
    };
  };
}

/**
 * Health check service that includes Soroban contract verification
 */
export class HealthCheckService {
  constructor(
    private readonly sorobanEscrow: SorobanEscrowServiceImpl,
    private readonly checkDatabase: () => Promise<boolean>
  ) {}

  async getHealth(): Promise<HealthCheckResponse> {
    const timestamp = new Date().toISOString();
    
    // Check database
    let dbStatus: 'up' | 'down';
    try {
      const isDbUp = await this.checkDatabase();
      dbStatus = isDbUp ? 'up' : 'down';
    } catch {
      dbStatus = 'down';
    }

    // Check Soroban contract
    const contractAddress = process.env.SOROBAN_ESCROW_CONTRACT_ADDRESS;
    let contractStatus: 'verified' | 'unverified' | 'mismatch' | 'not_configured';
    
    if (!contractAddress) {
      contractStatus = 'not_configured';
    } else if (!this.sorobanEscrow.isConfigured()) {
      contractStatus = 'mismatch';
    } else {
      contractStatus = this.sorobanEscrow.getContractVerificationStatus();
    }

    // Determine overall health
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy';
    if (dbStatus === 'down' || contractStatus === 'mismatch') {
      overallStatus = 'unhealthy';
    } else if (contractStatus === 'unverified' || contractStatus === 'not_configured') {
      overallStatus = 'degraded';
    } else {
      overallStatus = 'healthy';
    }

    return {
      status: overallStatus,
      timestamp,
      services: {
        database: dbStatus,
        soroban_contract: contractStatus,
      },
      details: {
        soroban: {
          contractAddress,
          expectedVersion: this.sorobanEscrow.getExpectedContractVersion(),
          resolvedVersion: this.sorobanEscrow.getResolvedContractVersion(),
          network: process.env.STELLAR_NETWORK || 'testnet',
        },
      },
    };
  }
}

/**
 * Express route handler example
 */
export function createHealthCheckRoute(healthCheckService: HealthCheckService) {
  return async (req: any, res: any) => {
    try {
      const health = await healthCheckService.getHealth();
      
      const statusCode = health.status === 'healthy' ? 200 : 
                        health.status === 'degraded' ? 200 : 503;
      
      res.status(statusCode).json(health);
    } catch (error) {
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: (error as Error).message,
      });
    }
  };
}

/**
 * Startup verification example
 * 
 * Call this during application startup to verify contract configuration
 * before accepting requests.
 */
export async function verifyContractOnStartup(
  sorobanEscrow: SorobanEscrowServiceImpl
): Promise<void> {
  console.log('[Startup] Verifying Soroban contract configuration...');
  
  try {
    const isVerified = await sorobanEscrow.verifyContractVersion();
    
    if (!isVerified) {
      console.error('[Startup] ⚠️  Contract verification failed!');
      console.error('[Startup] Expected version:', sorobanEscrow.getExpectedContractVersion());
      console.error('[Startup] Resolved version:', sorobanEscrow.getResolvedContractVersion());
      console.error('[Startup] Contract address:', process.env.SOROBAN_ESCROW_CONTRACT_ADDRESS);
      
      // In production, you might want to exit the process here
      // process.exit(1);
    } else {
      console.log('[Startup] ✓ Contract verified successfully');
      console.log('[Startup] Contract address:', process.env.SOROBAN_ESCROW_CONTRACT_ADDRESS);
      console.log('[Startup] Contract version:', sorobanEscrow.getResolvedContractVersion());
    }
  } catch (error) {
    console.error('[Startup] ✗ Contract verification error:', (error as Error).message);
    
    // In production, you might want to exit the process here
    // process.exit(1);
  }
}

/**
 * Example usage in Express app:
 * 
 * import express from 'express';
 * 
 * const app = express();
 * 
 * // Initialize services
 * const sorobanEscrow = new SorobanEscrowServiceImpl();
 * const healthCheckService = new HealthCheckService(
 *   sorobanEscrow,
 *   async () => {
 *     // Check database connection
 *     return true;
 *   }
 * );
 * 
 * // Verify contract on startup
 * await verifyContractOnStartup(sorobanEscrow);
 * 
 * // Register health check endpoint
 * app.get('/health', createHealthCheckRoute(healthCheckService));
 * 
 * app.listen(3000);
 * 
 * 
 * Example responses:
 * 
 * Healthy:
 * {
 *   "status": "healthy",
 *   "timestamp": "2024-01-01T12:00:00.000Z",
 *   "services": {
 *     "database": "up",
 *     "soroban_contract": "verified"
 *   },
 *   "details": {
 *     "soroban": {
 *       "contractAddress": "CAAAA...",
 *       "expectedVersion": "1.0.0",
 *       "resolvedVersion": "1.0.0",
 *       "network": "testnet"
 *     }
 *   }
 * }
 * 
 * Unhealthy (contract mismatch):
 * {
 *   "status": "unhealthy",
 *   "timestamp": "2024-01-01T12:00:00.000Z",
 *   "services": {
 *     "database": "up",
 *     "soroban_contract": "mismatch"
 *   },
 *   "details": {
 *     "soroban": {
 *       "contractAddress": "CAAAA...",
 *       "expectedVersion": "1.0.0",
 *       "resolvedVersion": "0.9.0",
 *       "network": "testnet"
 *     }
 *   }
 * }
 */
