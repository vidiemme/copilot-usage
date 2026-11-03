import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TokenCounters } from '@vidiemme/copilot-usage-contract';
import { parseUsageRecord, readCliCalls } from '../src/reload/copilotCli.js';
import { buildReloadPlan, proxyFirstStart, singleNestedRepository, type RateBook } from '../src/reload/index.js';
import { reconstructRounds, selectTier, type RateTier } from '../src/reload/reconstruct.js';
import { readChatRequests, replaySession } from '../src/reload/vscodeChat.js';

const OPUS: RateTier[] = [{ maxInputTokens: null, input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 }];
const GPT: RateTier[] = [
  { maxInputTokens: 272_000, input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  { maxInputTokens: null, input: 4, cachedInput: 0.4, cacheWrite: 5, output: 15 },
];
const NO_WRITE: RateTier[] = [{ maxInputTokens: null, input: 0.75, cachedInput: 0.075, cacheWrite: 0, output: 4.5 }];
const CREDIT_USD = 0.01;

/** Stesso calcolo del collector, evento per evento. */
function credits(rounds: TokenCounters[], tiers: RateTier[]): number {
  let usd = 0;
  for (const usage of rounds) {
    const input = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
    const tier = selectTier(tiers, input)!;
    usd +=
      (usage.inputTokens * tier.input +
        usage.cachedInputTokens * tier.cachedInput +
        usage.cacheWriteTokens * tier.cacheWrite +
        usage.outputTokens * tier.output) /
      1_000_000;
  }
  return usd / CREDIT_USD;
}

describe('reconstructRounds', () => {
  it('ricostruisce un round singolo in modo che il costo torni con i crediti', () => {
    const request = { rounds: 1, promptTokens: 115_857, completionTokens: 2110, credits: 55.32106 };
    const rounds = reconstructRounds(request, OPUS, CREDIT_USD)!;

    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.outputTokens).toBe(2110);
    expect(rounds[0]!.cachedInputTokens + rounds[0]!.cacheWriteTokens).toBe(115_857);
    expect(credits(rounds, OPUS)).toBeCloseTo(55.32106, 1);
  });

  it('distribuisce una richiesta agentica sui round, conservando output e costo', () => {
    const request = { rounds: 51, promptTokens: 196_222, completionTokens: 57_308, credits: 363.9541 };
    const rounds = reconstructRounds(request, OPUS, CREDIT_USD)!;

    expect(rounds).toHaveLength(51);
    expect(rounds.reduce((sum, usage) => sum + usage.outputTokens, 0)).toBe(57_308);
    expect(credits(rounds, OPUS)).toBeCloseTo(363.9541, 0);
  });

  // Sommare i round in un solo evento lo porterebbe nella fascia long context.
  it('tiene ogni round nella fascia della singola chiamata', () => {
    const request = { rounds: 20, promptTokens: 200_000, completionTokens: 20_000, credits: 150 };
    const rounds = reconstructRounds(request, GPT, CREDIT_USD)!;

    for (const usage of rounds) {
      expect(usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens).toBeLessThanOrEqual(272_000);
    }
    expect(credits(rounds, GPT)).toBeCloseTo(150, 0);
  });

  it('accorcia il contesto quando i crediti non coprono nemmeno le letture', () => {
    const request = { rounds: 10, promptTokens: 100_000, completionTokens: 1000, credits: 2 };
    const rounds = reconstructRounds(request, OPUS, CREDIT_USD)!;
    const input = rounds.reduce((sum, usage) => sum + usage.cachedInputTokens, 0);

    expect(input).toBeLessThan(10 * 100_000);
    expect(rounds.every((usage) => usage.cacheWriteTokens === 0)).toBe(true);
    expect(credits(rounds, OPUS)).toBeCloseTo(2, 1);
  });

  it('usa l\'input fresco come fascia cara se il modello non prezza la scrittura in cache', () => {
    const request = { rounds: 2, promptTokens: 50_000, completionTokens: 500, credits: 3 };
    const rounds = reconstructRounds(request, NO_WRITE, CREDIT_USD)!;

    expect(rounds.every((usage) => usage.cacheWriteTokens === 0)).toBe(true);
    expect(rounds.some((usage) => usage.inputTokens > 0)).toBe(true);
    expect(credits(rounds, NO_WRITE)).toBeCloseTo(3, 1);
  });
});

