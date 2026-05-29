#![cfg(test)]

use mentorminds_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Symbol, Vec,
};

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

fn create_token<'a>(env: &'a Env, admin: &Address) -> (Address, StellarAssetClient<'a>) {
    let token_address = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let sac = StellarAssetClient::new(env, &token_address);
    (token_address, sac)
}

fn advance_time(env: &Env, secs: u64) {
    env.ledger().with_mut(|li| li.timestamp += secs);
}

struct TestFixture {
    env: Env,
    contract_id: Address,
    mentor: Address,
    learner: Address,
    treasury: Address,
    token_address: Address,
}

impl TestFixture {
    fn setup() -> Self {
        Self::setup_with_fee(500)
    }
    fn setup_with_fee(fee_bps: u32) -> Self {
        Self::setup_full(fee_bps, 0)
    }

    fn setup_full(fee_bps: u32, auto_release_delay_secs: u64) -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| li.timestamp = 14_400);

        let contract_id = env.register_contract(None, EscrowContract);
        let admin = Address::generate(&env);
        let mentor = Address::generate(&env);
        let learner = Address::generate(&env);
        let treasury = Address::generate(&env);

        let (token_address, sac) = create_token(&env, &admin);
        sac.mint(&learner, &100_000);

        let client = EscrowContractClient::new(&env, &contract_id);
        let mut approved = Vec::new(&env);
        approved.push_back(token_address.clone());
        client.initialize(
            &admin,
            &treasury,
            &fee_bps,
            &approved,
            &auto_release_delay_secs,
            &None,
        );

        TestFixture {
            env,
            contract_id,
            mentor,
            learner,
            treasury,
            token_address,
        }
    }

    fn client(&self) -> EscrowContractClient<'_> {
        EscrowContractClient::new(&self.env, &self.contract_id)
    }
    fn token(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token_address)
    }
    fn sac(&self) -> StellarAssetClient<'_> {
        StellarAssetClient::new(&self.env, &self.token_address)
    }

    fn create_escrow_at(&self, amount: i128, session_end_time: u64, session_id: &str) -> u64 {
        self.client().create_escrow(
            &self.mentor,
            &self.learner,
            &amount,
            &Symbol::new(&self.env, session_id),
            &self.token_address,
            &session_end_time,
            &1u32,
        )
    }

    fn create_package_escrow_at(
        &self,
        amount: i128,
        session_end_time: u64,
        session_id: &str,
        total_sessions: u32,
    ) -> u64 {
        self.client().create_escrow(
            &self.mentor,
            &self.learner,
            &amount,
            &Symbol::new(&self.env, session_id),
            &self.token_address,
            &session_end_time,
            &total_sessions,
        )
    }

    fn open_dispute(&self, escrow_id: u64) {
        self.client()
            .dispute(&self.learner, &escrow_id, &symbol_short!("NO_SHOW"));
    }
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

#[test]
fn test_session_id_uniqueness() {
    let f = TestFixture::setup();
    f.create_escrow_at(1_000, 0, "S1");

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        f.create_escrow_at(1_000, 0, "S1");
    }));
    assert!(result.is_err(), "Duplicate session_id must panic");

    // Different session_id should work
    f.create_escrow_at(1_000, 0, "S2");
}

#[test]
fn test_release_partial() {
    let f = TestFixture::setup_with_fee(500); // 5% fee
    let id = f.create_package_escrow_at(1_200, 0, "S1", 3); // 3 sessions, 400 each

    let mentor_before = f.token().balance(&f.mentor);
    let treasury_before = f.token().balance(&f.treasury);

    // Release 1st session (400)
    f.client().release_partial(&f.learner, &id);

    // 400 * 0.05 = 20 fee, 380 net
    assert_eq!(f.token().balance(&f.mentor), mentor_before + 380);
    assert_eq!(f.token().balance(&f.treasury), treasury_before + 20);

    let e = f.client().get_escrow(&id);
    assert_eq!(e.amount, 800);
    assert_eq!(e.sessions_completed, 1);
    assert_eq!(e.status, EscrowStatus::Active);

    // Release 2nd session (400)
    f.client().release_partial(&f.learner, &id);
    assert_eq!(f.token().balance(&f.mentor), mentor_before + 760);
    assert_eq!(f.token().balance(&f.treasury), treasury_before + 40);

    let e2 = f.client().get_escrow(&id);
    assert_eq!(e2.amount, 400);
    assert_eq!(e2.sessions_completed, 2);
    assert_eq!(e2.status, EscrowStatus::Active);

    // Release 3rd session (remaining 400)
    f.client().release_partial(&f.learner, &id);
    assert_eq!(f.token().balance(&f.mentor), mentor_before + 1140);
    assert_eq!(f.token().balance(&f.treasury), treasury_before + 60);

    let e3 = f.client().get_escrow(&id);
    assert_eq!(e3.amount, 0);
    assert_eq!(e3.sessions_completed, 3);
    assert_eq!(e3.status, EscrowStatus::Released);
}

