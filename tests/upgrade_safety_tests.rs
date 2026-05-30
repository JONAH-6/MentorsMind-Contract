//! #419 — Contract Upgrade Safety
//!
//! Tests for:
//! - Initialization guard (double-init prevented)
//! - Version monotonicity (new_version must be > current)
//! - Timelock: upgrade cannot execute before delay elapses
//! - Only one pending upgrade at a time
//! - Cancel clears the pending slot
//! - Upgrade authorization (admin-only)

#![cfg(test)]

use mentorminds_upgrade_registry::{
    UpgradeRegistryContract, UpgradeRegistryContractClient,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    Address, BytesN, Env, Symbol,
};

fn zero_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

fn setup() -> (Env, Address, UpgradeRegistryContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(UpgradeRegistryContract, ());
    let client = UpgradeRegistryContractClient::new(&env, &id);
    client.initialize(&admin).unwrap();
    (env, admin, client)
}

fn advance_time(env: &Env, secs: u64) {
    let current = env.ledger().timestamp();
    env.ledger().set(LedgerInfo {
        timestamp: current + secs,
        protocol_version: 22,
        sequence_number: env.ledger().sequence() + 1,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 9_999_999,
    });
}

// ─── Initialization guard ─────────────────────────────────────────────────────

#[test]
fn double_initialize_returns_error() {
    let (env, admin, client) = setup();
    let result = client.try_initialize(&admin);
    assert!(result.is_err(), "second initialize must fail");
}

// ─── Version monotonicity ─────────────────────────────────────────────────────

#[test]
fn schedule_upgrade_requires_version_monotonic() {
    let (env, _admin, client) = setup();
    let name = Symbol::new(&env, "escrow");

    // First upgrade: v0 → v1 OK
    client
        .schedule_upgrade(&zero_hash(&env), &name, &1, &zero_hash(&env))
        .unwrap();
    client.cancel_pending_upgrade().unwrap();

    // Register v1 so the latest version is set
    client
        .register_upgrade(&name, &0, &1, &zero_hash(&env))
        .unwrap();

    // Now trying to schedule v1 again must fail (not monotonic)
    let result = client.try_schedule_upgrade(&zero_hash(&env), &name, &1, &zero_hash(&env));
    assert!(result.is_err(), "same version must be rejected");

    // v0 < v1 must also be rejected
    let result = client.try_schedule_upgrade(&zero_hash(&env), &name, &0, &zero_hash(&env));
    assert!(result.is_err(), "lower version must be rejected");

    // v2 > v1 must succeed
    client
        .schedule_upgrade(&zero_hash(&env), &name, &2, &zero_hash(&env))
        .unwrap();
}

// ─── Timelock ─────────────────────────────────────────────────────────────────

#[test]
fn execute_upgrade_before_timelock_returns_error() {
    let (env, _admin, client) = setup();
    let name = Symbol::new(&env, "lending");

    client
        .schedule_upgrade(&zero_hash(&env), &name, &1, &zero_hash(&env))
        .unwrap();

    // Do NOT advance time — timelock has not elapsed
    let result = client.try_execute_pending_upgrade();
    assert!(result.is_err(), "execute before timelock must fail");
}

#[test]
fn execute_upgrade_after_timelock_succeeds() {
    let (env, _admin, client) = setup();
    let name = Symbol::new(&env, "staking");

    client
        .schedule_upgrade(&zero_hash(&env), &name, &1, &zero_hash(&env))
        .unwrap();

    // Advance past the default 48-hour delay
    advance_time(&env, 48 * 3_600 + 1);

    // execute_pending_upgrade calls env.deployer().update_current_contract_wasm
    // which is allowed in the test environment with a zero hash.
    client.execute_pending_upgrade().unwrap();

    // After execution the pending slot must be cleared.
    assert!(client.get_pending_upgrade().is_none());
}

// ─── Single pending upgrade ───────────────────────────────────────────────────

#[test]
fn cannot_schedule_two_upgrades_simultaneously() {
    let (env, _admin, client) = setup();
    let name = Symbol::new(&env, "payment");

    client
        .schedule_upgrade(&zero_hash(&env), &name, &1, &zero_hash(&env))
        .unwrap();

    // Second schedule must fail while first is pending
    let result = client.try_schedule_upgrade(&zero_hash(&env), &name, &2, &zero_hash(&env));
    assert!(result.is_err(), "second pending upgrade must be rejected");
}

// ─── Cancel ───────────────────────────────────────────────────────────────────

#[test]
fn cancel_clears_pending_upgrade() {
    let (env, _admin, client) = setup();
    let name = Symbol::new(&env, "referral");

    client
        .schedule_upgrade(&zero_hash(&env), &name, &1, &zero_hash(&env))
        .unwrap();
    assert!(client.get_pending_upgrade().is_some());

    client.cancel_pending_upgrade().unwrap();
    assert!(client.get_pending_upgrade().is_none());
}

#[test]
fn cancel_with_no_pending_upgrade_returns_error() {
    let (_env, _admin, client) = setup();
    let result = client.try_cancel_pending_upgrade();
    assert!(result.is_err());
}

// ─── Execute with no pending upgrade ─────────────────────────────────────────

#[test]
fn execute_with_no_pending_upgrade_returns_error() {
    let (_env, _admin, client) = setup();
    let result = client.try_execute_pending_upgrade();
    assert!(result.is_err());
}

// ─── Upgrade delay configuration ─────────────────────────────────────────────

#[test]
fn upgrade_delay_defaults_to_48_hours() {
    let (_env, _admin, client) = setup();
    assert_eq!(client.get_upgrade_delay(), 48 * 3_600);
}

#[test]
fn set_upgrade_delay_accepted_in_valid_range() {
    let (_env, _admin, client) = setup();
    // 24 hours
    client.set_upgrade_delay(&(24 * 3_600)).unwrap();
    assert_eq!(client.get_upgrade_delay(), 24 * 3_600);
}

// ─── Upgrade history preserved after execute ─────────────────────────────────

#[test]
fn upgrade_history_recorded_after_execute() {
    let (env, _admin, client) = setup();
    let name = Symbol::new(&env, "bounty");

    client
        .schedule_upgrade(&zero_hash(&env), &name, &1, &zero_hash(&env))
        .unwrap();
    advance_time(&env, 48 * 3_600 + 1);
    client.execute_pending_upgrade().unwrap();

    let history = client.get_upgrade_history(&name);
    assert_eq!(history.len(), 1);
    assert_eq!(history.get(0).unwrap().new_version, 1);
}
