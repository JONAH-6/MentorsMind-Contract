-- Migration: 035_add_partial_refund_support
-- Adds partial_refund status and split amount columns to support
-- dispute resolutions where funds are split between mentor and learner.
-- Fixes issue #305: resolveDispute only supported 0% or 100% outcomes.

-- Add partial_refund to the status check constraint
ALTER TABLE escrows
  DROP CONSTRAINT IF EXISTS escrows_status_check;

ALTER TABLE escrows
  ADD CONSTRAINT escrows_status_check
    CHECK (status IN ('active', 'released', 'disputed', 'refunded', 'partial_refund', 'resolved'));

-- Add columns to record the split amounts for partial refunds
ALTER TABLE escrows
  ADD COLUMN IF NOT EXISTS mentor_payout_amount NUMERIC(20,7),
  ADD COLUMN IF NOT EXISTS learner_refund_amount NUMERIC(20,7);

COMMENT ON COLUMN escrows.mentor_payout_amount IS
  'Amount paid out to the mentor when a dispute is resolved with a partial split.';
COMMENT ON COLUMN escrows.learner_refund_amount IS
  'Amount refunded to the learner when a dispute is resolved with a partial split.';

-- Add escrow_id + type index on transactions for efficient lookup of split records
CREATE INDEX IF NOT EXISTS idx_escrow_transactions_escrow_id
  ON transactions (user_id)
  WHERE status = 'completed';
