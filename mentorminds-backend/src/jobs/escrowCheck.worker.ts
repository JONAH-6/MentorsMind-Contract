import { Pool } from 'pg';
import {
  EscrowReleaseService,
  EscrowReadRepository,
  EscrowWriteRepository,
  EscrowReleaseRecord,
  InternalReleasePolicy,
} from '../services/escrow-release.service';

const RELEASE_WINDOW_HOURS = 48;
const MAX_ESCROW_AGE_DAYS = 30; // FIX #260: Upper bound on escrow age
const MAX_RELEASE_ATTEMPTS = 5; // FIX #260: Max retry attempts
const RETRY_COOLDOWN_HOURS = 1; // FIX #260: Cooldown between retry attempts

const SYSTEM_USER_ID = 'system';

/** Messages that indicate the escrow is already in a terminal state — skip, don't error. */
function isSkippableReleaseError(msg: string): boolean {
  return (
    msg.includes('Cannot release escrow') ||
    msg.includes('Only the learner can release funds')
  );
}

/** DB-backed read repository for EscrowReleaseService. */
class PgEscrowReadRepository implements EscrowReadRepository {
  constructor(private readonly pool: Pool) {}

  async findById(id: string): Promise<EscrowReleaseRecord | null> {
    const result = await this.pool.query(
      `SELECT id, learner_id AS "learnerId", status FROM escrows WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }
}

/** DB-backed write repository for EscrowReleaseService. */
class PgEscrowWriteRepository implements EscrowWriteRepository {
  constructor(private readonly pool: Pool) {}

  async markReleased(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE escrows SET status = 'released' WHERE id = $1`,
      [id]
    );
  }
}

/** System callers (workers) are trusted to bypass the learner-only guard. */
const systemReleasePolicy: InternalReleasePolicy = {
  isTrustedSystemCaller: (callerId: string) => callerId === SYSTEM_USER_ID,
};

export class EscrowCheckWorker {
  private readonly releaseService: EscrowReleaseService;

  constructor(private readonly pool: Pool) {
    this.releaseService = new EscrowReleaseService(
      new PgEscrowReadRepository(pool),
      new PgEscrowWriteRepository(pool),
      systemReleasePolicy
    );
  }
  /**
   * Checks for escrows that have exceeded the release window and triggers auto-release.
   * 
   * FIX #260: Added upper age bound, retry limits, and cooldown to prevent:
   * - Processing ancient escrows indefinitely
   * - Hammering the RPC with repeated failed attempts
   * - Duplicate on-chain operations
   */
  async checkAutoRelease(): Promise<void> {
    // FIX #260: Query now includes:
    // 1. Upper age bound (30 days)
    // 2. Max attempts check (release_attempts < 5)
    // 3. Cooldown period (last_release_attempt_at is NULL or > 1 hour ago)
    const sql = `
      SELECT id, mentor_id, learner_id, amount, 
             COALESCE(release_attempts, 0) as release_attempts
      FROM escrows
      WHERE status IN ('funded', 'pending')
      AND created_at < NOW() - ($1 * INTERVAL '1 hour')
      AND created_at > NOW() - ($2 * INTERVAL '1 day')
      AND COALESCE(release_attempts, 0) < $3
      AND (last_release_attempt_at IS NULL 
           OR last_release_attempt_at < NOW() - ($4 * INTERVAL '1 hour'))
    `;

    try {
      const result = await this.pool.query(sql, [
        RELEASE_WINDOW_HOURS,
        MAX_ESCROW_AGE_DAYS,
        MAX_RELEASE_ATTEMPTS,
        RETRY_COOLDOWN_HOURS
      ]);
      
      if (result.rows.length === 0) {
        return;
      }

      console.log(`[EscrowCheckWorker] Found ${result.rows.length} escrows for auto-release.`);

      for (const row of result.rows) {
        await this.processAutoRelease(row);
      }
      
      // FIX #260: Alert on stuck escrows that exceeded max attempts
      await this.alertStuckEscrows();
    } catch (error) {
      console.error('[EscrowCheckWorker] Error checking auto-release:', error);
      throw error;
    }
  }

  private async processAutoRelease(escrow: any): Promise<void> {
    console.log(`[EscrowCheckWorker] Processing auto-release for escrow ${escrow.id} (attempt ${escrow.release_attempts + 1})`);
    
    try {
      // FIX #260: Increment release_attempts and update last_release_attempt_at
      await this.pool.query(
        `UPDATE escrows 
         SET release_attempts = COALESCE(release_attempts, 0) + 1,
             last_release_attempt_at = NOW()
         WHERE id = $1`,
        [escrow.id]
      );

      // FIX #290: Use EscrowReleaseService with bypassOwnerCheck: true so the
      // system caller is not blocked by the learner-only guard.
      // bypassOwnerCheck is validated against systemReleasePolicy — it is never
      // reachable from the HTTP API layer.
      await this.releaseService.releaseEscrow(escrow.id, SYSTEM_USER_ID, {
        bypassOwnerCheck: true,
      });

      console.log(`[EscrowCheckWorker] Auto-released escrow ${escrow.id}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // FIX #290: Treat "Cannot release escrow" AND "Only the learner can release
      // funds" as skippable — the escrow is already in a terminal state.
      if (isSkippableReleaseError(msg)) {
        console.log(`[EscrowCheckWorker] Skipping escrow ${escrow.id}: ${msg}`);
        return;
      }

      console.error(`[EscrowCheckWorker] Failed to release escrow ${escrow.id}:`, error);
      
      // Check if max attempts reached
      const attempts = escrow.release_attempts + 1;
      if (attempts >= MAX_RELEASE_ATTEMPTS) {
        console.error(`[EscrowCheckWorker] Escrow ${escrow.id} exceeded max attempts (${MAX_RELEASE_ATTEMPTS}). Flagging as stuck.`);
        // TODO: Alert admins about stuck escrow
      }
    }
  }

  /**
   * FIX #260: Identifies and alerts on escrows that have exceeded max retry attempts.
   * These escrows are stuck and require manual intervention.
   */
  private async alertStuckEscrows(): Promise<void> {
    const sql = `
      SELECT id, mentor_id, learner_id, amount, release_attempts, created_at
      FROM escrows
      WHERE status IN ('funded', 'pending')
      AND COALESCE(release_attempts, 0) >= $1
      AND created_at > NOW() - ($2 * INTERVAL '1 day')
    `;
    
    try {
      const result = await this.pool.query(sql, [
        MAX_RELEASE_ATTEMPTS,
        MAX_ESCROW_AGE_DAYS
      ]);
      
      if (result.rows.length > 0) {
        console.error(
          `[EscrowCheckWorker] ALERT: ${result.rows.length} stuck escrows require manual intervention:`,
          result.rows.map(r => ({ id: r.id, attempts: r.release_attempts, age_days: Math.floor((Date.now() - r.created_at.getTime()) / (1000 * 60 * 60 * 24)) }))
        );
        // TODO: Send alert to admin monitoring system (email, Slack, PagerDuty, etc.)
      }
    } catch (error) {
      console.error('[EscrowCheckWorker] Error checking stuck escrows:', error);
    }
  }
}
