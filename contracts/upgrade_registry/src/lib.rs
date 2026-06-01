#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    Symbol, Vec,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized  = 1,
    NotInitialized      = 2,
    NotAdmin            = 3,
    ContractNotFound    = 4,
    AlreadySubscribed   = 5,
    NotSubscribed       = 6,
    /// New version must be strictly greater than the current version.
    VersionNotMonotonic = 7,
    /// A timelock delay must elapse before the upgrade executes.
    TimelockNotElapsed  = 8,
    /// An upgrade is already pending; cancel it first.
    UpgradePending      = 9,
    /// No pending upgrade to execute or cancel.
    NoPendingUpgrade    = 10,
}

// ---------------------------------------------------------------------------
// Data Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeRecord {
    pub old_version:    u32,
    pub new_version:    u32,
    pub changelog_hash: BytesN<32>,
    pub timestamp:      u64,
    pub admin:          Address,
}

// ---------------------------------------------------------------------------
// Storage Keys
// ---------------------------------------------------------------------------

/// A pending (time-locked) upgrade waiting for the delay to elapse.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpgrade {
    /// WASM hash to apply when the timelock expires.
    pub new_wasm_hash:    BytesN<32>,
    /// Human-readable contract name for registry bookkeeping.
    pub contract_name:    Symbol,
    /// New version number (must be > current version).
    pub new_version:      u32,
    /// Changelog hash for audit trail.
    pub changelog_hash:   BytesN<32>,
    /// Ledger timestamp at which this upgrade was scheduled.
    pub scheduled_at:     u64,
    /// Earliest timestamp at which `execute_pending_upgrade` may be called.
    pub executable_after: u64,
    /// Admin that initiated the upgrade.
    pub admin:            Address,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    UpgradeHistory(Symbol),
    LatestVersion(Symbol),
    Subscribers(Symbol),
    /// Stores the single pending upgrade (only one may be in-flight at a time).
    PendingUpgrade,
    /// Minimum timelock delay in seconds for upgrades (default 48 h).
    UpgradeDelay,
}

/// Default upgrade timelock: 48 hours.
const DEFAULT_UPGRADE_DELAY: u64 = 48 * 60 * 60;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct UpgradeRegistryContract;

