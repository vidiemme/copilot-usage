import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { UsageEventPayload } from '@vidiemme/copilot-usage-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageForwarder } from '../src/collector/forwarder.js';
import type { ClientConfig } from '../src/config.js';

const TOKEN = 'z'.repeat(32);

let dir: string;
let server: Server;
let received: UsageEventPayload[];
let status: number;
let requests: number;
let userAgent: string | undefined;
let developerName: string | undefined;
let deviceName: string | undefined;

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
  deviceName = undefined;

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests += 1;
      userAgent = req.headers['user-agent'];
      developerName = req.headers['x-developer-name'] as string | undefined;
      deviceName = req.headers['x-device-name'] as string | undefined;
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

  // Un token ruotato o scaduto si sistema sulla postazione: nel frattempo
  // le misure non devono andare perse.
  it('tiene gli eventi nello spool se il token viene rifiutato', async () => {
    const forwarder = makeForwarder({ collectorToken: 'token-scaduto' });
    forwarder.enqueue(makeEvent('a'));
    await forwarder.flush();

    expect(spoolLines()).toHaveLength(1);
    expect(forwarder.stats().lastError).toBe('401');
  });

  it('si presenta con nome e versione del pacchetto', async () => {
    const forwarder = makeForwarder();
    forwarder.enqueue(makeEvent('a'));
    await forwarder.flush();

    expect(userAgent).toMatch(/^@vidiemme\/copilot-proxy\/\d+\.\d+\.\d+/);
    expect(developerName).toBeUndefined();
    expect(deviceName).toBeUndefined();
  });

  it('manda il nome del developer e l’hostname, se configurato', async () => {
    const forwarder = makeForwarder({ developerName: 'Niccolò Rossi' });
    forwarder.enqueue(makeEvent('a'));
    await forwarder.flush();

    expect(decodeURIComponent(developerName ?? '')).toBe('Niccolò Rossi');
    expect(decodeURIComponent(deviceName ?? '')).toBe(hostname().trim());
  });

  it('tiene i contatori di consegna', async () => {
    const forwarder = makeForwarder();
    forwarder.enqueue(makeEvent('a'));
    forwarder.enqueue(makeEvent('b'));
    await forwarder.flush();

    expect(forwarder.stats()).toMatchObject({ recorded: 2, delivered: 2, dropped: 0, lastError: null });
    expect(forwarder.stats().lastEventAt).not.toBeNull();
  });

  it('unisce il routing all\'evento ancora in coda senza contare una seconda misura', async () => {
    const forwarder = makeForwarder();
    forwarder.enqueue(makeEvent('a'));
    forwarder.enqueueFusionUpdate({ ...makeEvent('a'), hydraFusion: true });
    forwarder.enqueueFusionUpdate({ ...makeEvent('a'), hydraFusion: false });
    await forwarder.flush();

    expect(received).toEqual([expect.objectContaining({ requestId: 'a', hydraFusion: true })]);
    expect(forwarder.stats()).toMatchObject({ recorded: 1, delivered: 1, dropped: 0 });
  });

  it('ritenta un arricchimento separato senza alterare i contatori delle misure', async () => {
    const forwarder = makeForwarder();
    forwarder.enqueue(makeEvent('a'));
    await forwarder.flush();
    status = 503;
    forwarder.enqueueFusionUpdate({ ...makeEvent('a'), hydraFusion: true });
    await forwarder.flush();
    expect(spoolLines()).toHaveLength(1);
    expect(JSON.parse(spoolLines()[0]!)).toMatchObject({ fusionUpdate: { requestId: 'a', hydraFusion: true } });

    status = 202;
    await forwarder.flush();
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual({ ...makeEvent('a'), hydraFusion: true });
    expect(forwarder.stats()).toMatchObject({ recorded: 1, delivered: 1, dropped: 0 });
  });

  it('segnala lo scarto per coda piena, cosi\' il routing di quell\'evento non viene inviato', () => {
    const forwarder = makeForwarder();
    vi.spyOn(forwarder, 'flush').mockResolvedValue();
    for (let index = 0; index < 10_000; index += 1) {
      expect(forwarder.enqueue(makeEvent(`e-${index}`))).toBe(true);
    }

    expect(forwarder.enqueue(makeEvent('scartato'))).toBe(false);
    expect(forwarder.stats()).toMatchObject({ recorded: 10_001, dropped: 1 });
  });

  it("ricorda l'ultimo evento per famiglia di client", () => {
    const forwarder = makeForwarder();
    forwarder.enqueue({ ...makeEvent('a'), clientName: 'GitHubCopilotChat/0.72.0' });
    forwarder.enqueue({ ...makeEvent('b'), clientName: 'copilot/1.0.103 (darwin v24.20.0) client/github/cli' });
    forwarder.enqueue({ ...makeEvent('c'), clientName: null });

    expect(Object.keys(forwarder.stats().lastEventByClient).sort()).toEqual([
      'GitHubCopilotChat',
      'copilot',
      'sconosciuto',
    ]);
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
