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

## Fee Distribution Strategy

Every escrow release deducts a platform fee from the gross amount. That fee is then
split across four destinations according to fixed basis-point allocations.

### Fee Percentages

| Destination | Allocation | Basis Points | Contract |
|---|---|---|---|
| Treasury (platform revenue) | 80% of fee | configurable via `fee_bps` | `contracts/treasury` |
| Referral rewards | 10% of fee | 1000 bps of fee | `contracts/referral` |
| Insurance pool | 10% of fee | 1000 bps of fee | `contracts/insurance` |

The top-level `fee_bps` is set at initialization (default 500 bps = 5% of escrow amount,
capped at 1000 bps = 10%). Dynamic fee adjustment based on MNT/USDC price is supported
via `get_dynamic_fee`.

### Distribution Flow

```
escrow.amount
    └─ platform_fee  (amount × fee_bps / 10_000)
    │       ├─ 80% → treasury.deposit()
    │       ├─ 10% → referral.distribute_from_fee()   (reward_bps = 1000)
    │       └─ 10% → insurance.accrue_yield()          (YIELD_BPS = 10 bps of fee)
    └─ net_amount    (amount − platform_fee) → mentor
```

A `FeeDistributed` event is emitted on every release with the full breakdown so
off-chain indexers can track revenue without reading contract storage.

### Contract Responsibilities

- **`escrow`**: calculates `platform_fee` and `net_amount`, transfers both, emits
  `EscrowReleased` and `FeeDistributed` events.
- **`treasury`** (`contracts/treasury/src/lib.rs`): receives the platform share via
  `deposit`; admin can `allocate` or `distribute_to_stakers`.
- **`referral`** (`contracts/referral/src/lib.rs`): `distribute_from_fee(referrer,
  platform_fee, reward_bps)` adds `platform_fee × reward_bps / 10_000` to the
  referrer's pending MNT rewards.
- **`insurance`** (`contracts/insurance/src/lib.rs`): `accrue_yield(provider,
  platform_fee)` credits 0.1% of the fee (10 bps) to the provider's pool shares.

### Fee Events

```rust
// Emitted by escrow._do_release on every release
pub struct FeeDistributedEventData {
    pub escrow_id:      u64,
    pub gross_amount:   i128,
    pub platform_fee:   i128,
    pub net_amount:     i128,
    pub token_address:  Address,
}
```
