import pg from 'pg';
import type { ServerConfig } from '../config.js';

const { Pool } = pg;

export type Db = pg.Pool;

export function createPool(config: ServerConfig): Db {
  return new Pool({
    connectionString: config.databaseUrl,
    ssl: config.dbSsl ? { rejectUnauthorized: true } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}
