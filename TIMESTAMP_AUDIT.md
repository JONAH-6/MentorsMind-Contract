# Timestamp Dependency Audit — Issue #404

## Background

Stellar validators can skew `env.ledger().timestamp()` by up to ~30 seconds relative to wall-clock time. A malicious or misconfigured validator could therefore:

- Cause a time-sensitive check to pass slightly early (forward drift)
- Delay a check from passing (backward drift)
- Accept a stale transaction whose timestamp parameters were crafted at an earlier time

This audit reviews every `env.ledger().timestamp()` call across the four target contracts, documents the assumptions made, adds tolerance windows, enforces duration bounds, and adds tests that simulate manipulated timestamps.

---

## Contracts Audited

| Contract | File | Primary timestamp use |
|---|---|---|
| Escrow Factory | `contracts/escrow_factory/src/lib.rs` | Session-end timestamp for auto-release |
| Vesting | `contracts/vesting/src/lib.rs` | Cliff and vesting-end boundaries |
| Timelock | `contracts/timelock/src/lib.rs` | `ready_at` delay enforcement |
| Subscription | `contracts/subscription/src/lib.rs` | Billing-date and expiry checks |

---

## Shared Timestamp Assumptions

1. **Ledger timestamp is the only clock.** There is no wall-clock access inside a Soroban contract. All time comparisons use `env.ledger().timestamp()`.
2. **Validator drift is bounded at ±30 s in practice.** We use a conservative tolerance of **60 seconds** (`TIMESTAMP_TOLERANCE_SECS`) to give a comfortable margin.
3. **Timestamps are monotonically non-decreasing** within a single ledger sequence. A transaction cannot observe a timestamp earlier than the previous ledger's timestamp.
4. **Caller-supplied timestamps are untrusted.** Any `start` or deadline value passed by a caller is validated against the current ledger time before use.

---

## Findings and Fixes

### 1. Escrow Factory — Session-End Timestamp

**File:** `contracts/escrow_factory/src/lib.rs`

**Before:** The session-end time was computed as `env.ledger().timestamp() + 24 * 60 * 60` with no bounds checking. A validator skewing the clock forward could shorten the effective session window.

**Fixes applied:**

- Added `MIN_SESSION_DURATION_SECS = 3600` (1 hour) and `MAX_SESSION_DURATION_SECS = 2592000` (30 days).
- `validate_future_timestamp` enforces that the computed window is within `[MIN + TOLERANCE, MAX]`. The tolerance is added to the minimum so that even worst-case forward drift leaves the window above the minimum.
- Added `validate_start_timestamp` to reject caller-supplied `start` values that are more than `MAX_PAST_START_SECS = 300` (5 minutes) from the current ledger time, preventing stale transaction replay.
- `DEFAULT_SESSION_DURATION_SECS = 86400` (24 hours) is used when deploying, which is well within the validated bounds.

**Constants:**
```rust
const MIN_SESSION_DURATION_SECS: u64 = 60 * 60;          // 1 hour
const MAX_SESSION_DURATION_SECS: u64 = 30 * 24 * 60 * 60; // 30 days
const DEFAULT_SESSION_DURATION_SECS: u64 = 24 * 60 * 60;  // 24 hours
pub const TIMESTAMP_TOLERANCE_SECS: u64 = 60;              // 1 minute
const MAX_PAST_START_SECS: u64 = 5 * 60;                   // 5 minutes
```

---

### 2. Vesting — Cliff and Vesting-End Boundaries

**File:** `contracts/vesting/src/lib.rs`

**Before:** No minimum or maximum duration guards on `cliff_seconds` or `vesting_seconds`. A caller-supplied `start` was accepted without validation. The cliff check used a raw `<` comparison with no tolerance.

**Fixes applied:**

