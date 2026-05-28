# Custodial Wallet Design

**Status:** Deliberate design decision — security review required before production enablement.

## Overview

MentorMinds supports two wallet modes:

| Mode | Secret stored? | Who signs? | Risk |
|------|---------------|------------|------|
| **Custodial** | Yes (encrypted) | Platform | DB + KMS compromise exposes funds |
| **Non-custodial** | No | User (Freighter / own key) | Platform cannot act on user's behalf |

## Custodial Mode

### How it works

1. Platform generates a Stellar keypair via `Keypair.random()`.
2. The secret key is encrypted and stored in `wallets.encrypted_secret_key`.
3. The plaintext secret exists only in memory during the encrypt call and during transaction signing.
4. The `WalletRecord` type and all SELECT queries **exclude** `encrypted_secret_key` — it is never returned in API responses or logs.

### Encryption backend

| Environment | Backend | Config |
|-------------|---------|--------|
| Production | AWS KMS | `AWS_KMS_KEY_ID=<key-arn>` |
| Dev / CI | AES-256-GCM | `WALLET_ENCRYPTION_KEY=<64-char hex>` |

AWS KMS is strongly preferred for production: the plaintext key material never leaves the KMS HSM, and all encrypt/decrypt calls are logged in CloudTrail.

### Key rotation

Run `WalletModel.rotateAllKeys()` after rotating `AWS_KMS_KEY_ID` or `WALLET_ENCRYPTION_KEY`. The method:

1. Reads custodial wallets in batches of 100.
2. Decrypts each secret with the **old** key (pass a custom `decryptFn` if needed).
3. Re-encrypts with the **current** key.
4. Persists the new ciphertext atomically per row.

```ts
// Example: rotate all keys after updating AWS_KMS_KEY_ID
const { rotated, failed } = await walletModel.rotateAllKeys();
console.log(`Rotated ${rotated} wallets, ${failed} failures`);
```

### Threat model

| Threat | Mitigation |
|--------|-----------|
| DB breach | Secrets are encrypted; attacker needs KMS access too |
| KMS key compromise | Rotate key immediately; re-encrypt all secrets |
| Memory scraping | Plaintext secret held only during signing; not logged |
| API response leak | `encrypted_secret_key` excluded from all `WalletRecord` queries |
| Log leak | Never log secret key values; log key names only |

### Security review checklist

- [ ] KMS key policy restricts decrypt to the backend service role only
- [ ] CloudTrail logging enabled for the KMS key
- [ ] `encrypted_secret_key` column has column-level encryption or restricted DB role
- [ ] `getDecryptedSecret()` call sites are audited and rate-limited
- [ ] Key rotation runbook documented and tested
- [ ] Incident response plan for KMS key compromise

## Non-custodial Mode

Users provide their own Stellar public key. No secret is stored. The platform:

- Can receive payments to the user's address.
- Cannot sign transactions on behalf of the user.
- Requires the user to sign via Freighter or another wallet.

```ts
// Create a non-custodial wallet
await walletModel.createNonCustodial(userId, userPublicKey);
```

## Migration path

To migrate a custodial user to non-custodial:

1. User connects their own wallet (Freighter).
2. Platform transfers any custodial balance to the user's new address.
3. Update the wallet record: set `custodial = FALSE`, clear `encrypted_secret_key`.
4. Invalidate cache.

## References

- [AWS KMS Developer Guide](https://docs.aws.amazon.com/kms/latest/developerguide/)
- [Stellar Keypair documentation](https://stellar.github.io/js-stellar-sdk/Keypair.html)
- `src/services/kms-encryption.service.ts`
- `src/models/wallet.model.ts`
