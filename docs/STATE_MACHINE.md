# Escrow State Machine Guide

This guide documents escrow lifecycle states, allowed transitions, and transition guards.

## State Machine Diagram

![Escrow State Machine](./diagrams/state_machine.png)

## States

- `Active`: escrow created and funds locked
- `Disputed`: an active escrow was challenged by a participant
- `Released`: funds released to final recipient
- `Refunded`: funds returned by admin flow
- `Resolved`: dispute resolution finalized

Terminal states:
- `Released`
- `Refunded`
- `Resolved`

## Valid Transitions

| From | To | Trigger | Condition |
|---|---|---|---|
| `Active` | `Released` | `release_funds` | authorized release path |
| `Active` | `Released` | `try_auto_release` | `now >= session_end + auto_release_delay` |
| `Active` | `Disputed` | `dispute` | mentor/learner authorization |
| `Active` | `Refunded` | `refund` | admin path |
| `Disputed` | `Resolved` | `resolve_dispute` | admin/arbitration resolution |

Invalid examples:
- `Released -> Active`
- `Refunded -> Active`
- `Resolved -> Disputed`

## Transition Conditions

### `Active -> Released`
- Direct release: participant/admin authorization checks pass.
- Auto release: escrow timeout reached.

### `Active -> Disputed`
- Caller is a permitted party.
- Escrow not already terminal.

### `Active -> Refunded`
- Caller has admin permissions.
- Escrow still active.

### `Disputed -> Resolved`
- Admin/arbitration outcome submitted.
- Resolution timestamp recorded.

## Lifecycle Examples

### Example 1: Happy Path
1. `create_escrow` creates `Active`.
2. Session completes successfully.
3. `release_funds` transitions to `Released`.

### Example 2: Timeout Auto Release
1. `create_escrow` creates `Active`.
2. No manual release is submitted.
3. `try_auto_release` after delay transitions to `Released`.

### Example 3: Dispute and Resolution
1. `create_escrow` creates `Active`.
2. `dispute` transitions to `Disputed`.
3. Evidence/arbitration process runs.
4. `resolve_dispute` transitions to `Resolved`.

## Verification Expectations

- Every state transition must be validated against the allowed matrix.
- Terminal states cannot transition back to non-terminal states.
- Invariant checks should execute after state-changing operations.

Related documents:
- `contracts/escrow/INVARIANTS.md`
- `docs/state-machines.md`