- `MIN_VESTING_SECS = 86400` (1 day): vesting periods shorter than this are rejected. At 1 day, a 60-second drift is only 0.07% of the window — negligible.
- `MAX_VESTING_SECS = 315360000` (10 years): prevents accidental permanent locks.
- `MIN_CLIFF_SECS = 3600` (1 hour): non-zero cliffs shorter than this are rejected. Zero is still allowed (no cliff). This prevents a cliff so short that drift could collapse it entirely.
- Caller-supplied `start` (non-zero) is validated to be within `MAX_PAST_START_SECS = 300` seconds of the current ledger time.
- `claimable_amount` and `revoke` now use `cliff_end.saturating_add(TIMESTAMP_TOLERANCE_SECS)` as the cliff boundary. Tokens only become claimable once `current_time > cliff_end + TOLERANCE`, so a validator skewing the clock forward by up to 60 s cannot cause early cliff bypass.

**Constants:**
```rust
const MIN_CLIFF_SECS: u64 = 60 * 60;                       // 1 hour
const MIN_VESTING_SECS: u64 = 24 * 60 * 60;                // 1 day
const MAX_VESTING_SECS: u64 = 10 * 365 * 24 * 60 * 60;    // 10 years
pub const TIMESTAMP_TOLERANCE_SECS: u64 = 60;              // 1 minute
const MAX_PAST_START_SECS: u64 = 5 * 60;                   // 5 minutes
```

---

### 3. Timelock — Operation Readiness and Expiry

**File:** `contracts/timelock/src/lib.rs`

**Before:** `execute` checked `env.ledger().timestamp() >= op.ready_at` with no tolerance. There was no expiry — a scheduled operation could be executed arbitrarily far in the future, even after the contract state had changed in ways that made the operation unsafe.

**Fixes applied:**

- **Tolerance on readiness**: `execute` now requires `now >= ready_at + TIMESTAMP_TOLERANCE_SECS`. A validator skewing the clock forward by up to 60 s cannot execute an operation before the full delay has elapsed.
- **Operation expiry**: Operations must be executed within `OPERATION_EXPIRY_SECS = 1209600` (14 days) of their `ready_at` time. After that window, `execute` panics with `"operation expired"`. This prevents an attacker from holding a valid operation and executing it at an opportune moment.
- `is_operation_ready` updated to reflect both the tolerance and expiry checks.
- New `is_operation_expired` query function for off-chain monitoring.
- `ready_at` computation uses `checked_add` to prevent overflow.

**Constants:**
```rust
const MIN_DELAY: u64 = 48 * 60 * 60;                      // 48 hours (unchanged)
const MAX_DELAY: u64 = 30 * 24 * 60 * 60;                 // 30 days (unchanged)
pub const OPERATION_EXPIRY_SECS: u64 = 14 * 24 * 60 * 60; // 14 days (new)
pub const TIMESTAMP_TOLERANCE_SECS: u64 = 60;              // 1 minute (new)
```

---

### 4. Subscription — Billing Date and Expiry

**File:** `contracts/subscription/src/lib.rs`

**Before:** `renew` used a raw `<` comparison against `next_billing_date` with no tolerance. There was no expiry — a subscription could remain `Active` indefinitely without renewal, allowing sessions to be consumed on a lapsed subscription.

**Fixes applied:**

- **Renewal grace period**: `renew` allows renewal up to `RENEWAL_GRACE_SECS = 60` seconds *before* `next_billing_date`. This absorbs backward validator drift so a learner is not blocked from renewing on time.
- **Subscription expiry**: If `now >= next_billing_date + SUBSCRIPTION_EXPIRY_GRACE_SECS` (7 days), the subscription is lazily transitioned to `Expired` and renewal is rejected. The learner must create a new subscription.
- **`use_session` expiry check**: Before recording a session, the same expiry check is applied. Sessions cannot be consumed on a lapsed subscription.
- **`check_expiry` fallback**: A new public function allows off-chain systems (or anyone) to explicitly trigger the `Active → Expired` transition without waiting for a `use_session` or `renew` call.

**Constants:**
```rust
pub const RENEWAL_GRACE_SECS: u64 = 60;                        // 1 minute
pub const SUBSCRIPTION_EXPIRY_GRACE_SECS: u64 = 7 * 24 * 60 * 60; // 7 days
```

---

## Test Coverage

Each contract has dedicated timestamp manipulation tests:

