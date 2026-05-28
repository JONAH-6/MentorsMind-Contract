# Escrow Contract Features

## Escrow Metadata
Supports structured metadata for sessions.

## Escrow Ratings
Mentor/learner reputation tracking and rating system.

---

## Partial Refund

Allows an admin to refund a configurable percentage of the remaining escrowed amount to the learner without fully closing the escrow.

### Function

```rust
pub fn partial_refund(env: Env, escrow_id: u64, refund_bps: u32)
```

### Parameters

| Parameter    | Type  | Description                                                  |
|-------------|-------|--------------------------------------------------------------|
| `escrow_id` | `u64` | ID of the escrow to partially refund                         |
| `refund_bps` | `u32` | Basis points of the remaining amount to refund (1–10 000)   |

### Authorization

Admin only (`require_auth` on the stored admin address).

### Behavior

- `refund_bps = 5000` refunds 50% of the current `escrow.amount` to the learner.
- `refund_bps = 10000` refunds 100% and transitions the escrow to `Refunded`.
- Works on `Active` and `Disputed` escrows.
- No platform fee is deducted from partial refunds.

### Events

Topic: `("prt_rfnd", escrow_id)`  
Data: `(escrow_id, refund_bps, refund_amount, learner, token_address)`

### Error conditions

- `refund_bps` is 0 or > 10 000 → panics `"refund_bps must be between 1 and 10000"`
- Escrow status is not `Active` or `Disputed` → panics `"Escrow must be Active or Disputed for partial refund"`
- Computed refund amount is 0 → panics `"Refund amount is zero"`

---

## Escrow Transfer

Allows transferring an escrow to a different mentor or learner. Both current parties must authorize the transfer.

### Function

```rust
pub fn transfer_escrow(
    env: Env,
    escrow_id: u64,
    new_mentor: Option<Address>,
    new_learner: Option<Address>,
)
```

### Parameters

| Parameter     | Type              | Description                                      |
|--------------|-------------------|--------------------------------------------------|
| `escrow_id`  | `u64`             | ID of the escrow to transfer                     |
| `new_mentor` | `Option<Address>` | New mentor address, or `None` to keep current    |
| `new_learner`| `Option<Address>` | New learner address, or `None` to keep current   |

### Authorization

Both the current `mentor` **and** `learner` must authorize (`require_auth` on both).

### Behavior

- Escrow must be `Active`.
- Updates the `mentor` and/or `learner` fields on the stored escrow.
- Maintains the per-address escrow index lists (`MENTOR_ESCROWS`, `LEARNER_ESCROWS`) so queries remain consistent.
- Passing `None` for either party leaves that party unchanged.

### Events

Topic: `("esc_xfer", escrow_id)`  
Data: `(escrow_id, old_mentor, old_learner, new_mentor, new_learner)`

### Error conditions

- Escrow status is not `Active` → panics `"Escrow must be Active to transfer"`

---

## Auto-Expiration

Prevents indefinite fund lockup by allowing anyone to trigger a full refund on an escrow that has been unclaimed for 1 year (365 days).

### Function

```rust
pub fn expire_escrow(env: Env, escrow_id: u64)
```

### Parameters

| Parameter    | Type  | Description                    |
|-------------|-------|--------------------------------|
| `escrow_id` | `u64` | ID of the escrow to expire     |

### Authorization

**Permissionless** — no `require_auth`. Anyone may call this function once the expiration condition is met.

### Behavior

- Escrow must be `Active`.
- Expiration condition: `current_timestamp >= escrow.created_at + 365 days`.
- On expiration, the full `escrow.amount` is transferred back to the learner.
- Escrow status transitions to `Refunded`.
- The session ID reservation is released.

### Events

Topic: `("expired", escrow_id)`  
Data: `(escrow_id, learner, refund_amount, token_address, timestamp)`

### Error conditions

- Escrow status is not `Active` → panics `"Escrow not active"`
- Expiration time not reached → panics `"Escrow has not expired yet"`

---

## Pause / Resume

Allows either party to pause an escrow for rescheduled sessions. The auto-release deadline is automatically extended by the paused duration when the escrow is resumed.

### Functions

```rust
pub fn pause_escrow(env: Env, caller: Address, escrow_id: u64)
pub fn resume_escrow(env: Env, caller: Address, escrow_id: u64)
pub fn is_paused(env: Env, escrow_id: u64) -> bool
```

### Parameters

| Parameter    | Type      | Description                                  |
|-------------|-----------|----------------------------------------------|
| `caller`    | `Address` | Address of the party pausing/resuming        |
| `escrow_id` | `u64`     | ID of the escrow to pause or resume          |

### Authorization

Either the `mentor` or `learner` of the escrow (`require_auth` on `caller`).

### Behavior

**pause_escrow**
- Escrow must be `Active` and not already paused.
- Records the current timestamp as the pause start time.

**resume_escrow**
- Escrow must be `Active` and currently paused.
- Computes `paused_duration = now - paused_at`.
- Extends `escrow.session_end_time` by `paused_duration`, pushing out the auto-release window.
- Removes the pause record.

**is_paused**
- Returns `true` if the escrow currently has an active pause record.

### Events

Pause — Topic: `("paused", escrow_id)` / Data: `(escrow_id, caller, paused_at)`  
Resume — Topic: `("resumed", escrow_id)` / Data: `(escrow_id, caller, paused_duration, new_session_end_time)`

### Error conditions

**pause_escrow**
- Escrow not `Active` → panics `"Escrow must be Active to pause"`
- Already paused → panics `"Escrow already paused"`
- Caller is not mentor or learner → panics `"Caller not authorized to pause"`

**resume_escrow**
- Escrow not `Active` → panics `"Escrow must be Active to resume"`
- Not paused → panics `"Escrow is not paused"`
- Caller is not mentor or learner → panics `"Caller not authorized to resume"`
