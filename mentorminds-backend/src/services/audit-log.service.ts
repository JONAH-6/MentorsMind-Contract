import { createHash } from 'crypto';
import { Pool } from 'pg';

export interface AuditLogEntry {
  id: string;
  action: string;
  user_id: string;
  txHash: string;
  walletAddress: string;
  sequenceNumber: string;
  record_hash: string;
  previous_hash: string | null;
  createdAt: Date;
}

export interface AuditLogStats {
  total: number;
  byAction: Record<string, number>;
}

export interface AuditLogQueryOptions {
  action?: string;
  userId?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

// In-memory store — replace with DB in production
const logs: AuditLogEntry[] = [];

/**
 * Computes the canonical SHA-256 hash for an audit log record.
 * Algorithm: SHA-256( id + action + user_id + createdAt.toISOString() + (previous_hash ?? '') )
 */
export function computeRecordHash(entry: Pick<AuditLogEntry, 'id' | 'action' | 'user_id' | 'createdAt' | 'previous_hash'>): string {
  const content = [
    entry.id,
    entry.action,
    entry.user_id,
    entry.createdAt instanceof Date ? entry.createdAt.toISOString() : entry.createdAt,
    entry.previous_hash ?? '',
  ].join('|');
  return createHash('sha256').update(content).digest('hex');
}

export class AuditLogService {
  constructor(private readonly pool?: Pool) {}

  create(data: Omit<AuditLogEntry, 'id' | 'createdAt' | 'record_hash' | 'previous_hash'>): AuditLogEntry {
    const previous = logs.length > 0 ? logs[logs.length - 1] : null;
    const entry: AuditLogEntry = {
      id: crypto.randomUUID(),
      ...data,
      previous_hash: previous?.record_hash ?? null,
      createdAt: new Date(),
      record_hash: '',
    };
    entry.record_hash = computeRecordHash(entry);
    logs.push(entry);
    return entry;
  }

  findByWallet(walletAddress: string): AuditLogEntry[] {
    return logs.filter(e => e.walletAddress === walletAddress);
  }

  findByTxHash(txHash: string): AuditLogEntry | undefined {
    return logs.find(e => e.txHash === txHash);
  }

  getAll(): AuditLogEntry[] {
    return [...logs];
  }

  /**
   * Returns paginated audit log records from the database with optional filters.
   * Uses $N placeholders for all parameters to prevent SQL injection.
   */
  async query(options: AuditLogQueryOptions = {}): Promise<{ rows: AuditLogEntry[]; total: number }> {
    if (!this.pool) throw new Error('Database pool not configured');

    const { action, userId, startDate, endDate, limit = 50, offset = 0 } = options;
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (action) {
      values.push(action);
      conditions.push(`action = $${values.length}`);
    }
    if (userId) {
      values.push(userId);
      conditions.push(`user_id = $${values.length}`);
    }
    if (startDate) {
      values.push(startDate);
      conditions.push(`created_at >= $${values.length}`);
    }
    if (endDate) {
      values.push(endDate);
      conditions.push(`created_at <= $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count query
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM audit_logs ${whereClause}`,
      values,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Data query — LIMIT and OFFSET use $N placeholders
    values.push(limit);
    const limitPlaceholder = `$${values.length}`;
    values.push(offset);
    const offsetPlaceholder = `$${values.length}`;

    const dataResult = await this.pool.query<AuditLogEntry>(
      `SELECT * FROM audit_logs ${whereClause} ORDER BY created_at DESC LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      values,
    );

    return { rows: dataResult.rows, total };
  }

  /**
   * Returns aggregate statistics for audit logs with optional date filters.
   * Uses $N placeholders for date parameters to prevent SQL injection.
   */
  async getStats(startDate?: Date, endDate?: Date): Promise<AuditLogStats> {
    if (!this.pool) throw new Error('Database pool not configured');

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (startDate) {
      values.push(startDate);
      conditions.push(`created_at >= $${values.length}`);
    }
    if (endDate) {
      values.push(endDate);
      conditions.push(`created_at <= $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await this.pool.query<{ action: string; count: string }>(
      `SELECT action, COUNT(*) AS count FROM audit_logs ${whereClause} GROUP BY action`,
      values,
    );

    const byAction: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      byAction[row.action] = parseInt(row.count, 10);
      total += byAction[row.action];
    }

    return { total, byAction };
  }

  /**
   * Verifies the integrity of the audit log chain.
   * Checks both chain links (previous_hash) and content hashes (record_hash).
   */
  verifyChainIntegrity(entries: AuditLogEntry[] = logs): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (let i = 0; i < entries.length; i++) {
      const current = entries[i];

      // 1. Verify content hash
      const expectedHash = computeRecordHash(current);
      if (current.record_hash !== expectedHash) {
        errors.push(`Content tampered at record ${current.id}: hash mismatch`);
      }

      // 2. Verify chain link
      if (i > 0) {
        const previous = entries[i - 1];
        if (current.previous_hash !== previous.record_hash) {
          errors.push(`Chain break at record ${current.id}: previous_hash mismatch`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

export const auditLogService = new AuditLogService();