#[test]
fn test_three_session_package_full_lifecycle() {
    let f = TestFixture::setup_with_fee(1000); // 10% fee
    let id = f.create_package_escrow_at(3000, 0, "PKG1", 3);

    // 1st release
    f.client().release_partial(&f.learner, &id);
    let e1 = f.client().get_escrow(&id);
    assert_eq!(e1.amount, 2000);
    assert_eq!(e1.sessions_completed, 1);
    assert_eq!(f.token().balance(&f.mentor), 900); // 1000 - 100 fee

    // 2nd release
    f.client().release_partial(&f.learner, &id);
    let e2 = f.client().get_escrow(&id);
    assert_eq!(e2.amount, 1000);
    assert_eq!(e2.sessions_completed, 2);
    assert_eq!(f.token().balance(&f.mentor), 1800);

    // 3rd release
    f.client().release_partial(&f.learner, &id);
    let e3 = f.client().get_escrow(&id);
    assert_eq!(e3.amount, 0);
    assert_eq!(e3.sessions_completed, 3);
    assert_eq!(e3.status, EscrowStatus::Released);
    assert_eq!(f.token().balance(&f.mentor), 2700);
    assert_eq!(f.token().balance(&f.treasury), 300);
}

#[test]
#[should_panic(expected = "Escrow not active")]
fn test_over_release_panics() {
    let f = TestFixture::setup();
    let id = f.create_package_escrow_at(1000, 0, "S1", 1);

    f.client().release_partial(&f.learner, &id);
    // Should panic
    f.client().release_partial(&f.learner, &id);
}

#[test]
fn test_resolve_dispute_to_mentor() {
    let f = TestFixture::setup_with_fee(500);
    let id = f.create_escrow_at(1_000, 0, "S1");
    f.open_dispute(id);

    let mentor_before = f.token().balance(&f.mentor);

    // Resolve to mentor (true)
    f.client().resolve_dispute(&id, &true);

    // Should behave like _do_release: 950 to mentor, 50 to treasury
    assert_eq!(f.token().balance(&f.mentor), mentor_before + 950);
    assert_eq!(f.token().balance(&f.treasury), 50);

    let e = f.client().get_escrow(&id);
    assert_eq!(e.status, EscrowStatus::Resolved);
    assert_eq!(e.net_amount, 950);
    assert_eq!(e.platform_fee, 50);
}

#[test]
fn test_resolve_dispute_to_learner() {
    let f = TestFixture::setup_with_fee(500);
    let id = f.create_escrow_at(1_000, 0, "S1");
    f.open_dispute(id);

    let learner_before = f.token().balance(&f.learner);

    // Resolve to learner (false)
    f.client().resolve_dispute(&id, &false);

    // Full refund, no fees
    assert_eq!(f.token().balance(&f.learner), learner_before + 1_000);

    let e = f.client().get_escrow(&id);
    assert_eq!(e.status, EscrowStatus::Resolved);
    assert_eq!(e.net_amount, 0);
    assert_eq!(e.platform_fee, 1_000); // repurposed for learner share
}

#[test]
fn test_admin_release() {
    let f = TestFixture::setup_with_fee(500);
    let id = f.create_escrow_at(1_000, 0, "S1");

    f.client().admin_release(&id);

    let e = f.client().get_escrow(&id);
    assert_eq!(e.status, EscrowStatus::Released);
    assert_eq!(f.token().balance(&f.mentor), 950);
}

#[test]
fn test_try_auto_release() {
    let f = TestFixture::setup_full(500, 3600);
    let now = f.env.ledger().timestamp();
    let id = f.create_escrow_at(1_000, now, "S1");

    advance_time(&f.env, 3600 + 1);
    f.client().try_auto_release(&id);

    let e = f.client().get_escrow(&id);
    assert_eq!(e.status, EscrowStatus::Released);
}