describe('replaySession', () => {
  it('riapplica assegnazioni, aggiunte con troncamento e rimozioni', () => {
    const log = [
      { kind: 0, v: { sessionId: 's1', requests: [{ requestId: 'a' }], title: 'x' } },
      { kind: 2, k: ['requests'], v: [{ requestId: 'b' }, { requestId: 'c' }] },
      { kind: 2, k: ['requests'], i: 2, v: [{ requestId: 'd' }] },
      { kind: 1, k: ['requests', 0, 'promptTokens'], v: 42 },
      { kind: 3, k: ['title'] },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n');

    expect(replaySession(`${log}\n{troncata`)).toEqual({
      sessionId: 's1',
      requests: [{ requestId: 'a', promptTokens: 42 }, { requestId: 'b' }, { requestId: 'd' }],
    });
  });
});

describe('parseUsageRecord', () => {
  it('toglie la cache dall\'input e usa l\'id di GitHub come chiave', () => {
    const line = JSON.stringify({
      type: 'session.usage_record',
      timestamp: '2026-10-23T16:10:08.000Z',
      data: {
        usage: {
          model: 'claude-haiku-5.5',
          inputTokens: 3822,
          cacheReadTokens: 1397,
          cacheWriteTokens: 2421,
          outputTokens: 99,
          duration: 1212,
          apiEndpoint: '/v1/messages',
          apiCallId: 'msg_1',
          serviceRequestId: '328de55e-68a3-42db-aa85-5f61ce973bcd',
        },
      },
    });

    expect(parseUsageRecord(line, '/w', 's')).toMatchObject({
      requestId: '328de55e-68a3-42db-aa85-5f61ce973bcd',
      model: 'claude-haiku-5.5',
      usage: { inputTokens: 4, cachedInputTokens: 1397, cacheWriteTokens: 2421, outputTokens: 99 },
      durationMs: 1212,
    });
  });

  it('ignora le righe che non sono record di consumo', () => {
    expect(parseUsageRecord('{"type":"assistant.message"}', '/w', 's')).toBeUndefined();
    expect(parseUsageRecord('non json', '/w', 's')).toBeUndefined();
  });
});

describe('caricamento dello storico', () => {
  let root: string;
  let work: string;
  let storage: string;
  let state: string;

  function round(time: string) {
    return { timestamp: Date.parse(time) };
  }

  function chat(requestId: string, start: string, rounds: string[], extra: Record<string, unknown> = {}) {
    return {
      requestId,
      timestamp: Date.parse(start),
      modelId: 'copilot/claude-opus-5.5',
      promptTokens: 100_000,
      completionTokens: 3000,
      copilotCredits: 40,
      result: { metadata: { resolvedModel: 'claude-opus-5-5', toolCallRounds: rounds.map(round) } },
      ...extra,
    };
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'proxy-reload-'));
    work = join(root, 'work');
    const repo = join(work, 'cliente', 'portale');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@gitlab.com:cliente/web/portale.git\n');
    mkdirSync(join(root, 'altrove'), { recursive: true });

    storage = join(root, 'workspaceStorage');
    const inside = join(storage, 'h1');
    mkdirSync(join(inside, 'chatSessions'), { recursive: true });
    writeFileSync(join(inside, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(repo).href }));
    const session = {
      kind: 0,
      v: {
        sessionId: 'chat-1',
        requests: [
          chat('r1', '2026-10-05T09:00:00Z', ['2026-10-05T09:00:01Z', '2026-10-05T09:00:30Z']),
          chat('r2', '2026-11-02T09:00:00Z', ['2026-11-02T09:00:01Z']),
          chat('r3', '2026-10-06T09:00:00Z', [], { copilotCredits: undefined }),
          chat('r4', '2026-10-07T09:00:00Z', [], { result: { metadata: { resolvedModel: 'modello-ignoto' } } }),
        ],
      },
    };
    writeFileSync(join(inside, 'chatSessions', 'chat-1.jsonl'), `${JSON.stringify(session)}\n`);
    // Biforcazione: stessa richiesta copiata, con il timestamp del fork.
    const fork = { kind: 0, v: { sessionId: 'chat-2', requests: [chat('r1', '2026-10-20T09:00:00Z', ['2026-10-05T09:00:01Z', '2026-10-05T09:00:30Z'])] } };
    writeFileSync(join(inside, 'chatSessions', 'chat-2.jsonl'), `${JSON.stringify(fork)}\n`);

    const outside = join(storage, 'h2');
    mkdirSync(join(outside, 'chatSessions'), { recursive: true });
    writeFileSync(join(outside, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(join(root, 'altrove')).href }));
    writeFileSync(
      join(outside, 'chatSessions', 'x.json'),
      JSON.stringify({ sessionId: 'x', requests: [chat('o1', '2026-10-05T10:00:00Z', ['2026-10-05T10:00:01Z'])] }),
    );

    state = join(root, 'session-state');
    const cliSession = join(state, 'cli-1');
    mkdirSync(cliSession, { recursive: true });
    writeFileSync(join(cliSession, 'workspace.yaml'), `id: cli-1\ncwd: ${join(repo, 'src')}\n`);
    const record = (id: string, time: string) =>
      JSON.stringify({
        type: 'session.usage_record',
        timestamp: time,
        data: { usage: { model: 'claude-opus-5.5', inputTokens: 1000, cacheReadTokens: 900, outputTokens: 10, serviceRequestId: id } },
      });
    writeFileSync(
      join(cliSession, 'events.jsonl'),
      [record('g1', '2026-10-10T08:00:00Z'), '{"type":"user.message"}', record('g1', '2026-10-10T08:00:00Z'), record('g2', '2026-09-28T08:00:00Z')].join('\n'),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const rates: RateBook = {
    creditUsd: CREDIT_USD,
    models: new Map([
      ['claude-opus-5-5', { tiers: OPUS }],
      ['modello-ignoto', null],
    ]),
  };

  function plan(withRates: RateBook | undefined) {
    const inputs = {
      cliCalls: readCliCalls(state),
      chatRequests: readChatRequests([{ editor: 'VS Code', path: storage }]),
    };
    return buildReloadPlan(
      inputs,
      { roots: [work], markers: ['.git'], from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') },
      'dev-1',
      withRates,
    );
  }

  it('tiene una sola copia delle richieste biforcate, con l\'orario originale', () => {
    const requests = readChatRequests([{ editor: 'VS Code', path: storage }]);
    const r1 = requests.filter((request) => request.requestId === 'r1');

    expect(r1).toHaveLength(1);
    expect(r1[0]!.roundTimes[0]!.toISOString()).toBe('2026-10-05T09:00:01.000Z');
  });

  it('carica solo il periodo e le cartelle richieste, attribuendo il repository dal remote', () => {
    const result = plan(rates);

    expect(result.events.map((event) => event.requestId)).toEqual(['vscode-chat:r1:0', 'vscode-chat:r1:1', 'g1']);
    expect(new Set(result.events.map((event) => event.projectId))).toEqual(new Set(['cliente/web/portale']));
    expect(result.events.every((event) => event.developerId === 'dev-1')).toBe(true);
    expect(result.sources).toMatchObject({ 'copilot-cli': 1, 'vscode-chat': 1, 'claude-code': 0 });
    expect(result.chatCredits).toBe(40);
  });

  it('propaga il routing delle sessioni CLI e delle chat ai singoli eventi ricaricati', () => {
    const cli = readCliCalls(state).find((call) => call.requestId === 'g1')!;
    const chat = readChatRequests([{ editor: 'VS Code', path: storage }])
      .find((request) => request.requestId === 'r1')!;
    expect(chat.hydraFusion).toBe(false);
    const result = buildReloadPlan(
      { cliCalls: [{ ...cli, hydraFusion: true }], chatRequests: [{ ...chat, hydraFusion: true }] },
      { roots: [work], markers: ['.git'] },
      'dev-1',
      rates,
    );

    expect(result.events).toHaveLength(3);
    expect(result.events.every((event) => event.hydraFusion === true)).toBe(true);
    expect(result.events.map((event) => event.model)).toEqual([
      'claude-opus-5-5',
      'claude-opus-5-5',
      'claude-opus-5.5',
    ]);
  });

  it('segnala le richieste che non si possono ricostruire invece di caricarle a costo zero', () => {
    const result = plan(rates);

    expect(result.skippedChat.noBilling).toBe(1);
    expect(result.skippedChat.unpriced.get('modello-ignoto')).toBe(1);
  });

  it('conta le sessioni fuori dalle cartelle indicate invece di ignorarle', () => {
    const result = plan(rates);

    expect(result.skippedOutside.folders).toEqual(new Map([[join(root, 'altrove'), 1]]));
    expect(result.skippedOutside.noFolder).toBe(0);
  });

  it('senza listino carica comunque Copilot CLI', () => {
    const result = plan(undefined);

    expect(result.events.map((event) => event.requestId)).toEqual(['g1']);
    expect(result.skippedChat.noRates).toBe(2);
  });

  it('ricava il primo avvio del proxy dal suo log', () => {
    const log = join(root, 'proxy.log');
    writeFileSync(
      log,
      ['non json', '{"level":30,"time":1793102554476,"msg":"Server listening at http://127.0.0.1:8787"}', '{"time":1793200000000,"msg":"Server listening"}'].join('\n'),
    );

    expect(proxyFirstStart(log)?.getTime()).toBe(1793102554476);
    expect(proxyFirstStart(join(root, 'assente.log'))).toBeUndefined();
  });
});

