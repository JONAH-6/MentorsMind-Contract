import { Pool } from 'pg';

export interface AuditLogRecord {
  id: number;
  action: string;
  actor: string;
  details: Record<string, unknown>;
  created_at: Date;
}

export interface AuditLogSearchOptions {
  action?: string;
  actor?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

export class AuditLoggerService {
  constructor(private readonly pool: Pool) {}

  async log(action: string, actor: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (action, actor, details, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [action, actor, JSON.stringify(details)],
    );
  }

  async getRecentLogs(limit = 100): Promise<AuditLogRecord[]> {
    const { rows } = await this.pool.query<AuditLogRecord>(
      `SELECT id, action, actor, details, created_at
       FROM audit_logs
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async search(filters: {
    action?: string;
    actor?: string;
    since?: Date;
    until?: Date;
    limit?: number;
  }): Promise<AuditLogRecord[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters.action !== undefined) {
      conditions.push(`action = $${paramIndex++}`);
      values.push(filters.action);
    }
    if (filters.actor !== undefined) {
      conditions.push(`actor = $${paramIndex++}`);
      values.push(filters.actor);
    }
    if (filters.since !== undefined) {
      conditions.push(`created_at >= $${paramIndex++}`);
      values.push(filters.since);
    }
    if (filters.until !== undefined) {
      conditions.push(`created_at <= $${paramIndex++}`);
      values.push(filters.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(filters.limit ?? 100);

    const { rows } = await this.pool.query<AuditLogRecord>(
      `SELECT id, action, actor, details, created_at
       FROM audit_logs
       ${where}
       ORDER BY created_at DESC
       LIMIT $${paramIndex}`,
      values,
    );
    return rows;
  }

  /**
   * Searches audit log entries with optional filters.
   * Uses $N placeholders for all parameters including LIMIT and OFFSET.
   */
  async search(options: AuditLogSearchOptions = {}): Promise<{ rows: AuditLogRecord[]; total: number }> {
    const { action, actor, startDate, endDate, limit = 50, offset = 0 } = options;
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (action) {
      values.push(action);
      conditions.push(`action = $${values.length}`);
    }
    if (actor) {
      values.push(actor);
      conditions.push(`actor = $${values.length}`);
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

    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM audit_logs ${whereClause}`,
      values,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // LIMIT and OFFSET use $N placeholders — push values first, then reference by index
    values.push(limit);
    const limitPlaceholder = `$${values.length}`;
    values.push(offset);
    const offsetPlaceholder = `$${values.length}`;

    const { rows } = await this.pool.query<AuditLogRecord>(
      `SELECT id, action, actor, details, created_at
       FROM audit_logs ${whereClause}
       ORDER BY created_at DESC
       LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      values,
    );

    return { rows, total };
  }

  /**
   * Deletes audit log entries older than `retentionDays` days.
   *
   * Uses arithmetic multiplication ($1 * INTERVAL '1 day') instead of
   * string concatenation to prevent SQL injection — PostgreSQL only
   * accepts a numeric left-hand operand for this form.
   */
  async cleanupOldLogs(retentionDays: number): Promise<number> {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
      throw new Error('Invalid retention days: must be a positive integer');
    }

    const { rowCount } = await this.pool.query(
      `DELETE FROM audit_logs
       WHERE created_at < NOW() - ($1 * INTERVAL '1 day')`,
      [retentionDays],
    );

    return rowCount ?? 0;
  }
}
