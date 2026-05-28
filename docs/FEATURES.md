## Escrow Metadata
Supports structured metadata for sessions.

## Escrow Ratings
Mentor/learner reputation tracking and rating system.

---

## Escrow Cancellation

Allows a learner or mentor to cancel an active escrow before the session starts, with a full refund to the learner.

**Policy**
- Only the learner or mentor may cancel.
- Cancellation is only permitted before `session_end_time` (when set).
- An optional per-escrow cancellation deadline can be set by the admin via `set_cancel_deadline`.
- No platform fee is charged — the full escrowed amount is returned to the learner.

**Functions (escrow contract)**
- `cancel_escrow(caller, escrow_id)` — learner or mentor
- `set_cancel_deadline(escrow_id, deadline)` — admin only

**Events**
- `(Escrow, Cancelled, escrow_id)` → `EscrowCancelledEventData { escrow_id, learner, amount, cancelled_by, token_address }`

---

## Multi-Mentor Group Sessions

Supports sessions with multiple mentors, each receiving a proportional share of the net payment.

**Rules**
- At least 2 mentors must be specified.
- `share_bps` values must sum to exactly 10 000 (100%).
- Platform fee is deducted first; net is split proportionally. Rounding dust goes to the last mentor.

**Functions (escrow contract)**
- `create_multi_mentor_escrow(learner, mentors, amount, token, session_id, session_end_time)` — learner
- `release_multi_mentor_escrow(caller, escrow_id)` — learner or admin
- `get_multi_mentor_escrow(escrow_id)` — view

**Events**
- `(Escrow, MMCreated, escrow_id)` → `MultiMentorCreatedEventData`
- `(Escrow, MMReleased, escrow_id)` → `MultiMentorReleasedEventData`

---

## Escrow Insurance

Optional insurance pool that learners can pay into to protect against disputed sessions.

**How It Works**
1. Admin registers the insurance contract via `set_insurance_contract`.
2. Learner calls `pay_insurance_premium(learner, escrow_id, premium_bps)` (1–500 bps of escrow amount).
3. On a dispute resolved in the learner's favour, admin calls `claim` on the insurance contract.
4. Liquidity providers earn 0.1% yield on platform fees via `accrue_yield`.

**Functions (escrow contract)**
- `set_insurance_contract(insurance)` — admin
- `pay_insurance_premium(learner, escrow_id, premium_bps)` — learner
- `get_insurance_contract()` — view

**Functions (insurance contract)**
- `deposit(provider, amount)` / `withdraw(provider, amount)` — liquidity management
- `claim(escrow_id, learner, amount)` — admin, pays learner from pool
- `calculate_premium(escrow_amount, premium_bps)` — view
- `get_coverage_ratio()` — pool health in bps (alert below 500 bps)

---

## Referral Rewards

Incentivises user growth by rewarding referrers with MNT tokens when referred users complete sessions.

**Reward Amounts (base, before multiplier)**
- Mentor referee: 50 MNT
- Learner referee: 20 MNT

**Leaderboard Multipliers:** rank 1–3 → 2×, rank 4–10 → 1.5×, rank 11–50 → 1.25×, else 1×

**Functions (escrow contract)**
- `set_referral_contract(referral)` — admin
- `notify_referral_fulfilled(referee)` — admin, called after successful release
- `get_referral_contract()` — view

**Functions (referral contract)**
- `register_referral(referrer, referee, is_mentor)` — admin
- `fulfill_referral(referee)` — admin, queues reward
- `distribute_from_fee(referrer, platform_fee, reward_bps)` — admin, adds fee share to pending rewards
- `claim_reward(referrer)` — referrer, mints MNT with multiplier applied

**Events**
- `(Referral, Registered, referrer)` → `ReferralRegisteredEventData`
- `(Referral, RewardClaimed, referrer)` → `RewardClaimedEventData`
- `(Referral, FeeReward, referrer)` → `(reward,)`
- `(Escrow, RefFulf)` → `(referee,)`
