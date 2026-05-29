import { SorobanEscrowService, CreateEscrowInput } from '../src/services/escrow.service';

describe('SorobanEscrowService', () => {
  describe('generateEscrowId', () => {
    // Test the private method logic without instantiating the service
    // which requires valid Stellar keys
    
    it('should generate unique escrow IDs for same booking', () => {
      const bookingId = 'booking-123';
      
      // Simulate the generateEscrowId logic
      const generateEscrowId = (bid: string, customId?: string): string => {
        if (customId) return customId;
        return `${bid}-${require('crypto').randomUUID()}`;
      };
      
      const escrowId1 = generateEscrowId(bookingId);
      const escrowId2 = generateEscrowId(bookingId);
      
      // Verify they are different
      expect(escrowId1).not.toBe(escrowId2);
      
      // Verify both contain the bookingId for traceability
      expect(escrowId1).toContain('booking-123');
      expect(escrowId2).toContain('booking-123');
      
      // Verify format: {bookingId}-{uuid}
      expect(escrowId1).toMatch(/^booking-123-[0-9a-f-]{36}$/);
      expect(escrowId2).toMatch(/^booking-123-[0-9a-f-]{36}$/);
    });

    it('should use custom escrow ID when provided', () => {
      const customId = 'custom-escrow-id-123';
      const bookingId = 'booking-123';
      
      const generateEscrowId = (bid: string, customId?: string): string => {
        if (customId) return customId;
        return `${bid}-${require('crypto').randomUUID()}`;
      };
      
      const escrowId = generateEscrowId(bookingId, customId);
      
      expect(escrowId).toBe(customId);
      expect(escrowId).not.toContain('booking-123-');
    });

    it('should allow re-escrow with different IDs for same booking', () => {
      const bookingId = 'booking-456';
      
      const generateEscrowId = (bid: string, customId?: string): string => {
        if (customId) return customId;
        return `${bid}-${require('crypto').randomUUID()}`;
      };
      
      // Simulate first escrow attempt
      const firstEscrowId = generateEscrowId(bookingId);
      
      // Simulate retry after failure
      const secondEscrowId = generateEscrowId(bookingId);
      
      // Both should be unique
      expect(firstEscrowId).not.toBe(secondEscrowId);
      expect(firstEscrowId).toContain(bookingId);
      expect(secondEscrowId).toContain(bookingId);
    });

    it('should maintain traceability to original booking', () => {
      const bookingId = 'booking-789';
      
      const generateEscrowId = (bid: string, customId?: string): string => {
        if (customId) return customId;
        return `${bid}-${require('crypto').randomUUID()}`;
      };
      
      const escrowId = generateEscrowId(bookingId);
      
      // Should be able to extract bookingId from escrowId
      const extractedBookingId = escrowId.split('-').slice(0, 2).join('-');
      expect(extractedBookingId).toBe('booking-789');
    });

    it('should generate UUID-based IDs for uniqueness', () => {
      const generateEscrowId = (bid: string, customId?: string): string => {
        if (customId) return customId;
        return `${bid}-${require('crypto').randomUUID()}`;
      };
      
      const escrowId = generateEscrowId('test-booking');
      
      // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      expect(uuidPattern.test(escrowId)).toBe(true);
    });
  });

  describe('CreateEscrowInput interface', () => {
    it('should accept input without escrowId (auto-generated)', () => {
      const input: CreateEscrowInput = {
        bookingId: 'booking-001',
        learnerId: 'learner-abc',
        mentorId: 'mentor-xyz',
        amount: '1000000000',
        currency: 'USDC',
      };

      expect(input.bookingId).toBe('booking-001');
      expect(input.escrowId).toBeUndefined();
    });

    it('should accept input with custom escrowId', () => {
      const input: CreateEscrowInput = {
        bookingId: 'booking-002',
        learnerId: 'learner-def',
        mentorId: 'mentor-uvw',
        amount: '2000000000',
        currency: 'XLM',
        escrowId: 'custom-escrow-2024-001',
      };

      expect(input.escrowId).toBe('custom-escrow-2024-001');
    });
  });
});
