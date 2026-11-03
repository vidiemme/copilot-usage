import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { UsageForwarder } from './collector/forwarder.js';
import type { ClientConfig } from './config.js';
import { createProxyHandler } from './proxy/handler.js';
import { ProjectDetector } from './projectDetector.js';
import { defaultSessionStateDir } from './reload/copilotCli.js';
import type { UpdateStatus } from './selfUpdate.js';
import { FusionCorrelator } from './usage/fusionCorrelator.js';
import { CLIENT_VERSION } from './version.js';

export interface App {
  server: FastifyInstance;
  /** Da quando non arrivano richieste; `undefined` se ce n'e' una in corso. */
  idleSince: () => number | undefined;
  close: () => Promise<void>;
}

export interface AppOptions {
  updateStatus?: () => UpdateStatus;
  fusionSessionStateDir?: string;
  fusionPollIntervalMs?: number;
}

function createServer(config: ClientConfig): FastifyInstance {
  const options = {
    logger: { level: config.logLevel },
    // Le sessioni agentiche possono restare aperte a lungo.
    requestTimeout: 0,
    keepAliveTimeout: 120_000,
    bodyLimit: 64 * 1024 * 1024,
    // Il log per-richiesta duplicherebbe il record di usage senza aggiungere
    // nulla.
    logController: new LogController({ disableRequestLogging: true }),
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

export async function buildApp(config: ClientConfig, options: AppOptions = {}): Promise<App> {
  const server = createServer(config);

  // Una risposta in streaming e' in corso finche' la connessione non la chiude.
  let inFlight = 0;
  let lastActivityAt = Date.now();
  server.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url === '/_health') return;
    inFlight += 1;
    lastActivityAt = Date.now();
    reply.raw.once('close', () => {
      inFlight -= 1;
      lastActivityAt = Date.now();
    });
  });

  // Il proxy deve inoltrare il corpo byte per byte, senza reinterpretarlo.
  server.removeAllContentTypeParsers();
  server.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  const forwarder = new UsageForwarder(config, server.log);
  forwarder.start();
  const fusion = new FusionCorrelator(
    options.fusionSessionStateDir ?? defaultSessionStateDir(config.copilotHome),
    (event) => forwarder.enqueueFusionUpdate(event),
    server.log,
    options.fusionPollIntervalMs,
  );

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

  const startedAt = new Date().toISOString();
  server.get('/_health', async () => ({
    ok: true,
    version: CLIENT_VERSION,
    startedAt,
    upstream: config.upstreamBaseUrl,
    collector: config.collectorUrl,
    projectDetection: detector.enabled,
    usage: forwarder.stats(),
    spoolBytes: await stat(config.spoolPath).then(
      (info) => info.size,
      () => 0,
    ),
    update: options.updateStatus?.(),
  }));

  server.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    url: '/*',
    handler: createProxyHandler(config, forwarder, detector, fusion),
  });

  return {
    server,
    idleSince: () => (inFlight > 0 ? undefined : lastActivityAt),
    close: async () => {
      await server.close();
      await fusion.close();
      await forwarder.close();
    },
  };
}
