import { createServer, type IncomingMessage, type Server } from 'node:http';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UsageEventPayload } from '@vidiemme/copilot-usage-contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp, type App } from '../src/server.js';

let dir: string;
let upstream: Server;
let collector: Server;
let app: App;
let proxyUrl: string;
let upstreamBodies: Record<string, unknown>[];
let upstreamExtraHeaders: Record<string, string> = {};
let delivered: UsageEventPayload[];
let finishStream: (() => void) | undefined;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

const STREAMS: Record<string, string> = {
  '/chat/completions': `${sse([
    { model: 'gpt-5.4', choices: [{ delta: { content: 'ciao' } }] },
    {
      model: 'gpt-5.4',
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } },
    },
  ])}data: [DONE]\n\n`,
  '/responses': sse([
    { type: 'response.created', response: { model: 'gpt-6-sol', usage: null } },
    { type: 'response.output_text.delta', delta: 'ciao' },
    {
      type: 'response.completed',
      response: { model: 'gpt-6-sol', usage: { input_tokens: 50, output_tokens: 5 } },
    },
  ]),
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'proxy-e2e-'));

  upstream = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    upstreamBodies.push(body);
    const headers: Record<string, string> = {
      'content-type': 'text/event-stream',
    };
    if (body.omitUpstreamRequestId !== true) headers['x-request-id'] = `up-${upstreamBodies.length}`;
    Object.assign(headers, upstreamExtraHeaders);
    res.writeHead(200, headers);
    if (body.holdStream === true) {
      res.write(': keep-alive\n\n');
      finishStream = () => res.end(STREAMS[req.url ?? ''] ?? '');
      return;
    }
    res.end(STREAMS[req.url ?? ''] ?? '');
  });
  collector = createServer(async (req, res) => {
    delivered.push(...(JSON.parse(await readBody(req)) as { events: UsageEventPayload[] }).events);
    res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":1}');
  });

  const upstreamPort = await listen(upstream);
  const collectorPort = await listen(collector);

  app = await buildApp(
    loadConfig({
      COLLECTOR_TOKEN: 'z'.repeat(32),
      COLLECTOR_URL: `http://127.0.0.1:${collectorPort}/v1/usage`,
      UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      SPOOL_PATH: join(dir, 'spool.jsonl'),
      WORKSPACE_ROOTS: dir,
      COPILOT_HOME: join(dir, 'custom-home'),
      LOG_LEVEL: 'silent',
      // Un evento basta a far partire l'invio: niente attese sul timer.
      FLUSH_MAX_BATCH: '1',
    }),
    { fusionPollIntervalMs: 20 },
  );
  await app.server.listen({ port: 0, host: '127.0.0.1' });
  proxyUrl = `http://127.0.0.1:${(app.server.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await new Promise((resolve) => upstream.close(resolve));
  await new Promise((resolve) => collector.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  upstreamBodies = [];
  upstreamExtraHeaders = {};
  delivered = [];
  finishStream = undefined;
});

async function post(path: string, body: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${proxyUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer tid=abc;u=mario;exp=1' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  const text = await response.text();

  for (let attempt = 0; attempt < 100 && delivered.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return text;
}

async function postCli(
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
  path = '/chat/completions',
): Promise<string> {
  const response = await fetch(`${proxyUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'copilot/1.0', ...extraHeaders },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  for (let attempt = 0; attempt < 100 && delivered.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return text;
}

function createFusionSession(sessionId: string): string {
  const session = join(dir, 'custom-home', 'session-state', sessionId);
  mkdirSync(session, { recursive: true });
  const file = join(session, 'events.jsonl');
  writeFileSync(file, `${JSON.stringify({ type: 'session.start', data: { selectedModel: 'hydrafusion' } })}\n`);
  return file;
}

