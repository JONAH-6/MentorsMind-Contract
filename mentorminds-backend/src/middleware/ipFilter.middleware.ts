import { Request, Response, NextFunction } from 'express';
import { IpFilterService } from '../services/ipFilter.service';
import { auditLogService } from '../services/audit-log.service';

// Track the last time each IP was audit-logged (per-IP rate limit: once per minute).
const lastLoggedAt = new Map<string, number>();
const AUDIT_LOG_INTERVAL_MS = 60_000;

/**
 * Express middleware that blocks requests from IPs matching a 'block' rule
 * in the given context.
 *
 * The audit log write is fired asynchronously so it never delays the 403
 * response — critical under DDoS conditions where every millisecond counts
 * and a synchronous DB write per blocked request would overwhelm the database.
 *
 * To further reduce DB pressure, only the first blocked request per IP per
 * minute is logged.
 */
export function createBlocklistMiddleware(
  ipFilterService: IpFilterService,
  context: string,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      ?? req.socket.remoteAddress
      ?? '';

    const blocked = await ipFilterService.isBlocked(ip, context);

    if (!blocked) {
      return next();
    }

    // Fire audit log asynchronously — do NOT await.
    const now = Date.now();
    const lastLogged = lastLoggedAt.get(ip) ?? 0;
    if (now - lastLogged >= AUDIT_LOG_INTERVAL_MS) {
      lastLoggedAt.set(ip, now);
      Promise.resolve().then(() =>
        auditLogService.create({
          action: 'IP_BLOCKED',
          user_id: '',
          txHash: '',
          walletAddress: ip,
          sequenceNumber: '',
        })
      ).catch((err: unknown) => {
        console.error({ err }, 'AuditLog error');
      });
    }

    res.status(403).end();
  };
}