describe('cartella aperta sopra il repository', () => {
  let base: string;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'nested-'));
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function repo(path: string, remote?: string): string {
    const directory = join(base, path);
    mkdirSync(join(directory, '.git'), { recursive: true });
    writeFileSync(join(directory, '.git', 'config'), remote ? `[remote "origin"]\n\turl = ${remote}\n` : '');
    return directory;
  }

  it('trova l\'unico repository fino a due livelli, ignorando cartelle nascoste e dipendenze', () => {
    const one = repo('redroom/monorepo');
    repo('redroom/.cache/plugin');
    repo('redroom/node_modules/pkg');
    const deep = repo('cliente/apps/web');

    expect(singleNestedRepository(join(base, 'redroom'), ['.git'])).toBe(one);
    expect(singleNestedRepository(join(base, 'cliente'), ['.git'])).toBe(deep);
  });

  it('tratta un clone e i suoi worktree come un solo repository', () => {
    const main = repo('medismart/medismart-service', 'git@gitlab.com:air-liquide/medismart-service.git');
    const pointer = join(main, '.git', 'worktrees', 'feature-x');
    mkdirSync(pointer, { recursive: true });
    writeFileSync(join(pointer, 'commondir'), '../..\n');
    mkdirSync(join(base, 'medismart', 'feature-x'), { recursive: true });
    writeFileSync(join(base, 'medismart', 'feature-x', '.git'), `gitdir: ${pointer}\n`);
    repo('medismart-e-altro/medismart-service', 'git@gitlab.com:air-liquide/medismart-service.git');
    repo('medismart-e-altro/client-react', 'git@gitlab.com:air-liquide/client-react.git');

    expect(singleNestedRepository(join(base, 'medismart'), ['.git'])).toBeDefined();
    expect(singleNestedRepository(join(base, 'medismart-e-altro'), ['.git'])).toBeUndefined();
  });

  it('non sceglie fra piu\' repository, ne\' oltre due livelli', () => {
    repo('airliquide/medismart-service');
    repo('airliquide/client-react');
    repo('profondo/a/b/c');

    expect(singleNestedRepository(join(base, 'airliquide'), ['.git'])).toBeUndefined();
    expect(singleNestedRepository(join(base, 'profondo'), ['.git'])).toBeUndefined();
  });

  it('attribuisce le sessioni della cartella contenitore al remote del repository interno', () => {
    repo('contenitore/monorepo', 'git@gitlab.com:bip/red/redroom/monorepo.git');
    const call = (id: string, cwd: string) => ({
      requestId: id,
      occurredAt: new Date('2026-10-10T08:00:00Z'),
      cwd,
      sessionId: 's',
      model: 'gpt-6-luna',
      endpoint: null,
      usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
      durationMs: null,
    });

    const result = buildReloadPlan(
      { cliCalls: [call('c1', join(base, 'contenitore')), call('c2', join(base, 'airliquide'))], chatRequests: [] },
      { roots: [base], markers: ['.git'] },
      'dev-1',
      undefined,
    );

    expect(result.events.map((event) => [event.requestId, event.projectId])).toEqual([
      ['c1', 'bip/red/redroom/monorepo'],
      ['c2', 'airliquide'],
    ]);
  });

  it('non cerca dentro un root di lavoro, anche se contiene un solo repository', () => {
    const root = join(base, 'solo-root');
    repo('solo-root/sdk', 'https://github.com/flutter/flutter.git');
    const result = buildReloadPlan(
      {
        cliCalls: [
          {
            requestId: 'h1',
            occurredAt: new Date('2026-10-10T08:00:00Z'),
            cwd: root,
            sessionId: 's',
            model: null,
            endpoint: null,
            usage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
            durationMs: null,
          },
        ],
        chatRequests: [],
      },
      { roots: [root], markers: ['.git'] },
      'dev-1',
      undefined,
    );

    expect(result.events.map((event) => event.projectId)).toEqual(['solo-root']);
  });
});
