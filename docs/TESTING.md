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
