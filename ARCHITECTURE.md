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

Dispute resolution architecture:
- `dispute_evidence` stores bounded evidence items per disputed escrow and immutable dispute resolution records.
- `governance` manages arbitrator registration, active arbitrator discovery, and deterministic arbitrator selection for dispute IDs.
- `escrow` consumes arbitration outcomes to transition disputed escrows into terminal resolution states.
- Event stream includes `evidence_submitted` and `dispute_resolved` topics to support off-chain indexing and auditability.

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
