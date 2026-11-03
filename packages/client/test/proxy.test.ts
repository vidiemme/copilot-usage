import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
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
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-request-id': `up-${upstreamBodies.length}`,
    });
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
      LOG_LEVEL: 'silent',
      // Un evento basta a far partire l'invio: niente attese sul timer.
      FLUSH_MAX_BATCH: '1',
    }),
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
});
