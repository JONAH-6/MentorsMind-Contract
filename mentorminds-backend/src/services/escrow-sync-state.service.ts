/**
 * Escrow Sync State Service
 * Manages cursor-based pagination and sync state for escrow polling.
 * Prevents runaway polling and ensures all escrows are eventually synced.
 */

import { getRedisClient } from './redis.service';

const SYNC_STATE_KEY = 'mm:escrow:sync:state';
const SYNC_METRICS_KEY = 'mm:escrow:sync:metrics';
const SYNC_LOCK_KEY = 'mm:escrow:sync:lock';
const SYNC_LOCK_TTL = 60; // 60 seconds

export interface SyncState {
  lastSyncedBookingId: string | null;
  lastSyncTimestamp: number;
  totalBookingsProcessed: number;
  currentBatchNumber: number;
}

export interface SyncMetrics {
  totalSyncCycles: number;
  totalBookingsProcessed: number;
  totalRpcCalls: number;
  lastSyncDuration: number;
  averageSyncDuration: number;
  failedSyncs: number;
  lastError: string | null;
  lastErrorTimestamp: number | null;
}

/**
 * Get the current sync state from Redis.
 * Returns default state if none exists.
 */
export async function getSyncState(): Promise<SyncState> {
  const client = getRedisClient();
  const stateData = await client.get(SYNC_STATE_KEY);
  
  if (!stateData) {
    return {
      lastSyncedBookingId: null,
      lastSyncTimestamp: 0,
      totalBookingsProcessed: 0,
      currentBatchNumber: 0,
    };
  }
  
  try {
    return JSON.parse(stateData);
  } catch (error) {
    console.error('[EscrowSync] Failed to parse sync state:', error);
    return {
      lastSyncedBookingId: null,
      lastSyncTimestamp: 0,
      totalBookingsProcessed: 0,
      currentBatchNumber: 0,
    };
  }
}

/**
 * Update the sync state in Redis.
 */
export async function updateSyncState(state: Partial<SyncState>): Promise<void> {
  const client = getRedisClient();
  const currentState = await getSyncState();
  
  const newState: SyncState = {
    ...currentState,
    ...state,
    lastSyncTimestamp: Date.now(),
  };
  
  await client.set(SYNC_STATE_KEY, JSON.stringify(newState));
}

/**
 * Reset the sync cursor to start from the beginning.
 * Useful when you want to force a full resync.
 */
export async function resetSyncCursor(): Promise<void> {
  await updateSyncState({
    lastSyncedBookingId: null,
    currentBatchNumber: 0,
  });
}

/**
 * Get sync metrics from Redis.
 */
export async function getSyncMetrics(): Promise<SyncMetrics> {
  const client = getRedisClient();
  const metricsData = await client.get(SYNC_METRICS_KEY);
  
  if (!metricsData) {
    return {
      totalSyncCycles: 0,
      totalBookingsProcessed: 0,
      totalRpcCalls: 0,
      lastSyncDuration: 0,
      averageSyncDuration: 0,
      failedSyncs: 0,
      lastError: null,
      lastErrorTimestamp: null,
    };
  }
  
  try {
    return JSON.parse(metricsData);
  } catch (error) {
    console.error('[EscrowSync] Failed to parse sync metrics:', error);
    return {
      totalSyncCycles: 0,
      totalBookingsProcessed: 0,
      totalRpcCalls: 0,
      lastSyncDuration: 0,
      averageSyncDuration: 0,
      failedSyncs: 0,
      lastError: null,
      lastErrorTimestamp: null,
    };
  }
}

/**
 * Update sync metrics in Redis.
 */
export async function updateSyncMetrics(update: {
  syncDuration?: number;
  bookingsProcessed?: number;
  rpcCalls?: number;
  error?: string | null;
}): Promise<void> {
  const client = getRedisClient();
  const currentMetrics = await getSyncMetrics();
  
  const newMetrics: SyncMetrics = {
    ...currentMetrics,
    totalSyncCycles: currentMetrics.totalSyncCycles + 1,
  };
  
  if (update.bookingsProcessed !== undefined) {
    newMetrics.totalBookingsProcessed += update.bookingsProcessed;
  }
  
  if (update.rpcCalls !== undefined) {
    newMetrics.totalRpcCalls += update.rpcCalls;
  }
  
  if (update.syncDuration !== undefined) {
    newMetrics.lastSyncDuration = update.syncDuration;
    
    // Calculate rolling average (weighted towards recent syncs)
    if (newMetrics.averageSyncDuration === 0) {
      newMetrics.averageSyncDuration = update.syncDuration;
    } else {
      newMetrics.averageSyncDuration = 
        (newMetrics.averageSyncDuration * 0.8) + (update.syncDuration * 0.2);
    }
  }
  
  if (update.error !== undefined) {
    if (update.error) {
      newMetrics.failedSyncs += 1;
      newMetrics.lastError = update.error;
      newMetrics.lastErrorTimestamp = Date.now();
    } else {
      // Clear error on successful sync
      newMetrics.lastError = null;
      newMetrics.lastErrorTimestamp = null;
    }
  }
  
  await client.set(SYNC_METRICS_KEY, JSON.stringify(newMetrics));
}

/**
 * Acquire a distributed lock for sync operations.
 * Prevents multiple instances from syncing simultaneously.
 * 
 * @returns true if lock was acquired, false if another instance holds the lock
 */
export async function acquireSyncLock(): Promise<boolean> {
  const client = getRedisClient();
  
  // Use SET with NX (only set if not exists) and EX (expiry)
  const result = await client.set(
    SYNC_LOCK_KEY,
    Date.now().toString(),
    'EX',
    SYNC_LOCK_TTL,
    'NX'
  );
  
  return result === 'OK';
}

/**
 * Release the sync lock.
 */
export async function releaseSyncLock(): Promise<void> {
  const client = getRedisClient();
  await client.del(SYNC_LOCK_KEY);
}

/**
 * Check if sync is currently locked by another instance.
 */
export async function isSyncLocked(): Promise<boolean> {
  const client = getRedisClient();
  const lockValue = await client.get(SYNC_LOCK_KEY);
  return lockValue !== null;
}

/**
 * Get a summary of sync state and metrics for monitoring.
 */
export async function getSyncSummary(): Promise<{
  state: SyncState;
  metrics: SyncMetrics;
  isLocked: boolean;
}> {
  const [state, metrics, isLocked] = await Promise.all([
    getSyncState(),
    getSyncMetrics(),
    isSyncLocked(),
  ]);
  
  return { state, metrics, isLocked };
}

export const escrowSyncStateService = {
  getSyncState,
  updateSyncState,
  resetSyncCursor,
  getSyncMetrics,
  updateSyncMetrics,
  acquireSyncLock,
  releaseSyncLock,
  isSyncLocked,
  getSyncSummary,
};
