# Configuration Guide

## Overview

This document describes the configuration options for the MentorMinds backend, with special focus on network-specific asset configuration.

## Environment Variables

### Core Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | Server port |
| `NODE_ENV` | No | `development` | Environment mode (`development`, `production`) |
| `FRONTEND_URL` | No | `*` | Frontend URL for CORS configuration |

### Stellar Network Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STELLAR_NETWORK` | No | `testnet` | Stellar network to use (`testnet` or `mainnet`) |
| `HORIZON_URL` | No | Network-dependent | Horizon API endpoint |
| `NETWORK_PASSPHRASE` | No | Network-dependent | Stellar network passphrase |

### Database Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes (production) | - | PostgreSQL connection string |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection string |

### Stellar Account Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STELLAR_STARTING_BALANCE` | No | `2.5` | Starting XLM balance for new accounts |

### Soroban Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SOROBAN_RPC_URL` | No | Network-dependent | Soroban RPC endpoint |
| `SOROBAN_CB_FAILURE_THRESHOLD` | No | `5` | Circuit breaker failure threshold |
| `SOROBAN_CB_RECOVERY_MS` | No | `30000` | Circuit breaker recovery time (ms) |

### Contract IDs

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ESCROW_CONTRACT_ID` | Yes | - | Escrow smart contract ID |
| `VERIFICATION_CONTRACT_ID` | Yes | - | Verification contract ID |
| `MNT_TOKEN_CONTRACT_ID` | Yes | - | MNT token contract ID |
| `REFERRAL_CONTRACT_ID` | Yes | - | Referral contract ID |

## Asset Configuration

### Network-Aware Asset Issuers

The application automatically selects the correct asset issuer addresses based on the `STELLAR_NETWORK` environment variable. This ensures that operations work correctly on both testnet and mainnet.

### Supported Assets

#### XLM (Stellar Lumens)
- **Type**: Native asset
- **Issuer**: None (native)
- **Decimals**: 7
- **Networks**: Mainnet, Testnet

#### USDC (USD Coin)
- **Type**: Credit asset
- **Decimals**: 6
- **Mainnet Issuer**: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
  - Issued by: Circle
  - Verified: ✓
- **Testnet Issuer**: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
  - Issued by: Circle (Testnet)
  - Verified: ✓

#### PYUSD (PayPal USD)
- **Type**: Credit asset
- **Decimals**: 6
- **Mainnet Issuer**: `GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF`
  - Issued by: PayPal
  - Verified: ✓
- **Testnet Issuer**: `GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF`
  - Note: Currently using mainnet issuer as placeholder
  - Status: ⚠️ Update when official testnet issuer is available

### Verifying Asset Issuers

The application performs automatic validation of asset issuers at startup:

1. **Format Validation**: Checks that issuer addresses are properly formatted (56 characters, starts with 'G')
2. **Existence Validation**: Verifies that issuer accounts exist on the configured network
3. **Network Consistency**: Ensures issuers match the active network

#### Startup Validation Behavior

- **Production Mode** (`NODE_ENV=production`):
  - Validation failure throws an error and prevents startup
  - Ensures no misconfiguration in production

- **Development Mode** (`NODE_ENV=development`):
  - Validation failure logs a warning but allows startup
  - Enables development with placeholder issuers

### Configuration Files

Asset configuration is managed in:
- `src/config/asset.config.ts` - Network-aware issuer configuration
- `src/services/asset.service.ts` - Asset metadata service
- `src/services/asset-validation.service.ts` - Startup validation

## Network Configuration Examples

### Testnet Configuration

```bash
# .env
STELLAR_NETWORK=testnet
HORIZON_URL=https://horizon-testnet.stellar.org
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
```

**Asset Issuers Used**:
- XLM: Native
- USDC: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
- PYUSD: `GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF` (placeholder)

### Mainnet Configuration

```bash
# .env
STELLAR_NETWORK=mainnet
HORIZON_URL=https://horizon.stellar.org
NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
SOROBAN_RPC_URL=https://soroban-mainnet.stellar.org
```

**Asset Issuers Used**:
- XLM: Native
- USDC: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
- PYUSD: `GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF`

## Troubleshooting

### Asset Not Found Errors

**Symptom**: Operations fail with "asset_not_found" or empty orderbooks

**Causes**:
1. Wrong network configuration (using mainnet issuers on testnet)
2. Issuer account doesn't exist on the network
3. Missing `STELLAR_NETWORK` environment variable

**Solutions**:
1. Verify `STELLAR_NETWORK` matches your `HORIZON_URL`
2. Check startup logs for asset validation warnings
3. Ensure issuer accounts exist on the target network

### Startup Validation Failures

**Symptom**: Application fails to start with asset validation error

**Causes**:
1. Invalid issuer address format
2. Issuer account not found on network
3. Network connectivity issues

**Solutions**:
1. Check issuer addresses in `src/config/asset.config.ts`
2. Verify network connectivity to Horizon API
3. In development, validation warnings won't prevent startup

### PYUSD Testnet Issues

**Known Issue**: PYUSD testnet issuer is currently a placeholder

**Workaround**:
1. For testnet development, consider using only XLM and USDC
2. Update `ASSET_ISSUER_CONFIG.PYUSD.testnetIssuer` when official testnet issuer is available
3. Monitor PayPal's Stellar integration announcements

## Adding New Assets

To add support for a new asset:

1. **Update Type Definitions** (`src/types/asset.types.ts`):
   ```typescript
   export type AssetCode = 'XLM' | 'USDC' | 'PYUSD' | 'NEWASSET';
   ```

2. **Add Asset Configuration** (`src/config/asset.config.ts`):
   ```typescript
   NEWASSET: {
     code: 'NEWASSET',
     mainnetIssuer: 'G...',
     testnetIssuer: 'G...',
     decimals: 7,
     name: 'New Asset Name',
   }
   ```

3. **Update Exchange Rate Service** (if needed):
   - Add asset pairs to `ASSET_PAIRS` in `exchange-rate.service.ts`

4. **Test Configuration**:
   ```bash
   npm run start
   # Check startup logs for validation results
   ```

## Security Considerations

### Issuer Verification

Always verify asset issuers before adding them to configuration:

1. **Check Official Sources**: Verify issuer addresses from official documentation
2. **Use Stellar Expert**: Check issuer reputation on stellar.expert
3. **Verify on Network**: Ensure issuer account exists and is properly configured
4. **Test on Testnet First**: Always test new assets on testnet before mainnet

### Environment Separation

- Never use testnet configuration in production
- Keep mainnet and testnet configurations in separate environment files
- Use CI/CD to enforce correct configuration per environment

## Monitoring

### Startup Logs

The application logs asset configuration at startup:

```
============================================================
Validating Asset Configuration...
============================================================
Asset Configuration (Network: testnet)
  XLM: native
  USDC: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
  PYUSD: GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF

✓ XLM: native
✓ USDC: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
⚠ PYUSD: GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF
  Warning: Using placeholder testnet issuer

✓ All asset issuers validated successfully
============================================================
```

### Health Check Endpoint

Check asset configuration via API:

```bash
curl http://localhost:3001/health
```

## References

- [Stellar Asset Documentation](https://developers.stellar.org/docs/issuing-assets)
- [Circle USDC on Stellar](https://www.circle.com/en/usdc-multichain/stellar)
- [PayPal PYUSD Documentation](https://www.paypal.com/us/digital-wallet/manage-money/crypto/pyusd)
- [Stellar Expert](https://stellar.expert/) - Asset verification tool

## Changelog

### 2026-04-28
- Added network-aware asset configuration
- Implemented startup validation for asset issuers
- Added separate mainnet/testnet issuer addresses
- Updated USDC and PYUSD issuer addresses
- Added comprehensive documentation

### Previous
- Initial asset configuration with hardcoded issuers
