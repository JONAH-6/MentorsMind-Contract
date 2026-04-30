# Escrow Sync Service Documentation

## Overview

The Escrow Sync Service manages periodic synchronization of on-chain escrow state with the database. It implements cursor-based pagination, distributed locking, and rate limiting to handle large-scale operations efficiently.

## Problem Statement

### Original Issue

The original `syncPendingEscrows` implementation had several scalability problems:

1. **No Pagination**: Fetched up to 200 bookings every 30 seconds without cursor-based pagination
2. **Runaway Polling**: At scale, this meant 200 RPC calls every 30 seconds per instance
3. **Instance Multiplication**: Multiple instances would multiply the load (3 instances = 600 RPC calls/30s)
4. **Missing Records**: If >200 active escrows existed, oldest ones were never synced
5. **No Rate Limiting**: Bookings were synced every cycle regardless of whether they needed it
6. **No Metrics**: No visibility into sync performance or issues

### Impact

- High RPC costs (200+ calls per 30 seconds)
- Potential rate limiting from RPC providers
- Incomplete sync coverage for large datasets
- Duplicate work across multiple instances
- No monitoring or alerting capabilities

## Solution Architecture

### Components

1. **Escrow Sync State Service** (`escrow-sync-state.service.ts`)
   - Manages cursor-based pagination state
   - Tracks sync metrics
   - Provides distributed locking

2. **Escrow Sync Scheduler** (`escrow-sync-scheduler.service.ts`)
   - Manages periodic sync cycles
   - Implements distributed locking
   - Configurable intervals and batch sizes

3. **Optimized Sync Method** (`sorobanEscrow.service.ts`)
   - Cursor-based pagination
   - Time-based filtering (only sync stale records)
   - Batch processing with limits

4. **Booking Repository** (`booking.repository.example.ts`)
   - Implements paginated queries
   - Tracks last sync timestamp per booking

5. **Monitoring API** (`escrow-sync.routes.ts`)
   - Exposes sync status and metrics
   - Health check endpoint
   - Manual control endpoints

### Key Features

#### 1. Cursor-Based Pagination

Instead of fetching all records, the system:
- Tracks the last synced booking ID
- Fetches records after that ID
- Processes in configurable batches (default: 50)
- Resets cursor when reaching the end

```typescript
// Fetch next batch after last synced booking
const bookings = await repo.findBookingsWithActiveEscrowPaginated(
  statuses,
  {
    limit: 50,
    afterBookingId: lastSyncedBookingId,
    minLastSyncMinutes: 5,
  }
);
```

#### 2. Time-Based Filtering

Only syncs bookings that haven't been synced recently:
- Adds `last_escrow_sync_at` column to bookings table
- Only syncs records not synced in last 5 minutes (configurable)
- Reduces unnecessary RPC calls

```sql
WHERE (
  last_escrow_sync_at IS NULL 
  OR last_escrow_sync_at < NOW() - INTERVAL '5 minutes'
)
```

#### 3. Distributed Locking

Prevents duplicate work across multiple instances:
- Uses Redis for distributed locks
- Lock TTL of 60 seconds
- Only one instance syncs at a time

```typescript
const lockAcquired = await acquireSyncLock();
if (!lockAcquired) {
  console.log('Another instance is syncing, skipping');
  return;
}
```

#### 4. Metrics Tracking

Comprehensive metrics for monitoring:
- Total sync cycles
- Total bookings processed
- Total RPC calls
- Average sync duration
- Failed syncs
- Last error details

## Configuration

### Environment Variables

```bash
# Sync interval (milliseconds)
ESCROW_SYNC_INTERVAL_MS=30000

# Batch size per cycle
ESCROW_SYNC_BATCH_SIZE=50

# Minimum minutes between syncs for same booking
ESCROW_SYNC_MIN_INTERVAL_MINUTES=5

# Maximum batches to process per cycle
ESCROW_SYNC_MAX_BATCHES_PER_CYCLE=1

# Enable/disable sync
ESCROW_SYNC_ENABLED=true
```

### Scheduler Configuration

```typescript
const scheduler = createEscrowSyncScheduler(
  escrowService,
  bookingRepo,
  escrowStateResolver,
  {
    syncIntervalMs: 30000,        // 30 seconds
    batchSize: 50,                // 50 bookings per batch
    minSyncIntervalMinutes: 5,    // Only sync if >5 min since last sync
    maxBatchesPerCycle: 1,        // Process 1 batch per cycle
    enabled: true,                // Enable scheduler
  }
);

await scheduler.start();
```

## Database Migration

### Add Required Column

