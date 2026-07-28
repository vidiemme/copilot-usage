import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { UsageEventPayload } from '@vidiemme/copilot-usage-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageForwarder } from '../src/collector/forwarder.js';
import type { ClientConfig } from '../src/config.js';

const TOKEN = 'z'.repeat(32);

let dir: string;
let server: Server;
let received: UsageEventPayload[];
let status: number;
let requests: number;

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeEvent(id: string): UsageEventPayload {
  return {
    requestId: id,
    occurredAt: '2026-02-01T10:00:00.000Z',
    developerId: 'dev-1',
    developerSource: 'pseudonym',
    projectId: 'acme/portal',
    projectSource: 'workspace',
    repository: null,
    clientName: 'test',
    sessionId: null,
    endpoint: '/chat/completions',
    model: 'gpt-5.4',
    usage: { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5 },
    streamed: false,
    durationMs: 10,
  };
}

function makeForwarder(overrides: Partial<ClientConfig> = {}): UsageForwarder {
  const port = (server.address() as AddressInfo).port;
  const config = {
    collectorUrl: `http://127.0.0.1:${port}/v1/usage`,
    collectorToken: TOKEN,
    collectorTimeoutMs: 2000,
    spoolPath: join(dir, 'spool.jsonl'),
    flushIntervalMs: 60_000,
    flushMaxBatch: 100,
    ...overrides,
  } as ClientConfig;

  return new UsageForwarder(config, silentLogger);
}

function spoolLines(): string[] {
  const path = join(dir, 'spool.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'forwarder-'));
  received = [];
  requests = 0;
  status = 202;

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests += 1;
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      if (status >= 300) {
        res.writeHead(status).end();
        return;
      }
      received.push(...JSON.parse(Buffer.concat(chunks).toString()).events);
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('UsageForwarder', () => {
  it('invia gli eventi accodati con il token di ingest', async () => {
    const forwarder = makeForwarder();
    forwarder.enqueue(makeEvent('a'));
    forwarder.enqueue(makeEvent('b'));
    await forwarder.flush();

    expect(received.map((event) => event.requestId)).toEqual(['a', 'b']);
    expect(spoolLines()).toHaveLength(0);
  });

  // Il proxy non deve mai perdere una misura solo perche' il collector e' giu':
  // gli eventi restano su disco e ripartono al tentativo successivo.
  it('parcheggia su disco quando il collector risponde 5xx e ritenta dopo', async () => {
    const forwarder = makeForwarder();
    status = 503;
    forwarder.enqueue(makeEvent('a'));
    await forwarder.flush();

    expect(received).toHaveLength(0);
    expect(spoolLines()).toHaveLength(1);

    status = 202;
    await forwarder.flush();

    expect(received.map((event) => event.requestId)).toEqual(['a']);
    expect(spoolLines()).toHaveLength(0);
  });

  it('parcheggia su disco quando il collector e irraggiungibile', async () => {
    const forwarder = makeForwarder({ collectorUrl: 'http://127.0.0.1:1/v1/usage' });
    forwarder.enqueue(makeEvent('a'));
    await forwarder.flush();

    expect(spoolLines()).toHaveLength(1);
  });

  // Un 4xx non si risolve ritentando: se restasse in coda bloccherebbe
  // per sempre tutte le misure successive.
  it('scarta cio che il collector rifiuta in modo definitivo', async () => {
    const forwarder = makeForwarder();
    status = 400;
    forwarder.enqueue(makeEvent('a'));
    await forwarder.flush();

    expect(spoolLines()).toHaveLength(0);
  });

  it('ritenta invece dopo un 429', async () => {
    const forwarder = makeForwarder();
    status = 429;
    forwarder.enqueue(makeEvent('a'));
    await forwarder.flush();

    expect(spoolLines()).toHaveLength(1);
  });

  it('recupera un invio interrotto da un arresto brusco', async () => {
    writeFileSync(join(dir, 'spool.jsonl.sending'), `${JSON.stringify(makeEvent('orfano'))}\n`);

    const forwarder = makeForwarder();
    forwarder.start();
    await forwarder.flush();

    expect(received.map((event) => event.requestId)).toEqual(['orfano']);
    expect(existsSync(join(dir, 'spool.jsonl.sending'))).toBe(false);
  });

  it('ignora le righe di spool troncate senza perdere le altre', async () => {
    writeFileSync(
      join(dir, 'spool.jsonl'),
      `${JSON.stringify(makeEvent('a'))}\n{"requestId":"tron\n${JSON.stringify(makeEvent('b'))}\n`,
    );

    const forwarder = makeForwarder();
    await forwarder.flush();

    expect(received.map((event) => event.requestId)).toEqual(['a', 'b']);
  });

  it('spezza gli invii secondo la dimensione del batch', async () => {
    const forwarder = makeForwarder({ flushMaxBatch: 2 });
    for (const id of ['a', 'b', 'c', 'd', 'e']) forwarder.enqueue(makeEvent(id));
    await forwarder.flush();

    expect(requests).toBe(3);
    expect(received).toHaveLength(5);
  });

  it('svuota la coda alla chiusura', async () => {
    const forwarder = makeForwarder();
    forwarder.start();
    forwarder.enqueue(makeEvent('a'));
    await forwarder.close();

    expect(received.map((event) => event.requestId)).toEqual(['a']);
  });

  it('parcheggia cio che resta se alla chiusura il collector e giu', async () => {
    const forwarder = makeForwarder();
    forwarder.start();
    status = 503;
    forwarder.enqueue(makeEvent('a'));
    await forwarder.close();

    expect(spoolLines()).toHaveLength(1);
  });
});
