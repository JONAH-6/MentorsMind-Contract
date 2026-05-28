-- Canonical schema for MentorMinds backend.
-- Apply migrations in numbered order; this file reflects the cumulative state.

-- ── transactions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id               SERIAL PRIMARY KEY,
  user_id          VARCHAR(255)  NOT NULL,
  amount           VARCHAR(50)   NOT NULL,
  destination      VARCHAR(56)   NOT NULL,
  status           VARCHAR(20)   NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'completed', 'failed')),
  transaction_hash VARCHAR(64),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id     ON transactions (user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_destination ON transactions (destination);
CREATE INDEX IF NOT EXISTS idx_transactions_status      ON transactions (status);

-- ── escrows (033_create_escrows) ─────────────────────────────────────────────
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
  release_attempts  INTEGER       NOT NULL DEFAULT 0,
  last_release_attempt_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_escrows_learner_id ON escrows (learner_id);
CREATE INDEX IF NOT EXISTS idx_escrows_mentor_id  ON escrows (mentor_id);
CREATE INDEX IF NOT EXISTS idx_escrows_status     ON escrows (status);
CREATE INDEX IF NOT EXISTS idx_escrows_auto_release 
  ON escrows (status, created_at, release_attempts, last_release_attempt_at)
  WHERE status IN ('funded', 'pending');
