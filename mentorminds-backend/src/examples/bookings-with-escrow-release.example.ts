/**
 * Example: Integrating Escrow Release Queue into BookingsService
 * 
 * This example shows how to:
 * 1. Create escrow with deadline when confirming a booking
 * 2. Schedule delayed release when session completes
 * 3. Cancel scheduled release when dispute is opened
 */

import {
  scheduleEscrowRelease,
  cancelEscrowRelease,
  EscrowReleaseQueue,
} from '../services/escrow-release-queue.service';
import { SorobanEscrowService, CreateEscrowInput } from '../services/escrow.service';

interface Booking {
  id: string;
  mentorId: string;
  learnerId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  status: 'pending' | 'confirmed' | 'completed' | 'disputed';
  escrowId?: string;
}

interface BookingRepository {
  findById(id: string): Promise<Booking | null>;
  update(booking: Booking): Promise<void>;
}

/**
 * Example BookingsService with proper escrow integration
 */
export class BookingsServiceWithEscrowRelease {
  constructor(
    private readonly bookingRepo: BookingRepository,
    private readonly sorobanEscrow: SorobanEscrowService,
    private readonly escrowReleaseQueue: EscrowReleaseQueue
  ) {}

  /**
   * Confirm booking and create escrow with deadline.
   * 
   * Deadline = scheduledEnd + 7 days grace period
   */
  async confirmBooking(bookingId: string, amount: string, currency: string): Promise<void> {
    const booking = await this.bookingRepo.findById(bookingId);
    if (!booking) {
      throw new Error(`Booking ${bookingId} not found`);
    }

    // Calculate deadline: session end + 7 days grace period
    const GRACE_PERIOD_DAYS = 7;
    const deadlineMs = booking.scheduledEnd.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
    const deadline = Math.floor(deadlineMs / 1000); // Convert to Unix timestamp (seconds)

    // Create escrow with deadline
    const escrowInput: CreateEscrowInput = {
      bookingId: booking.id,
      learnerId: booking.learnerId,
      mentorId: booking.mentorId,
      amount,
      currency,
      deadline,
    };

    const result = await this.sorobanEscrow.createEscrow(escrowInput);

    // Update booking with escrow ID
    booking.escrowId = result.escrowId;
    booking.status = 'confirmed';
    await this.bookingRepo.update(booking);
  }

  /**
   * Complete booking and schedule delayed escrow release.
   * 
   * Release is scheduled 48 hours after completion to allow time for disputes.
   */
  async completeBooking(bookingId: string, completedBy: 'mentor' | 'learner'): Promise<void> {
    const booking = await this.bookingRepo.findById(bookingId);
    if (!booking) {
      throw new Error(`Booking ${bookingId} not found`);
    }

    if (!booking.escrowId) {
      throw new Error(`Booking ${bookingId} has no escrow`);
    }

    // Update booking status
    booking.status = 'completed';
    await this.bookingRepo.update(booking);

    // Schedule delayed release (48 hours from now)
    await scheduleEscrowRelease(
      {
        escrowId: booking.escrowId,
        mentorId: booking.mentorId,
        learnerId: booking.learnerId,
        sessionCompletedAt: new Date(),
      },
      this.escrowReleaseQueue
    );

    console.log(`[BookingsService] Scheduled escrow release for ${booking.escrowId} in 48 hours`);
  }

  /**
   * Open dispute and cancel scheduled release.
   * 
   * When a dispute is opened, the scheduled auto-release must be cancelled
   * to prevent funds from being released while the dispute is being resolved.
   */
  async openDispute(bookingId: string, reason: string): Promise<void> {
    const booking = await this.bookingRepo.findById(bookingId);
    if (!booking) {
      throw new Error(`Booking ${bookingId} not found`);
    }

    if (!booking.escrowId) {
      throw new Error(`Booking ${bookingId} has no escrow`);
    }

    // Cancel any scheduled release
    await cancelEscrowRelease(booking.escrowId, this.escrowReleaseQueue);

    // Update booking status
    booking.status = 'disputed';
    await this.bookingRepo.update(booking);

    console.log(`[BookingsService] Cancelled scheduled release for disputed escrow ${booking.escrowId}`);
  }
}

/**
 * Example usage:
 * 
 * const bookingsService = new BookingsServiceWithEscrowRelease(
 *   bookingRepository,
 *   sorobanEscrowService,
 *   escrowReleaseQueue
 * );
 * 
 * // 1. Confirm booking with escrow (includes deadline)
 * await bookingsService.confirmBooking('booking-123', '100.00', 'USDC');
 * 
 * // 2. Complete session (schedules 48-hour delayed release)
 * await bookingsService.completeBooking('booking-123', 'learner');
 * 
 * // 3. If dispute opened, cancel scheduled release
 * await bookingsService.openDispute('booking-123', 'Service not delivered');
 */
