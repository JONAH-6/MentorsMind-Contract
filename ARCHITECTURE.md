# MentorsMind Contract Architecture

This document describes the security and upgrade architecture of the MentorsMind Soroban smart contracts.

---

## 1. Multi-Signature Admin (`contracts/multisig_admin`)

### Overview

Critical admin operations require approval from multiple trusted signers before execution. This prevents any single compromised key from affecting the platform.

### Configuration

| Mode   | Signers | Threshold | Use case                        |
|--------|---------|-----------|----------------------------------|
| 2-of-3 | 3       | 2         | Small team / testnet             |
| 3-of-5 | 5       | 3         | Production / mainnet             |

The threshold is configurable and can itself be changed via a multi-sig proposal.

### Proposal Lifecycle

```
propose_action()  →  sign_action() × N  →  execute_action()
                                        ↘  cancel_action()
```

1. Any signer calls `propose_action(target, function, args)` — auto-counts as 1 approval.
2. Other signers call `sign_action(proposal_id)` until the threshold is met.
3. Anyone calls `execute_action(proposal_id)` once threshold is reached.
4. Any signer (or the proposer) may call `cancel_action(proposal_id)` before execution.

Proposals expire after **7 days** if not executed.

### Self-Targeted Operations

When `target == multisig_contract_address`, the following internal operations are supported:

| Function           | Effect                                      |
|--------------------|---------------------------------------------|
| `add_signer`       | Add a new signer address                    |
| `remove_signer`    | Remove a signer (cannot drop below threshold) |
| `update_threshold` | Change the approval threshold               |

### External Operations

For any other target, `execute_action` calls `env.invoke_contract(target, function, args)`. This is how the multisig controls escrow fee changes, treasury allocations, and admin transfers.

### Events

| Event topic                          | Data                          |
|--------------------------------------|-------------------------------|
| `(multisig, init)`                   | `(signer_count, threshold)`   |
| `(multisig, proposed, id)`           | `(proposer, expiry)`          |
| `(multisig, signed, id)`             | `(signer, approval_count)`    |
| `(multisig, executed, id)`           | `(id, target, function)`      |
| `(multisig, cancelled, id)`          | `caller`                      |
| `(multisig, sgn_add, address)`       | `new_count`                   |
| `(multisig, sgn_rm, address)`        | `new_count`                   |
| `(multisig, thresh, new_threshold)`  | `old_threshold`               |

---

## 2. Timelock (`contracts/timelock`)

### Overview

Critical operations (fee changes, treasury updates, admin transfers) are subject to a mandatory delay, giving the community time to review and react before changes take effect.

### Delay Bounds

| Parameter   | Value  | Rationale                              |
|-------------|--------|----------------------------------------|
| `MIN_DELAY` | 24h    | Minimum community review window        |
| `MAX_DELAY` | 30 days| Prevents indefinitely pending ops      |

Fee changes and treasury updates use **24–48h** delays. Admin transfers use **48h**.

### Operation Lifecycle

```
schedule(target, fn, args, delay)  →  [delay elapses]  →  execute(op_id)
                                   ↘  cancel(op_id)
```

1. Any caller schedules an operation with a delay in `[MIN_DELAY, MAX_DELAY]`.
2. After `ready_at = now + delay`, anyone can call `execute(op_id)`.
3. The admin (or proposer) can cancel before execution.

### Integration Pattern

To enforce timelock on escrow fee changes:

```rust
// Off-chain: schedule the fee change
timelock.schedule(caller, escrow_contract, "update_fee", [new_fee], 24h);

// After 24h: execute
timelock.execute(op_id);
// → calls escrow.update_fee(new_fee)
```

### Events

| Event topic                          | Data                              |
|--------------------------------------|-----------------------------------|
| `(timelock, init)`                   | `admin`                           |
| `(timelock, sched, op_id)`           | `(caller, target, function, delay)` |
| `(timelock, exec, op_id)`            | `true`                            |
| `(timelock, cancel, op_id)`          | `true`                            |
| `(timelock, adm_xfr)`               | `(old_admin, new_admin)`          |

---

## 3. UUPS Upgrade Registry (`contracts/upgrade_registry`)

### Overview

MentorsMind uses the **UUPS (Universal Upgradeable Proxy Standard)** pattern adapted for Soroban. The upgrade logic lives inside the contract itself, authorized by the admin. After an upgrade, the contract at the same address runs new WASM code while all storage is preserved.