```sql
-- Add last_escrow_sync_at column to bookings table
ALTER TABLE bookings 
ADD COLUMN IF NOT EXISTS last_escrow_sync_at TIMESTAMP;

-- Add index for efficient querying
CREATE INDEX IF NOT EXISTS idx_bookings_escrow_sync 
ON bookings(last_escrow_sync_at) 
WHERE escrow_id IS NOT NULL 
  AND payment_status NOT IN ('paid', 'refunded');

-- Add composite index for cursor-based pagination
CREATE INDEX IF NOT EXISTS idx_bookings_escrow_pagination 
ON bookings(id, escrow_id, status, payment_status, last_escrow_sync_at)
WHERE escrow_id IS NOT NULL;
```

### Prisma Schema

```prisma
model Booking {
  id                  String    @id @default(cuid())
  escrowId            String?   @map("escrow_id")
  status              String
  paymentStatus       String    @map("payment_status")
  lastEscrowSyncAt    DateTime? @map("last_escrow_sync_at")
  createdAt           DateTime  @default(now()) @map("created_at")
  updatedAt           DateTime  @updatedAt @map("updated_at")
  
  @@index([lastEscrowSyncAt])
  @@index([id, escrowId, status, paymentStatus, lastEscrowSyncAt])
  @@map("bookings")
}
```

## API Endpoints

### Get Sync Status

```http
GET /api/v1/escrow-sync/status
```

**Response:**
```json
{
  "state": {
    "lastSyncedBookingId": "booking_123",
    "lastSyncTimestamp": 1234567890,
    "totalBookingsProcessed": 1500,
    "currentBatchNumber": 30
  },
  "metrics": {
    "totalSyncCycles": 100,
    "totalBookingsProcessed": 1500,
    "totalRpcCalls": 1500,
    "lastSyncDuration": 2500,
    "averageSyncDuration": 2300,
    "failedSyncs": 2,
    "lastError": null,
    "lastErrorTimestamp": null
  },
  "isLocked": false
}
```

### Get Metrics

```http
GET /api/v1/escrow-sync/metrics
```

**Response:**
```json
{
  "totalSyncCycles": 100,
  "totalBookingsProcessed": 1500,
  "totalRpcCalls": 1500,
  "lastSyncDuration": 2500,
  "averageSyncDuration": 2300,
  "failedSyncs": 2,
  "rpcCallsPerMinute": 50,
  "bookingsPerMinute": 50
}
```

### Health Check

```http
GET /api/v1/escrow-sync/health
```

**Response:**
```json
{
  "healthy": true,
  "status": "ok",
  "details": {
    "lastSyncAge": 25000,
    "isLocked": false,
    "recentErrors": 0
  }
}
```

### Reset Cursor

```http
POST /api/v1/escrow-sync/reset-cursor
```

**Response:**
```json
{
  "success": true,
  "message": "Sync cursor reset successfully"
}
```

## Performance Comparison

### Before Optimization

| Metric | Value |
|--------|-------|
| Bookings per cycle | Up to 200 |
| RPC calls per cycle | Up to 200 |
| RPC calls per minute | 400 (30s interval) |
| RPC calls per minute (3 instances) | 1,200 |
| Coverage | Incomplete (>200 escrows) |
| Duplicate work | Yes (all instances) |

### After Optimization

| Metric | Value |
|--------|-------|
| Bookings per cycle | 50 (configurable) |
| RPC calls per cycle | ~10-50 (only stale records) |
| RPC calls per minute | ~20-100 |
| RPC calls per minute (3 instances) | ~20-100 (distributed lock) |
| Coverage | Complete (cursor-based) |
| Duplicate work | No (distributed lock) |

### Improvement

- **80-95% reduction** in RPC calls
- **Complete coverage** of all escrows
- **No duplicate work** across instances
- **Predictable load** with configurable limits

## Monitoring

### Key Metrics to Track

1. **RPC Calls Per Minute**
   - Target: <100 calls/minute
   - Alert if: >200 calls/minute

2. **Sync Duration**
   - Target: <5 seconds per cycle
   - Alert if: >10 seconds per cycle

3. **Failed Syncs**
   - Target: 0 failures
   - Alert if: >5 failures in 10 minutes

4. **Last Sync Age**
   - Target: <60 seconds
   - Alert if: >120 seconds

5. **Bookings Processed**
   - Track trend over time
   - Alert if: sudden drop to 0

### Grafana Dashboard Example

```promql
# RPC calls per minute
rate(escrow_sync_rpc_calls_total[1m]) * 60

# Average sync duration
rate(escrow_sync_duration_seconds_sum[5m]) / rate(escrow_sync_duration_seconds_count[5m])

# Failed syncs
increase(escrow_sync_failed_total[10m])

# Bookings processed per minute
rate(escrow_sync_bookings_processed_total[1m]) * 60
```

### Logging

The service logs detailed information:

```
[EscrowSyncScheduler] Starting sync cycle
[EscrowSyncScheduler] Sync cycle completed: {
  bookingsProcessed: 45,
  rpcCalls: 45,
  duration: 2300ms,
  hasMore: true
}
[EscrowSyncScheduler] Metrics summary: {
  totalCycles: 100,
  totalBookings: 1500,
  totalRpcCalls: 1500,
  avgDuration: 2300ms,
  failedSyncs: 0
}
```

