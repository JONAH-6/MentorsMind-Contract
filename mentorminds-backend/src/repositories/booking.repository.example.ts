/**
 * Example Booking Repository Implementation
 * Shows how to implement the BookingRepository interface with pagination support.
 * 
 * This is a reference implementation - adapt to your actual database layer
 * (Prisma, TypeORM, raw SQL, etc.)
 */

import type { 
  BookingRepository, 
  BookingRecord, 
  BookingPaymentStatus 
} from '../services/sorobanEscrow.service';

/**
 * Example implementation using raw SQL queries.
 * Replace with your actual ORM/database layer.
 */
export class BookingRepositoryImpl implements BookingRepository {
  constructor(private readonly db: any) {} // Replace 'any' with your DB client type

  /**
   * Update payment status for a booking.
   */
  async updatePaymentStatus(
    bookingId: string,
    status: BookingPaymentStatus
  ): Promise<void> {
    await this.db.query(
      `UPDATE bookings 
       SET payment_status = $1, updated_at = NOW() 
       WHERE id = $2`,
      [status, bookingId]
    );
  }

  /**
   * Find bookings with active escrow (legacy method - no pagination).
   * @deprecated Use findBookingsWithActiveEscrowPaginated instead
   */
  async findBookingsWithActiveEscrow(statuses: string[]): Promise<BookingRecord[]> {
    const result = await this.db.query(
      `SELECT id, escrow_id, status, payment_status
       FROM bookings
       WHERE status = ANY($1)
         AND escrow_id IS NOT NULL
         AND payment_status NOT IN ('paid', 'refunded')
       ORDER BY id ASC
       LIMIT 200`,
      [statuses]
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      escrowId: row.escrow_id,
      status: row.status,
      paymentStatus: row.payment_status,
    }));
  }

  /**
   * Find bookings with active escrow using cursor-based pagination.
   * 
   * Features:
   * - Cursor-based pagination (afterBookingId)
   * - Only returns bookings not synced recently (minLastSyncMinutes)
   * - Configurable batch size
   * 
   * @param statuses - Booking statuses to include
   * @param options - Pagination and filtering options
   * @returns Array of booking records
   */
  async findBookingsWithActiveEscrowPaginated(
    statuses: string[],
    options: {
      limit: number;
      afterBookingId?: string | null;
      minLastSyncMinutes?: number;
    }
  ): Promise<BookingRecord[]> {
    const { limit, afterBookingId, minLastSyncMinutes = 5 } = options;

    // Build query with cursor and time-based filtering
    let query = `
      SELECT id, escrow_id, status, payment_status
      FROM bookings
      WHERE status = ANY($1)
        AND escrow_id IS NOT NULL
        AND payment_status NOT IN ('paid', 'refunded')
    `;

    const params: any[] = [statuses];
    let paramIndex = 2;

    // Add cursor condition
    if (afterBookingId) {
      query += ` AND id > $${paramIndex}`;
      params.push(afterBookingId);
      paramIndex++;
    }

    // Add time-based filtering to avoid syncing too frequently
    // Only sync bookings that haven't been synced in the last N minutes
    query += `
      AND (
        last_escrow_sync_at IS NULL 
        OR last_escrow_sync_at < NOW() - INTERVAL '${minLastSyncMinutes} minutes'
      )
    `;

    // Order by ID for consistent pagination
    query += ` ORDER BY id ASC LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.db.query(query, params);

    return result.rows.map((row: any) => ({
      id: row.id,
      escrowId: row.escrow_id,
      status: row.status,
      paymentStatus: row.payment_status,
    }));
  }

  /**
   * Update the last escrow sync timestamp for a booking.
   * This prevents the same booking from being synced too frequently.
   */
  async updateLastEscrowSync(bookingId: string): Promise<void> {
    await this.db.query(
      `UPDATE bookings 
       SET last_escrow_sync_at = NOW() 
       WHERE id = $1`,
      [bookingId]
    );
  }
}

/**
 * SQL Migration to add last_escrow_sync_at column
 * 
 * Run this migration to add the required column to your bookings table:
 * 
 * ```sql
 * -- Add last_escrow_sync_at column to bookings table
 * ALTER TABLE bookings 
 * ADD COLUMN IF NOT EXISTS last_escrow_sync_at TIMESTAMP;
 * 
 * -- Add index for efficient querying
 * CREATE INDEX IF NOT EXISTS idx_bookings_escrow_sync 
 * ON bookings(last_escrow_sync_at) 
 * WHERE escrow_id IS NOT NULL 
 *   AND payment_status NOT IN ('paid', 'refunded');
 * 
 * -- Add composite index for cursor-based pagination
 * CREATE INDEX IF NOT EXISTS idx_bookings_escrow_pagination 
 * ON bookings(id, escrow_id, status, payment_status, last_escrow_sync_at)
 * WHERE escrow_id IS NOT NULL;
 * ```
 */

/**
 * Example Prisma Schema
 * 
 * If using Prisma, add this to your schema:
 * 
 * ```prisma
 * model Booking {
 *   id                  String    @id @default(cuid())
 *   escrowId            String?   @map("escrow_id")
 *   status              String
 *   paymentStatus       String    @map("payment_status")
 *   lastEscrowSyncAt    DateTime? @map("last_escrow_sync_at")
 *   createdAt           DateTime  @default(now()) @map("created_at")
 *   updatedAt           DateTime  @updatedAt @map("updated_at")
 *   
 *   @@index([lastEscrowSyncAt])
 *   @@index([id, escrowId, status, paymentStatus, lastEscrowSyncAt])
 *   @@map("bookings")
 * }
 * ```
 */