async function recordFusionUsage(file: string, serviceRequestId: string, model: string): Promise<void> {
  appendFileSync(file, `${JSON.stringify({
    type: 'session.usage_record',
    timestamp: new Date().toISOString(),
    data: { usage: { serviceRequestId, model, fusion: { syntheticModel: 'hydrafusion' } } },
  })}\n`);
  for (let attempt = 0; attempt < 150 && delivered.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('proxy end-to-end', () => {
  it("non considera i controlli di health come attivita' che impedisce l'aggiornamento", async () => {
    const idleSince = app.idleSince();
    expect(idleSince).toBeTypeOf('number');
    const now = vi.spyOn(Date, 'now').mockReturnValue((idleSince ?? 0) + 60_000);
    try {
      const response = await fetch(`${proxyUrl}/_health?probe=1`);
      expect(response.status).toBe(200);
      await response.json();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(app.idleSince()).toBe(idleSince);
    } finally {
      now.mockRestore();
    }
  });

  it('inoltra lo stream intatto, inietta include_usage e misura chat completions', async () => {
    const text = await post('/p/acme/chat/completions', { model: 'gpt-5.4', stream: true });

    expect(text).toBe(STREAMS['/chat/completions']);
    expect(upstreamBodies[0]).toMatchObject({ stream_options: { include_usage: true } });
    expect(delivered).toEqual([
      expect.objectContaining({
        requestId: 'up-1',
        projectId: 'acme',
        projectSource: 'path',
        developerSource: 'pseudonym',
        endpoint: '/chat/completions',
        model: 'gpt-5.4',
        usage: { inputTokens: 60, cachedInputTokens: 40, cacheWriteTokens: 0, outputTokens: 7 },
      }),
    ]);
  });

  it('non tocca il corpo della Responses API e ne misura lo stream', async () => {
    await post('/responses', { model: 'gpt-6-sol', stream: true });

    expect(upstreamBodies[0]).not.toHaveProperty('stream_options');
    expect(delivered).toEqual([
      expect.objectContaining({
        model: 'gpt-6-sol',
        usage: { inputTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5 },
      }),
    ]);
  });

  it('espone versione e contatori su /_health', async () => {
    const health = (await (await fetch(`${proxyUrl}/_health`)).json()) as Record<string, unknown>;

    expect(health).toMatchObject({
      ok: true,
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      usage: expect.objectContaining({ recorded: 2, delivered: 2, lastError: null }),
      spoolBytes: 0,
    });
  });

  it("resta occupato durante uno stream anche se arrivano controlli di health", async () => {
    const response = await fetch(`${proxyUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4', stream: true, holdStream: true }),
    });
    try {
      expect(app.idleSince()).toBeUndefined();
      const health = await fetch(`${proxyUrl}/_health`);
      expect(health.status).toBe(200);
      await health.json();
      expect(app.idleSince()).toBeUndefined();
    } finally {
      finishStream?.();
    }
    await response.text();
    for (let attempt = 0; attempt < 100 && delivered.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(delivered).toHaveLength(1);
    expect(app.idleSince()).toBeTypeOf('number');
  });

  it('aggiorna l\'evento quando la CLI scrive il routing dopo la risposta', async () => {
    const before = (await (await fetch(`${proxyUrl}/_health`)).json()) as {
      usage: { recorded: number; delivered: number };
    };
    const file = createFusionSession('cli-1');

    const text = await postCli({ model: 'gpt-5.4', stream: true });
    expect(text).toBe(STREAMS['/chat/completions']);
    expect(delivered[0]!.hydraFusion).toBeNull();

    await recordFusionUsage(file, 'up-1', 'gpt-5.4');

    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toMatchObject({ requestId: 'up-1', model: 'gpt-5.4', hydraFusion: true });
    expect(delivered[1]!.usage).toEqual(delivered[0]!.usage);
    const after = (await (await fetch(`${proxyUrl}/_health`)).json()) as {
      usage: { recorded: number; delivered: number };
    };
    expect(after.usage.recorded).toBe(before.usage.recorded + 1);
    expect(after.usage.delivered).toBe(before.usage.delivered + 1);
  });

  it('correla la CLI usando il service request id quando differisce da x-request-id', async () => {
    const before = (await (await fetch(`${proxyUrl}/_health`)).json()) as {
      usage: { recorded: number; delivered: number };
    };
    const file = createFusionSession('cli-service-id');
    upstreamExtraHeaders['x-copilot-service-request-id'] = 'service-1';

    await postCli({ model: 'gpt-6-sol', stream: true }, {}, '/responses');
    await recordFusionUsage(file, 'service-1', 'gpt-6-sol');

    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toMatchObject({ requestId: 'service-1', hydraFusion: null });
    expect(delivered[1]).toMatchObject({ requestId: 'service-1', hydraFusion: true });
    expect(delivered[1]!.usage).toEqual(delivered[0]!.usage);
    const after = (await (await fetch(`${proxyUrl}/_health`)).json()) as {
      usage: { recorded: number; delivered: number };
    };
    expect(after.usage.recorded).toBe(before.usage.recorded + 1);
    expect(after.usage.delivered).toBe(before.usage.delivered + 1);
  });

  it('usa il service request id della CLI anche senza x-request-id', async () => {
    const file = createFusionSession('cli-service-only');
    upstreamExtraHeaders['x-copilot-service-request-id'] = 'service-only';

    await postCli({ model: 'gpt-6-sol', stream: true, omitUpstreamRequestId: true }, {}, '/responses');
    await recordFusionUsage(file, 'service-only', 'gpt-6-sol');

    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toMatchObject({ requestId: 'service-only', hydraFusion: null });
    expect(delivered[1]).toMatchObject({ requestId: 'service-only', hydraFusion: true });
  });

  it('ripiega su x-request-id se il service request id della CLI e vuoto', async () => {
    upstreamExtraHeaders['x-copilot-service-request-id'] = '';
    upstreamExtraHeaders['x-request-id'] = 'legacy-empty';
    await postCli({ model: 'gpt-6-sol', stream: true }, {}, '/responses');
    expect(delivered).toEqual([expect.objectContaining({ requestId: 'legacy-empty', hydraFusion: null })]);
  });

  it('mantiene x-request-id per i client diversi dalla CLI', async () => {
    upstreamExtraHeaders['x-copilot-service-request-id'] = 'service-other-client';
    await post('/responses', { model: 'gpt-6-sol', stream: true });
    expect(delivered).toEqual([expect.objectContaining({ requestId: 'up-1' })]);
  });

  it('riconosce il modello sintetico richiesto anche se la risposta nomina un modello fisico', async () => {
    await post('/chat/completions', { model: 'hydrafusion', stream: true });
    expect(delivered).toEqual([expect.objectContaining({ model: 'gpt-5.4', hydraFusion: true })]);
  });

  it('non correla un id fornito dal client quando manca quello del servizio', async () => {
    const session = join(dir, 'custom-home', 'session-state', 'cli-1');
    mkdirSync(session, { recursive: true });
    writeFileSync(join(session, 'events.jsonl'), [
      JSON.stringify({ type: 'session.start', data: { selectedModel: 'hydrafusion' } }),
      JSON.stringify({
        type: 'session.usage_record',
        timestamp: new Date().toISOString(),
        data: { usage: { serviceRequestId: 'client-id', model: 'gpt-5.4', fusion: { syntheticModel: 'hydrafusion' } } },
      }),
      '',
    ].join('\n'));

    await postCli(
      { model: 'gpt-5.4', stream: true, omitUpstreamRequestId: true },
      { 'x-request-id': 'client-id' },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(delivered).toEqual([expect.objectContaining({ requestId: 'client-id', hydraFusion: null })]);
  });
});