## Troubleshooting

### High RPC Call Rate

**Symptoms**: RPC calls >200/minute

**Causes**:
1. `minSyncIntervalMinutes` too low
2. `batchSize` too large
3. Many bookings with stale sync timestamps

**Solutions**:
1. Increase `minSyncIntervalMinutes` to 10-15 minutes
2. Reduce `batchSize` to 25-30
3. Check if `last_escrow_sync_at` is being updated properly

### Incomplete Sync Coverage

**Symptoms**: Some bookings never synced

**Causes**:
1. Cursor not advancing
2. Query filtering too aggressive
3. Errors during sync

**Solutions**:
1. Check sync state: `GET /api/v1/escrow-sync/status`
2. Reset cursor: `POST /api/v1/escrow-sync/reset-cursor`
3. Review error logs

### Sync Taking Too Long

**Symptoms**: Sync duration >10 seconds

**Causes**:
1. `batchSize` too large
2. Slow RPC responses
3. Database query performance

**Solutions**:
1. Reduce `batchSize` to 25-30
2. Check RPC endpoint health
3. Verify database indexes exist

### Multiple Instances Not Coordinating

**Symptoms**: Duplicate RPC calls, high load

**Causes**:
1. Redis connection issues
2. Lock TTL too short
3. Clock skew between instances

**Solutions**:
1. Verify Redis connectivity
2. Increase lock TTL to 90 seconds
3. Sync system clocks (NTP)

## Best Practices

### Configuration Tuning

1. **Start Conservative**:
   ```typescript
   {
     batchSize: 25,
     minSyncIntervalMinutes: 10,
     maxBatchesPerCycle: 1,
   }
   ```

2. **Monitor and Adjust**:
   - Watch RPC call rate
   - Check sync coverage
   - Adjust based on load

3. **Scale Gradually**:
   - Increase batch size slowly
   - Monitor impact on RPC provider
   - Keep minSyncIntervalMinutes high

### Database Optimization

1. **Ensure Indexes Exist**:
   ```sql
   CREATE INDEX idx_bookings_escrow_sync ...
   CREATE INDEX idx_bookings_escrow_pagination ...
   ```

2. **Monitor Query Performance**:
   ```sql
   EXPLAIN ANALYZE
   SELECT * FROM bookings
   WHERE ...
   ```

3. **Archive Old Records**:
   - Move completed bookings to archive table
   - Reduces active dataset size

### Monitoring Setup

1. **Set Up Alerts**:
   - RPC call rate >200/minute
   - Sync duration >10 seconds
   - Failed syncs >5 in 10 minutes
   - Last sync age >120 seconds

2. **Create Dashboard**:
   - RPC calls per minute (graph)
   - Sync duration (graph)
   - Bookings processed (counter)
   - Failed syncs (counter)
   - Current sync state (table)

3. **Regular Reviews**:
   - Weekly: Review metrics trends
   - Monthly: Optimize configuration
   - Quarterly: Capacity planning

## Migration Guide

### Step 1: Add Database Column

```sql
ALTER TABLE bookings 
ADD COLUMN IF NOT EXISTS last_escrow_sync_at TIMESTAMP;

CREATE INDEX idx_bookings_escrow_sync 
ON bookings(last_escrow_sync_at) 
WHERE escrow_id IS NOT NULL;
```

### Step 2: Update Repository

Implement the new pagination methods in your booking repository:

```typescript
class BookingRepository implements BookingRepository {
  async findBookingsWithActiveEscrowPaginated(...) { ... }
  async updateLastEscrowSync(...) { ... }
}
```

### Step 3: Initialize Scheduler

```typescript
import { createEscrowSyncScheduler } from './services/escrow-sync-scheduler.service';

const scheduler = createEscrowSyncScheduler(
  escrowService,
  bookingRepo,
  escrowStateResolver
);

await scheduler.start();
```

### Step 4: Monitor

1. Check logs for sync cycles
2. Monitor RPC call rate
3. Verify all bookings are being synced
4. Adjust configuration as needed

### Step 5: Deprecate Old Method

Once stable, remove calls to the old `syncPendingEscrows` method.

## Future Enhancements

1. **Event Streaming**: Use Soroban event streaming API instead of polling
2. **Priority Queue**: Sync high-value escrows more frequently
3. **Adaptive Batching**: Adjust batch size based on load
4. **Multi-Region**: Coordinate sync across regions
5. **Webhook Notifications**: Alert on escrow state changes

## References

- Sync State Service: `src/services/escrow-sync-state.service.ts`
- Scheduler Service: `src/services/escrow-sync-scheduler.service.ts`
- Escrow Service: `src/services/sorobanEscrow.service.ts`
- Repository Example: `src/repositories/booking.repository.example.ts`
- API Routes: `src/routes/escrow-sync.routes.ts`
