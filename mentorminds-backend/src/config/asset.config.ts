/**
 * Asset Configuration
 * Network-aware asset issuer configuration for Stellar mainnet and testnet.
 * Provides runtime issuer selection based on STELLAR_NETWORK environment variable.
 */

import { AssetCode } from '../types/asset.types';

export type StellarNetwork = 'mainnet' | 'testnet';

/**
 * Asset issuer configuration for a specific asset across networks.
 * Contains both mainnet and testnet issuer addresses.
 */
export interface AssetIssuerConfig {
  code: AssetCode;
  mainnetIssuer: string | null;
  testnetIssuer: string | null;
  decimals: number;
  name: string;
}

/**
 * Asset issuer configurations for all supported assets.
 * 
 * USDC Issuers:
 * - Mainnet: Circle's official USDC issuer
 * - Testnet: Circle's testnet USDC issuer
 * 
 * PYUSD Issuers:
 * - Mainnet: PayPal's official PYUSD issuer
 * - Testnet: Test issuer for PYUSD (placeholder - update with official testnet issuer when available)
 * 
 * Note: XLM is the native asset and has no issuer.
 */
export const ASSET_ISSUER_CONFIG: Record<AssetCode, AssetIssuerConfig> = {
  XLM: {
    code: 'XLM',
    mainnetIssuer: null, // Native asset
    testnetIssuer: null, // Native asset
    decimals: 7,
    name: 'Stellar Lumens',
  },
  USDC: {
    code: 'USDC',
    // Circle USDC on Stellar Mainnet
    mainnetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    // Circle USDC on Stellar Testnet
    testnetIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    decimals: 6,
    name: 'USD Coin',
  },
  PYUSD: {
    code: 'PYUSD',
    // PayPal USD on Stellar Mainnet
    mainnetIssuer: 'GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF',
    // PayPal USD on Stellar Testnet (placeholder - update when official testnet issuer is available)
    // For testing purposes, you can use a custom test asset or wait for official testnet support
    testnetIssuer: 'GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF', // Using mainnet as placeholder
    decimals: 6,
    name: 'PayPal USD',
  },
};

/**
 * Get the current Stellar network from environment variables.
 * Defaults to 'testnet' if not specified.
 * 
 * @returns The current network ('mainnet' or 'testnet')
 */
export function getCurrentNetwork(): StellarNetwork {
  const network = process.env.STELLAR_NETWORK?.toLowerCase();
  return network === 'mainnet' ? 'mainnet' : 'testnet';
}

/**
 * Get the issuer address for an asset on the current network.
 * 
 * @param assetCode - The asset code (XLM, USDC, or PYUSD)
 * @param network - Optional network override (defaults to current network from env)
 * @returns The issuer address for the asset on the specified network, or null for native asset
 * @throws Error if the asset code is not supported
 */
export function getAssetIssuer(
  assetCode: AssetCode,
  network?: StellarNetwork
): string | null {
  const config = ASSET_ISSUER_CONFIG[assetCode];
  if (!config) {
    throw new Error(`Unsupported asset code: ${assetCode}`);
  }

  const targetNetwork = network || getCurrentNetwork();
  return targetNetwork === 'mainnet' ? config.mainnetIssuer : config.testnetIssuer;
}

/**
 * Get all asset issuer configurations.
 * 
 * @returns Record of all asset issuer configurations
 */
export function getAllAssetConfigs(): Record<AssetCode, AssetIssuerConfig> {
  return ASSET_ISSUER_CONFIG;
}

/**
 * Validate that an issuer address is properly formatted.
 * Stellar addresses are 56 characters long and start with 'G'.
 * 
 * @param issuer - The issuer address to validate
 * @returns true if the issuer is valid, false otherwise
 */
export function isValidIssuerAddress(issuer: string | null): boolean {
  if (issuer === null) return true; // Native asset
  return typeof issuer === 'string' && issuer.length === 56 && issuer.startsWith('G');
}

/**
 * Get a human-readable description of the current asset configuration.
 * Useful for logging and debugging.
 * 
 * @returns Configuration summary string
 */
export function getAssetConfigSummary(): string {
  const network = getCurrentNetwork();
  const lines = [`Asset Configuration (Network: ${network})`];
  
  for (const [code, config] of Object.entries(ASSET_ISSUER_CONFIG)) {
    const issuer = network === 'mainnet' ? config.mainnetIssuer : config.testnetIssuer;
    lines.push(`  ${code}: ${issuer || 'native'}`);
  }
  
  return lines.join('\n');
}
