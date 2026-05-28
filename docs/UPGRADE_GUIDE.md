# Contract Upgrade Guide

## Overview

This guide documents the procedures for upgrading MentorsMind smart contracts on the Stellar Soroban blockchain. All upgrades follow semantic versioning and include comprehensive migration paths.

## Table of Contents

1. [Upgrade Process](#upgrade-process)
2. [Migration Procedures](#migration-procedures)
3. [Rollback Steps](#rollback-steps)
4. [Breaking Changes](#breaking-changes)
5. [Upgrade Checklist](#upgrade-checklist)
6. [Upgrade Scripts](#upgrade-scripts)

---

## Upgrade Process

### Phase 1: Preparation

1. **Review Changes**
   - Examine all code changes in the new version
   - Identify breaking changes using VERSION_POLICY.md
   - Assess impact on existing data and integrations

2. **Build New Version**

   ```bash
   npm run build
   npm run optimize
   ```

3. **Test Locally**

   ```bash
   npm run local:reset
   npm run test
   npm run local:seed
   ```

4. **Verify Compatibility**
   - Run integration tests against old data
   - Test state machine transitions
   - Validate event emissions

### Phase 2: Staging Deployment

1. **Deploy to Testnet**

   ```bash
   soroban contract deploy \
     --wasm contracts/escrow/target/wasm32-unknown-unknown/release/mentorminds_escrow.wasm \
     --network testnet \
     --source-account <admin-account>
   ```

2. **Register Upgrade**
   - Call `upgrade_registry.register_upgrade()` with:
     - Contract name
     - Old version number
     - New version number
     - Changelog hash (SHA-256 of CHANGELOG.md)

3. **Run Staging Tests**
   - Execute full integration test suite
   - Verify all contract functions
   - Test cross-contract interactions

### Phase 3: Production Deployment

1. **Announce Upgrade**
   - Notify all integrators 48 hours in advance
   - Provide migration guide for breaking changes
   - Share upgrade window and expected downtime

2. **Deploy to Mainnet**

   ```bash
   soroban contract deploy \
     --wasm contracts/escrow/target/wasm32-unknown-unknown/release/mentorminds_escrow.wasm \
     --network public \
     --source-account <admin-account>
   ```

3. **Register Upgrade**
   - Call `upgrade_registry.register_upgrade()` on mainnet
   - Record transaction hash for audit trail

4. **Verify Deployment**
   - Call contract functions to confirm deployment
   - Check event emissions
   - Validate state consistency

---

## Migration Procedures

### Data Migration Pattern

For breaking changes that modify storage structure:

1. **Create Migration Contract**

   ```rust
   pub fn migrate_data(env: Env, old_contract: Address) -> Result<(), Error> {
       // 1. Read data from old contract
       let old_data = old_contract.read_state()?;

       // 2. Transform data to new format
       let new_data = transform_data(old_data)?;

       // 3. Write to new storage
       write_new_state(env, new_data)?;

       // 4. Emit migration event
       env.events().publish(
           (symbol_short!("migrate"),),
           MigrationEvent {
               old_version: 1,
               new_version: 2,
               timestamp: env.ledger().timestamp(),
           }
       );

       Ok(())
   }
   ```

2. **Execute Migration**
   - Call migration function with old contract address
   - Verify data integrity post-migration
   - Validate all records transformed correctly

3. **Verify Migration**
   - Compare record counts before/after
   - Spot-check random records
   - Run consistency checks

### Stream Migration Example

For V1 to V2 stream migrations:

```bash
# 1. Identify V1 streams
soroban contract invoke \
  --id <stream-contract-id> \
  --network testnet \
  -- list_streams_v1

# 2. Migrate each stream
soroban contract invoke \
  --id <stream-contract-id> \
  --network testnet \
  -- migrate_stream \
  --sender <account> \
  --v1_id <stream-id>

# 3. Verify migration event
soroban events \
  --network testnet \
  --topic "migrate"
```

### State Synchronization

For upgrades affecting backend integration:

1. **Pause New Operations**
   - Stop accepting new escrows/streams
   - Allow existing operations to complete

2. **Sync Database**
   - Query all on-chain records
   - Update backend database with new state
   - Verify consistency

3. **Resume Operations**
   - Re-enable new operations
   - Monitor for anomalies

---

## Rollback Steps

### Immediate Rollback (Within 1 Hour)

If critical issues are discovered:

1. **Stop New Operations**

   ```bash
   # Call pause function on new contract
   soroban contract invoke \
     --id <new-contract-id> \
     --network public \
     -- pause
   ```

2. **Revert to Previous Version**

   ```bash
   # Update contract reference to old version
   soroban contract deploy \
     --wasm contracts/escrow/target/wasm32-unknown-unknown/release/mentorminds_escrow_v1.wasm \
     --network public \
     --source-account <admin-account>
   ```

3. **Verify Rollback**
   - Confirm old contract is active
   - Test critical functions
   - Monitor event stream

### Delayed Rollback (After 1 Hour)

If issues are discovered after operations have resumed:

1. **Assess Data Integrity**
   - Identify affected records
   - Determine if data can be recovered
   - Calculate potential losses

2. **Execute Rollback**
   - Deploy previous version
   - Run data recovery procedures
   - Notify affected users

3. **Post-Mortem**
   - Document root cause
   - Update testing procedures
   - Implement preventive measures

### Rollback Checklist

- [ ] Pause new operations on new contract
- [ ] Deploy previous version
- [ ] Verify old contract is active
- [ ] Test critical functions
- [ ] Check event stream
- [ ] Notify integrators
- [ ] Document incident
- [ ] Schedule post-mortem

---

## Breaking Changes

### Identifying Breaking Changes

Refer to VERSION_POLICY.md for complete list. Common examples:

**Storage Changes**

- Modifying existing storage keys
- Removing storage keys
- Changing data types
- Reordering storage layout

**Function Interface Changes**

- Changing parameter types or order
- Changing return types
- Removing public functions
- Changing function behavior

**Event Changes**

- Modifying event structure
- Removing events
- Changing event topics

**Business Logic Changes**

- Fee calculation changes
- Authorization changes
- Timing changes
- Token economics changes

### Migration for Breaking Changes

1. **Escrow Status Changes**

   ```rust
   // Old: Active, Released, Disputed, Refunded
   // New: Active, Released, Disputed, Refunded, Resolved

   // Migration: No data change needed, new status only used for new escrows
   ```

2. **Fee Calculation Changes**

   ```rust
   // Old: flat 5% fee
   // New: tiered fee (1-5% based on amount)

   // Migration: Recalculate fees for existing escrows
   let new_fee = calculate_tiered_fee(escrow.amount);
   escrow.platform_fee = new_fee;
   ```

3. **Authorization Changes**

   ```rust
   // Old: Only mentor can release
   // New: Mentor or admin can release

   // Migration: No data change, new logic applies to new operations
   ```

---

## Upgrade Checklist

### Pre-Upgrade

- [ ] All tests passing locally
- [ ] Code review completed
- [ ] Security audit passed (if applicable)
- [ ] CHANGELOG.md updated
- [ ] VERSION_POLICY.md reviewed
- [ ] Migration guide prepared
- [ ] Integrators notified
- [ ] Rollback plan documented
- [ ] Testnet deployment successful
- [ ] Staging tests passed

### During Upgrade

- [ ] Announce upgrade window
- [ ] Deploy to mainnet
- [ ] Register upgrade in upgrade_registry
- [ ] Verify deployment
- [ ] Monitor event stream
- [ ] Check error rates
- [ ] Verify state consistency

### Post-Upgrade

- [ ] All functions working correctly
- [ ] Events emitting properly
- [ ] No error spikes
- [ ] Database synchronized
- [ ] Integrators confirmed success
- [ ] Update documentation
- [ ] Archive old version
- [ ] Schedule post-upgrade review

---

## Upgrade Scripts

### Build and Optimize

```bash
#!/bin/bash
# scripts/upgrade.sh - Complete upgrade workflow

set -e

CONTRACT=${1:-escrow}
NETWORK=${2:-testnet}

echo "🔨 Building $CONTRACT contract..."
cargo build --package $CONTRACT --target wasm32-unknown-unknown --release

echo "⚙️  Optimizing WASM..."
soroban contract optimize \
  --wasm contracts/$CONTRACT/target/wasm32-unknown-unknown/release/mentorminds_$CONTRACT.wasm

echo "📦 Deploying to $NETWORK..."
CONTRACT_ID=$(soroban contract deploy \
  --wasm contracts/$CONTRACT/target/wasm32-unknown-unknown/release/mentorminds_$CONTRACT.wasm \
  --network $NETWORK \
  --source-account default)

echo "✅ Deployed: $CONTRACT_ID"
echo "📝 Register upgrade with:"
echo "   soroban contract invoke --id <upgrade-registry-id> -- register_upgrade"
```

### Verify Upgrade

```bash
#!/bin/bash
# scripts/verify-upgrade.sh - Verify upgrade success

CONTRACT_ID=$1
NETWORK=${2:-testnet}

echo "🔍 Verifying contract deployment..."

# Test basic function
echo "Testing contract functions..."
soroban contract invoke \
  --id $CONTRACT_ID \
  --network $NETWORK \
  -- get_contract_info

# Check events
echo "Checking recent events..."
soroban events \
  --network $NETWORK \
  --contract $CONTRACT_ID \
  --limit 10

echo "✅ Verification complete"
```

### Rollback Script

```bash
#!/bin/bash
# scripts/rollback.sh - Rollback to previous version

CONTRACT=${1:-escrow}
NETWORK=${2:-testnet}
OLD_VERSION=${3:-v1}

echo "⚠️  Rolling back $CONTRACT to $OLD_VERSION..."

# Pause new contract
echo "Pausing new contract..."
soroban contract invoke \
  --id <new-contract-id> \
  --network $NETWORK \
  -- pause

# Deploy old version
echo "Deploying old version..."
soroban contract deploy \
  --wasm contracts/$CONTRACT/target/wasm32-unknown-unknown/release/mentorminds_${CONTRACT}_${OLD_VERSION}.wasm \
  --network $NETWORK \
  --source-account default

echo "✅ Rollback complete"
```

---

## Version History

See CHANGELOG.md for complete version history and upgrade notes.

## Support

For upgrade assistance:

- Review ERRORS.md for error codes
- Check TROUBLESHOOTING.md for common issues
- Contact security@mentorminds.io for security concerns