### UUPS vs Transparent Proxy

Soroban does not have a traditional proxy/implementation split. Instead, `env.deployer().update_current_contract_wasm(new_hash)` replaces the WASM at the current contract address. This is equivalent to UUPS:

- Upgrade authorization is enforced inside the contract (admin `require_auth`).
- No separate proxy contract needed.
- Storage layout is preserved across upgrades.

### Upgrade Flow

```
1. Build new WASM → upload → get new_wasm_hash
2. Admin calls upgrade_contract(new_wasm_hash, contract_name, new_version, changelog_hash)
3. Registry records the upgrade history
4. env.deployer().update_current_contract_wasm(new_wasm_hash) swaps the code
5. Contract now runs new code at the same address
```

### Registry Functions

| Function              | Description                                          |
|-----------------------|------------------------------------------------------|
| `upgrade_contract`    | UUPS upgrade: swap WASM + record history (admin only)|
| `register_upgrade`    | Record an external contract upgrade (admin only)     |
| `subscribe`           | Subscribe to upgrade notifications                   |
| `unsubscribe`         | Unsubscribe from notifications                       |
| `get_upgrade_history` | Full upgrade history for a contract                  |
| `get_latest_version`  | Current version number                               |
| `get_subscribers`     | Notification subscribers                             |

### Storage Gap

Because Soroban storage is key-value (not slot-based), there is no storage collision risk between versions. New fields are simply new keys. Old keys remain readable with their original values. The `SchemaVersion` key in `InstanceKey` tracks breaking storage changes.

### Events

| Event topic                          | Data                                          |
|--------------------------------------|-----------------------------------------------|
| `(upgrade, init)`                    | `admin`                                       |
| `(upgrade, uups, contract_name)`     | `(old_ver, new_ver, wasm_hash, changelog)`    |
| `(upgrade, reg, contract_name)`      | `(old_ver, new_ver, changelog_hash)`          |
| `(sub, added, contract_name)`        | `subscriber`                                  |
| `(sub, removed, contract_name)`      | `subscriber`                                  |

---

## 4. Eternal Storage (`contracts/shared/src/storage.rs`)

### Overview

The eternal storage pattern separates storage layout from contract logic. All storage access goes through typed key enums, making the layout explicit, auditable, and upgrade-safe.

### Storage Tiers

| Tier        | Soroban API              | Use case                                      | Cost   |
|-------------|--------------------------|-----------------------------------------------|--------|
| Instance    | `storage().instance()`   | Config read on every call (admin, fee, flags) | Low    |
| Persistent  | `storage().persistent()` | Per-entity records (escrows, proposals)       | Medium |
| Temporary   | `storage().temporary()`  | Nonces, rate limits, reentrancy locks         | Lowest |

### Key Enums

```rust
// Instance keys (config)
InstanceKey::Admin
InstanceKey::PlatformFee
InstanceKey::Paused
InstanceKey::SchemaVersion
InstanceKey::Threshold        // multisig
InstanceKey::SignerCount      // multisig
InstanceKey::ProposalCount    // multisig
InstanceKey::OpCount          // timelock

// Persistent keys (records)
PersistentKey::Escrow(u64)
PersistentKey::Signer(Address)
PersistentKey::Proposal(u32)
PersistentKey::Approval(u32, Address)
PersistentKey::TimelockOp(BytesN<32>)
PersistentKey::UpgradeHistory(Symbol)
PersistentKey::LatestVersion(Symbol)
PersistentKey::Subscribers(Symbol)
PersistentKey::AllocHistory
PersistentKey::Custom(Symbol)   // extensibility

// Temporary keys (short-lived)
TempKey::ReentrancyLock(Symbol)
TempKey::RateLimit(Address, u64)
TempKey::Nonce(Address)
```

### Usage

```rust
use shared::storage::{EternalStorage, InstanceKey, PersistentKey};

// Write
EternalStorage::set_instance(&env, &InstanceKey::PlatformFee, &500u32);
EternalStorage::set_persistent(&env, &PersistentKey::Escrow(id), &escrow);

// Read
let fee: u32 = EternalStorage::get_instance(&env, &InstanceKey::PlatformFee)
    .unwrap_or(500);

// Remove (migration)
EternalStorage::remove_persistent(&env, &PersistentKey::Custom(old_key));
```

