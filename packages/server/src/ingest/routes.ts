import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { InvalidEventError, parseIngestBody } from '@vidiemme/copilot-usage-contract';
import type { ServerConfig } from '../config.js';
import { computeCost } from '../pricing/cost.js';
import type { UsageWriter } from '../storage/writer.js';

/**
 * Confronto a tempo costante fra credenziali di lunghezza qualsiasi.
 *
 * `timingSafeEqual` richiede buffer della stessa lunghezza e fallirebbe (o
 * rivelerebbe la lunghezza del segreto) su input arbitrari: si confrontano
 * quindi i digest, che sono sempre di 32 byte.
 */
function matchesToken(candidate: string, tokens: string[]): boolean {
  const provided = createHash('sha256').update(candidate).digest();
  let valid = false;
  for (const token of tokens) {
    if (timingSafeEqual(provided, createHash('sha256').update(token).digest())) valid = true;
  }
  return valid;
}

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

export function registerIngestRoutes(
  app: FastifyInstance,
  config: ServerConfig,
  writer: UsageWriter,
): void {
  app.post('/v1/usage', async (request, reply) => {
    const token = bearer(request);
    if (!token || !matchesToken(token, config.ingestTokens)) {
      await reply.code(401).send({ error: 'non_autorizzato' });
      return;
    }

    let body;
    try {
      body = parseIngestBody(request.body);
    } catch (error) {
      if (error instanceof InvalidEventError) {
        await reply.code(400).send({ error: 'payload_non_valido', detail: error.message });
        return;
      }
      throw error;
    }

    // Il costo si calcola qui e non sul client: il listino vive con il
    // servizio, cosi' aggiornarlo non richiede di ridistribuire le postazioni,
    // e un client manomesso non puo' dichiarare quanto ha speso.
    for (const event of body.events) {
      const cost = computeCost(event.model ?? undefined, event.usage);

      writer.enqueue({
        occurredAt: new Date(event.occurredAt),
        requestId: event.requestId,
        developerId: event.developerId,
        projectId: event.projectId,
        projectSource: event.projectSource,
        developerSource: event.developerSource,
        clientName: event.clientName,
        sessionId: event.sessionId,
        endpoint: event.endpoint,
        rawModel: event.model,
        canonicalModel: cost.canonicalModel,
        vendor: cost.vendor,
        tier: cost.tier,
        inputTokens: event.usage.inputTokens,
        cachedInputTokens: event.usage.cachedInputTokens,
        cacheWriteTokens: event.usage.cacheWriteTokens,
        outputTokens: event.usage.outputTokens,
        rateCardVersion: cost.rateCardVersion,
        costUsd: cost.costUsd,
        aiCredits: cost.aiCredits,
        priced: cost.priced,
        streamed: event.streamed,
        durationMs: event.durationMs,
        repository: event.repository ?? undefined,
      });
    }

    await reply.code(202).send({ accepted: body.events.length });
  });
}
