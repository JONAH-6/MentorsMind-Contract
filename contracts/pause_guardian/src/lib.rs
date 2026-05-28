#![no_std]

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};

const PAUSED: Symbol = symbol_short!("PAUSED");
const ADMIN: Symbol = symbol_short!("ADMIN");
/// Number of consecutive failures required to trip the circuit breaker.
const CIRCUIT_THRESHOLD: u32 = 3;
const FAILURES: Symbol = symbol_short!("FAILURES");

#[contract]
pub struct PauseGuardian;

#[contractimpl]
impl PauseGuardian {
    /// Initialize with an admin address.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&ADMIN) {
            panic!("already initialized");
        }
        env.storage().instance().set(&ADMIN, &admin);
        env.storage().instance().set(&PAUSED, &false);
        env.storage().instance().set(&FAILURES, &0u32);
    }

    /// Pause or unpause the contract. Admin only.
    pub fn set_paused(env: Env, value: bool) {
        let admin: Address = env.storage().instance().get(&ADMIN).expect("not initialized");
        admin.require_auth();
        env.storage().instance().set(&PAUSED, &value);
        // Reset failure counter when an admin manually unpauses.
        if !value {
            env.storage().instance().set(&FAILURES, &0u32);
        }
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED).unwrap_or(false)
    }

    /// Record a yield/external contract failure.
    /// Automatically trips the circuit breaker (pauses) after CIRCUIT_THRESHOLD failures.
    pub fn record_failure(env: Env) {
        let count: u32 = env.storage().instance().get(&FAILURES).unwrap_or(0);
        let next = count.saturating_add(1);
        env.storage().instance().set(&FAILURES, &next);
        if next >= CIRCUIT_THRESHOLD {
            env.storage().instance().set(&PAUSED, &true);
        }
    }

    /// Returns the current consecutive failure count.
    pub fn failure_count(env: Env) -> u32 {
        env.storage().instance().get(&FAILURES).unwrap_or(0)
    }

    /// Reset failure counter. Admin only.
    pub fn reset_failures(env: Env) {
        let admin: Address = env.storage().instance().get(&ADMIN).expect("not initialized");
        admin.require_auth();
        env.storage().instance().set(&FAILURES, &0u32);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    #[test]
    fn test_circuit_breaker_trips_after_threshold() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(PauseGuardian, ());
        let client = PauseGuardianClient::new(&env, &contract_id);
        client.initialize(&admin);

        assert!(!client.is_paused());
        client.record_failure();
        client.record_failure();
        assert!(!client.is_paused());
        client.record_failure(); // hits threshold
        assert!(client.is_paused());
        assert_eq!(client.failure_count(), 3);
    }

    #[test]
    fn test_manual_unpause_resets_failures() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register(PauseGuardian, ());
        let client = PauseGuardianClient::new(&env, &contract_id);
        client.initialize(&admin);

        client.record_failure();
        client.record_failure();
        client.record_failure();
        assert!(client.is_paused());

        client.set_paused(&false);
        assert!(!client.is_paused());
        assert_eq!(client.failure_count(), 0);
    }
}
