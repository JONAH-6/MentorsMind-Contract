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
