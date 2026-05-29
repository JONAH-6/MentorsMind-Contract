# Fee Calculation Testing

This document describes the testing scenarios and verification steps for the fee calculation logic in the MentorMinds contract ecosystem, particularly covering `escrow` and `payment_router` contracts.

## Overview

Fee calculation logic is pivotal to platform economics. The maximum allowable fee across the platform is hardcapped at 10% (1,000 basis points). All fees are calculated using integer math to ensure deterministic results across the Soroban VM, applying standard truncation (rounding down) as typical in blockchain arithmetic.

## Test Cases Covered

The `tests/fees/mod.rs` integration test suite validates the following scenarios:

### 1. Various Fee Percentages
The calculation logic is tested against the following standard fee percentages:
- **1%** (100 bps)
- **2.5%** (250 bps)
- **5%** (500 bps)
- **10%** (1000 bps)

### 2. Various Principal Amounts
To ensure precision scaling, fee scenarios run against a matrix of base amounts ranging from small values (e.g., `100` units) to large values (e.g., `1,000,000` units).

### 3. Edge Cases
- **Zero Fee Scenario**: Validates that when fee basis points are configured to `0`, the calculated fee is strictly `0` with no transaction panics or math errors.
- **Maximum Fee Scenario**: Asserts that calculating fees at the extreme maximum (10% / 1000 bps) behaves properly and correctly limits platform extraction.

### 4. Precision and Rounding
Since the calculation executes as `(amount * fee_bps) / 10000`, the tests verify that fractional units are appropriately truncated. 
- *Example*: A 2.5% fee on a principal of `105` mathematically evaluates to `2.625`. The tests verify that the smart contract calculates this strictly as `2`.

## Execution
To run the fee calculation tests, invoke the standard `cargo test` command in the `MentorsMind-Contract` root directory:
```bash
cargo test --package mentorminds-integration-tests --test integration_test fees::
```

---

# Token Approval Testing

This section details the testing scenarios for the token whitelist management logic in the `escrow` and `treasury` contracts. Ensuring only approved tokens are allowed for operations guarantees compliance and avoids exposure to malicious or unsupported assets.

## Overview

Token whitelists restrict contract interactions to pre-approved Stellar assets. Both the `escrow` contract (during session creation) and the `treasury` contract (during deposits) strictly enforce this check.

## Test Cases Covered

The `tests/token_approval/mod.rs` integration test suite validates the following critical paths:

### 1. Token Approval by Admin
Verifies that only an authorized admin can add a token to the whitelist by calling `set_approved_token(&token_address, &true)`. Once added, `is_token_approved` correctly evaluates to `true` on both the `escrow` and `treasury` contracts.

### 2. Token Rejection / Removal by Admin
Confirms that an admin can dynamically revoke a previously approved token using `set_approved_token(&token_address, &false)`. Subsequent checks on the token yield `false`.

### 3. Escrow Creation with Approved Tokens
Tests the happy path where a learner successfully creates a session escrow (`create_escrow`) funded with a token that exists on the whitelist. The contract effectively transfers the token and successfully provisions the escrow.

### 4. Escrow Creation with Unapproved Tokens (Fails)
Tests the failure path by deliberately attempting to initialize an escrow with an unapproved or removed token. The transaction accurately reverts/panics with the `Token not approved` constraint error.

## Execution
To run the token approval tests, invoke the standard `cargo test` command in the `MentorsMind-Contract` root directory:
```bash
cargo test --package mentorminds-integration-tests --test integration_test token_approval::
```

---

# Partial Release Testing

This section outlines the testing scenarios for multi-session partial release logic in the `escrow` contract. Partial releases allow mentors to withdraw funds incrementally upon the completion of individual sessions within a multi-session engagement, without waiting for the entire package to conclude.

## Overview

When an escrow is created for a bundle of sessions (`total_sessions > 1`), funds are initially locked. `release_partial` calculates the proportionate share for a single session, deducts the applicable platform fee, and transfers the net amount to the mentor. The final session triggers a state transition on the escrow to `Released`.

## Test Cases Covered

The `tests/partial_release/mod.rs` integration test suite validates the following multi-session scenarios:

### 1. Partial Release for 2-Session Escrow
Verifies the math and state transitions for a simple 2-session bundle. The first release correctly transfers 50% of the principal and fees, incrementing `sessions_completed`. The second release transfers the remainder and correctly finalizes the escrow status to `Released`.

### 2. Partial Release for 5-Session Escrow
Validates sequential iterative releases over a larger `total_sessions` scale. Checks that iterating `release_partial` correctly loops until completion without panic or state corruption.

### 3. Partial Release for 10-Session Escrow
Ensures the integer math safely computes fractional divisions correctly without losing precision or locking residual dust in the contract for a 10-session package. 

### 4. Sequential Partial Releases & State Finality
Validates that calling `release_partial` after the maximum number of sessions have been completed results in an appropriate failure (`Completed`). Ensures double-releases are mechanically impossible.

### 5. Partial Release with Disputes
Tests the intersection of partial releases and the dispute resolution state machine. For example, verifying a scenario where session 1 completes successfully (mentor gets paid) but session 2 falls into dispute. It validates that the correct unreleased remainder is successfully refunded to the learner without interfering with the funds already released.

## Execution
To run the partial release tests, invoke the standard `cargo test` command in the `MentorsMind-Contract` root directory:
```bash
cargo test --package mentorminds-integration-tests --test integration_test partial_release::
```

---

# Refund Testing

This section documents the scenarios for testing standard, partial, and yield-bearing refund logic within the `escrow` contract. Ensuring robust refund handling guarantees capital protection across all potential escrow states.

## Overview

Refund operations are generally invoked by the platform admin in the event of unresolvable disputes, cancellations, or SLA breaches. Testing confirms that funds are properly remitted to the `learner` while respecting the integrity of the state machine. 

## Test Cases Covered

The `tests/refund/mod.rs` integration test suite validates the following critical paths:

### 1. Refund from Active State
Validates the standard cancellation path where an admin refunds a freshly created (Active/Pending) escrow. The full principal is transferred back to the learner, and the escrow is marked as `Refunded`.

### 2. Refund after Dispute Resolution
Tests refund behavior when an escrow enters a `Disputed` state. Ensures that invoking a refund correctly overrides the dispute, returns funds to the learner, and finalizes the escrow to `Refunded`.

### 3. Partial Refund Scenarios
Verifies the custom `partial_refund` functionality. Confirms that issuing a partial refund deducts from the principal and transfers the specific amount back to the learner, while keeping the escrow `Active` until the remainder is fully drained.

### 4. Refund with Yield
Tests the `refund_with_yield` logic, allowing the admin to return the base principal along with accrued yield (e.g., from external staking). Confirms that both the principal and the specified yield value are transferred accurately.

### 5. Authorization Checks
Asserts that only the authorized `Admin` can trigger a refund. Unauthorized callers correctly encounter panic conditions, preserving the immutable security of the locked capital.

## Execution
To run the refund tests, invoke the standard `cargo test` command in the `MentorsMind-Contract` root directory:
```bash
cargo test --package mentorminds-integration-tests --test integration_test refund::
```