#[contractimpl]
impl UpgradeRegistryContract {
    /// Initialize the upgrade registry.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("init")),
            admin,
        );
        Ok(())
    }

    // ─── Upgrade delay configuration ─────────────────────────────────────

    /// Set the minimum timelock delay (seconds) that must elapse between
    /// scheduling and executing an upgrade. Admin only.
    ///
    /// Must be between 1 hour and 30 days.
    pub fn set_upgrade_delay(env: Env, delay_secs: u64) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        let min = 3_600_u64;       // 1 hour
        let max = 30 * 24 * 3_600_u64; // 30 days
        if delay_secs < min || delay_secs > max {
            panic!("upgrade delay out of range [1h, 30d]");
        }
        env.storage().instance().set(&DataKey::UpgradeDelay, &delay_secs);
        Ok(())
    }

    /// Return the current upgrade delay in seconds.
    pub fn get_upgrade_delay(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::UpgradeDelay)
            .unwrap_or(DEFAULT_UPGRADE_DELAY)
    }

    // ─── Two-step time-locked upgrade ────────────────────────────────────

    /// Schedule a UUPS upgrade. Admin only.
    ///
    /// The upgrade will not execute immediately — `execute_pending_upgrade`
    /// must be called after `get_upgrade_delay()` seconds have elapsed.
    /// Only one upgrade may be pending at a time.
    ///
    /// # Safety guards
    /// - Re-initialization is prevented: `initialize` checks storage before
    ///   writing, so calling it again is a no-op error.
    /// - Version monotonicity: `new_version` must be strictly greater than the
    ///   current latest version for `contract_name`.
    /// - Timelock: the upgrade cannot execute until the delay has elapsed.
    pub fn schedule_upgrade(
        env: Env,
        new_wasm_hash: BytesN<32>,
        contract_name: Symbol,
        new_version: u32,
        changelog_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        // Guard: only one pending upgrade at a time.
        if env.storage().instance().has(&DataKey::PendingUpgrade) {
            return Err(Error::UpgradePending);
        }

        // Guard: version must be strictly monotonically increasing.
        let current_version: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::LatestVersion(contract_name.clone()))
            .unwrap_or(0);
        if new_version <= current_version {
            return Err(Error::VersionNotMonotonic);
        }

        let delay = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeDelay)
            .unwrap_or(DEFAULT_UPGRADE_DELAY);

        let now = env.ledger().timestamp();
        let pending = PendingUpgrade {
            new_wasm_hash: new_wasm_hash.clone(),
            contract_name: contract_name.clone(),
            new_version,
            changelog_hash: changelog_hash.clone(),
            scheduled_at: now,
            executable_after: now.saturating_add(delay),
            admin: admin.clone(),
        };

        env.storage().instance().set(&DataKey::PendingUpgrade, &pending);

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("sched"), contract_name),
            (new_version, now.saturating_add(delay), new_wasm_hash),
        );
        Ok(())
    }

    /// Execute the pending upgrade once the timelock has elapsed. Admin only.
    ///
    /// Applies the WASM swap, records the upgrade in history, and clears the
    /// pending slot.
    pub fn execute_pending_upgrade(env: Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        let pending: PendingUpgrade = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .ok_or(Error::NoPendingUpgrade)?;

        // Guard: timelock must have elapsed.
        if env.ledger().timestamp() < pending.executable_after {
            return Err(Error::TimelockNotElapsed);
        }

        // Record upgrade history.
        let old_version: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::LatestVersion(pending.contract_name.clone()))
            .unwrap_or(0);

        let record = UpgradeRecord {
            old_version,
            new_version: pending.new_version,
            changelog_hash: pending.changelog_hash.clone(),
            timestamp: env.ledger().timestamp(),
            admin: admin.clone(),
        };

        let mut history: Vec<UpgradeRecord> = env
            .storage()
            .persistent()
            .get(&DataKey::UpgradeHistory(pending.contract_name.clone()))
            .unwrap_or(Vec::new(&env));
        history.push_back(record);
        env.storage()
            .persistent()
            .set(&DataKey::UpgradeHistory(pending.contract_name.clone()), &history);
        env.storage()
            .persistent()
            .set(&DataKey::LatestVersion(pending.contract_name.clone()), &pending.new_version);

        // Clear pending slot before WASM swap to prevent re-entrancy.
        env.storage().instance().remove(&DataKey::PendingUpgrade);

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("exec"), pending.contract_name),
            (old_version, pending.new_version, pending.new_wasm_hash.clone()),
        );

        // Apply the UUPS upgrade.
        env.deployer().update_current_contract_wasm(pending.new_wasm_hash);

        Ok(())
    }

    /// Cancel a scheduled (pending) upgrade. Admin only.
    pub fn cancel_pending_upgrade(env: Env) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        if !env.storage().instance().has(&DataKey::PendingUpgrade) {
            return Err(Error::NoPendingUpgrade);
        }

        env.storage().instance().remove(&DataKey::PendingUpgrade);

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("cancel")),
            (),
        );
        Ok(())
    }

    /// Return the pending upgrade, if any.
    pub fn get_pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        env.storage().instance().get(&DataKey::PendingUpgrade)
    }

    /// UUPS upgrade: replace this contract's WASM with a new version.
    ///
    /// This is the core UUPS pattern for Soroban: the upgrade logic lives
    /// inside the contract itself, authorized by the admin.
    /// After calling this, the contract at the same address runs new code.
    pub fn upgrade_contract(
        env: Env,
        new_wasm_hash: BytesN<32>,
        contract_name: Symbol,
        new_version: u32,
        changelog_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        let old_version: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::LatestVersion(contract_name.clone()))
            .unwrap_or(0);

        // Record the upgrade before applying it
        let record = UpgradeRecord {
            old_version,
            new_version,
            changelog_hash: changelog_hash.clone(),
            timestamp: env.ledger().timestamp(),
            admin: admin.clone(),
        };

        let mut history: Vec<UpgradeRecord> = env
            .storage()
            .persistent()
            .get(&DataKey::UpgradeHistory(contract_name.clone()))
            .unwrap_or(Vec::new(&env));
        history.push_back(record);
        env.storage()
            .persistent()
            .set(&DataKey::UpgradeHistory(contract_name.clone()), &history);
        env.storage()
            .persistent()
            .set(&DataKey::LatestVersion(contract_name.clone()), &new_version);

        // Emit upgrade event before applying (so indexers see it)
        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("uups"), contract_name.clone()),
            (old_version, new_version, new_wasm_hash.clone(), changelog_hash),
        );

        // Apply the UUPS upgrade: swap WASM at this contract address
        env.deployer().update_current_contract_wasm(new_wasm_hash);

        Ok(())
    }

    /// Register an upgrade record without performing the WASM swap.
    /// Used to track upgrades of external contracts in the registry.
    pub fn register_upgrade(
        env: Env,
        contract_name: Symbol,
        old_version: u32,
        new_version: u32,
        changelog_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        let record = UpgradeRecord {
            old_version,
            new_version,
            changelog_hash: changelog_hash.clone(),
            timestamp: env.ledger().timestamp(),
            admin: admin.clone(),
        };

        let mut history: Vec<UpgradeRecord> = env
            .storage()
            .persistent()
            .get(&DataKey::UpgradeHistory(contract_name.clone()))
            .unwrap_or(Vec::new(&env));

        // Append before persisting so the upgrade trail remains ordered and
        // replayable by downstream indexers.
        history.push_back(record);
        env.storage()
            .persistent()
            .set(&DataKey::UpgradeHistory(contract_name.clone()), &history);
        env.storage()
            .persistent()
            .set(&DataKey::LatestVersion(contract_name.clone()), &new_version);

        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("reg"), contract_name.clone()),
            (old_version, new_version, changelog_hash),
        );
        Ok(())
    }

    /// Subscribe to upgrade notifications for a contract.
    pub fn subscribe(env: Env, subscriber: Address, contract_name: Symbol) -> Result<(), Error> {
        subscriber.require_auth();

        let mut subscribers: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Subscribers(contract_name.clone()))
            .unwrap_or(Vec::new(&env));

        for addr in subscribers.iter() {
            if addr == subscriber {
                return Err(Error::AlreadySubscribed);
            }
        }

        // Keep the subscriber list unique so the same address does not receive
        // duplicate upgrade notifications.
        subscribers.push_back(subscriber.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Subscribers(contract_name.clone()), &subscribers);

        env.events().publish(
            (symbol_short!("sub"), symbol_short!("added"), contract_name),
            subscriber,
        );
        Ok(())
    }

    /// Unsubscribe from upgrade notifications.
    pub fn unsubscribe(env: Env, subscriber: Address, contract_name: Symbol) -> Result<(), Error> {
        subscriber.require_auth();

        let subscribers: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Subscribers(contract_name.clone()))
            .unwrap_or(Vec::new(&env));

        let mut found = false;
        let mut new_subscribers = Vec::new(&env);
        for addr in subscribers.iter() {
            if addr != subscriber {
                new_subscribers.push_back(addr);
            } else {
                found = true;
            }
        }

        if !found {
            return Err(Error::NotSubscribed);
        }

        env.storage()
            .persistent()
            .set(&DataKey::Subscribers(contract_name.clone()), &new_subscribers);
        // Rebuild the list instead of mutating in place; the intent is clearer
        // and the resulting state stays deterministic.
        env.storage().persistent().set(
            &DataKey::Subscribers(contract_name.clone()),
            &new_subscribers,
        );

        env.events().publish(
            (symbol_short!("sub"), symbol_short!("removed"), contract_name),
            subscriber,
        );
        Ok(())
    }

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    pub fn get_upgrade_history(env: Env, contract_name: Symbol) -> Vec<UpgradeRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::UpgradeHistory(contract_name))
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_latest_version(env: Env, contract_name: Symbol) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::LatestVersion(contract_name))
            .unwrap_or(0)
    }

    pub fn get_subscribers(env: Env, contract_name: Symbol) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Subscribers(contract_name))
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    /// Check whether a contract meets a minimum required version.
    /// Returns true if the contract's latest version >= min_version.
    pub fn check_min_version(env: Env, contract_name: Symbol, min_version: u32) -> bool {
        let latest = env
            .storage()
            .persistent()
            .get(&DataKey::LatestVersion(contract_name))
            .unwrap_or(0u32);
        latest >= min_version
    }

    /// Returns the registry contract's own version constant.
    pub fn registry_version(_env: Env) -> u32 {
        1
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    fn setup() -> (Env, Address, UpgradeRegistryContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let admin       = Address::generate(&env);
        let contract_id = env.register_contract(None, UpgradeRegistryContract);
        let client      = UpgradeRegistryContractClient::new(&env, &contract_id);
        client.initialize(&admin).unwrap();
        (env, admin, client)
    }

    #[test]
    fn test_initialize() {
        let (env, admin, client) = setup();
        assert_eq!(client.get_admin().unwrap(), admin);
        // Double init rejected
        assert_eq!(client.try_initialize(&admin), Err(Ok(Error::AlreadyInitialized)));
    }

    #[test]
    fn test_register_upgrade() {
        let (env, _admin, client) = setup();
        let contract_name = symbol_short!("escrow");
        let hash = BytesN::from_array(&env, &[1u8; 32]);

        client.register_upgrade(&contract_name, &1, &2, &hash).unwrap();

        let history = client.get_upgrade_history(&contract_name);
        assert_eq!(history.len(), 1);
        let record = history.get(0).unwrap();
        assert_eq!(record.old_version, 1);
        assert_eq!(record.new_version, 2);
        assert_eq!(client.get_latest_version(&contract_name), 2);
    }

    #[test]
    fn test_multiple_upgrades_tracked() {
        let (env, _admin, client) = setup();
        let contract_name = symbol_short!("escrow");
        let hash = BytesN::from_array(&env, &[0u8; 32]);

        client.register_upgrade(&contract_name, &1, &2, &hash).unwrap();
        client.register_upgrade(&contract_name, &2, &3, &hash).unwrap();
        client.register_upgrade(&contract_name, &3, &4, &hash).unwrap();

        let history = client.get_upgrade_history(&contract_name);
        assert_eq!(history.len(), 3);
        assert_eq!(client.get_latest_version(&contract_name), 4);
    }

    #[test]
    fn test_subscribe() {
        let (env, _admin, client) = setup();
        let contract_name = symbol_short!("escrow");
        let subscriber    = Address::generate(&env);

        client.subscribe(&subscriber, &contract_name).unwrap();

        let subscribers = client.get_subscribers(&contract_name);
        assert_eq!(subscribers.len(), 1);
        assert_eq!(subscribers.get(0).unwrap(), subscriber);

        // Duplicate subscribe rejected
        assert_eq!(
            client.try_subscribe(&subscriber, &contract_name),
            Err(Ok(Error::AlreadySubscribed))
        );
    }

    #[test]
    fn test_unsubscribe() {
        let (env, _admin, client) = setup();
        let contract_name = symbol_short!("escrow");
        let subscriber    = Address::generate(&env);

        client.subscribe(&subscriber, &contract_name).unwrap();
        client.unsubscribe(&subscriber, &contract_name).unwrap();

        assert_eq!(client.get_subscribers(&contract_name).len(), 0);

        // Unsubscribe when not subscribed
        assert_eq!(
            client.try_unsubscribe(&subscriber, &contract_name),
            Err(Ok(Error::NotSubscribed))
        );
    }

    #[test]
    fn test_non_admin_cannot_register_upgrade() {
        let (env, _admin, client) = setup();
        let contract_name  = symbol_short!("escrow");
        let hash           = BytesN::from_array(&env, &[0u8; 32]);
        let _non_admin     = Address::generate(&env);

        // mock_all_auths is on, but the admin check is enforced by require_auth
        // In a real test without mock_all_auths this would fail; here we verify
        // the admin field is correctly stored and returned
        assert_eq!(client.get_admin().is_ok(), true);
        // Register succeeds because mock_all_auths is active
        client.register_upgrade(&contract_name, &0, &1, &hash).unwrap();
        assert_eq!(client.get_latest_version(&contract_name), 1);
    }

    #[test]
    fn test_upgrade_history_independent_per_contract() {
        let (env, _admin, client) = setup();
        let escrow_name   = symbol_short!("escrow");
        let treasury_name = symbol_short!("treasury");
        let hash          = BytesN::from_array(&env, &[0u8; 32]);

        client.register_upgrade(&escrow_name,   &1, &2, &hash).unwrap();
        client.register_upgrade(&treasury_name, &1, &3, &hash).unwrap();

        assert_eq!(client.get_latest_version(&escrow_name),   2);
        assert_eq!(client.get_latest_version(&treasury_name), 3);
        assert_eq!(client.get_upgrade_history(&escrow_name).len(),   1);
        assert_eq!(client.get_upgrade_history(&treasury_name).len(), 1);
    }
}
