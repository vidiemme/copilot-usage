import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/config.js';
import { registerIngestRoutes } from '../src/ingest/routes.js';
import type { UsageEvent, UsageWriter } from '../src/storage/writer.js';

const TOKEN = 'a'.repeat(32);
const OTHER_TOKEN = 'b'.repeat(32);

let app: FastifyInstance;
let written: UsageEvent[];

function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req-1',
    occurredAt: '2026-02-01T10:00:00.000Z',
    developerId: 'dev-1',
    developerSource: 'pseudonym',
    projectId: 'acme/portal',
    projectSource: 'workspace',
    repository: null,
    clientName: 'GitHubCopilotChat/0.57.0',
    sessionId: null,
    endpoint: '/chat/completions',
    model: 'gpt-5.4',
    usage: {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    },
    streamed: true,
    durationMs: 100,
    ...overrides,
  };
}

function post(body: unknown, token: string | null = TOKEN) {
  return app.inject({
    method: 'POST',
    url: '/v1/usage',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body as object,
  });
}

beforeEach(async () => {
  written = [];
  app = Fastify({ logger: false });

  const writer = {
    enqueue: (event: UsageEvent) => written.push(event),
  } as unknown as UsageWriter;

  registerIngestRoutes(app, { ingestTokens: [TOKEN, OTHER_TOKEN] } as ServerConfig, writer);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('POST /v1/usage', () => {
  it('accetta un batch valido', async () => {
    const response = await post({ events: [validEvent(), validEvent({ requestId: 'req-2' })] });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: 2 });
    expect(written).toHaveLength(2);
  });

  it('accetta qualsiasi token configurato', async () => {
    expect((await post({ events: [validEvent()] }, OTHER_TOKEN)).statusCode).toBe(202);
  });

  it('rifiuta le richieste senza credenziali valide', async () => {
    for (const token of [null, '', 'sbagliato', `${TOKEN}x`, TOKEN.slice(0, -1)]) {
      const response = await post({ events: [validEvent()] }, token);

      expect(response.statusCode).toBe(401);
    }
    expect(written).toHaveLength(0);
  });

  it('rifiuta un payload non conforme senza scrivere nulla', async () => {
    for (const body of [
      {},
      { events: [] },
      { events: [validEvent({ requestId: '' })] },
      { events: [validEvent({ usage: { inputTokens: -5 } })] },
    ]) {
      const response = await post(body);

      expect(response.statusCode).toBe(400);
    }
    expect(written).toHaveLength(0);
  });

  // Il prezzo si calcola qui, non sul client: e' il punto del taglio.
  it('applica il listino agli eventi ricevuti', async () => {
    await post({ events: [validEvent()] });

    const event = written[0]!;
    expect(event.canonicalModel).toBe('gpt-5-4');
    expect(event.priced).toBe(true);
    expect(event.costUsd).toBeGreaterThan(0);
    expect(event.rateCardVersion).toBeTruthy();
  });

  it('registra i modelli sconosciuti a costo zero invece di scartarli', async () => {
    await post({ events: [validEvent({ model: 'modello-mai-visto' })] });

    const event = written[0]!;
    expect(event.rawModel).toBe('modello-mai-visto');
    expect(event.priced).toBe(false);
    expect(event.costUsd).toBe(0);
  });

  it('ignora un costo dichiarato dal client', async () => {
    await post({ events: [validEvent({ costUsd: 999, priced: true, aiCredits: 999 })] });

    expect(written[0]!.costUsd).toBeLessThan(999);
  });
});