#[test]
fn test_query_by_mentor_pagination() {
    let f = TestFixture::setup();
    let mentor = Address::generate(&f.env);
    let learner = f.learner.clone();

    // Create 5 escrows for the same mentor
    for i in 0..5 {
        let session_id = Symbol::new(&f.env, &format!("S{}", i));
        f.client().create_escrow(
            &mentor,
            &learner,
            &1_000,
            &session_id,
            &f.token_address,
            &0,
            &1u32,
        );
    }

    // Page 0, size 2 -> should return 2 escrows (ids 1, 2)
    let page0 = f.client().get_escrows_by_mentor(&mentor, &0, &2);
    assert_eq!(page0.len(), 2);
    assert_eq!(page0.get(0).unwrap().id, 1);
    assert_eq!(page0.get(1).unwrap().id, 2);

    // Page 1, size 2 -> should return 2 escrows (ids 3, 4)
    let page1 = f.client().get_escrows_by_mentor(&mentor, &1, &2);
    assert_eq!(page1.len(), 2);
    assert_eq!(page1.get(0).unwrap().id, 3);
    assert_eq!(page1.get(1).unwrap().id, 4);

    // Page 2, size 2 -> should return 1 escrow (id 5)
    let page2 = f.client().get_escrows_by_mentor(&mentor, &2, &2);
    assert_eq!(page2.len(), 1);
    assert_eq!(page2.get(0).unwrap().id, 5);

    // Page 3, size 2 -> should return 0 escrows
    let page3 = f.client().get_escrows_by_mentor(&mentor, &3, &2);
    assert_eq!(page3.len(), 0);
}

#[test]
fn test_query_by_learner_pagination() {
    let f = TestFixture::setup();
    let mentor = f.mentor.clone();
    let learner = Address::generate(&f.env);

    // Mint tokens for the new learner
    f.sac().mint(&learner, &100_000);

    // Create 3 escrows for the same learner
    for i in 0..3 {
        let session_id = Symbol::new(&f.env, &format!("L{}", i));
        f.client().create_escrow(
            &mentor,
            &learner,
            &1_000,
            &session_id,
            &f.token_address,
            &0,
            &1u32,
        );
    }

    // Page 0, size 2 -> 2 escrows
    let page0 = f.client().get_escrows_by_learner(&learner, &0, &2);
    assert_eq!(page0.len(), 2);

    // Page 1, size 2 -> 1 escrow
    let page1 = f.client().get_escrows_by_learner(&learner, &1, &2);
    assert_eq!(page1.len(), 1);
}

#[test]
fn test_query_by_status() {
    let f = TestFixture::setup();
    let id1 = f.create_escrow_at(1_000, 0, "S1");
    let id2 = f.create_escrow_at(1_000, 0, "S2");
    let id3 = f.create_escrow_at(1_000, 0, "S3");

    // All should be Active initially
    let active_ids = f.client().get_escrows_by_status(&EscrowStatus::Active);
    assert_eq!(active_ids.len(), 3);
    fn vec_has_u64(v: &soroban_sdk::Vec<u64>, x: u64) -> bool {
        for i in 0..v.len() {
            if v.get(i).unwrap() == x {
                return true;
            }
        }
        false
    }
    assert!(vec_has_u64(&active_ids, id1));
    assert!(vec_has_u64(&active_ids, id2));
    assert!(vec_has_u64(&active_ids, id3));

    // Release one
    f.client().release_funds(&f.learner, &id1);

    let active_ids2 = f.client().get_escrows_by_status(&EscrowStatus::Active);
    assert_eq!(active_ids2.len(), 2);
    assert!(!vec_has_u64(&active_ids2, id1));

    let released_ids = f.client().get_escrows_by_status(&EscrowStatus::Released);
    assert_eq!(released_ids.len(), 1);
    assert!(vec_has_u64(&released_ids, id1));
}

#[test]
fn test_page_size_cap() {
    let f = TestFixture::setup();
    let mentor = f.mentor.clone();
    let learner = f.learner.clone();

    // Create 60 escrows
    for i in 0..60 {
        let session_id = Symbol::new(&f.env, &format!("S{}", i));
        f.client().create_escrow(
            &mentor,
            &learner,
            &100,
            &session_id,
            &f.token_address,
            &0,
            &1u32,
        );
    }

    // Try to get 100 per page, should be capped at 50
    let results = f.client().get_escrows_by_mentor(&mentor, &0, &100);
    assert_eq!(results.len(), 50);
}

