import { Request, Response, NextFunction } from 'express';

/**
 * Strips HTML tags and trims a string to prevent XSS.
 */
function sanitizeString(val: string): string {
  return val.replace(/<[^>]*>/g, '').trim();
}

/**
 * Recursively sanitizes all string values in an object.
 */
function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string') {
      result[key] = sanitizeString(val);
    } else if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      result[key] = sanitizeObject(val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Sanitizes req.body in-place and attaches req.sanitizedQuery with
 * sanitized copies of all string query parameters.
 *
 * Controllers should read query params from req.sanitizedQuery instead
 * of req.query to ensure XSS payloads are stripped before use.
 */
export const sanitizeInput = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body as Record<string, unknown>);
  }

  // req.query is a read-only getter in Express 5; build a sanitized copy instead.
  const sanitizedQuery: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(req.query)) {
    sanitizedQuery[key] = typeof val === 'string' ? sanitizeString(val) : val;
  }
  (req as any).sanitizedQuery = sanitizedQuery;

  next();
};
