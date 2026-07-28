import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Agent, request as undiciRequest } from 'undici';
import type { RepositoryIdentity } from '@vidiemme/copilot-usage-contract';
import { resolveAttribution } from '../attribution.js';
import type { ClientConfig } from '../config.js';
import type { UsageForwarder } from '../collector/forwarder.js';
import { ProjectDetector } from '../projectDetector.js';
import { isStreamingResponse, UsageCollector } from '../usage/collector.js';
import { buildDownstreamHeaders, buildUpstreamHeaders } from './headers.js';
import { inspectRequest } from './inspectRequest.js';

/**
 * Le risposte agentiche possono restare aperte per molti minuti: i timeout di
 * default di undici (300s) interromperebbero gli stream lunghi.
 */
const dispatcher = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connect: { timeout: 30_000 },
});

/**
 * Header con cui i client identificano la finestra o la conversazione. Servono
 * a tenere separate sessioni parallele dello stesso developer: senza, due
 * progetti aperti insieme condividerebbero l'ereditarieta' del progetto.
 */
const SESSION_HEADERS = ['vscode-sessionid', 'x-vscode-session-id', 'x-session-id'];

function sessionKey(
  headers: FastifyRequest['headers'],
  bodySessionId: string | undefined,
  developerId: string,
): string {
  for (const name of SESSION_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string' && value.length > 0) return `s:${value}`;
  }
  return bodySessionId ? `s:${bodySessionId}` : `d:${developerId}`;
}

export function createProxyHandler(
  config: ClientConfig,
  forwarder: UsageForwarder,
  detector?: ProjectDetector,
) {
  const upstream = new URL(config.upstreamBaseUrl);

  return async function proxyHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const startedAt = Date.now();
    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);

    const attribution = resolveAttribution(
      { path: request.url, headers: request.headers },
      config,
    );

    const [pathname, search = ''] = attribution.upstreamPath.split('?', 2) as [string, string?];
    const facts = inspectRequest(pathname, rawBody);

    // Se nessun segnale esplicito ha nominato il progetto, lo si deduce dai
    // path citati nella richiesta: e' cio' che rende superflua la
    // configurazione per singolo repository.
    let { projectId, projectSource } = attribution;
    let repository: RepositoryIdentity | undefined;
    if (projectSource === 'fallback' && detector?.enabled) {
      const detected = detector.detect(
        rawBody,
        sessionKey(request.headers, facts.sessionId, attribution.developerId),
      );
      if (detected) {
        repository = detected.repository;
        projectId = detected.repository.projectId;
        projectSource = detected.source;
      }
    }

    const targetUrl = `${upstream.origin}${upstream.pathname.replace(/\/$/, '')}${pathname}${
      search ? `?${search}` : ''
    }`;

    const headers = buildUpstreamHeaders(request.headers, {
      projectHeader: config.projectHeader,
      overrideAuthToken: config.upstreamAuthToken,
      upstreamHost: upstream.host,
    });
    if (facts.body.length > 0) headers.set('content-length', String(facts.body.length));

    const controller = new AbortController();
    // L'upstream va interrotto solo se e' il client a sganciarsi prima della
    // fine: `request.raw` chiude gia' a corpo letto, quindi non e' un segnale
    // valido di disconnessione.
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort();
    });

    let upstreamResponse: Awaited<ReturnType<typeof undiciRequest>>;
    try {
      upstreamResponse = await undiciRequest(targetUrl, {
        method: request.method as 'POST',
        headers: Object.fromEntries(headers.entries()),
        body: facts.body.length > 0 ? facts.body : undefined,
        dispatcher,
        signal: controller.signal,
      });
    } catch (error) {
      request.log.error({ err: error, targetUrl }, 'richiesta upstream fallita');
      await reply.code(502).send({ error: 'upstream_unreachable' });
      return;
    }

    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item);
    }

    const contentType = responseHeaders.get('content-type') ?? undefined;
    const streaming = isStreamingResponse(contentType);
    const collector = new UsageCollector(streaming);

    const requestId =
      responseHeaders.get('x-request-id') ??
      (request.headers['x-request-id'] as string | undefined) ??
      randomUUID();

    let recorded = false;
    const record = (): void => {
      if (recorded) return;
      recorded = true;

      const parsed = collector.finish();
      // Nessun contatore: probabilmente non e' una richiesta di inferenza
      // (es. /models, health check). Non va registrata.
      if (!parsed) return;

      forwarder.enqueue({
        requestId,
        occurredAt: new Date(startedAt).toISOString(),
        developerId: attribution.developerId,
        developerSource: attribution.developerSource,
        projectId,
        projectSource,
        repository: repository ?? null,
        clientName: attribution.clientName,
        sessionId: facts.sessionId ?? null,
        endpoint: pathname,
        model: parsed.model ?? facts.model ?? null,
        usage: {
          inputTokens: parsed.inputTokens,
          cachedInputTokens: parsed.cachedInputTokens,
          cacheWriteTokens: parsed.cacheWriteTokens,
          outputTokens: parsed.outputTokens,
        },
        streamed: streaming,
        durationMs: Date.now() - startedAt,
      });
    };

    reply.code(upstreamResponse.statusCode);
    reply.headers(buildDownstreamHeaders(responseHeaders));

    const source = Readable.from(upstreamResponse.body, { objectMode: false });
    const passthrough = new PassThrough();

    source.on('data', (chunk: Buffer) => {
      try {
        collector.push(chunk);
      } catch (error) {
        request.log.warn({ err: error }, 'parsing usage fallito');
      }
    });
    // Anche in caso di interruzione i token di input sono stati consumati:
    // si registra comunque quanto raccolto.
    source.on('end', record);
    source.on('error', record);
    source.on('close', record);

    source.pipe(passthrough);

    await reply.send(passthrough);
  };
}