### Escrow Factory (`timestamp_tests` module)
| Test | What it verifies |
|---|---|
| `test_future_timestamp_valid` | Normal 24 h window passes validation |
| `test_future_timestamp_not_future` | Same-block timestamp rejected |
| `test_future_timestamp_too_short` | 30 s window rejected |
| `test_future_timestamp_too_long` | 31-day window rejected |
| `test_start_timestamp_valid_now` | Current time accepted as start |
| `test_start_timestamp_valid_slight_past` | 2-minute-old start accepted |
| `test_start_timestamp_too_old` | 10-minute-old start rejected |
| `test_start_timestamp_too_future` | 10-minute-future start rejected |
| `test_drift_forward_still_valid` | Worst-case forward drift still passes |

### Vesting
| Test | What it verifies |
|---|---|
| `test_claimable_amount_at_cliff_boundary_with_tolerance` | Tokens are 0 at `cliff_end` and at `cliff_end + TOLERANCE`; positive only after |
| `test_manipulated_timestamp_cannot_bypass_cliff` | Forward drift of exactly TOLERANCE does not unlock tokens |
| `test_create_schedule_vesting_too_short` | Sub-day vesting rejected |
| `test_create_schedule_vesting_too_long` | 11-year vesting rejected |
| `test_create_schedule_cliff_too_short` | 30 s non-zero cliff rejected |
| `test_create_schedule_zero_cliff_allowed` | Explicit zero cliff permitted |
| `test_create_schedule_stale_start_rejected` | 10-minute-old start rejected |
| `test_create_schedule_future_start_rejected` | 10-minute-future start rejected |

### Timelock
| Test | What it verifies |
|---|---|
| `test_execute_before_ready_at_panics` | Execution at exactly `ready_at` blocked |
| `test_execute_at_ready_at_plus_tolerance_minus_one_panics` | One second before tolerance clears is blocked |
| `test_manipulated_timestamp_cannot_execute_early` | Forward drift of exactly TOLERANCE is blocked |
| `test_execute_after_expiry_panics` | Execution past expiry window rejected |
| `test_is_operation_expired` | Expiry query reflects correct state |
| `test_is_operation_ready_respects_tolerance` | Ready query respects tolerance boundary |

### Subscription
| Test | What it verifies |
|---|---|
| `test_renew_within_grace_period` | Renewal succeeds at `billing_date - GRACE` |
| `test_renew_too_early_panics` | Renewal well before grace window rejected |
| `test_renew_after_expiry_panics` | Renewal after expiry transitions to Expired and panics |
| `test_use_session_after_expiry_panics` | Session use after expiry transitions to Expired and panics |
| `test_check_expiry_transitions_to_expired` | Explicit expiry check transitions state |
| `test_check_expiry_no_op_when_active` | Expiry check is no-op when subscription is current |
| `test_manipulated_timestamp_cannot_renew_early` | Forward drift just below grace window is blocked |

---

## Fallback Mechanisms

| Contract | Fallback |
|---|---|
| Escrow Factory | Session-end is always derived from `now + DEFAULT_SESSION_DURATION_SECS`; caller cannot supply an arbitrary end time |
| Vesting | `start = 0` falls back to `current_time`; no caller-controlled timestamp reaches the schedule without validation |
| Timelock | Expired operations can be cancelled by admin; `is_operation_expired` allows off-chain detection |
| Subscription | `check_expiry` allows anyone to trigger the `Active → Expired` transition; lazy expiry in `use_session` and `renew` ensures state is always consistent |

---

## Residual Risk

- **Validator collusion**: If a supermajority of validators collude to skew the clock by more than 60 s, the tolerance windows can be bypassed. This is a protocol-level risk outside the scope of contract-level mitigations.
- **Long-running operations (Timelock)**: The 14-day expiry window is a trade-off. Operations that are legitimately delayed (e.g., due to a network outage) may expire. Admins should monitor `is_operation_expired` and reschedule if needed.
- **Subscription expiry grace (7 days)**: A learner who forgets to renew has 7 days before the subscription lapses. This is intentionally generous to avoid penalising users for minor delays.
