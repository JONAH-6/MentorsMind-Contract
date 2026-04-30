-- Migration: 035_add_booking_id_to_escrows
-- Fix #368: Add booking_id column to escrows table so each escrow is linked
-- to the booking that originated it. Previously, the Soroban contract received
-- the escrow's own DB UUID as the booking reference (circular reference).

ALTER TABLE escrows
  ADD COLUMN IF NOT EXISTS booking_id VARCHAR(255);

-- Back-fill existing rows with a sentinel so NOT NULL can be enforced going forward.
-- Rows created before this migration have no real booking reference.
UPDATE escrows SET booking_id = 'legacy-' || id::text WHERE booking_id IS NULL;

ALTER TABLE escrows
  ALTER COLUMN booking_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_escrows_booking_id ON escrows (booking_id);

COMMENT ON COLUMN escrows.booking_id IS
  'Foreign key to the bookings table. Passed to the Soroban contract as the booking reference so on-chain escrows can be traced back to the originating booking.';
