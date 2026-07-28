import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { MAX_EVENTS_PER_BATCH } from '@vidiemme/copilot-usage-contract';
import type { ServerConfig } from './config.js';
import { registerIngestRoutes } from './ingest/routes.js';
import { registerReportingRoutes } from './reporting/routes.js';
import { createPool } from './storage/db.js';
import { UsageWriter } from './storage/writer.js';

export interface App {
  server: FastifyInstance;
  close: () => Promise<void>;
}

/**
 * Un evento pesa meno di un kilobyte: questo tetto lascia margine abbondante
 * al batch massimo e chiude la porta ai payload pensati per saturare memoria.
 */
const BODY_LIMIT = MAX_EVENTS_PER_BATCH * 4 * 1024;

function createServer(config: ServerConfig): FastifyInstance {
  const options = {
    logger: { level: config.logLevel },
    bodyLimit: BODY_LIMIT,
    trustProxy: true,
  } satisfies FastifyServerOptions;

  if (!config.tlsKeyPath || !config.tlsCertPath) return Fastify(options);

  return Fastify({
    ...options,
    https: {
      key: readFileSync(config.tlsKeyPath),
      cert: readFileSync(config.tlsCertPath),
    },
  }) as unknown as FastifyInstance;
}

export async function buildApp(config: ServerConfig): Promise<App> {
  const server = createServer(config);

  const db = createPool(config);
  const writer = new UsageWriter(db, config, server.log);
  writer.start();

  registerIngestRoutes(server, config, writer);
  registerReportingRoutes(server, db);

  return {
    server,
    close: async () => {
      await server.close();
      await writer.close();
      await db.end();
    },
  };
}
