import { Pool } from 'pg';

// Single shared pool — do NOT import optimizedPool from database-pool.config.ts.
// That file has been removed; all pool config lives here.
export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'mentorminds',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 20,
  min: 4,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  statement_timeout: 10000,
});

pool.on('connect', () => {
  const totalCount = pool.totalCount;
  if (totalCount > 1) {
    // Warn if something has created a second pool instance
    console.warn(`[DB] Pool connection established. Total pool size: ${totalCount}`);
  }
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});
