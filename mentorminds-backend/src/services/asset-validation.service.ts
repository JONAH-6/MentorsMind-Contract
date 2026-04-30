/**
 * Asset Validation Service
 * Validates that configured asset issuers exist on the active Stellar network.
 * Should be run at application startup to catch configuration errors early.
 */

import { AssetCode } from '../types/asset.types';
import { 
  getCurrentNetwork, 
  getAssetIssuer, 
  isValidIssuerAddress,
  getAssetConfigSummary,
  ASSET_ISSUER_CONFIG 
} from '../config/asset.config';

/**
 * Result of asset issuer validation
 */
export interface AssetValidationResult {
  valid: boolean;
  network: string;
  assets: Array<{
    code: AssetCode;
    issuer: string | null;
    valid: boolean;
    error?: string;
  }>;
  summary: string;
}

/**
 * Validate issuer address format.
 * Checks that the issuer is either null (native) or a valid Stellar address.
 * 
 * @param assetCode - The asset code being validated
 * @param issuer - The issuer address to validate
 * @returns Validation result with error message if invalid
 */
function validateIssuerFormat(
  assetCode: AssetCode,
  issuer: string | null
): { valid: boolean; error?: string } {
  // Native asset (XLM) should have null issuer
  if (assetCode === 'XLM') {
    if (issuer !== null) {
      return {
        valid: false,
        error: 'XLM is a native asset and should not have an issuer',
      };
    }
    return { valid: true };
  }

  // Non-native assets must have an issuer
  if (issuer === null) {
    return {
      valid: false,
      error: 'Non-native asset must have an issuer address',
    };
  }

  // Validate issuer address format
  if (!isValidIssuerAddress(issuer)) {
    return {
      valid: false,
      error: `Invalid issuer address format. Expected 56-character address starting with 'G', got: ${issuer}`,
    };
  }

  return { valid: true };
}

/**
 * Validate that an issuer account exists on the Stellar network.
 * Makes a request to Horizon to check if the account exists.
 * 
 * @param issuer - The issuer address to check
 * @param horizonUrl - The Horizon API URL
 * @returns true if the account exists, false otherwise
 */
async function checkIssuerExists(
  issuer: string,
  horizonUrl: string
): Promise<{ exists: boolean; error?: string }> {
  try {
    const response = await fetch(`${horizonUrl}/accounts/${issuer}`);
    
    if (response.ok) {
      return { exists: true };
    }
    
    if (response.status === 404) {
      return {
        exists: false,
        error: 'Issuer account not found on network',
      };
    }
    
    return {
      exists: false,
      error: `Horizon API error: ${response.status} ${response.statusText}`,
    };
  } catch (error) {
    return {
      exists: false,
      error: `Failed to check issuer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Validate all configured asset issuers for the current network.
 * Checks both format and existence on the network.
 * 
 * @param options - Validation options
 * @param options.checkExistence - Whether to check if issuers exist on network (requires network call)
 * @param options.horizonUrl - Horizon API URL (defaults to env var or testnet)
 * @returns Validation result with details for each asset
 */
export async function validateAssetIssuers(options?: {
  checkExistence?: boolean;
  horizonUrl?: string;
}): Promise<AssetValidationResult> {
  const network = getCurrentNetwork();
  const horizonUrl = options?.horizonUrl || 
    process.env.HORIZON_URL || 
    'https://horizon-testnet.stellar.org';
  
  const checkExistence = options?.checkExistence ?? true;
  
  const results: AssetValidationResult['assets'] = [];
  let allValid = true;

  // Validate each asset
  for (const assetCode of Object.keys(ASSET_ISSUER_CONFIG) as AssetCode[]) {
    const issuer = getAssetIssuer(assetCode);
    
    // Validate format
    const formatValidation = validateIssuerFormat(assetCode, issuer);
    
    if (!formatValidation.valid) {
      allValid = false;
      results.push({
        code: assetCode,
        issuer,
        valid: false,
        error: formatValidation.error,
      });
      continue;
    }

    // Check existence on network (skip for native asset)
    if (checkExistence && issuer !== null) {
      const existenceCheck = await checkIssuerExists(issuer, horizonUrl);
      
      if (!existenceCheck.exists) {
        allValid = false;
        results.push({
          code: assetCode,
          issuer,
          valid: false,
          error: existenceCheck.error,
        });
        continue;
      }
    }

    // Asset is valid
    results.push({
      code: assetCode,
      issuer,
      valid: true,
    });
  }

  return {
    valid: allValid,
    network,
    assets: results,
    summary: getAssetConfigSummary(),
  };
}

/**
 * Validate asset configuration at startup and log results.
 * Throws an error if validation fails in production, warns in development.
 * 
 * @param options - Validation options
 * @throws Error if validation fails and NODE_ENV is production
 */
export async function validateAssetConfigAtStartup(options?: {
  checkExistence?: boolean;
  horizonUrl?: string;
}): Promise<void> {
  console.log('='.repeat(60));
  console.log('Validating Asset Configuration...');
  console.log('='.repeat(60));

  const result = await validateAssetIssuers(options);

  console.log(result.summary);
  console.log('');

  // Log each asset validation result
  for (const asset of result.assets) {
    const status = asset.valid ? '✓' : '✗';
    const issuerDisplay = asset.issuer || 'native';
    
    if (asset.valid) {
      console.log(`${status} ${asset.code}: ${issuerDisplay}`);
    } else {
      console.error(`${status} ${asset.code}: ${issuerDisplay}`);
      console.error(`  Error: ${asset.error}`);
    }
  }

  console.log('');

  if (!result.valid) {
    const errorMessage = 'Asset configuration validation failed. Please check issuer addresses for the current network.';
    
    if (process.env.NODE_ENV === 'production') {
      console.error('='.repeat(60));
      console.error('FATAL: ' + errorMessage);
      console.error('='.repeat(60));
      throw new Error(errorMessage);
    } else {
      console.warn('='.repeat(60));
      console.warn('WARNING: ' + errorMessage);
      console.warn('Application will continue in development mode.');
      console.warn('='.repeat(60));
    }
  } else {
    console.log('✓ All asset issuers validated successfully');
    console.log('='.repeat(60));
  }
}

export const assetValidationService = {
  validateAssetIssuers,
  validateAssetConfigAtStartup,
};
