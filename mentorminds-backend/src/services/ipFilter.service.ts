import { Pool } from 'pg';
import * as ipaddr from 'ipaddr.js';

export type RuleType = 'allow' | 'block';

export interface IpRule {
  id: number;
  ip_range: string;
  rule_type: RuleType;
  context: string;
  created_at: Date;
}

export interface AddRuleData {
  ipRange: string;
  ruleType: RuleType;
  context: string;
}

interface CompiledRule {
  rule: IpRule;
  /** Pre-parsed CIDR range, or null if the range could not be parsed. */
  range: [ipaddr.IPv4 | ipaddr.IPv6, number] | null;
}

// Module-level compiled-rule cache keyed by context.
// Invalidated whenever rules are mutated (add / remove).
const compiledCache = new Map<string, CompiledRule[]>();

// Metric counter: total blocklist hits since process start.
let blocklistHits = 0;

/** Returns the total number of blocklist hits since process start. */
export function getBlocklistHits(): number {
  return blocklistHits;
}

function invalidateCache(context?: string): void {
  if (context) {
    compiledCache.delete(context);
  } else {
    compiledCache.clear();
  }
}

/**
 * Parse and compile a list of IpRules into CompiledRules.
 * Parsing is done once here so matchIp never calls parseCIDR per request.
 */
function compileRules(rules: IpRule[]): CompiledRule[] {
  return rules.map((rule) => {
    try {
      const range = ipaddr.parseCIDR(rule.ip_range) as [ipaddr.IPv4 | ipaddr.IPv6, number];
      return { rule, range };
    } catch {
      return { rule, range: null };
    }
  });
}

export class IpFilterService {
  constructor(private readonly pool: Pool) {}

  /**
   * Adds a new IP filter rule.
   * Throws if an identical rule (ip_range + rule_type + context) already exists
   * to prevent duplicate rules from accumulating in the blocklist.
   */
  async addRule(data: AddRuleData): Promise<IpRule> {
    const existing = await this.pool.query<{ id: number }>(
      `SELECT id FROM ip_rules
       WHERE ip_range = $1 AND rule_type = $2 AND context = $3`,
      [data.ipRange, data.ruleType, data.context],
    );

    if (existing.rows.length > 0) {
      throw new Error(`Rule for ${data.ipRange} already exists`);
    }

    const { rows } = await this.pool.query<IpRule>(
      `INSERT INTO ip_rules (ip_range, rule_type, context, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING *`,
      [data.ipRange, data.ruleType, data.context],
    );

    invalidateCache(data.context);
    return rows[0];
  }

  async removeRule(id: number): Promise<void> {
    await this.pool.query('DELETE FROM ip_rules WHERE id = $1', [id]);
    // We don't know the context from id alone — clear the whole cache.
    invalidateCache();
  }

  async listRules(context?: string): Promise<IpRule[]> {
    if (context) {
      const { rows } = await this.pool.query<IpRule>(
        'SELECT * FROM ip_rules WHERE context = $1 ORDER BY created_at DESC',
        [context],
      );
      return rows;
    }
    const { rows } = await this.pool.query<IpRule>(
      'SELECT * FROM ip_rules ORDER BY created_at DESC',
    );
    return rows;
  }

  /**
   * Returns true if the given IP matches any block rule in the given context.
   *
   * CIDR ranges are pre-compiled into ipaddr range objects when rules are
   * first loaded from the DB and cached at module level.  Subsequent calls
   * for the same context perform only in-memory comparisons — no DB query
   * and no per-request parseCIDR() call.
   */
  async isBlocked(ip: string, context: string): Promise<boolean> {
    let compiled = compiledCache.get(context);

    if (!compiled) {
      const { rows } = await this.pool.query<IpRule>(
        `SELECT * FROM ip_rules WHERE rule_type = 'block' AND context = $1`,
        [context],
      );
      compiled = compileRules(rows);
      compiledCache.set(context, compiled);
    }

    let parsedIp: ipaddr.IPv4 | ipaddr.IPv6;
    try {
      parsedIp = ipaddr.parse(ip);
    } catch {
      return false;
    }

    for (const { range } of compiled) {
      if (!range) continue;
      try {
        if (parsedIp.match(range)) {
          blocklistHits++;
          return true;
        }
      } catch {
        // address-family mismatch (IPv4 vs IPv6) — skip
      }
    }

    return false;
  }
}
