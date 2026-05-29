/**
 * Escrow Sync API Routes
 * Endpoints for monitoring and managing escrow sync operations
 */

import { Router, Request, Response } from 'express';
import { escrowSyncStateService } from '../services/escrow-sync-state.service';

const router = Router();

/**
 * GET /api/v1/escrow-sync/status
 * Get current sync status and metrics
 * 
 * Response:
 * {
 *   "state": {
 *     "lastSyncedBookingId": "booking_123",
 *     "lastSyncTimestamp": 1234567890,
 *     "totalBookingsProcessed": 1500,
 *     "currentBatchNumber": 30
 *   },
 *   "metrics": {
 *     "totalSyncCycles": 100,
 *     "totalBookingsProcessed": 1500,
 *     "totalRpcCalls": 1500,
 *     "lastSyncDuration": 2500,
 *     "averageSyncDuration": 2300,
 *     "failedSyncs": 2,
 *     "lastError": null,
 *     "lastErrorTimestamp": null
 *   },
 *   "isLocked": false
 * }
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const summary = await escrowSyncStateService.getSyncSummary();
    res.json(summary);
  } catch (error) {
    console.error('[EscrowSyncAPI] Error fetching status:', error);
    res.status(500).json({
      error: 'Failed to fetch sync status',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/v1/escrow-sync/metrics
 * Get detailed sync metrics
 * 
 * Response:
 * {
 *   "totalSyncCycles": 100,
 *   "totalBookingsProcessed": 1500,
 *   "totalRpcCalls": 1500,
 *   "lastSyncDuration": 2500,
 *   "averageSyncDuration": 2300,
 *   "failedSyncs": 2,
 *   "lastError": null,
 *   "lastErrorTimestamp": null,
 *   "rpcCallsPerMinute": 50,
 *   "bookingsPerMinute": 50
 * }
 */
router.get('/metrics', async (req: Request, res: Response) => {
  try {
    const metrics = await escrowSyncStateService.getSyncMetrics();
    
    // Calculate rates
    const rpcCallsPerMinute = metrics.totalSyncCycles > 0
      ? Math.round((metrics.totalRpcCalls / metrics.totalSyncCycles) * 2) // 2 cycles per minute (30s interval)
      : 0;
    
    const bookingsPerMinute = metrics.totalSyncCycles > 0
      ? Math.round((metrics.totalBookingsProcessed / metrics.totalSyncCycles) * 2)
      : 0;

    res.json({
      ...metrics,
      rpcCallsPerMinute,
      bookingsPerMinute,
    });
  } catch (error) {
    console.error('[EscrowSyncAPI] Error fetching metrics:', error);
    res.status(500).json({
      error: 'Failed to fetch sync metrics',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /api/v1/escrow-sync/reset-cursor
 * Reset the sync cursor to start from the beginning
 * 
 * Response:
 * {
 *   "success": true,
 *   "message": "Sync cursor reset successfully"
 * }
 */
router.post('/reset-cursor', async (req: Request, res: Response) => {
  try {
    await escrowSyncStateService.resetSyncCursor();
    
    console.log('[EscrowSyncAPI] Sync cursor reset by API request');
    
    res.json({
      success: true,
      message: 'Sync cursor reset successfully. Next sync will start from the beginning.',
    });
  } catch (error) {
    console.error('[EscrowSyncAPI] Error resetting cursor:', error);
    res.status(500).json({
      error: 'Failed to reset sync cursor',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/v1/escrow-sync/health
 * Health check for sync operations
 * 
 * Response:
 * {
 *   "healthy": true,
 *   "status": "ok",
 *   "details": {
 *     "lastSyncAge": 25000,
 *     "isLocked": false,
 *     "recentErrors": 0
 *   }
 * }
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    const summary = await escrowSyncStateService.getSyncSummary();
    
    const now = Date.now();
    const lastSyncAge = now - summary.state.lastSyncTimestamp;
    const recentErrors = summary.metrics.lastErrorTimestamp && 
      (now - summary.metrics.lastErrorTimestamp < 300000) // Errors in last 5 minutes
      ? summary.metrics.failedSyncs
      : 0;

    // Consider unhealthy if:
    // - Last sync was more than 2 minutes ago
    // - There are recent errors
    // - Sync is locked for more than 2 minutes
    const isHealthy = 
      lastSyncAge < 120000 && 
      recentErrors === 0 &&
      (!summary.isLocked || lastSyncAge < 120000);

    const status = isHealthy ? 'ok' : 'degraded';

    res.status(isHealthy ? 200 : 503).json({
      healthy: isHealthy,
      status,
      details: {
        lastSyncAge,
        isLocked: summary.isLocked,
        recentErrors,
        lastError: summary.metrics.lastError,
      },
    });
  } catch (error) {
    console.error('[EscrowSyncAPI] Error checking health:', error);
    res.status(503).json({
      healthy: false,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
