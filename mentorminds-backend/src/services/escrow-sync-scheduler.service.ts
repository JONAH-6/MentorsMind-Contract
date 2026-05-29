/**
 * Escrow Sync Scheduler Service
 * Manages periodic syncing of escrow state with distributed locking
 * and configurable intervals.
 */

import { 
  escrowSyncStateService,
  acquireSyncLock,
  releaseSyncLock 
} from './escrow-sync-state.service';
import type { 
  BookingRepository, 
  EscrowStateResolver 
} from './sorobanEscrow.service';
import type { SorobanEscrowServiceImpl } from './sorobanEscrow.service';

const DEFAULT_SYNC_INTERVAL_MS = 30_000; // 30 seconds
const DEFAULT_BATCH_SIZE = 50; // Process 50 bookings per cycle
const DEFAULT_MIN_SYNC_INTERVAL_MINUTES = 5; // Only sync bookings not synced in last 5 minutes

export interface EscrowSyncSchedulerConfig {
  syncIntervalMs?: number;
  batchSize?: number;
  minSyncIntervalMinutes?: number;
  maxBatchesPerCycle?: number;
  enabled?: boolean;
}

export class EscrowSyncScheduler {
  private intervalHandle: NodeJS.Timeout | null = null;
  private isRunning = false;
  private config: Required<EscrowSyncSchedulerConfig>;

  constructor(
    private readonly escrowService: SorobanEscrowServiceImpl,
    private readonly bookingRepo: BookingRepository,
    private readonly escrowStateResolver: EscrowStateResolver,
    config?: EscrowSyncSchedulerConfig
  ) {
    this.config = {
      syncIntervalMs: config?.syncIntervalMs || DEFAULT_SYNC_INTERVAL_MS,
      batchSize: config?.batchSize || DEFAULT_BATCH_SIZE,
      minSyncIntervalMinutes: config?.minSyncIntervalMinutes || DEFAULT_MIN_SYNC_INTERVAL_MINUTES,
      maxBatchesPerCycle: config?.maxBatchesPerCycle || 1,
      enabled: config?.enabled ?? true,
    };
  }

  /**
   * Start the sync scheduler.
   * Safe to call multiple times - subsequent calls are no-ops if already running.
   */
  async start(): Promise<void> {
    if (this.intervalHandle !== null) {
      console.log('[EscrowSyncScheduler] Already running');
      return;
    }

    if (!this.config.enabled) {
      console.log('[EscrowSyncScheduler] Disabled by configuration');
      return;
    }

    console.log('='.repeat(60));
    console.log('[EscrowSyncScheduler] Starting escrow sync scheduler');
    console.log(`  Interval: ${this.config.syncIntervalMs / 1000}s`);
    console.log(`  Batch size: ${this.config.batchSize}`);
    console.log(`  Min sync interval: ${this.config.minSyncIntervalMinutes} minutes`);
    console.log(`  Max batches per cycle: ${this.config.maxBatchesPerCycle}`);
    console.log('='.repeat(60));

    // Run initial sync immediately
    await this.runSyncCycle();

    // Schedule periodic syncs
    this.intervalHandle = setInterval(
      () => this.runSyncCycle(),
      this.config.syncIntervalMs
    );
  }

  /**
   * Stop the sync scheduler.
   * Safe to call even if not running.
   */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log('[EscrowSyncScheduler] Stopped');
    }
  }

  /**
   * Run a single sync cycle with distributed locking.
   * Only one instance across all servers will execute at a time.
   */
  private async runSyncCycle(): Promise<void> {
    if (this.isRunning) {
      console.log('[EscrowSyncScheduler] Previous sync still running, skipping cycle');
      return;
    }

    // Try to acquire distributed lock
    const lockAcquired = await acquireSyncLock();
    
    if (!lockAcquired) {
      console.log('[EscrowSyncScheduler] Another instance is syncing, skipping cycle');
      return;
    }

    this.isRunning = true;
    const cycleStartTime = Date.now();

    try {
      console.log('[EscrowSyncScheduler] Starting sync cycle');

      const result = await this.escrowService.syncPendingEscrowsOptimized(
        this.bookingRepo,
        this.escrowStateResolver,
        {
          batchSize: this.config.batchSize,
          minSyncIntervalMinutes: this.config.minSyncIntervalMinutes,
          maxBatches: this.config.maxBatchesPerCycle,
        }
      );

      const cycleDuration = Date.now() - cycleStartTime;

      console.log('[EscrowSyncScheduler] Sync cycle completed:', {
        bookingsProcessed: result.bookingsProcessed,
        rpcCalls: result.rpcCalls,
        duration: `${result.duration}ms`,
        hasMore: result.hasMore,
        cycleDuration: `${cycleDuration}ms`,
      });

      // Log warning if sync is taking too long
      if (cycleDuration > this.config.syncIntervalMs * 0.8) {
        console.warn(
          `[EscrowSyncScheduler] Sync cycle took ${cycleDuration}ms, ` +
          `which is ${Math.round((cycleDuration / this.config.syncIntervalMs) * 100)}% ` +
          `of the sync interval (${this.config.syncIntervalMs}ms). ` +
          `Consider increasing the interval or reducing batch size.`
        );
      }

      // Log metrics summary periodically
      const metrics = await escrowSyncStateService.getSyncMetrics();
      if (metrics.totalSyncCycles % 10 === 0) {
        console.log('[EscrowSyncScheduler] Metrics summary:', {
          totalCycles: metrics.totalSyncCycles,
          totalBookings: metrics.totalBookingsProcessed,
          totalRpcCalls: metrics.totalRpcCalls,
          avgDuration: `${Math.round(metrics.averageSyncDuration)}ms`,
          failedSyncs: metrics.failedSyncs,
        });
      }
    } catch (error) {
      console.error('[EscrowSyncScheduler] Sync cycle failed:', error);
      
      // Log error details
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[EscrowSyncScheduler] Error details:', {
        message: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      this.isRunning = false;
      await releaseSyncLock();
    }
  }

  /**
   * Get the current scheduler status.
   */
  getStatus(): {
    running: boolean;
    enabled: boolean;
    config: Required<EscrowSyncSchedulerConfig>;
  } {
    return {
      running: this.intervalHandle !== null,
      enabled: this.config.enabled,
      config: this.config,
    };
  }

  /**
   * Manually trigger a sync cycle (bypasses interval).
   * Useful for testing or manual operations.
   */
  async triggerSync(): Promise<void> {
    console.log('[EscrowSyncScheduler] Manual sync triggered');
    await this.runSyncCycle();
  }

  /**
   * Update scheduler configuration.
   * Requires restart to take effect.
   */
  updateConfig(config: Partial<EscrowSyncSchedulerConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
    console.log('[EscrowSyncScheduler] Configuration updated:', this.config);
  }
}

/**
 * Create and configure an escrow sync scheduler instance.
 */
export function createEscrowSyncScheduler(
  escrowService: SorobanEscrowServiceImpl,
  bookingRepo: BookingRepository,
  escrowStateResolver: EscrowStateResolver,
  config?: EscrowSyncSchedulerConfig
): EscrowSyncScheduler {
  return new EscrowSyncScheduler(
    escrowService,
    bookingRepo,
    escrowStateResolver,
    config
  );
}
