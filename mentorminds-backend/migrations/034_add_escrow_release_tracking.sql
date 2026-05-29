-- Migration: 034_add_escrow_release_tracking
-- Adds columns to track auto-release attempts and prevent infinite retries
-- Fixes issue #260: escrowCheckWorker has no upper bound on escrow age

-- Add release attempt tracking columns
ALTER TABLE escrows
  ADD COLUMN IF NOT EXISTS release_attempts INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS last_release_attempt_at TIMESTAMPTZ;

-- Add index for efficient querying of escrows eligible for auto-release
CREATE INDEX IF NOT EXISTS idx_escrows_auto_release 
  ON escrows (status, created_at, release_attempts, last_release_attempt_at)
  WHERE status IN ('funded', 'pending');

-- Add comment explaining the columns
COMMENT ON COLUMN escrows.release_attempts IS 
  'Number of times auto-release has been attempted. Max 5 attempts before flagging as stuck.';
COMMENT ON COLUMN escrows.last_release_attempt_at IS 
  'Timestamp of last auto-release attempt. Used for cooldown period (1 hour) between retries.';
