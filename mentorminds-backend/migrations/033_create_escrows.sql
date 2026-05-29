-- Migration: 033_create_escrows
-- Creates the escrows table used by EscrowModel.
-- This replaces any runtime CREATE TABLE IF NOT EXISTS calls that were
-- previously in EscrowModel.initializeTable().

CREATE TABLE IF NOT EXISTS escrows (
  id                SERIAL PRIMARY KEY,
  session_id        VARCHAR(255)  NOT NULL UNIQUE,
  learner_id        VARCHAR(255)  NOT NULL,
  mentor_id         VARCHAR(255)  NOT NULL,
  amount            NUMERIC(20,7) NOT NULL CHECK (amount > 0),
  token             VARCHAR(12)   NOT NULL DEFAULT 'XLM',
  status            VARCHAR(20)   NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'released', 'disputed', 'refunded', 'resolved')),
  stellar_tx_hash   VARCHAR(64),
  dispute_reason    TEXT,
  resolved_at       TIMESTAMPTZ,
  released_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_escrows_learner_id ON escrows (learner_id);
CREATE INDEX IF NOT EXISTS idx_escrows_mentor_id  ON escrows (mentor_id);
CREATE INDEX IF NOT EXISTS idx_escrows_status     ON escrows (status);