// -----------------------------------------------------------------------
// Task 1: Partial refund tests
// -----------------------------------------------------------------------

#[test]
fn test_partial_refund_50_percent() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "PR1");

    let learner_before = f.token().balance(&f.learner);
    f.client().partial_refund(&id, &5_000u32); // 50%

    assert_eq!(f.token().balance(&f.learner), learner_before + 500);
    let e = f.client().get_escrow(&id);
    assert_eq!(e.amount, 500);
    assert_eq!(e.status, EscrowStatus::Active); // still active
}

#[test]
fn test_partial_refund_100_percent_closes_escrow() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "PR2");

    let learner_before = f.token().balance(&f.learner);
    f.client().partial_refund(&id, &10_000u32); // 100%

    assert_eq!(f.token().balance(&f.learner), learner_before + 1_000);
    let e = f.client().get_escrow(&id);
    assert_eq!(e.amount, 0);
    assert_eq!(e.status, EscrowStatus::Refunded);
}

#[test]
fn test_partial_refund_on_disputed_escrow() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "PR3");
    f.open_dispute(id);

    let learner_before = f.token().balance(&f.learner);
    f.client().partial_refund(&id, &2_500u32); // 25%

    assert_eq!(f.token().balance(&f.learner), learner_before + 250);
    assert_eq!(f.client().get_escrow(&id).amount, 750);
}

#[test]
#[should_panic(expected = "refund_bps must be between 1 and 10000")]
fn test_partial_refund_zero_bps_panics() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "PR4");
    f.client().partial_refund(&id, &0u32);
}

#[test]
#[should_panic(expected = "refund_bps must be between 1 and 10000")]
fn test_partial_refund_over_10000_bps_panics() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "PR5");
    f.client().partial_refund(&id, &10_001u32);
}

#[test]
#[should_panic(expected = "Escrow must be Active or Disputed for partial refund")]
fn test_partial_refund_on_released_escrow_panics() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "PR6");
    f.client().release_funds(&f.learner, &id);
    f.client().partial_refund(&id, &5_000u32);
}

// -----------------------------------------------------------------------
// Task 2: Escrow transfer tests
// -----------------------------------------------------------------------

#[test]
fn test_transfer_escrow_new_mentor() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "TR1");
    let new_mentor = Address::generate(&f.env);

    f.client().transfer_escrow(&id, &Some(new_mentor.clone()), &None);

    let e = f.client().get_escrow(&id);
    assert_eq!(e.mentor, new_mentor);
    assert_eq!(e.learner, f.learner);
}

#[test]
fn test_transfer_escrow_new_learner() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "TR2");
    let new_learner = Address::generate(&f.env);

    f.client().transfer_escrow(&id, &None, &Some(new_learner.clone()));

    let e = f.client().get_escrow(&id);
    assert_eq!(e.mentor, f.mentor);
    assert_eq!(e.learner, new_learner);
}

#[test]
fn test_transfer_escrow_both_parties() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "TR3");
    let new_mentor = Address::generate(&f.env);
    let new_learner = Address::generate(&f.env);

    f.client().transfer_escrow(&id, &Some(new_mentor.clone()), &Some(new_learner.clone()));

    let e = f.client().get_escrow(&id);
    assert_eq!(e.mentor, new_mentor);
    assert_eq!(e.learner, new_learner);
}

#[test]
#[should_panic(expected = "Escrow must be Active to transfer")]
fn test_transfer_escrow_released_panics() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "TR4");
    f.client().release_funds(&f.learner, &id);
    let new_mentor = Address::generate(&f.env);
    f.client().transfer_escrow(&id, &Some(new_mentor), &None);
}

// -----------------------------------------------------------------------
// Task 3: Auto-expiration tests
// -----------------------------------------------------------------------

#[test]
fn test_expire_escrow_after_one_year() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "EX1");

    let learner_before = f.token().balance(&f.learner);

    // Advance past 1 year
    advance_time(&f.env, 365 * 24 * 60 * 60 + 1);
    f.client().expire_escrow(&id);

    assert_eq!(f.token().balance(&f.learner), learner_before + 1_000);
    let e = f.client().get_escrow(&id);
    assert_eq!(e.status, EscrowStatus::Refunded);
    assert_eq!(e.amount, 0);
}