### Upgrade Safety

- Adding new `PersistentKey` variants is always safe — old data is unaffected.
- Renaming or removing keys requires a migration step (read old key, write new key, remove old key).
- Increment `InstanceKey::SchemaVersion` on any breaking storage change.

---

## Security Considerations

### Multi-Sig + Timelock Composition

For maximum security, combine both:

```
Multisig.propose_action(timelock, "schedule", [escrow, "update_fee", [new_fee], 48h])
→ 3-of-5 signers approve
→ Multisig.execute_action() calls timelock.schedule(...)
→ 48h passes
→ Anyone calls timelock.execute(op_id)
→ escrow.update_fee(new_fee) executes
```

This means fee changes require both multi-sig consensus AND a 48h community review window.

### Emergency Cancel

The timelock admin (which should be the multisig) can cancel any pending operation before it executes. This is the emergency mechanism for blocking malicious or erroneous operations.

### Upgrade Authorization

`upgrade_contract` requires admin auth. In production, the admin should be the multisig contract, so upgrades require 3-of-5 approval before the WASM swap occurs.
# MentorMinds Contract Architecture

This document describes system architecture, contract relationships, data flow, and deployment topology for MentorMinds on Stellar Soroban.

## Architecture Diagrams

- System context / C4 L1: `docs/diagrams/system_architecture.png`
- Contract relationship map / UML component-style: `docs/diagrams/contract_relationships.png`
- Escrow-centric data flow: `docs/diagrams/data_flow.png`
- Deployment topology (testnet/mainnet): `docs/diagrams/deployment_architecture.png`

## System Context (C4 L1)

Primary actors and systems:
- Learner and Mentor clients (wallet-backed)
- MentorMinds backend services (indexing, orchestration)
- Soroban smart contracts (escrow core + supporting modules)
- Stellar network (testnet/mainnet)

Trust boundaries:
- User wallet boundary (signature authority)
- Off-chain backend boundary (read/index/automation)
- On-chain execution boundary (state + funds)

## Contract Relationship View

Core contracts:
- `escrow`: lifecycle state + fund custody logic
- `verification`: mentor verification state
- `mnt_token`: token/utility integration

Supporting contracts (examples):
- `reputation`: consumes escrow completion status for reviews
- `dispute_evidence`: accepts evidence only while escrow is disputed
- `health_dashboard`: aggregates metrics across contracts
- `escrow_factory`: deployment/orchestration for escrow instances

Yield architecture:
- `lending_pool` acts as the dedicated yield contract for pooled liquidity operations.
- Yield lifecycle is explicit: protocol accrues yield, then distributes lender-share LP value through yield distribution calls.
- `interface_registry` exposes canonical `yield_v1` registration and lookup so escrow and other contracts can resolve the active yield contract address/version without hard-coding IDs.

Design rule:
- Cross-contract consumers mirror escrow struct/status fields for decode stability.

## Data Flow View

Escrow lifecycle flow:
1. Learner creates escrow (`Active`) and funds are locked.
2. Session completes; escrow is released manually or via timeout.
3. If contested, escrow enters `Disputed` and evidence/arbitration flows run.
4. Final outcome transitions to a terminal state (`Released`, `Refunded`, `Resolved`).
5. Downstream contracts (reputation, analytics, dashboards) consume finalized outcomes.

Operational flow:
1. Contracts are deployed via `scripts/deploy.sh`.
2. Addresses and metadata are persisted in `deployed/<network>.json`.
3. Backend/services read deployment metadata to configure environment-specific contract bindings.

## Deployment Architecture

Environments:
- Testnet for development/integration
- Mainnet for production

Per-environment deployment includes:
- Distinct contract IDs
- Distinct admin identity and treasury settings
- Distinct deployment metadata file (`deployed/testnet.json`, `deployed/mainnet.json`)

Deployment controls:
- Parameterized initialization (`fee_bps`, `auto_release_delay_secs`, approved tokens)
- Optional skip flags for build/fund/init/verify
- Optional forced redeploy for fresh IDs

## Diagram Maintenance

Keep diagrams aligned with code and docs when:
- new contracts are introduced
- escrow status model changes
- deployment workflow changes

Update paths:
- diagram files under `docs/diagrams/`
- related docs: `docs/STATE_MACHINE.md`, `docs/DEPLOYMENT_GUIDE.md`, `README.md`
