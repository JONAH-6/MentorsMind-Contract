# Quote Service Documentation

## Overview

The Quote Service manages exchange rate quotes with built-in security features to prevent replay attacks. Quotes are time-limited (120 seconds) and single-use only.

## Security Features

### 1. Time-Based Expiry
- Quotes expire after 120 seconds (2 minutes)
- Stored in Redis with automatic TTL-based eviction
- Expiry checked on both retrieval and validation

### 2. Single-Use Enforcement
- **Critical Security Feature**: Quotes are deleted immediately after validation
- Prevents replay attacks where the same quote is used for multiple payments
- Once validated, a quote cannot be reused

### 3. Replay Attack Prevention
The service implements the following safeguards:
- Quote is deleted from Redis immediately after `validateQuote()` is called
- Subsequent attempts to validate the same quote will fail with "Quote expired or not found"
- No grace period or retry mechanism that could allow reuse

## API Endpoints

### Create Quote
```http
POST /api/v1/quotes
Content-Type: application/json

{
  "fromAsset": "XLM",
  "toAsset": "USDC",
  "amount": "100"
}
```

**Response:**
```json
{
  "id": "quote_1234567890_abc123",
  "fromAsset": "XLM",
  "toAsset": "USDC",
  "rate": 0.0875,
  "amount": "100",
  "estimatedOutput": "8.7500000",
  "expiresAt": "2024-01-01T12:02:00.000Z",
  "createdAt": "2024-01-01T12:00:00.000Z"
}
```

### Get Quote (Read-Only)
```http
GET /api/v1/quotes/:quoteId
```

**Response:**
```json
{
  "id": "quote_1234567890_abc123",
  "fromAsset": "XLM",
  "toAsset": "USDC",
  "rate": 0.0875,
  "amount": "100",
  "estimatedOutput": "8.7500000",
  "expiresAt": "2024-01-01T12:02:00.000Z",
  "createdAt": "2024-01-01T12:00:00.000Z"
}
```

**Note:** This endpoint does NOT consume the quote. Use for display purposes only.

### Validate Quote (Single-Use)
```http
POST /api/v1/quotes/:quoteId/validate
```

**Response:**
```json
{
  "valid": true,
  "quote": {
    "id": "quote_1234567890_abc123",
    "fromAsset": "XLM",
    "toAsset": "USDC",
    "rate": 0.0875,
    "amount": "100",
    "estimatedOutput": "8.7500000",
    "expiresAt": "2024-01-01T12:02:00.000Z",
    "createdAt": "2024-01-01T12:00:00.000Z"
  }
}
```

**Important:** After successful validation, the quote is permanently deleted and cannot be reused.

## Usage Flow

### Typical Payment Flow with Quotes

1. **User requests a quote**
   ```typescript
   const quote = await quoteService.createQuote({
     fromAsset: 'XLM',
     toAsset: 'USDC',
     amount: '100'
   });
   // Display quote to user: "100 XLM = 8.75 USDC"
   ```

2. **User confirms payment**
   ```typescript
   // Validate and consume the quote
   const validatedQuote = await quoteService.validateQuote(quote.id);
   
   // Proceed with payment using the validated rate
   await initiatePayment({
     quoteId: validatedQuote.id,
     fromAsset: validatedQuote.fromAsset,
     toAsset: validatedQuote.toAsset,
     amount: validatedQuote.amount,
     rate: validatedQuote.rate
   });
   ```

3. **Quote is now consumed**
   ```typescript
   // This will fail with "Quote expired or not found"
   await quoteService.validateQuote(quote.id);
   ```

## Error Handling

### Quote Not Found
```json
{
  "error": "Quote expired or not found"
}
```
**Causes:**
- Quote has expired (>120 seconds old)
- Quote has already been validated and consumed
- Quote ID is invalid
- Redis evicted the key due to memory pressure

### Invalid Amount
```json
{
  "error": "Invalid amount"
}
```
**Causes:**
- Amount is not a valid number
- Amount is negative or zero

### Exchange Rate Unavailable
```json
{
  "error": "No trading path available for XLM/USDC"
}
```
**Causes:**
- No liquidity on the Stellar DEX for the requested pair
- Horizon API is unavailable
- Network connectivity issues

## Testing

### Run Unit Tests
```bash
npm test quote.service.test.ts
```

### Run Integration Tests
```bash
npm test quote.routes.test.ts
```

### Key Test Cases
- ✅ Quote creation with valid parameters
- ✅ Quote validation and consumption
- ✅ Expired quote rejection
- ✅ **Replay attack prevention** (quote cannot be used twice)
- ✅ Invalid amount handling
- ✅ Exchange rate fetch errors

## Security Considerations

### Why Single-Use Quotes Matter

Without single-use enforcement, an attacker could:
1. Request a quote when exchange rates are favorable
2. Wait for rates to become even more favorable
3. Use the same quote multiple times to execute multiple payments at the old rate
4. Profit from the rate difference at the expense of the platform

### Implementation Details

The `validateQuote` function implements single-use enforcement:

```typescript
export async function validateQuote(quoteId: string): Promise<Quote> {
  const client = getRedisClient();
  const key = quoteKey(quoteId);

  // Fetch quote from Redis
  const quoteData = await client.get(key);
  
  if (!quoteData) {
    throw new Error('Quote expired or not found');
  }

  const quote = JSON.parse(quoteData);

  // Check expiry
  if (new Date() > new Date(quote.expiresAt)) {
    await client.del(key);
    throw new Error('Quote expired or not found');
  }

  // CRITICAL: Delete immediately after validation
  await client.del(key);

  return quote;
}
```

### Clock Skew Considerations

Even if Redis TTL is extended by clock skew:
- The quote is still deleted after first validation
- The expiry check in `validateQuote` provides defense-in-depth
- No quote can be used more than once

## Configuration

### Environment Variables

```bash
# Redis connection (required)
REDIS_URL=redis://localhost:6379

# Quote TTL (optional, defaults to 120 seconds)
QUOTE_TTL_SECONDS=120
```

### Redis Key Format

Quotes are stored with the following key pattern:
```
mm:quote:{quoteId}
```

Example:
```
mm:quote:quote_1234567890_abc123
```

## Monitoring

### Metrics to Track

1. **Quote Creation Rate**: Number of quotes created per minute
2. **Quote Validation Rate**: Number of quotes validated per minute
3. **Quote Expiry Rate**: Percentage of quotes that expire without validation
4. **Validation Failures**: Number of failed validation attempts (potential replay attacks)

### Logging

The service logs the following events:
- Quote creation with asset pair and amount
- Quote validation success
- Quote validation failure (with reason)
- Redis connection errors

## Future Enhancements

1. **Rate Limiting**: Limit quote creation per user/IP to prevent abuse
2. **Quote History**: Store validated quotes in a separate table for audit purposes
3. **Dynamic TTL**: Adjust TTL based on market volatility
4. **Slippage Protection**: Add maximum acceptable slippage parameter
5. **Multi-Step Quotes**: Support for complex path payments with multiple hops
