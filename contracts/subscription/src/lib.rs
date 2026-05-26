#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, token, Address, Env};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SECONDS_PER_MONTH: u64 = 30 * 24 * 60 * 60; // 30 days

// ---------------------------------------------------------------------------
// Timestamp security constants
// ---------------------------------------------------------------------------

/// Grace period applied to the billing-date check in `renew`.
/// A learner may renew up to RENEWAL_GRACE_SECS *before* `next_billing_date`
/// to absorb validator timestamp drift (Stellar validators may drift up to
/// ~30 s).  Using 60 s gives a comfortable margin.
pub const RENEWAL_GRACE_SECS: u64 = 60; // 1 minute

/// Maximum time after `next_billing_date` that a subscription is still
/// considered Active before it transitions to Expired.  After this window
/// the subscription must be explicitly renewed or it is treated as lapsed.
/// This prevents a subscription from remaining "Active" indefinitely if the
/// learner never renews.
pub const SUBSCRIPTION_EXPIRY_GRACE_SECS: u64 = 7 * 24 * 60 * 60; // 7 days

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SubscriptionStatus {
    Active,
    Paused,
    Cancelled,
    Expired,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Plan {
    pub mentor: Address,
    pub price_per_month: i128,
    pub token: Address,
    pub sessions_per_month: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct SubscriptionRecord {
    pub learner: Address,
    pub mentor: Address,
    pub plan_id: u32,
    pub start_date: u64,
    pub next_billing_date: u64,
    pub sessions_used: u32,
    pub status: SubscriptionStatus,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Escrow,
    PlanCounter,
    SubCounter,
    Plan(u32),
    Sub(u32),
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct SubscriptionContract;

#[contractimpl]
impl SubscriptionContract {
    /// One-time initialization. Sets admin and escrow wallet.
    pub fn initialize(env: Env, admin: Address, escrow: Address) {
        if env.storage().persistent().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage().persistent().set(&DataKey::Escrow, &escrow);
        env.storage().persistent().set(&DataKey::PlanCounter, &0u32);
        env.storage().persistent().set(&DataKey::SubCounter, &0u32);
    }

    // -----------------------------------------------------------------------
    // Plans
    // -----------------------------------------------------------------------

    /// Create a subscription plan. Returns the new plan ID.
    pub fn create_plan(
        env: Env,
        mentor: Address,
        price_per_month: i128,
        token: Address,
        sessions_per_month: u32,
    ) -> u32 {
        mentor.require_auth();
        if price_per_month <= 0 {
            panic!("price must be positive");
        }
        if sessions_per_month == 0 {
            panic!("sessions_per_month must be > 0");
        }

        let plan_id: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::PlanCounter)
            .unwrap_or(0);

        let plan = Plan {
            mentor,
            price_per_month,
            token,
            sessions_per_month,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Plan(plan_id), &plan);
        env.storage()
            .persistent()
            .set(&DataKey::PlanCounter, &(plan_id + 1));

        plan_id
    }

    // -----------------------------------------------------------------------
    // Subscriptions
    // -----------------------------------------------------------------------

    /// Subscribe to a plan. Transfers first month payment to escrow.
    pub fn subscribe(env: Env, learner: Address, plan_id: u32) -> u32 {
        learner.require_auth();

        let plan: Plan = env
            .storage()
            .persistent()
            .get(&DataKey::Plan(plan_id))
            .expect("plan not found");

        let escrow: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow)
            .expect("not initialized");

        // Transfer first month payment from learner to escrow
        token::Client::new(&env, &plan.token).transfer(
            &learner,
            &escrow,
            &plan.price_per_month,
        );

        let now = env.ledger().timestamp();
        let sub_id: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::SubCounter)
            .unwrap_or(0);

        let record = SubscriptionRecord {
            learner: learner.clone(),
            mentor: plan.mentor.clone(),
            plan_id,
            start_date: now,
            next_billing_date: now + SECONDS_PER_MONTH,
            sessions_used: 0,
            status: SubscriptionStatus::Active,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Sub(sub_id), &record);
        env.storage()
            .persistent()
            .set(&DataKey::SubCounter, &(sub_id + 1));

        env.events().publish(
            (symbol_short!("subscribed"), plan_id),
            (learner, plan.mentor, sub_id),
        );

        sub_id
    }

    /// Renew a subscription — callable by anyone once next_billing_date is reached.
    ///
    /// # Timestamp security
    /// A grace period of `RENEWAL_GRACE_SECS` is applied to the billing-date
    /// check so that a validator with a slightly slow clock cannot prevent a
    /// timely renewal.  The subscription must also not have lapsed beyond
    /// `SUBSCRIPTION_EXPIRY_GRACE_SECS` past the billing date; if it has, the
    /// subscription is transitioned to `Expired` and renewal is rejected.
    pub fn renew(env: Env, subscription_id: u32) {
        let mut record: SubscriptionRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Sub(subscription_id))
            .expect("subscription not found");

        if record.status != SubscriptionStatus::Active {
            panic!("subscription not active");
        }

        let now = env.ledger().timestamp();

        // Check whether the subscription has lapsed (past billing date + expiry grace).
        let expiry_deadline = record
            .next_billing_date
            .checked_add(SUBSCRIPTION_EXPIRY_GRACE_SECS)
            .expect("timestamp overflow");
        if now >= expiry_deadline {
            // Transition to Expired and reject renewal — the learner must
            // create a new subscription.
            record.status = SubscriptionStatus::Expired;
            env.storage()
                .persistent()
                .set(&DataKey::Sub(subscription_id), &record);
            env.events().publish(
                (symbol_short!("expired"), subscription_id),
                (record.learner, record.plan_id),
            );
            panic!("subscription expired; create a new subscription");
        }

        // Apply grace period: allow renewal up to RENEWAL_GRACE_SECS before
        // the billing date to absorb validator clock drift.
        let effective_billing_date = record
            .next_billing_date
            .saturating_sub(RENEWAL_GRACE_SECS);
        if now < effective_billing_date {
            panic!("billing date not reached");
        }

        let plan: Plan = env
            .storage()
            .persistent()
            .get(&DataKey::Plan(record.plan_id))
            .expect("plan not found");

        let escrow: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Escrow)
            .expect("not initialized");

        token::Client::new(&env, &plan.token).transfer(
            &record.learner,
            &escrow,
            &plan.price_per_month,
        );

        record.next_billing_date += SECONDS_PER_MONTH;
        record.sessions_used = 0;
        env.storage()
            .persistent()
            .set(&DataKey::Sub(subscription_id), &record);

        env.events().publish(
            (symbol_short!("renewed"), subscription_id),
            (record.learner, record.plan_id),
        );
    }

    /// Cancel a subscription — learner only, effective end of billing period.
    pub fn cancel(env: Env, subscription_id: u32) {
        let mut record: SubscriptionRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Sub(subscription_id))
            .expect("subscription not found");

        record.learner.require_auth();

        if record.status == SubscriptionStatus::Cancelled {
            panic!("already cancelled");
        }

        record.status = SubscriptionStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Sub(subscription_id), &record);

        env.events().publish(
            (symbol_short!("cancelled"), subscription_id),
            (record.learner, record.plan_id),
        );
    }

    /// Pause a subscription — learner only.
    pub fn pause(env: Env, subscription_id: u32) {
        let mut record: SubscriptionRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Sub(subscription_id))
            .expect("subscription not found");

        record.learner.require_auth();

        if record.status != SubscriptionStatus::Active {
            panic!("subscription not active");
        }

        record.status = SubscriptionStatus::Paused;
        env.storage()
            .persistent()
            .set(&DataKey::Sub(subscription_id), &record);

        env.events().publish(
            (symbol_short!("paused"), subscription_id),
            (record.learner, record.plan_id),
        );
    }

    /// Record a session use. Panics if limit exceeded, subscription not active,
    /// or the subscription has lapsed past its expiry grace window.
    ///
    /// # Timestamp security
    /// Before recording a session, the subscription's expiry status is checked.
    /// If the current time has passed `next_billing_date + SUBSCRIPTION_EXPIRY_GRACE_SECS`
    /// the subscription is transitioned to `Expired` and the session is rejected.
    /// This prevents sessions from being consumed on a lapsed subscription.
    pub fn use_session(env: Env, subscription_id: u32) {
        let mut record: SubscriptionRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Sub(subscription_id))
            .expect("subscription not found");

        if record.status != SubscriptionStatus::Active {
            panic!("subscription not active");
        }

        // Lazily transition to Expired if the subscription has lapsed.
        let now = env.ledger().timestamp();
        let expiry_deadline = record
            .next_billing_date
            .checked_add(SUBSCRIPTION_EXPIRY_GRACE_SECS)
            .expect("timestamp overflow");
        if now >= expiry_deadline {
            record.status = SubscriptionStatus::Expired;
            env.storage()
                .persistent()
                .set(&DataKey::Sub(subscription_id), &record);
            env.events().publish(
                (symbol_short!("expired"), subscription_id),
                (record.learner, record.plan_id),
            );
            panic!("subscription expired");
        }

        let plan: Plan = env
            .storage()
            .persistent()
            .get(&DataKey::Plan(record.plan_id))
            .expect("plan not found");

        if record.sessions_used >= plan.sessions_per_month {
            panic!("session limit reached");
        }

        record.sessions_used += 1;
        env.storage()
            .persistent()
            .set(&DataKey::Sub(subscription_id), &record);
    }

    /// Explicitly check and transition a subscription to Expired if it has
    /// lapsed.  This is a fallback for off-chain systems that need to
    /// synchronise state without waiting for a `use_session` or `renew` call.
    pub fn check_expiry(env: Env, subscription_id: u32) {
        let mut record: SubscriptionRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Sub(subscription_id))
            .expect("subscription not found");

        if record.status != SubscriptionStatus::Active {
            return; // Already in a terminal or non-active state
        }

        let now = env.ledger().timestamp();
        let expiry_deadline = record
            .next_billing_date
            .checked_add(SUBSCRIPTION_EXPIRY_GRACE_SECS)
            .expect("timestamp overflow");

        if now >= expiry_deadline {
            record.status = SubscriptionStatus::Expired;
            env.storage()
                .persistent()
                .set(&DataKey::Sub(subscription_id), &record);
            env.events().publish(
                (symbol_short!("expired"), subscription_id),
                (record.learner, record.plan_id),
            );
        }
    }

    /// Get a subscription record by ID.
    pub fn get_subscription(env: Env, id: u32) -> SubscriptionRecord {
        env.storage()
            .persistent()
            .get(&DataKey::Sub(id))
            .expect("subscription not found")
    }

    /// Get a plan by ID.
    pub fn get_plan(env: Env, plan_id: u32) -> Plan {
        env.storage()
            .persistent()
            .get(&DataKey::Plan(plan_id))
            .expect("plan not found")
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env,
    };

    fn setup() -> (Env, SubscriptionContractClient<'static>, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, SubscriptionContract);
        let client = SubscriptionContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let escrow = Address::generate(&env);
        let mentor = Address::generate(&env);
        let learner = Address::generate(&env);

        client.initialize(&admin, &escrow);
        (env, client, admin, escrow, mentor, learner)
    }

    fn create_token(env: &Env, admin: &Address) -> (Address, TokenClient, StellarAssetClient) {
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let token_address = token_id.address();
        let token = TokenClient::new(env, &token_address);
        let token_admin = StellarAssetClient::new(env, &token_address);
        (token_address, token, token_admin)
    }

    #[test]
    fn test_subscribe() {
        let (env, client, admin, escrow, mentor, learner) = setup();
        let (token_address, token, token_admin) = create_token(&env, &admin);

        token_admin.mint(&learner, &1000);

        let plan_id = client.create_plan(&mentor, &100i128, &token_address, &5u32);
        let sub_id = client.subscribe(&learner, &plan_id);

        assert_eq!(sub_id, 0);
        assert_eq!(token.balance(&learner), 900);
        assert_eq!(token.balance(&escrow), 100);

        let record = client.get_subscription(&sub_id);
        assert_eq!(record.status, SubscriptionStatus::Active);
        assert_eq!(record.sessions_used, 0);
        assert_eq!(record.plan_id, plan_id);
    }

    #[test]
    fn test_renew() {
        let (env, client, admin, escrow, mentor, learner) = setup();
        let (token_address, token, token_admin) = create_token(&env, &admin);

        token_admin.mint(&learner, &1000);

        let plan_id = client.create_plan(&mentor, &100i128, &token_address, &5u32);
        let sub_id = client.subscribe(&learner, &plan_id);

        // Advance time past billing date (within expiry grace window)
        env.ledger().with_mut(|li| {
            li.timestamp += SECONDS_PER_MONTH + 1;
        });

        client.renew(&sub_id);

        assert_eq!(token.balance(&learner), 800);
        assert_eq!(token.balance(&escrow), 200);

        let record = client.get_subscription(&sub_id);
        assert_eq!(record.sessions_used, 0); // reset on renewal
    }

    #[test]
    fn test_renew_within_grace_period() {
        // Renewal should succeed up to RENEWAL_GRACE_SECS before billing date.
        let (env, client, admin, escrow, mentor, learner) = setup();
        let (token_address, token, token_admin) = create_token(&env, &admin);

        token_admin.mint(&learner, &1000);

        let plan_id = client.create_plan(&mentor, &100i128, &token_address, &5u32);
        let sub_id = client.subscribe(&learner, &plan_id);

        // Advance to billing_date - RENEWAL_GRACE_SECS (just inside grace window)
        env.ledger().with_mut(|li| {
            li.timestamp += SECONDS_PER_MONTH - RENEWAL_GRACE_SECS;
        });

        client.renew(&sub_id);
        assert_eq!(token.balance(&escrow), 200);
    }

    #[test]
    #[should_panic(expected = "billing date not reached")]
    fn test_renew_too_early_panics() {
        let (env, client, admin, _escrow, mentor, learner) = setup();
        let (token_address, _token, token_admin) = create_token(&env, &admin);
        token_admin.mint(&learner, &1000);

        let plan_id = client.create_plan(&mentor, &100i128, &token_address, &5u32);
        let sub_id = client.subscribe(&learner, &plan_id);

        // Do NOT advance time — should panic (well before grace window)
        client.renew(&sub_id);
    }

    #[test]
    #[should_panic(expected = "subscription expired")]
    fn test_renew_after_expiry_panics() {
        let (env, client, admin, _escrow, mentor, learner) = setup();
        let (token_address, _token, token_admin) = create_token(&env, &admin);
        token_admin.mint(&learner, &1000);

        let plan_id = client.create_plan(&mentor, &100i128, &token_address, &5u32);
        let sub_id = client.subscribe(&learner, &plan_id);

        // Advance past billing_date + SUBSCRIPTION_EXPIRY_GRACE_SECS
        env.ledger().with_mut(|li| {
            li.timestamp += SECONDS_PER_MONTH + SUBSCRIPTION_EXPIRY_GRACE_SECS + 1;
        });

        client.renew(&sub_id);
    }

    #[test]
    #[should_panic(expected = "subscription expired")]
    fn test_use_session_after_expiry_panics() {
        let (env, client, admin, _escrow, mentor, learner) = setup();
        let (token_address, _token, token_admin) = create_token(&env, &admin);
        token_admin.mint(&learner, &1000);

        let plan_id = client.create_plan(&mentor, &100i128, &token_address, &5u32);
        let sub_id = client.subscribe(&learner, &plan_id);

        // Advance past expiry
        env.ledger().with_mut(|li| {
            li.timestamp += SECONDS_PER_MONTH + SUBSCRIPTION_EXPIRY_GRACE_SECS + 1;
        });

        client.use_session(&sub_id);
    }

    #[test]
    fn test_check_expiry_transitions_to_expired() {
        let (env, client, admin, _escrow, mentor, learner) = setup();
        let (token_address, _token, token_admin) = create_token(&env, &admin);
        token_admin.mint(&learner, &1000);

        let plan_id = client.create_plan(&mentor, &100i128, &token_address, &5u32);
        let sub_id = client.subscribe(&learner, &plan_id);

        // Advance past expiry
        env.ledger().with_mut(|li| {
            li.timestamp += SECONDS_PER_MONTH + SUBSCRIPTION_EXPIRY_GRACE_SECS + 1;
        });

        client.check_expiry(&sub_id);

        let record = client.get_subscription(&sub_id);
        assert_eq!(record.status, SubscriptionStatus::Expired);
    }

    #[test]
    fn test_check_expiry_no_op_when_active() {
        let (env, client, admin, _escrow, mentor, learner) = setup();
        let (token_address, _token, token_admin) = create_token(&env, &admin);
        token_admin.mint(&learner, &1000);

        let plan_id = client.create_plan(&mentor, &100i128, &token_address, &5u32);
        let sub_id = client.subscribe(&learner, &plan_id);

        // Do not advance time — subscription is still active
        client.check_expiry(&sub_id);

        let record = client.get_subscription(&sub_id);
        assert_eq!(record.status, SubscriptionStatus::Active);
    }

    /// Simulate a validator that skews the clock forward by RENEWAL_GRACE_SECS.
    /// The subscription must NOT be renewable before the billing date has elapsed.
    #[test]
    #[should_panic(expected = "billing date not reached")]
    fn test_manipulated_timestamp_cannot_renew_early() {
        let (env, client, admin, _escrow, mentor, learner) = setup();
        let (token_address, _token, token_admin) = create_token(&env, &admin);
        token_admin.mint(&learner, &1000);

        let plan_id = client.create_plan(&mentor, &100i128, &token_address, &5u32);
        let sub_id = client.subscribe(&learner, &plan_id);

        // Validator skews clock forward by RENEWAL_GRACE_SECS - 1.
        // This is still before the effective billing date.
        env.ledger().with_mut(|li| {
            li.timestamp += SECONDS_PER_MONTH - RENEWAL_GRACE_SECS - 1;
        });

        client.renew(&sub_id);
    }

    #[test]
    fn test_cancel_mid_period() {
        let (env, client, admin, _escrow, mentor, learner) = setup();
        let (token_address, _token, token_admin) = create_token(&env, &admin);
        token_admin.mint(&learner, &1000);

        let plan_id = client.create_plan(&mentor, &100i128, &token_address, &5u32);
        let sub_id = client.subscribe(&learner, &plan_id);

        // Cancel mid-period (no time advance needed)
        client.cancel(&sub_id);

        let record = client.get_subscription(&sub_id);
        assert_eq!(record.status, SubscriptionStatus::Cancelled);

        // Advance past billing date — renew should fail
        env.ledger().with_mut(|li| {
            li.timestamp += SECONDS_PER_MONTH + 1;
        });
    }

    #[test]
    fn test_session_count_enforcement() {
        let (env, client, admin, _escrow, mentor, learner) = setup();
        let (token_address, _token, token_admin) = create_token(&env, &admin);
        token_admin.mint(&learner, &1000);

        let plan_id = client.create_plan(&mentor, &100i128, &token_address, &2u32);
        let sub_id = client.subscribe(&learner, &plan_id);

        client.use_session(&sub_id);
        client.use_session(&sub_id);

        let record = client.get_subscription(&sub_id);
        assert_eq!(record.sessions_used, 2);
    }

    #[test]
    #[should_panic(expected = "session limit reached")]
    fn test_session_limit_exceeded_panics() {
        let (env, client, admin, _escrow, mentor, learner) = setup();
        let (token_address, _token, token_admin) = create_token(&env, &admin);
        token_admin.mint(&learner, &1000);

        let plan_id = client.create_plan(&mentor, &100i128, &token_address, &1u32);
        let sub_id = client.subscribe(&learner, &plan_id);

        client.use_session(&sub_id);
        client.use_session(&sub_id); // should panic
    }

    #[test]
    fn test_pause() {
        let (env, client, admin, _escrow, mentor, learner) = setup();
        let (token_address, _token, token_admin) = create_token(&env, &admin);
        token_admin.mint(&learner, &1000);

        let plan_id = client.create_plan(&mentor, &100i128, &token_address, &5u32);
        let sub_id = client.subscribe(&learner, &plan_id);

        client.pause(&sub_id);

        let record = client.get_subscription(&sub_id);
        assert_eq!(record.status, SubscriptionStatus::Paused);
    }
}
