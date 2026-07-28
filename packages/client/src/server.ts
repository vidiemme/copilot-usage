import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { UsageForwarder } from './collector/forwarder.js';
import type { ClientConfig } from './config.js';
import { createProxyHandler } from './proxy/handler.js';
import { ProjectDetector } from './projectDetector.js';

export interface App {
  server: FastifyInstance;
  close: () => Promise<void>;
}

function createServer(config: ClientConfig): FastifyInstance {
  const options = {
    logger: { level: config.logLevel },
    // Le sessioni agentiche possono restare aperte a lungo.
    requestTimeout: 0,
    keepAliveTimeout: 120_000,
    bodyLimit: 64 * 1024 * 1024,
    // Il log per-richiesta duplicherebbe il record di usage senza aggiungere
    // nulla. Deprecato in Fastify 5, da migrare a `logController` in v6.
    disableRequestLogging: true,
  } satisfies FastifyServerOptions;

  if (!config.tlsKeyPath || !config.tlsCertPath) return Fastify(options);

  // In TLS l'istanza Fastify e' tipizzata su https.Server: l'interfaccia
  // pubblica usata qui e' identica, quindi si normalizza il tipo.
  return Fastify({
    ...options,
    https: {
      key: readFileSync(config.tlsKeyPath),
      cert: readFileSync(config.tlsCertPath),
    },
  }) as unknown as FastifyInstance;
}

export async function buildApp(config: ClientConfig): Promise<App> {
  const server = createServer(config);

  // Il proxy deve inoltrare il corpo byte per byte, senza reinterpretarlo.
  server.removeAllContentTypeParsers();
  server.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  const forwarder = new UsageForwarder(config, server.log);
  forwarder.start();

  const detector = new ProjectDetector({
    roots: config.workspaceRoots,
    markers: config.projectMarkers,
    stickyTtlMs: config.projectStickyTtlMs,
    maxScanBytes: 4 * 1024 * 1024,
  });
  if (!detector.enabled) {
    server.log.warn(
      'WORKSPACE_ROOTS non impostato: il progetto va dichiarato esplicitamente, altrimenti il traffico finisce in `unassigned`',
    );
  }

  server.get('/_health', async () => ({
    ok: true,
    upstream: config.upstreamBaseUrl,
    collector: config.collectorUrl,
    projectDetection: detector.enabled,
  }));

  server.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    url: '/*',
    handler: createProxyHandler(config, forwarder, detector),
  });

  return {
    server,
    close: async () => {
      await server.close();
      await forwarder.close();
    },
  };
}
