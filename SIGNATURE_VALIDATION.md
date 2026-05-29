# Signature Validation — Issue #405

## Overview

This document describes the meta-transaction (gasless transaction) signature
validation system implemented for MentorsMind contracts.  It covers the threat
model, the design of the `MetaTxPayload` envelope, nonce management, expiry
enforcement, and replay protection.

---

## Threat Model

A gasless transaction allows a **relayer** to submit a transaction on behalf of
a **signer** (e.g. a learner who has no XLM for fees).  The signer authorises
the operation off-chain; the relayer pays the fee and submits on-chain.

Without proper controls, an attacker can:

| Attack | Description |
|---|---|
| **Replay** | Re-submit a previously accepted signed payload to repeat an operation |
| **Cross-contract replay** | Submit a payload signed for contract A against contract B |
| **Cross-action replay** | Use a signature for `DeployEscrow` to authorise `ReleaseEscrow` |
| **Parameter substitution** | Change call parameters while keeping the signature valid |
| **Stale signature** | Submit a signature long after it was issued, when contract state has changed |
| **Long-lived signature** | Issue a signature with a far-future deadline, creating a persistent attack window |

---

## Implementation

### Module: `contracts/shared/src/sig_validation.rs`

The core utilities live in the `shared` crate so they can be reused by any
contract in the workspace.

#### `MetaTxPayload`

```rust
pub struct MetaTxPayload {
    pub contract_id: Address,   // prevents cross-contract replay
    pub nonce:       u64,       // per-user monotonic counter — prevents replay
    pub deadline:    u64,       // ledger timestamp after which the sig is invalid
    pub action:      MetaTxAction, // discriminant — prevents cross-action replay
    pub params_hash: BytesN<32>,   // commitment to call parameters
}
```

Every field is included in the value passed to `require_auth_for_args`, so the
Soroban host verifies that the signer's key pair signed **exactly** this
payload.  Changing any field produces a different value that the host will
reject.

#### `MetaTxAction`

```rust
pub enum MetaTxAction {
    DeployEscrow       = 0,
    ReleaseEscrow      = 1,
    CancelSubscription = 2,
    ClaimVested        = 3,
}
```

Add new variants here as new meta-transaction operations are introduced.

#### `validate_and_consume_nonce`

The main entry point.  Performs all checks in order and advances the nonce
atomically on success:

```
1. contract_id == env.current_contract_address()   → prevents cross-contract replay
2. payload.nonce == stored_nonce(signer)            → prevents replay
3. deadline > now + EXPIRY_TOLERANCE_SECS           → prevents expired payloads
4. deadline <= now + MAX_DEADLINE_SECS              → prevents long-lived signatures
5. signer.require_auth_for_args(payload)            → cryptographic verification (host)
6. stored_nonce += 1                                → atomic nonce advance
```

The nonce is advanced **after** the auth check so a failed auth does not
consume the nonce.

#### Constants

| Constant | Value | Purpose |
|---|---|---|
| `EXPIRY_TOLERANCE_SECS` | 60 s | Absorbs validator clock drift (~30 s on Stellar) |
| `MAX_DEADLINE_SECS` | 86 400 s (24 h) | Limits the stolen-signature window |

---

### Nonce Storage

Nonces are stored in **persistent storage** under the key
`(NONCE_PREFIX, signer_address)`.  Each `(contract, signer)` pair has an
independent nonce.  The nonce starts at 0 and increments by 1 on every
accepted meta-transaction.  Gaps are not allowed.

```
Key:   ("NONCE", Address)
Value: u64
```

---

### Cryptographic Verification

Soroban does not expose raw ECDSA/Ed25519 recovery inside a contract.
Instead, the platform's auth framework handles key-pair verification.
`require_auth_for_args(payload)` instructs the host to verify that the
signer's key pair authorised exactly the given `Val`.  This supports:

- Ed25519 keypairs (standard Stellar accounts)
- secp256k1 keypairs
- Multisig / policy accounts (via Soroban auth policies)

The contract does not need to implement any cryptographic primitives.

---

### Integration: `EscrowFactory::execute_meta_tx`

```rust
pub fn execute_meta_tx(
    env: Env,
    signer: Address,
    payload: MetaTxPayload,
    mentor: Address,
    learner: Address,
    amount: i128,
    token: Address,
    session_id: Symbol,
) -> Address
```

A relayer calls this to deploy an escrow on behalf of `signer`.  The function:

1. Checks `payload.action == MetaTxAction::DeployEscrow`
2. Calls `validate_and_consume_nonce` (all checks + nonce advance)
3. Delegates to `deploy_escrow` with the provided parameters

`get_nonce(signer)` is a read-only query that returns the current nonce for
off-chain clients building the next payload.

---

## Off-Chain Signing Flow

```
Client (learner)                    Relayer                     Contract
     |                                 |                            |
     |  1. GET /nonce?signer=<addr>    |                            |
     |-------------------------------->|                            |
     |                                 |  get_nonce(signer)         |
     |                                 |-------------------------->|
     |                                 |  <-- nonce: 42            |
     |  <-- nonce: 42                  |                            |
     |                                 |                            |
     |  2. Build MetaTxPayload:        |                            |
     |     contract_id = factory_addr  |                            |
     |     nonce       = 42            |                            |
     |     deadline    = now + 1h      |                            |
     |     action      = DeployEscrow  |                            |
     |     params_hash = SHA256(args)  |                            |
     |                                 |                            |
     |  3. Sign payload with keypair   |                            |
     |                                 |                            |
     |  4. POST /relay {payload, sig, args}                         |
     |-------------------------------->|                            |
     |                                 |  execute_meta_tx(...)      |
     |                                 |-------------------------->|
     |                                 |                            | validate_and_consume_nonce
     |                                 |                            | → host verifies sig
     |                                 |                            | → nonce 42 → 43
     |                                 |                            | → deploy_escrow(...)
     |                                 |  <-- escrow_address        |
     |  <-- escrow_address             |                            |
```