#[test]
#[should_panic(expected = "Escrow has not expired yet")]
fn test_expire_escrow_before_one_year_panics() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "EX2");

    // Only advance 364 days
    advance_time(&f.env, 364 * 24 * 60 * 60);
    f.client().expire_escrow(&id);
}

#[test]
#[should_panic(expected = "Escrow not active")]
fn test_expire_already_released_escrow_panics() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "EX3");
    f.client().release_funds(&f.learner, &id);

    advance_time(&f.env, 365 * 24 * 60 * 60 + 1);
    f.client().expire_escrow(&id);
}

#[test]
fn test_expire_escrow_permissionless() {
    // Anyone can trigger expiration — no auth required
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "EX4");
    advance_time(&f.env, 365 * 24 * 60 * 60 + 1);

    // Call from a random address (mock_all_auths covers it, but expire_escrow
    // doesn't require_auth so this is truly permissionless)
    f.client().expire_escrow(&id);
    assert_eq!(f.client().get_escrow(&id).status, EscrowStatus::Refunded);
}

// -----------------------------------------------------------------------
// Task 4: Pause / Resume tests
// -----------------------------------------------------------------------

#[test]
fn test_pause_and_resume_extends_deadline() {
    let f = TestFixture::setup_full(0, 3600);
    let now = f.env.ledger().timestamp();
    let id = f.create_escrow_at(1_000, now + 7200, "PS1");

    let original_end = f.client().get_escrow(&id).session_end_time;

    // Pause
    f.client().pause_escrow(&f.learner, &id);
    assert!(f.client().is_paused(&id));

    // Advance 1 hour while paused
    advance_time(&f.env, 3600);

    // Resume
    f.client().resume_escrow(&f.mentor, &id);
    assert!(!f.client().is_paused(&id));

    // session_end_time should be extended by 3600 seconds
    let e = f.client().get_escrow(&id);
    assert_eq!(e.session_end_time, original_end + 3600);
}

#[test]
fn test_pause_by_mentor() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "PS2");
    f.client().pause_escrow(&f.mentor, &id);
    assert!(f.client().is_paused(&id));
}

#[test]
fn test_pause_by_learner() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "PS3");
    f.client().pause_escrow(&f.learner, &id);
    assert!(f.client().is_paused(&id));
}

#[test]
#[should_panic(expected = "Escrow already paused")]
fn test_double_pause_panics() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "PS4");
    f.client().pause_escrow(&f.learner, &id);
    f.client().pause_escrow(&f.learner, &id);
}

#[test]
#[should_panic(expected = "Escrow is not paused")]
fn test_resume_not_paused_panics() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "PS5");
    f.client().resume_escrow(&f.learner, &id);
}

#[test]
#[should_panic(expected = "Escrow must be Active to pause")]
fn test_pause_released_escrow_panics() {
    let f = TestFixture::setup_with_fee(0);
    let id = f.create_escrow_at(1_000, 0, "PS6");
    f.client().release_funds(&f.learner, &id);
    f.client().pause_escrow(&f.learner, &id);
}

#[test]
fn test_auto_release_blocked_while_paused() {
    // After pause+resume, the deadline is extended so auto-release should
    // not trigger at the original time.
    let f = TestFixture::setup_full(0, 3600);
    let now = f.env.ledger().timestamp();
    let id = f.create_escrow_at(1_000, now, "PS7");

    // Pause immediately, advance 1 hour, resume
    f.client().pause_escrow(&f.learner, &id);
    advance_time(&f.env, 3600);
    f.client().resume_escrow(&f.mentor, &id);

    // At this point session_end_time was extended by 3600s.
    // The auto-release window is session_end_time + auto_release_delay.
    // We are now at now+3600; session_end_time = now+3600; window = now+3600+3600 = now+7200.
    // Trying to auto-release now should fail.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        f.client().try_auto_release(&id);
    }));
    assert!(result.is_err(), "Auto-release should be blocked after pause extension");

    // Advance past the extended window
    advance_time(&f.env, 3600 + 1);
    f.client().try_auto_release(&id);
    assert_eq!(f.client().get_escrow(&id).status, EscrowStatus::Released);
}