---

## Signature Requirements

When building a `MetaTxPayload` off-chain:

1. **Fetch the current nonce** via `get_nonce(signer_address)`.
2. **Set `contract_id`** to the exact address of the contract that will execute
   the meta-transaction.
3. **Set `deadline`** to `current_unix_time + desired_validity_window`.
   - Minimum: `now + EXPIRY_TOLERANCE_SECS + 1` (61 s)
   - Maximum: `now + MAX_DEADLINE_SECS` (24 h)
   - Recommended: `now + 3600` (1 hour) for interactive flows
4. **Set `action`** to the discriminant matching the intended operation.
5. **Compute `params_hash`** as SHA-256 of the ABI-encoded call parameters.
   This binds the signature to the exact arguments.
6. **Sign the payload** using the signer's Stellar keypair (Ed25519).
7. **Submit to the relayer** along with the raw call parameters.

---

## Test Coverage

### Unit tests in `contracts/shared/src/sig_validation.rs`

| Test | Scenario |
|---|---|
| `test_initial_nonce_is_zero` | Fresh signer starts at nonce 0 |
| `test_deadline_valid` | 1-hour deadline accepted |
| `test_deadline_exactly_at_tolerance_boundary_rejected` | Boundary case rejected |
| `test_deadline_in_past_rejected` | Past deadline rejected |
| `test_deadline_zero_rejected` | Zero deadline rejected |
| `test_deadline_beyond_max_rejected` | Deadline > 24 h rejected |
| `test_deadline_at_max_accepted` | Exactly 24 h accepted |
| `test_is_deadline_valid_*` | View function correctness |
| `test_contract_mismatch_rejected` | Cross-contract replay blocked |
| `test_wrong_nonce_rejected` | Wrong nonce blocked |
| `test_replay_same_nonce_rejected` | Direct replay blocked |
| `test_sequential_nonces_accepted` | 5 sequential nonces all accepted |
| `test_skipped_nonce_rejected` | Gap in nonce sequence blocked |
| `test_expired_payload_rejected` | Expired payload blocked |
| `test_deadline_too_far_rejected` | Long-lived signature blocked |
| `test_replay_after_nonce_advance` | Replay after nonce advance blocked |
| `test_cross_contract_replay_rejected` | Cross-contract replay blocked |
| `test_expired_payload_with_correct_nonce_rejected` | Stale payload blocked |
| `test_independent_nonces_per_signer` | Signers have isolated nonces |
| `test_nonce_not_consumed_on_deadline_failure` | Nonce unchanged on failure |

### Integration tests in `tests/sig_validation_tests.rs`

| Test | Scenario |
|---|---|
| `test_deadline_one_hour_ahead_valid` | Happy path deadline |
| `test_deadline_at_max_boundary_valid` | Ceiling boundary |
| `test_deadline_at_tolerance_boundary_rejected` | Tolerance boundary |
| `test_deadline_in_past_rejected` | Past deadline |
| `test_deadline_one_second_past_max_rejected` | One second over ceiling |
| `test_is_deadline_valid_*` | View function |
| `test_initial_nonce_zero_for_new_signer` | Initial state |
| `test_different_signers_have_independent_initial_nonces` | Isolation |
| `test_replay_consumed_nonce_rejected` | Direct replay |
| `test_attacker_replay_after_victim_nonce_advance` | Replay after advance |
| `test_cross_contract_replay_rejected` | Cross-contract replay |
| `test_action_discriminant_is_preserved_in_payload` | Action binding |
| `test_expired_payload_correct_nonce_rejected` | Stale payload |
| `test_nonce_unchanged_after_expired_payload` | Nonce not consumed on failure |
| `test_nonce_unchanged_after_contract_mismatch` | Nonce not consumed on mismatch |
| `test_sequential_nonces_all_accepted` | 10 sequential nonces |
| `test_skipped_nonce_rejected` | Gap in sequence |
| `test_two_signers_independent_nonces` | Signer isolation |
| `test_long_lived_signature_rejected` | 48-hour deadline blocked |
| `test_params_hash_distinguishes_payloads` | Parameter binding |
| `test_validator_drift_does_not_cause_premature_expiry` | Drift documentation |

---

## Residual Risk

| Risk | Mitigation |
|---|---|
| **Relayer censorship** | A malicious relayer can refuse to submit. Users can always submit directly. |
| **Nonce front-running** | A relayer could submit a different nonce-0 tx before the user's. Mitigated by the user signing a specific `params_hash`. |
| **Key compromise** | If the signer's key is compromised, all future nonces are at risk. No contract-level mitigation — key rotation is a wallet concern. |
| **Validator collusion** | A supermajority skewing the clock by > 60 s could cause premature expiry. Protocol-level risk. |
| **`params_hash` collision** | SHA-256 collision resistance is assumed. No known practical attacks. |
